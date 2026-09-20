// The hub end to end, with three fake extension instances standing in for
// three Safari profiles: the shape measured 2026-09-15. Each instance is a
// long-poll loop answering `tabs`, `probeActive`, `toggleActive` and `eval`
// from a small model of what it sees and what it can reach. The hub is the
// real one, spawned on a spare port with HOME pointed at a scratch directory
// so its start-up files (the panel's MCP config) land nowhere real.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BRIDGE = path.join(__dirname, "..", "bridge", "claude-safari-bridge.js");
const { TAB_SLOT } = require(BRIDGE);
// Well away from the real hub's 29170: a collision there would register these
// fakes on the user's own hub. The child's exit is watched for the same reason.
const PORT = 39000 + Math.floor(Math.random() * 900);
const HUB = `http://127.0.0.1:${PORT}`;

const tab = (id, index, url, owned, windowId) =>
  ({ tabId: id, windowId, index, active: index === 1, url, title: "T " + url, favIconUrl: "", owned });

// What each instance sees. A and B see the same three tabs under shifted ids
// (A: 324/15050/29993 in window 312; B: 325/15051/29994 in window 313); A
// reaches the talkback PR (the active tab), B the mobile PR; C has no window.
const MODELS = {
  // The two contexts of the last tests: the build the app now holds, and a
  // copy an update superseded that Safari is still running.
  NEW: { tabs: [tab(900, 1, "https://new-context/", true, 700)] },
  OLD: { tabs: [tab(800, 1, "https://superseded-context/", true, 701)] },
  TWIN: { tabs: [tab(700, 1, "https://twin/", true, 702)] },
  A: {
    tabs: [tab(324, 0, "https://calendar/", false, 312),
      tab(15050, 1, "https://github.com/browserstack/talkback/pull/145", true, 312),
      tab(29993, 2, "https://github.com/browserstack/mobile/pull/14167", false, 312)],
  },
  B: {
    tabs: [tab(325, 0, "https://calendar/", false, 313),
      tab(15051, 1, "https://github.com/browserstack/talkback/pull/145", false, 313),
      tab(29994, 2, "https://github.com/browserstack/mobile/pull/14167", true, 313)],
  },
  C: { tabs: [] },
};
const served = { A: [], B: [], C: [], NEW: [], OLD: [], TWIN: [] };   // which calls each instance answered

function model(name, tool, args) {
  const m = MODELS[name];
  served[name].push({ tool, tabId: args.tabId });
  const active = m.tabs.find((t) => t.active) || null;
  const reach = (id) => { const t = m.tabs.find((x) => x.tabId === id); if (!t) throw new Error("Invalid call to tabs.get(). Tab not found."); return t; };
  if (m.fail) throw new Error("simulated: cannot run in this tab");
  switch (tool) {
    case "tabs": return m.tabs;
    case "probeActive": return active ? { tabId: active.tabId, owned: active.owned } : { tabId: null, owned: false };
    case "toggleActive": return { handled: !!(active && active.owned) };
    case "eval": {
      const t = args.tabId != null ? reach(args.tabId) : active;
      if (!t) throw new Error("no active Safari tab");
      if (!t.owned) throw new Error("content script did not answer after injection (Safari-internal or blocked page?)");
      return { tabId: t.tabId, value: "ran in " + t.url + " via " + name };
    }
    default: throw new Error("unknown tool: " + tool);
  }
}

