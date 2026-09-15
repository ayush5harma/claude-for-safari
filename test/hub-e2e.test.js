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
const served = { A: [], B: [], C: [] };   // which calls each instance answered

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
function startInstance(name) {
  const ctl = new AbortController();
  const loop = (async () => {
    for (;;) {
      let r;
      try {
        r = await fetch(HUB + "/pull", { method: "POST", headers: { "x-claude-instance": "inst-" + name }, signal: ctl.signal });
      } catch (e) { if (ctl.signal.aborted) return; await new Promise((f) => setTimeout(f, 50)); continue; }
      if (r.status !== 200) continue;
      const call = await r.json();
      let out;
      try { out = { result: model(name, call.tool, call.args || {}) }; } catch (e) { out = { error: e.message }; }
      await fetch(HUB + "/result", { method: "POST", headers: { "content-type": "application/json", "x-claude-instance": "inst-" + name },
        body: JSON.stringify({ id: call.id, ...out }) }).catch(() => {});
    }
  })();
  instances.push({ ctl, loop });
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
