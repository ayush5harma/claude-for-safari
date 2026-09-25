// The background page's half of background agent work (0.43), against stubbed
// browser APIs: a new tab opens behind the owner's view, a screenshot never
// switches the showing tab unless forced (and puts it back when it is), an
// awaited eval polls its job, a frame is reached through the world route with
// the frame target Safari is given, and a profile name rides every hub request.
// Loaded the way the other background tests load it: the manifest's
// background scripts as one script in a vm context.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "extension");
const SCRIPTS = require(path.join(EXT, "manifest.json")).background.scripts;
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// `tabs` is Safari's view; `pageRun` answers the content-world ops for a tab
// (it stands in for content.js's world.run), and `frames` lists, per tab, the
// subframes a world probe with allFrames also runs in.
function load({ tabs, pageRun = () => ({ ok: true }), frames = {}, store = {}, owned = [] }) {
  const calls = { create: [], update: [], capture: [], exec: [], hub: [], ran: [] };
  // One world per frame, kept across calls as a page keeps it: a tag a probe
  // leaves in a frame is still there for the next executeScript.
  const worlds = new Map();
  const world = (tabId, href) => {
    const k = tabId + "|" + href;
    if (!worlds.has(k)) {
      worlds.set(k, {
        __claudeSafariContent: "ready",
        __claudeSafari: { v: 7, gen: 1, run: (msg) => {
          if (msg.op === "ping") return { ok: true, v: 7, hidden: false };
          calls.ran.push([href, msg.op]);
          return pageRun(msg, tabId, href);
        } },
      });
    }
    return worlds.get(k);
  };
  const runIn = (code, tabId, href) => {
    const ctx = vm.createContext({ window: world(tabId, href), location: { href }, document: { readyState: "complete" }, Math, Date, String });
    return plain(vm.runInContext(code, ctx));
  };
  const ownedSet = new Set(owned);
  let nextId = 500;
  const browser = {
    storage: {
      local: {
        async get(k) { return typeof k === "string" ? (k in store ? { [k]: store[k] } : {}) : { ...store }; },
        async set(o) { Object.assign(store, o); },
        async remove(k) { delete store[k]; },
      },
      onChanged: { addListener() {} },
    },
    declarativeNetRequest: { async updateDynamicRules() {} },
    scripting: { async registerContentScripts() {}, async unregisterContentScripts() {} },
    browserAction: { setBadgeText() {}, setTitle() {}, onClicked: { addListener() {} } },
    permissions: { async contains() { return true; } },
    runtime: { onMessage: { addListener() {} }, getURL: (p) => "safari-web-extension://AGENT-TEST/" + p, getManifest: () => ({ version: "0.43" }) },
    tabs: {
      async query(q) {
        let out = tabs;
        if (q && q.active) out = out.filter((t) => t.active);
        if (q && q.windowId != null) out = out.filter((t) => t.windowId === q.windowId);
        if (q && q.lastFocusedWindow) out = out.filter((t) => t.windowId === 1);
        return out;
      },
      async get(id) { const t = tabs.find((x) => x.id === id); if (!t) throw new Error("Tab not found"); return t; },
      async create(opts) {
        calls.create.push(plain(opts));
        const t = { id: nextId++, windowId: opts.windowId != null ? opts.windowId : 1, active: !!opts.active, url: opts.url, title: "" };
        return t;
      },
      async update(id, props) {
        calls.update.push([id, plain(props)]);
        if (props.active) {
          const t = tabs.find((x) => x.id === id);
          for (const o of tabs) if (o.windowId === t.windowId) o.active = o.id === id;
        }
        return tabs.find((x) => x.id === id);
      },
      async captureVisibleTab(windowId) {
        const showing = tabs.find((t) => t.windowId === windowId && t.active);
        calls.capture.push([windowId, showing && showing.id]);
        return "data:image/png;base64,AAAA";
      },
      // The message route answers only a ping, and only in an `owned` tab
      // (this copy's content script holds its channel): enough for the
      // ownership checks. Every op goes through the world, which is the route
      // a frame always takes.
      async sendMessage(id, msg) { return msg.op === "ping" && ownedSet.has(id) ? { ok: true, v: 7, hidden: false } : undefined; },
      async executeScript(id, opts) {
        calls.exec.push([id, plain({ ...opts, code: undefined })]);
        if (opts.file) return [undefined];
        const t = tabs.find((x) => x.id === id);
        if (opts.allFrames) return [t.url, ...(frames[id] || [])].map((href) => runIn(opts.code, id, href));
        const href = opts.frameId ? (frames[id] || [])[opts.frameId - 1] : t.url;
        return [runIn(opts.code, id, href)];
      },
    },
  };
  const fetch = async (url, opts = {}) => {
    calls.hub.push([String(url).replace(/^https?:\/\/[^/]+/, ""), opts.headers || {}]);
    return new Promise(() => {});        // the poll parks forever; these tests call handlers directly
  };
  const ctx = vm.createContext({ browser, chrome: browser, console, fetch, URL, setTimeout, clearTimeout,
    setInterval, clearInterval, AbortSignal: { timeout: () => undefined } });
  vm.runInContext(SCRIPTS.map((f) => fs.readFileSync(path.join(EXT, f), "utf8")).join("\n;\n"), ctx, { filename: "background-bundle.js" });
  const handlers = vm.runInContext("handlers", ctx);
  return { ctx, calls, store, tabs, run: async (tool, args) => plain(await handlers[tool](args)) };
}