const instances = [];
// `opts` is what an extension puts in its headers: the id it persists, and
// (since 0.41) the context's base URL and the build it runs. Two loops sharing
// one id is the measured case of a profile running a second context after a
// bundle was replaced under it.
function startInstance(name, opts = {}) {
  const ctl = new AbortController();
  const headers = { "x-claude-instance": opts.id || "inst-" + name };
  if (opts.base) headers["x-claude-base"] = opts.base;
  if (opts.version) headers["x-claude-version"] = opts.version;
  let polls = 0;
  const self = { ctl, name, polls: () => polls };
  const loop = (async () => {
    for (;;) {
      let r;
      try {
        polls += 1;
        r = await fetch(HUB + "/pull", { method: "POST", headers, signal: ctl.signal });
      } catch (e) { if (ctl.signal.aborted) return; await new Promise((f) => setTimeout(f, 50)); continue; }
      if (r.status !== 200) continue;
      const call = await r.json();
      let out;
      try { out = { result: model(name, call.tool, call.args || {}) }; } catch (e) { out = { error: e.message }; }
      await fetch(HUB + "/result", { method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ id: call.id, ...out }) }).catch(() => {});
    }
  })();
  self.loop = loop;
  instances.push(self);
  return self;
}

// Wait until the hub's instance list satisfies `ok`, or give up.
async function waitForStatus(ok, tries = 100) {
  let st = null;
  for (let i = 0; i < tries; i++) {
    st = await (await fetch(HUB + "/status")).json();
    if (ok(st)) return st;
    await new Promise((f) => setTimeout(f, 50));
  }
  return st;
}

async function call(tool, args = {}) {
  const r = await fetch(HUB + "/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, args }) });
  return { status: r.status, body: await r.json() };
}

let hub, home;
before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-hub-test-"));
  hub = spawn(process.execPath, [BRIDGE, "--serve"],
    { env: { ...process.env, HOME: home, BRIDGE_PORT: String(PORT), BRIDGE_BIND: "127.0.0.1", BRIDGE_TOKEN: "", BRIDGE_PANEL_TOOLS: "" },
      stdio: ["ignore", "ignore", "inherit"] });
  let exited = null;
  hub.on("exit", (code) => { exited = code; });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(HUB + "/health")).ok; } catch { await new Promise((f) => setTimeout(f, 50)); }
  }
  assert.equal(exited, null, "the spawned hub died (port taken?) -- /health would be answering for someone else");
  assert.ok(up, "hub came up on " + HUB);
  // Start in reverse so the slots are not simply alphabetical.
  for (const n of ["C", "B", "A"]) startInstance(n);
  // Every instance parked once => all three are live.
  for (let i = 0; i < 100; i++) {
    const st = await (await fetch(HUB + "/status")).json();
    if (st.instances && st.instances.length === 3) break;
    await new Promise((f) => setTimeout(f, 50));
  }
});
after(async () => {
  for (const i of instances) i.ctl.abort();
  hub.kill();
  await Promise.allSettled(instances.map((i) => i.loop));
  fs.rmSync(home, { recursive: true, force: true });
});

test("status shows one row per polling instance", async () => {
  const st = await (await fetch(HUB + "/status")).json();
  assert.equal(st.instances.length, 3);
  const slots = st.instances.map((i) => i.slot);
  assert.ok(slots[0] >= 1, "the first slot is never 0 (a raw Safari id must not route)");
  assert.deepEqual(slots, [slots[0], slots[0] + 1, slots[0] + 2]);
});

test("Codex chat is absent unless this Mac explicitly enables it", async () => {
  const health = await (await fetch(HUB + "/health")).json();
  assert.equal(health.codexEnabled, false);
  const r = await fetch(HUB + "/chat", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "codex", prompt: "Hello" }) });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /unavailable/);
});

test("tabs merges the three listings: each tab once, from the instance that reaches it", async () => {
  const { body } = await call("tabs");
  const tabs = body.result;
  assert.equal(tabs.length, 3);
  assert.deepEqual(tabs.map((t) => t.url), ["https://calendar/",
    "https://github.com/browserstack/talkback/pull/145", "https://github.com/browserstack/mobile/pull/14167"]);
  // Which slot each instance got depends on who parked first; recover it from
  // the ids the merged list carries and check the SHAPE: the two owned tabs
  // come from different slots, and each id decodes to that instance's number.
  const slotOf = (t) => Math.floor(t.tabId / TAB_SLOT);
  const talkback = tabs[1], mobile = tabs[2];
  assert.notEqual(slotOf(talkback), slotOf(mobile), "owned by different instances");
  assert.equal(talkback.tabId % TAB_SLOT, 15050, "talkback is A's 15050");
  assert.equal(mobile.tabId % TAB_SLOT, 29994, "mobile is B's 29994");
  for (const t of tabs) { assert.equal("owned" in t, false); assert.equal("index" in t, false); }
});

