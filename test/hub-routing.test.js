// The hub's multi-instance routing, on the shape measured 2026-09-15 (Safari
// 27, three profiles, nine tabs): two instances listing the same tabs under
// shifted ids and a third listing nothing, each page reachable from exactly one
// of them. These are the pure pieces the bridge exports; the wiring around
// them (one parked /pull per instance, the fan-out) is exercised live by
// claude_safari_tabs against a Safari with two or more profiles.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  TAB_SLOT, SLOT_BASE, encodeTabId, decodeTabId, mergeTabListings, pickActiveSlot,
  cmpVersion, currentInstances, describeInstance,
} = require(path.join(__dirname, "..", "bridge", "claude-safari-bridge.js"));

const tab = (id, index, url, owned, extra = {}) => ({
  tabId: id, windowId: 312, index, active: false, url, title: "T " + url, favIconUrl: "", owned, ...extra,
});

test("tab ids round-trip through a slot, and the run's first slot is never 0", () => {
  assert.deepEqual(decodeTabId(encodeTabId(2, 15050)), { slot: 2, id: 15050 });
  assert.deepEqual(decodeTabId(encodeTabId(437, 29993)), { slot: 437, id: 29993 });
  assert.equal(encodeTabId(1, 7), TAB_SLOT + 7);
  // A raw Safari id (slot 0) can never be this run's, so a stale or guessed
  // one lands in the "no longer polling" branch instead of on a live profile.
  assert.ok(SLOT_BASE >= 1 && SLOT_BASE < 1000);
  assert.deepEqual(decodeTabId(29993), { slot: 0, id: 29993 });
  // Anything that is not a non-negative number passes through unchanged.
  assert.equal(encodeTabId(1, null), null);
  assert.equal(encodeTabId(1, undefined), undefined);
});

test("a single listing without ownership marks is passed through in order, ids stamped", () => {
  // What a 0.37 extension (no `owned`) returns: the hub must still hand every
  // tab out, in Safari's order, with nothing but the ids changed.
  const legacy = [{ tabId: 3, windowId: 1, active: true, url: "https://a/", title: "A", favIconUrl: "" },
    { tabId: 4, windowId: 1, active: false, url: "https://b/", title: "B", favIconUrl: "" }];
  assert.deepEqual(mergeTabListings([{ slot: 0, tabs: legacy }]), legacy);
  const stamped = mergeTabListings([{ slot: 1, tabs: legacy }]);
  assert.deepEqual(stamped.map((t) => t.tabId), [TAB_SLOT + 3, TAB_SLOT + 4]);
  assert.deepEqual(stamped.map((t) => t.windowId), [TAB_SLOT + 1, TAB_SLOT + 1]);
});

test("the measured three-profile shape: each tab once, from the instance that can reach it", () => {
  // Instance 0 numbers the tabs 324/322/29993/15050, instance 1 the same tabs
  // 325/323/29994/15051 (one higher, another window id), instance 2 sees no
  // window. Instance 0 reaches the talkback PR, instance 1 the mobile PR.
  const a = [tab(324, 0, "https://calendar/", false), tab(322, 1, "https://slack/", false),
    tab(29993, 2, "https://github.com/browserstack/mobile/pull/14167", false),
    tab(15050, 3, "https://github.com/browserstack/talkback/pull/145", true)];
  const b = [tab(325, 0, "https://calendar/", false, { windowId: 313 }), tab(323, 1, "https://slack/", false, { windowId: 313 }),
    tab(29994, 2, "https://github.com/browserstack/mobile/pull/14167", true, { windowId: 313 }),
    tab(15051, 3, "https://github.com/browserstack/talkback/pull/145", false, { windowId: 313 })];
  const merged = mergeTabListings([{ slot: 0, tabs: a }, { slot: 1, tabs: b }, { slot: 2, tabs: [] }]);
  assert.equal(merged.length, 4, "each tab exactly once");
  // Safari's order is kept (the largest listing's, the lowest slot on a tie).
  assert.deepEqual(merged.map((t) => t.url),
    ["https://calendar/", "https://slack/", "https://github.com/browserstack/mobile/pull/14167", "https://github.com/browserstack/talkback/pull/145"]);
  // The mobile PR comes from instance 1, everything else from instance 0.
  assert.deepEqual(merged.map((t) => t.tabId), [324, 322, TAB_SLOT + 29994, 15050]);
  assert.deepEqual(merged.map((t) => t.windowId), [312, 312, TAB_SLOT + 313, 312]);
  // The routing field never reaches a caller.
  for (const t of merged) assert.equal("owned" in t, false);
});