const T = (id, windowId, active, url = "https://t" + id + "/") => ({ id, windowId, active, url, title: "T" + id, status: "complete" });

test("a new tab opens in the background of the owner's current window by default", async () => {
  const env = load({ tabs: [T(1, 1, true), T(2, 1, false), T(3, 2, true)] });
  const r = await env.run("navigate", { url: "https://example.com/", newTab: true });
  assert.deepEqual(env.calls.create, [{ url: "https://example.com/", active: false, windowId: 1 }]);
  assert.equal(r.active, false);
  assert.equal(r.windowId, 1);
  assert.equal(env.calls.update.length, 0, "no tab was switched");
});

test("a new tab goes to the window a caller names, and is shown only when asked", async () => {
  const env = load({ tabs: [T(1, 1, true), T(3, 2, true)] });
  await env.run("navigate", { url: "https://example.com/", newTab: true, windowId: 2 });
  await env.run("navigate", { url: "https://example.org/", newTab: true, active: true });
  assert.deepEqual(env.calls.create, [
    { url: "https://example.com/", active: false, windowId: 2 },
    { url: "https://example.org/", active: true, windowId: 1 },
  ]);
});

test("navigating a pinned tab changes its URL and nothing about which tab is shown", async () => {
  const env = load({ tabs: [T(1, 1, true), T(2, 1, false)] });
  const r = await env.run("navigate", { url: "https://example.com/", tabId: 2 });
  assert.deepEqual(env.calls.update, [[2, { url: "https://example.com/" }]]);
  assert.equal(r.windowId, 1);
});

test("a screenshot of a background tab is refused, naming read and eval, and switches nothing", async () => {
  const env = load({ tabs: [T(1, 1, true), T(2, 1, false)] });
  await assert.rejects(env.run("screenshot", { tabId: 2 }), /not the tab its window is showing.*claude_safari_read.*claude_safari_eval/s);
  assert.equal(env.calls.update.length, 0);
  assert.equal(env.calls.capture.length, 0);
});

test("a screenshot of a showing tab is taken as is", async () => {
  const env = load({ tabs: [T(1, 1, true), T(2, 1, false)] });
  const r = await env.run("screenshot", { tabId: 1 });
  assert.equal(r.switched, false);
  assert.deepEqual(env.calls.capture, [[1, 1]]);
  assert.equal(env.calls.update.length, 0);
});

test("a forced screenshot switches to the tab, captures it, and puts the window back", async () => {
  const env = load({ tabs: [T(1, 1, true), T(2, 1, false)] });
  const r = await env.run("screenshot", { tabId: 2, force: true });
  assert.equal(r.switched, true);
  assert.deepEqual(env.calls.capture, [[1, 2]], "the capture saw the forced tab");
  assert.deepEqual(env.calls.update, [[2, { active: true }], [1, { active: true }]]);
  assert.equal(env.tabs.find((t) => t.id === 1).active, true, "the owner's tab is showing again");
});

test("an eval that returns a promise is polled until the job settles", async () => {
  let polls = 0;
  const env = load({
    tabs: [T(1, 1, true)],
    pageRun: (msg) => {
      if (msg.op === "eval") return { pending: "j1-1" };
      if (msg.op === "job") return ++polls < 3 ? { pending: "j1-1" } : { value: 42 };
      return null;
    },
  });
  const r = await env.run("eval", { code: "fetch('/x').then(r => 42)" });
  assert.deepEqual(r, { value: 42 });
  assert.equal(polls, 3);
});

test("an eval whose promise outlives timeoutMs is reported by name", async () => {
  const env = load({ tabs: [T(1, 1, true)], pageRun: (msg) => (msg.op === "eval" || msg.op === "job" ? { pending: "j" } : null) });
  await assert.rejects(env.run("eval", { code: "new Promise(() => {})", timeoutMs: 250 }), /did not settle within 250ms/);
});

