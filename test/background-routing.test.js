// The background page's half of the multi-profile routing, against stubbed
// browser APIs: which tabs it calls its own, the two hub probes, the toolbar
// click's relay-then-inject order, and the instance header on every hub
// request. Loaded the way background-ua.test.js loads it (the three background
// scripts as one script in a vm context); see that file for why.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "extension");
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const BACKGROUND_SCRIPTS = require(path.join(EXT, "manifest.json")).background.scripts;
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// `owned` is the set of tab ids whose content script answers this instance's
// ping; `relay` is what the hub says to /relay. `pull` hands the poll loop one
// call and then parks it forever.
function load({ tabs = [], owned = [], relay = { handled: false }, pull = null } = {}) {
  const sent = [];           // [tabId, msg] for every tabs.sendMessage
  const injected = [];       // tabIds given to executeScript
  const hubRequests = [];    // [path, headers, body] for every hubFetch
  const results = [];        // bodies posted to /result
  let clicked = null;
  const ownedSet = new Set(owned);
  const browser = {
    storage: { local: { async get() { return {}; }, async set() {}, async remove() {} }, onChanged: { addListener() {} } },
    declarativeNetRequest: { async updateDynamicRules() {} },
    scripting: { async registerContentScripts() {}, async unregisterContentScripts() {} },
    browserAction: { setBadgeText() {}, setTitle() {}, onClicked: { addListener: (fn) => { clicked = fn; } } },
    runtime: { onMessage: { addListener() {} } },
    tabs: {
      async query(q) {
        if (q && q.active) return tabs.filter((t) => t.active);
        return tabs;
      },
      async get(id) { const t = tabs.find((x) => x.id === id); if (!t) throw new Error("Invalid call to tabs.get(). Tab not found."); return t; },
      async sendMessage(id, msg) {
        sent.push([id, plain(msg)]);
        if (!ownedSet.has(id)) return undefined;              // Safari: nobody received it
        if (msg.op === "ping") return { ok: true, v: 5, hidden: false };
        if (msg.op === "togglePanel") return { open: true };
        return { ok: true };
      },
      async executeScript(id) { injected.push(id); ownedSet.add(id); },  // the injection takes the page
    },
  };
  let pulled = false;
  const fetch = async (url, opts = {}) => {
    const p = url.replace(/^https?:\/\/[^/]+/, "");
    hubRequests.push([p, opts.headers || {}, opts.body ? JSON.parse(opts.body) : null]);
    if (p === "/pull") {
      if (pull && !pulled) { pulled = true; return { status: 200, ok: true, json: async () => pull }; }
      return new Promise(() => {});
    }
    if (p === "/result") { results.push(JSON.parse(opts.body)); return { status: 200, ok: true, json: async () => ({ ok: true }) }; }
    if (p === "/relay") return { status: 200, ok: true, json: async () => relay };
    throw new Error("unexpected " + p);
  };
  const ctx = vm.createContext({
    browser, chrome: browser, console, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortSignal: { timeout: () => undefined },
  });
  const src = BACKGROUND_SCRIPTS.map((f) => fs.readFileSync(path.join(EXT, f), "utf8")).join("\n;\n");
  vm.runInContext(src, ctx, { filename: "background-bundle.js" });
  return { ctx, sent, injected, hubRequests, results, click: (tab) => clicked(tab) };
}

const T = (id, active = false) => ({ id, windowId: 1, index: id, active, url: "https://t" + id + "/", title: "T" + id });

test("every hub request names this background page, with one id for its whole life", async () => {
  const env = load({ tabs: [T(1, true)], owned: [1], pull: { id: "c1", tool: "probeActive", args: {} } });
  await settle(20);
  const ids = new Set(env.hubRequests.map(([, h]) => h["x-claude-instance"]));
  assert.equal(ids.size, 1);
  const [id] = ids;
  assert.match(id, /^[0-9a-z-]{8,}$/i);   // a UUID in Safari; base36 in this sandbox
  assert.ok(env.hubRequests.some(([p]) => p === "/pull") && env.hubRequests.some(([p]) => p === "/result"));
});