test("two windows whose first tabs show the same page are told apart by listing position", () => {
  // Both instances see window 1 then window 2, each opening on a Start Page:
  // the same index (0), url and title twice. Matching on the tab's index within
  // its window would attribute window 2's tab to window 1's owner.
  const a = [tab(10, 0, "favorites://", true, { windowId: 1 }), tab(11, 1, "https://x/", false, { windowId: 1 }),
    tab(20, 0, "favorites://", false, { windowId: 2 })];
  const b = [tab(110, 0, "favorites://", false, { windowId: 3 }), tab(111, 1, "https://x/", false, { windowId: 3 }),
    tab(120, 0, "favorites://", true, { windowId: 4 })];
  const merged = mergeTabListings([{ slot: 1, tabs: a }, { slot: 2, tabs: b }]);
  assert.deepEqual(merged.map((t) => t.tabId), [TAB_SLOT + 10, TAB_SLOT + 11, 2 * TAB_SLOT + 120]);
});

test("an owned tab only a smaller listing saw is appended, not lost", () => {
  const big = [tab(1, 0, "https://a/", false), tab(2, 1, "https://b/", false)];
  const small = [tab(9, 0, "https://c/", true)];
  const merged = mergeTabListings([{ slot: 0, tabs: big }, { slot: 1, tabs: small }]);
  assert.deepEqual(merged.map((t) => t.tabId), [1, 2, TAB_SLOT + 9]);
});

test("empty and malformed listings merge to nothing", () => {
  assert.deepEqual(mergeTabListings([]), []);
  assert.deepEqual(mergeTabListings([{ slot: 0, tabs: null }, null]), []);
});

test("the active-tab call goes to the owner, else to an instance that sees a tab, else the lowest slot", () => {
  assert.equal(pickActiveSlot([{ slot: 0, probe: { tabId: 5, owned: false } }, { slot: 1, probe: { tabId: 6, owned: true } }]), 1);
  assert.equal(pickActiveSlot([{ slot: 0, probe: { tabId: null, owned: false } }, { slot: 1, probe: { tabId: 6, owned: false } }]), 1);
  assert.equal(pickActiveSlot([{ slot: 2, probe: null }, { slot: 1, probe: null }]), 1);
  // An instance that did not answer the probe (an old build, a timeout) never
  // beats one that did.
  assert.equal(pickActiveSlot([{ slot: 0, probe: null }, { slot: 3, probe: { tabId: 1, owned: false } }]), 3);
  assert.equal(pickActiveSlot([]), null);
});

test("versions compare component by component, so 0.40 is newer than 0.9", () => {
  // This project numbers 0.37, 0.38, 0.39, 0.40 -- a string compare would call
  // 0.9 the newest of those.
  assert.equal(cmpVersion("0.40", "0.9") > 0, true);
  assert.equal(cmpVersion("0.37", "0.41") < 0, true);
  assert.equal(cmpVersion("0.41", "0.41"), 0);
  assert.equal(cmpVersion("1.0", "0.99") > 0, true);
  assert.equal(cmpVersion("", "0.41") < 0, true);
});

test("only contexts running the newest version a live one reports may take a call", () => {
  const i = (slot, version) => ({ slot, version, base: "safari-web-extension://" + slot + "/" });
  const live = [i(1, "0.37"), i(2, "0.41"), i(3, "0.41")];
  assert.deepEqual(currentInstances(live).map((x) => x.slot), [2, 3]);
  // An extension too old to report a version cannot be the newest -- but if
  // NOBODY reports one, every instance stays eligible rather than none.
  assert.deepEqual(currentInstances([i(1, ""), i(2, "0.41")]).map((x) => x.slot), [2]);
  assert.deepEqual(currentInstances([i(1, ""), i(2, "")]).map((x) => x.slot), [1, 2]);
  assert.deepEqual(currentInstances([]), []);
});

test("a refusal names the slot, the build and the context diag reports", () => {
  assert.equal(describeInstance({ slot: 460, version: "0.41", base: "safari-web-extension://7A6C/" }),
    "slot 460 (version 0.41, safari-web-extension://7A6C/)");
  assert.equal(describeInstance({ slot: 3, version: "", base: "" }), "slot 3 (version unknown)");
});
