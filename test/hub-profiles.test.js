// The hub's half of background agent work (0.43): profiles as a routing key,
// windows pinned like tabs, the derived window title, the upload cap and the
// MCP schemas. Pure pieces the bridge exports; the wiring is covered end to
// end in hub-e2e.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  TAB_SLOT, mergeTabListings, cleanProfile, sameProfile, pinRoute, checkUpload, UPLOAD_MAX_BYTES, TOOLS, callTool,
} = require(path.join(__dirname, "..", "bridge", "claude-safari-bridge.js"));

const tab = (id, index, url, owned, extra = {}) => ({
  tabId: id, windowId: 312, index, active: false, url, title: "T " + url, favIconUrl: "", owned, ...extra,
});
const inst = (slot, profile, version = "0.43") => ({ slot, profile, version, base: "safari-web-extension://" + slot + "/" });

test("each tab carries its profile, and a windowTitle built the way Safari titles the window", () => {
  // Safari 27 names a window "<profile> — <showing tab's title>" (read over
  // AppleScript, 2026-09-26: "Personal — Start Page").
  const personal = [tab(1, 0, "https://a/", true, { active: true }), tab(2, 1, "https://b/", false)];
  const agent = [tab(7, 0, "https://example.com/", true, { windowId: 90 }),
    tab(8, 1, "https://en.wikipedia.org/", true, { windowId: 90, active: true })];
  const merged = mergeTabListings([{ slot: 1, profile: "Personal", tabs: personal }, { slot: 2, profile: "Agent", tabs: agent }]);
  assert.deepEqual(merged.map((t) => t.profile), ["Personal", "Personal", "Agent", "Agent"]);
  assert.deepEqual(merged.map((t) => t.windowTitle),
    ["Personal — T https://a/", "Personal — T https://a/",
      "Agent — T https://en.wikipedia.org/", "Agent — T https://en.wikipedia.org/"]);
  assert.deepEqual(merged.map((t) => t.windowId), [TAB_SLOT + 312, TAB_SLOT + 312, 2 * TAB_SLOT + 90, 2 * TAB_SLOT + 90]);
});

test("a tab two copies list and neither reaches gets no profile, rather than a guess", () => {
  // The 2026-09-15 shape: both copies list the same window. Only the owned
  // tab's profile is known; the unloaded one could be either's.
  const a = [tab(1, 0, "https://owned-by-a/", true, { active: true }), tab(2, 1, "https://nobody/", false)];
  const b = [tab(11, 0, "https://owned-by-a/", false, { windowId: 313, active: true }), tab(12, 1, "https://nobody/", false, { windowId: 313 })];
  const merged = mergeTabListings([{ slot: 1, profile: "Personal", tabs: a }, { slot: 2, profile: "Work", tabs: b }]);
  assert.deepEqual(merged.map((t) => [t.url, t.profile]), [["https://owned-by-a/", "Personal"], ["https://nobody/", null]]);
});

