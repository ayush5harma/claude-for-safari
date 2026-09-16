// The background page's half of the multi-profile routing, against stubbed
// browser APIs: which tabs it calls its own, the two hub probes, the toolbar
// click's repair-then-relay order, the world route into a page whose content
// script belongs to another extension context, and the instance header on
// every hub request. Loaded the way background-ua.test.js loads it (the three
// background scripts as one script in a vm context); see that file for why.

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
// ping; `worldOwned` is the set whose content script is in the page but belongs
// to ANOTHER context -- no message ever reaches it, and only the world route
// (tabs.executeScript into the shared content world) does. `relay` is what the
// hub says to /relay. `pull` hands the poll loop one call and then parks it
// forever.
function load({ tabs = [], owned = [], worldOwned = [], blockInjection = [], injectFails = [],
  relay = { handled: false }, pull = null, store = {} } = {}) {
  const sent = [];           // [tabId, msg] for every tabs.sendMessage
  const injected = [];       // tabIds given to executeScript with a file
  const evaluated = [];      // [tabId, code] for every executeScript with code
  const hubRequests = [];    // [path, headers, body] for every hubFetch
  const results = [];        // bodies posted to /result
  let clicked = null;
  const ownedSet = new Set(owned);
  // One content world per tab, as the page would hold it: a run that publishes
  // its ops there serves every context, whoever it belongs to.
  const worlds = new Map();
  const publish = (id) => worlds.set(id, {
    __claudeSafariContent: "ready",
    __claudeSafari: { v: 6, gen: 1, ctx: "safari-web-extension://OTHER/", run: (msg) => {
      if (msg.op === "ping") return { ok: true, v: 6, hidden: false };
      if (msg.op === "togglePanel") return { open: true };
      return { ok: true, op: msg.op };
    } },
  });
  for (const id of worldOwned) publish(id);
  const blocked = new Set(blockInjection);   // an old script in the page that the guard keeps
  const fails = new Set(injectFails);        // a tab nothing can be injected into
  const browser = {
    storage: {
      local: {
        async get(k) {
          if (typeof k === "string") return k in store ? { [k]: store[k] } : {};
          if (Array.isArray(k)) return Object.fromEntries(k.filter((x) => x in store).map((x) => [x, store[x]]));
          return { ...store };
        },
        async set(o) { Object.assign(store, o); },
        async remove(k) { delete store[k]; },
      },
      onChanged: { addListener() {} },
    },
    declarativeNetRequest: { async updateDynamicRules() {} },
    scripting: { async registerContentScripts() {}, async unregisterContentScripts() {} },
    browserAction: { setBadgeText() {}, setTitle() {}, onClicked: { addListener: (fn) => { clicked = fn; } } },
    runtime: { onMessage: { addListener() {} }, getURL: (p) => "safari-web-extension://TEST-INSTANCE/" + p, getManifest: () => ({ version: "test" }) },
    tabs: {
      async query(q) {
        if (q && q.active) return tabs.filter((t) => t.active);
        return tabs;
      },
      async get(id) { const t = tabs.find((x) => x.id === id); if (!t) throw new Error("Invalid call to tabs.get(). Tab not found."); return t; },
      async sendMessage(id, msg) {
        sent.push([id, plain(msg)]);
        if (!ownedSet.has(id)) return undefined;              // Safari: nobody received it
        if (msg.op === "ping") return { ok: true, v: 6, hidden: false };
        if (msg.op === "togglePanel") return { open: true };
        return { ok: true };
      },
      // The real thing evaluates in the page's content world; so does this,
      // against the world object above, so the code the background page builds
      // is under test rather than a paraphrase of it.
      async executeScript(id, opts) {
        // A Safari-internal page, a tab Safari has not loaded, a site with no
        // grant: every route into the page is closed.
        if (fails.has(id)) throw new Error("Cannot access contents of the tab");
        if (opts && opts.file) {
          injected.push(id);
          if (blocked.has(id)) return [undefined];            // the run-once guard held
          ownedSet.add(id);                                   // the injection takes the page
          publish(id);
          return [undefined];
        }
        evaluated.push([id, (opts && opts.code) || ""]);
        const world = worlds.get(id) || {};
        // Enough page for the probes the background page evaluates there.
        const ctx = vm.createContext({ window: world, document: { readyState: "complete" },
          location: { href: "https://t" + id + "/" } });
        const value = vm.runInContext(String((opts && opts.code) || "undefined"), ctx);
        // A takeover clears the guard in the world, which is what lets the
        // next injection run.
        if (world.__claudeSafariContent === "stale") blocked.delete(id);
        return [plain(value)];
      },
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
  return { ctx, sent, injected, evaluated, hubRequests, results, worlds, store, click: (tab) => clicked(tab) };
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

test("a restarted background page keeps its instance id, so tab ids stay valid", async () => {
  // Safari restarts this page on its own; with a fresh id the hub called the
  // restarted copy a new profile and every tabId a session held went stale.
  const restarted = load({ tabs: [T(1, true)], owned: [1], store: { instanceId: "kept-across-restarts" },
    pull: { id: "c1", tool: "probeActive", args: {} } });
  await settle(20);
  const ids = new Set(restarted.hubRequests.map(([, h]) => h["x-claude-instance"]));
  assert.deepEqual([...ids], ["kept-across-restarts"]);

  const first = load({ tabs: [T(1, true)], owned: [1], pull: { id: "c1", tool: "probeActive", args: {} } });
  await settle(20);
  const [minted] = new Set(first.hubRequests.map(([, h]) => h["x-claude-instance"]));
  assert.equal(first.store.instanceId, minted, "a first run persists the id it minted");
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

test("diag reports the instance, the ping and what the content world shows", async () => {
  const env = load({ tabs: [T(8, true)], owned: [8], worldOwned: [8], pull: { id: "d", tool: "diag", args: { tabId: 8 } } });
  await settle(20);
  const r = env.results.find((x) => x.id === "d").result;
  assert.equal(r.tabId, 8);
  assert.equal(r.instance, "safari-web-extension://TEST-INSTANCE/");
  assert.equal(r.version, "test");
  assert.equal(r.ping.ok, true);
  assert.ok(r.pingMs >= 0);
  // What the content world shows, including whether a script published the
  // world route there and which context it belongs to.
  assert.equal(typeof r.world, "object");
  assert.equal(r.world.state, "ready");
  assert.equal(r.world.run, true);
  assert.equal(r.world.ctx, "safari-web-extension://OTHER/");
  assert.equal(r.worldError, null);
  assert.equal(env.injected.length, 0, "diag never injects the content script");
  assert.ok(env.evaluated.some(([id]) => id === 8), "diag probes the world instead");
});

test("a click on a page this instance owns toggles it directly, no relay, no injection", async () => {
  const env = load({ tabs: [T(8, true)], owned: [8] });
  await env.click(T(8, true));
  assert.ok(env.sent.some(([id, m]) => id === 8 && m.op === "togglePanel"));
  assert.equal(env.hubRequests.filter(([p]) => p === "/relay").length, 0);
  assert.deepEqual(env.injected, []);
});

test("a click on a page another context's script holds goes through the world, not the hub", async () => {
  // The script in the page belongs to another profile's copy, so no message
  // from here ever reaches it -- the case that left the panel unopenable until
  // the world route existed.
  const env = load({ tabs: [T(8, true)], owned: [], worldOwned: [8], relay: { handled: true } });
  await env.click(T(8, true));
  assert.equal(env.hubRequests.filter(([p]) => p === "/relay").length, 0, "the panel must open with the hub down");
  assert.deepEqual(env.injected, [], "a script that answers the world needs no second run");
  assert.ok(env.evaluated.some(([id, code]) => id === 8 && code.includes("togglePanel")), "toggled through the world");
});

test("a page whose script answers neither route is taken over, then toggled", async () => {
  // An old build's content script: it set the run-once guard and publishes no
  // world route, so the first injection returns at the guard.
  const env = load({ tabs: [T(8, true)], owned: [], blockInjection: [8], relay: { handled: false } });
  await env.click(T(8, true));
  assert.equal(env.injected.filter((id) => id === 8).length, 2, "injected, blocked, then injected again after the takeover");
  assert.ok(env.evaluated.some(([id, code]) => id === 8 && code.includes("__claudeSafariContent = 'stale'")), "cleared the guard");
  assert.ok(env.sent.some(([id, m]) => id === 8 && m.op === "togglePanel"), "and the panel opened");
});

test("a page no route can reach falls back to the hub relay", async () => {
  const env = load({ tabs: [T(8, true)], owned: [], injectFails: [8], relay: { handled: true } });
  await env.click(T(8, true));
  assert.equal(env.hubRequests.filter(([p]) => p === "/relay").length, 1);
  assert.equal(env.sent.filter(([, m]) => m.op === "togglePanel").length, 0);
});

test("with no script in the page at all, the clicked instance injects and takes it", async () => {
  const env = load({ tabs: [T(8, true)], owned: [], relay: { handled: false } });
  await env.click(T(8, true));
  assert.deepEqual(env.injected, [8], "one injection is enough");
  assert.ok(env.sent.some(([id, m]) => id === 8 && m.op === "togglePanel"), "then toggled");
  assert.equal(env.hubRequests.filter(([p]) => p === "/relay").length, 0, "no relay was needed");
});

test("a tool call reaches a page held by another context", async () => {
  const env = load({ tabs: [T(5, true)], owned: [], worldOwned: [5],
    pull: { id: "r", tool: "read", args: { tabId: 5 } } });
  await settle(30);
  const r = env.results.find((x) => x.id === "r");
  assert.equal(r.error, undefined, "the world route answered");
  assert.equal(r.result.tabId, 5);
  assert.deepEqual(env.injected, [], "reading never had to re-run the script");
});