test("a frameUrl runs the op in the one frame it names, and in no other", async () => {
  const env = load({
    tabs: [T(1, 1, true, "https://outer.example/")],
    // The second frame is a page's own embed whose URL merely CONTAINS the
    // text another frame is named by: the case a first-match-while-running
    // design leaked a fill or an upload into.
    frames: { 1: ["https://pay.example/checkout", "https://ads.example/slot#pay.example/checkout"] },
    pageRun: (msg, tabId, href) => ({ clicked: href }),
  });
  const r = await env.run("click", { selector: "#go", frameUrl: "https://pay.example/checkout" });
  assert.deepEqual(r, { clicked: "https://pay.example/checkout" });
  assert.deepEqual(env.calls.ran, [["https://pay.example/checkout", "click"]], "exactly one frame ran the op");
  // Ambiguous or absent: refused, and nothing runs anywhere.
  await assert.rejects(env.run("click", { selector: "#go", frameUrl: "pay.example" }), /2 frames' URLs contain "pay\.example"/);
  await assert.rejects(env.run("click", { selector: "#go", frameUrl: "nowhere" }),
    /no frame's URL contains "nowhere" \(frames here: https:\/\/outer\.example\/, https:\/\/pay\.example\/checkout, /);
  assert.equal(env.calls.ran.length, 1);
});

test("a frame whose script is there but slow is not retried, so an action never runs twice", async () => {
  const env = load({
    tabs: [T(1, 1, true, "https://outer.example/")],
    frames: { 1: ["https://inner.example/"] },
    pageRun: (msg) => (msg.op === "upload" ? undefined : { ok: true }),   // no answer, as a busy frame gives none
  });
  await assert.rejects(env.run("upload", { selector: "#f", files: [], frameUrl: "inner.example" }), /not retried/);
  assert.equal(env.calls.exec.filter(([, o]) => o.file).length, 0, "no re-injection");
  assert.equal(env.calls.ran.filter(([, op]) => op === "upload").length, 1);
});

test("a call routed by profile acts in a showing tab this copy can reach, not the owner's front tab", async () => {
  // Window 1 is the owner's front window, in another profile (this copy's
  // ping is not answered there); window 2's showing tab is this profile's.
  const env = load({ tabs: [T(1, 1, true), T(3, 2, true, "https://mine/")], owned: [3], pageRun: (msg, tabId) => ({ tab: tabId }) });
  assert.deepEqual(await env.run("eval", { code: "1", profile: "Agent" }), { tab: 3 });
  await env.run("navigate", { url: "https://example.com/", newTab: true, profile: "Agent" });
  assert.equal(env.calls.create[0].windowId, 2, "the new tab opens in this profile's window");
  const none = load({ tabs: [T(1, 1, true)], owned: [] });
  await assert.rejects(none.run("read", { profile: "Agent" }), /pass a tabId or windowId/);
});

test("a windowId without a tabId means that window's showing tab, not the owner's front tab", async () => {
  const env = load({ tabs: [T(1, 1, true), T(3, 2, true)] });
  await env.run("navigate", { url: "https://example.com/", windowId: 2 });
  assert.deepEqual(env.calls.update, [[3, { url: "https://example.com/" }]]);
});

test("a frameId is handed to Safari, and frame 0 is the top frame as before", async () => {
  const env = load({
    tabs: [T(1, 1, true, "https://outer.example/")],
    frames: { 1: ["https://inner.example/"] },
    pageRun: (msg, tabId, href) => ({ filled: href }),
  });
  assert.deepEqual(await env.run("fill", { selector: "#q", value: "x", frameId: 1 }), { filled: "https://inner.example/" });
  assert.ok(env.calls.exec.some(([, o]) => o.frameId === 1));
  assert.deepEqual(await env.run("fill", { selector: "#q", value: "x", frameId: 0 }), { filled: "https://outer.example/" });
});

test("an upload is passed to the page with its files", async () => {
  let seen = null;
  const env = load({ tabs: [T(1, 1, true)], pageRun: (msg) => { seen = msg; return { uploaded: [{ name: "a.txt", size: 2 }], count: 1 }; } });
  const r = await env.run("upload", { selector: "#f", files: [{ name: "a.txt", type: "text/plain", base64: "aGk=" }] });
  assert.equal(r.count, 1);
  assert.deepEqual(plain(seen), { op: "upload", selector: "#f", files: [{ name: "a.txt", type: "text/plain", base64: "aGk=" }] });
});

test("a profile name is stored per profile and sent, URI-encoded, on every hub request", async () => {
  const env = load({ tabs: [T(1, 1, true)], store: { profileName: "Café" } });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const pulls = env.calls.hub.filter(([p]) => p === "/pull");
  assert.ok(pulls.length >= 1);
  assert.equal(pulls[0][1]["x-claude-profile"], encodeURIComponent("Café"), "the first poll already carries it");
  const r = await env.run("setProfile", { name: "  Agent\n" });
  assert.equal(r.profile, "Agent");
  assert.equal(env.store.profileName, "Agent");
  await env.run("setProfile", { name: "" });
  assert.equal("profileName" in env.store, false, "an empty name clears it");
});