test("a pinned tabId routes to the instance that numbered it, and comes back stamped", async () => {
  const { body } = await call("tabs");
  const mobile = body.result[2];
  const before = served.B.length;
  const r = await call("eval", { tabId: mobile.tabId, code: "1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.value, "ran in https://github.com/browserstack/mobile/pull/14167 via B");
  assert.equal(r.body.result.tabId, mobile.tabId, "the result's tabId is the caller's id, not B's raw one");
  assert.equal(served.B.length, before + 1, "B answered it");
  assert.equal(served.B[served.B.length - 1].tabId, 29994, "B saw its own id");
});

test("a call with no tabId goes to the instance that owns the active tab", async () => {
  const beforeA = served.A.filter((c) => c.tool === "eval").length;
  const r = await call("eval", { code: "1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.value, "ran in https://github.com/browserstack/talkback/pull/145 via A");
  assert.equal(served.A.filter((c) => c.tool === "eval").length, beforeA + 1);
});

test("a tabId from a slot nobody polls is refused with a hint, not run in the wrong tab", async () => {
  const st = await (await fetch(HUB + "/status")).json();
  const stale = (Math.max(...st.instances.map((i) => i.slot)) + 5) * TAB_SLOT + 29993;
  const r = await call("eval", { tabId: stale, code: "1" });
  assert.equal(r.status, 200);
  assert.match(r.body.error, /no longer polling.*claude_safari_tabs again/);
  // A raw Safari id (slot 0) is refused the same way, never tried on a profile.
  const r0 = await call("eval", { tabId: 29993, code: "1" });
  assert.match(r0.body.error, /no longer polling/);
  assert.equal(served.A.concat(served.B, served.C).filter((c) => c.tabId === 29993).length, 0);
});

test("every instance failing tabs is reported as the error, not as an empty Safari", async () => {
  for (const n of ["A", "B", "C"]) MODELS[n].fail = true;
  try {
    const { body } = await call("tabs");
    assert.equal(body.result, undefined);
    assert.match(body.error, /simulated/);
  } finally { for (const n of ["A", "B", "C"]) delete MODELS[n].fail; }
});

test("a result posted by an instance the call was not routed to is refused", async () => {
  const r = await fetch(HUB + "/result", { method: "POST", headers: { "content-type": "application/json", "x-claude-instance": "inst-Z" },
    body: JSON.stringify({ id: "not-a-real-call" }) });
  assert.equal(r.status, 200, "an unknown id is simply ignored");
});

test("a relayed toolbar click is handled by the instance that owns the active tab", async () => {
  // C clicks (it owns nothing); A owns the active tab and toggles.
  const r = await fetch(HUB + "/relay", { method: "POST", headers: { "content-type": "application/json", "x-claude-instance": "inst-C" },
    body: JSON.stringify({ tool: "toggleActive", args: {} }) });
  assert.deepEqual(await r.json(), { handled: true });
  // A's relay asks only the OTHERS: B and C own nothing, so nobody handles it
  // and A would go on to inject.
  const r2 = await fetch(HUB + "/relay", { method: "POST", headers: { "content-type": "application/json", "x-claude-instance": "inst-A" },
    body: JSON.stringify({ tool: "toggleActive", args: {} }) });
  assert.deepEqual(await r2.json(), { handled: false });
});

// ── Two contexts of one profile, and a build that superseded one ─────────────
// These start extra instances and leave them polling, so they run last.

test("two contexts polling under one id get a slot each, instead of releasing each other's park", async () => {
  // storage.local is per profile, so before 0.41 both contexts of a profile
  // sent the same id. The hub kept one parked /pull per id: the second park
  // released the first with 204, the released copy re-polled at once, and the
  // pair spun. Splitting them apart also keeps their tab numbering apart.
  const before = (await (await fetch(HUB + "/status")).json()).instances.length;
  const one = startInstance("TWIN", { id: "shared-id" });
  const two = startInstance("TWIN", { id: "shared-id" });
  const st = await waitForStatus((s) => s.instances.length >= before + 2);
  assert.equal(st.instances.length, before + 2, "two slots, not one");
  const parkedPolls = one.polls() + two.polls();
  await new Promise((f) => setTimeout(f, 300));
  assert.ok(one.polls() + two.polls() <= parkedPolls,
    "both parks hold; neither copy is being released and re-polling");
  assert.equal(st.instances.filter((i) => i.parked).length, before + 2, "every instance is parked");
});

test("a call is never routed to a context a newer build has superseded", async () => {
  startInstance("OLD", { id: "ctx-old", base: "safari-web-extension://OLD/", version: "0.37" });
  startInstance("NEW", { id: "ctx-new", base: "safari-web-extension://NEW/", version: "0.41" });
  const st = await waitForStatus((s) => s.instances.some((i) => i.version === "0.41") &&
    s.instances.some((i) => i.version === "0.37"));
  const oldRow = st.instances.find((i) => i.version === "0.37");
  const newRow = st.instances.find((i) => i.version === "0.41");
  assert.equal(newRow.current, true);
  assert.equal(oldRow.current, false, "the superseded context is not one a call may be routed to");

  // A call naming no tab goes to the newest build, never to the old copy --
  // which is where "unknown tool: diag" came from on the Mac this was measured
  // on: an older build answering an op it does not have.
  const servedOld = served.OLD.length;
  const r = await call("eval", { code: "1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.result.value, /via NEW$/);
  assert.equal(served.OLD.length, servedOld, "the superseded copy answered nothing");
});

test("a tab id the superseded context minted is refused by name, not run there", async () => {
  const st = await (await fetch(HUB + "/status")).json();
  const oldRow = st.instances.find((i) => i.version === "0.37");
  const servedOld = served.OLD.length;
  const r = await call("eval", { tabId: oldRow.slot * TAB_SLOT + 800, code: "1" });
  assert.equal(r.status, 200);
  assert.match(r.body.error, /superseded/);
  assert.match(r.body.error, /version 0\.37/, "the refusal names the build");
  assert.match(r.body.error, /safari-web-extension:\/\/OLD\//, "and the context, as diag reports it");
  assert.match(r.body.error, /version 0\.41/, "and what is live instead");
  assert.equal(served.OLD.length, servedOld, "nothing ran in the old copy's tab");
});

test("a pre-0.35 GET /pull is held, then refused, and an abandoned one costs nothing", async () => {
  // The hold is what turns a stale build's unbacked poll loop (287 GET/s
  // measured) into one request every few seconds. It must still ANSWER -- the
  // timer is cleared on the request's close, and node emits that only after
  // the response ends for a client that waits (measured on node 24), so a
  // waiting client gets its 403 and an aborted one leaves no timer behind.
  const t0 = Date.now();
  const r = await fetch(HUB + "/pull");
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /POST-only/);
  assert.ok(Date.now() - t0 >= 2500, "it was held, not answered at once");

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(fetch(HUB + "/pull", { signal: ac.signal }));
  // The hub is still serving: a hold that had crashed on its own write would
  // show up here.
  assert.equal((await (await fetch(HUB + "/health")).json()).ok, true);
});

test("the merged tab listing leaves out a superseded context's tabs", async () => {
  const { body } = await call("tabs");
  assert.ok(body.result.some((t) => t.url === "https://new-context/"));
  assert.equal(body.result.some((t) => t.url === "https://superseded-context/"), false);
});