test("the MCP side refuses a name that is not one of its tools, such as the hub's setProfile", async () => {
  const r = await callTool("claude_safari_setProfile", { name: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unknown tool claude_safari_setProfile/);
});

test("profile names are cleaned from the header and matched as a person types them", () => {
  assert.equal(cleanProfile("Agent"), "Agent");
  assert.equal(cleanProfile(encodeURIComponent("  Café Work ")), "Café Work");
  assert.equal(cleanProfile("%E0%A4%A"), "%E0%A4%A", "a malformed escape is kept as sent, not thrown");
  assert.equal(cleanProfile("a\u0000b\nc"), "abc");
  assert.equal(cleanProfile(""), null);
  assert.equal(cleanProfile("x".repeat(99)).length, 40);
  assert.equal(sameProfile("agent ", "Agent"), true);
  assert.equal(sameProfile(null, "Agent"), false);
});

test("a profile routes to the copy carrying that name, and an unknown one is refused with the fix", () => {
  const live = [inst(5, "Personal"), inst(6, "Agent"), inst(7, null)];
  const r = pinRoute({ profile: "agent", url: "https://example.com/" }, live, live);
  assert.deepEqual(r.pool.map((i) => i.slot), [6]);
  assert.equal(r.args.url, "https://example.com/");
  const none = pinRoute({ profile: "Scratch" }, live, live);
  assert.match(none.error, /no Safari extension instance is named profile "Scratch"/);
  assert.match(none.error, /slot 5 profile "Personal", slot 6 profile "Agent", slot 7 unnamed/);
  assert.match(none.error, /setProfile/);
});

test("a windowId pins the call like a tabId, and the instance gets Safari's raw ids", () => {
  const live = [inst(5, "Personal"), inst(6, "Agent")];
  const w = pinRoute({ windowId: 6 * TAB_SLOT + 44, newTab: true }, live, live);
  assert.equal(w.inst.slot, 6);
  assert.equal(w.args.windowId, 44);
  const both = pinRoute({ tabId: 6 * TAB_SLOT + 3, windowId: 6 * TAB_SLOT + 44 }, live, live);
  assert.deepEqual([both.inst.slot, both.args.tabId, both.args.windowId], [6, 3, 44]);
  // Two ids from two profiles, or an id outside the named profile, never run.
  assert.match(pinRoute({ tabId: 5 * TAB_SLOT + 3, windowId: 6 * TAB_SLOT + 44 }, live, live).error, /different/);
  assert.match(pinRoute({ tabId: 5 * TAB_SLOT + 3, profile: "Agent" }, live, live).error,
    /tab \d+ is in profile "Personal", not profile "Agent"/);
  // The refusals the hub has always given for a tab id keep their wording.
  assert.match(pinRoute({ windowId: 9 * TAB_SLOT + 1 }, live, live).error, /^window \d+ was listed by .*no longer polling/);
  assert.match(pinRoute({ tabId: 5 * TAB_SLOT + 3 }, live, [live[1]]).error, /superseded/);
  // No pin, no profile: every current copy stays in the pool.
  assert.deepEqual(pinRoute({}, live, live).pool.map((i) => i.slot), [5, 6]);
});

test("an upload is checked and capped before it is sent anywhere", () => {
  const ok = checkUpload({ selector: "#f", files: [{ name: "a.txt", type: "text/plain", base64: "aGVsbG8=" }] });
  assert.equal(ok.bytes, 5);
  assert.deepEqual(ok.files, [{ name: "a.txt", type: "text/plain", base64: "aGVsbG8=" }]);
  // A data: URL is accepted and reduced to its base64.
  assert.equal(checkUpload({ selector: "#f", files: [{ name: "a", base64: "data:text/plain;base64,aGk=" }] }).files[0].base64, "aGk=");
  assert.match(checkUpload({ files: [] }).error, /selector/);
  assert.match(checkUpload({ selector: "#f", files: [] }).error, /non-empty/);
  assert.match(checkUpload({ selector: "#f", files: [{ name: "a", base64: "not base64!" }] }).error, /not valid base64/);
  assert.match(checkUpload({ selector: "#f", files: [{ base64: "aGk=" }] }).error, /name/);
  const big = "A".repeat(Math.ceil((UPLOAD_MAX_BYTES + 3) / 3) * 4);
  assert.match(checkUpload({ selector: "#f", files: [{ name: "big", base64: big }] }).error, /MB decoded/);
  assert.match(checkUpload({ selector: "#f", files: Array.from({ length: 11 }, (_, i) => ({ name: "f" + i, base64: "" })) }).error,
    /at most 10/);
});

test("the MCP schemas carry the new arguments and the upload tool", () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t.inputSchema.properties]));
  for (const n of ["claude_safari_read", "claude_safari_click", "claude_safari_fill", "claude_safari_eval", "claude_safari_upload"]) {
    assert.ok(byName[n].frameId && byName[n].frameUrl && byName[n].profile, n + " takes a frame and a profile");
  }
  assert.ok(byName.claude_safari_navigate.windowId && byName.claude_safari_navigate.active && byName.claude_safari_navigate.profile);
  assert.ok(byName.claude_safari_screenshot.force);
  assert.ok(byName.claude_safari_eval.timeoutMs);
  assert.deepEqual(TOOLS.find((t) => t.name === "claude_safari_upload").inputSchema.required, ["selector", "files"]);
});