test("tabs marks ownership only when the hub asks for it; the panel's listing pings nothing", async () => {
  const env = load({ tabs: [T(1), T(2, true), T(3)], owned: [2], pull: { id: "c1", tool: "tabs", args: { probe: true } } });
  await settle(20);
  const listing = env.results.find((r) => r.id === "c1").result;
  assert.deepEqual(listing.map((t) => [t.tabId, t.owned]), [[1, false], [2, true], [3, false]]);
  assert.equal(env.sent.filter(([, m]) => m.op === "ping").length, 3, "one ping per tab");
  assert.equal("index" in listing[0], false);

  const quiet = load({ tabs: [T(1), T(2, true)], owned: [2], pull: { id: "c2", tool: "tabs", args: {} } });
  await settle(20);
  const plainListing = quiet.results.find((r) => r.id === "c2").result;
  assert.equal("owned" in plainListing[0], false);
  assert.equal(quiet.sent.length, 0, "no pings without probe");
});

test("probeActive reports the active tab and whether this instance can reach it", async () => {
  const mine = load({ tabs: [T(7), T(8, true)], owned: [8], pull: { id: "p", tool: "probeActive", args: {} } });
  await settle(20);
  assert.deepEqual(mine.results.find((r) => r.id === "p").result, { tabId: 8, owned: true });
  const notMine = load({ tabs: [T(7), T(8, true)], owned: [], pull: { id: "p", tool: "probeActive", args: {} } });
  await settle(20);
  assert.deepEqual(notMine.results.find((r) => r.id === "p").result, { tabId: 8, owned: false });
});

test("toggleActive toggles the panel only in a page this instance owns", async () => {
  const owner = load({ tabs: [T(8, true)], owned: [8], pull: { id: "t", tool: "toggleActive", args: {} } });
  await settle(20);
  assert.deepEqual(owner.results.find((r) => r.id === "t").result, { handled: true });
  assert.ok(owner.sent.some(([id, m]) => id === 8 && m.op === "togglePanel"));
  const other = load({ tabs: [T(8, true)], owned: [], pull: { id: "t", tool: "toggleActive", args: {} } });
  await settle(20);
  assert.deepEqual(other.results.find((r) => r.id === "t").result, { handled: false });
  assert.equal(other.injected.length, 0, "a probe never injects");
});

test("a click on a page this instance owns toggles it directly, no relay, no injection", async () => {
  const env = load({ tabs: [T(8, true)], owned: [8] });
  await env.click(T(8, true));
  assert.ok(env.sent.some(([id, m]) => id === 8 && m.op === "togglePanel"));
  assert.equal(env.hubRequests.filter(([p]) => p === "/relay").length, 0);
  assert.deepEqual(env.injected, []);
});

test("a click on another profile's page is relayed, and this instance stays out of it", async () => {
  const env = load({ tabs: [T(8, true)], owned: [], relay: { handled: true } });
  await env.click(T(8, true));
  assert.equal(env.hubRequests.filter(([p]) => p === "/relay").length, 1);
  assert.deepEqual(env.injected, [], "the owner has the page; injecting here would double the guard");
  assert.equal(env.sent.filter(([, m]) => m.op === "togglePanel").length, 0);
});

test("when no profile owns the page, the clicked instance injects and takes it", async () => {
  const env = load({ tabs: [T(8, true)], owned: [], relay: { handled: false } });
  await env.click(T(8, true));
  assert.equal(env.hubRequests.filter(([p]) => p === "/relay").length, 1, "asked first");
  assert.deepEqual(env.injected, [8], "then injected");
  assert.ok(env.sent.some(([id, m]) => id === 8 && m.op === "togglePanel"), "then toggled");
});
