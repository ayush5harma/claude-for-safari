// Which port the bridge uses, per mode. Found 2026-11-18: a Rails dev shell
// exports PORT=3003 (direnv), every Claude Code started in that repo inherited
// it, and the stdio MCP child -- which read bare PORT like the hub does --
// looked for its hub on :3003, spawned one there that no extension polls, and
// answered every claude_safari_* call with "Safari extension did not respond"
// while the real hub on :29170 and the extension were both healthy.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { resolvePort, DEFAULT_PORT } = require(path.join(__dirname, "..", "bridge", "claude-safari-bridge.js"));

test("the default port is 29170, the one the extension polls", () => {
  assert.equal(DEFAULT_PORT, 29170);
  assert.equal(resolvePort({}, false), 29170);
  assert.equal(resolvePort({}, true), 29170);
});

test("the MCP child ignores a bare PORT from the shell it inherited", () => {
  assert.equal(resolvePort({ PORT: "3003" }, false), 29170);
});

test("the hub honours a PaaS PORT (Heroku's router)", () => {
  assert.equal(resolvePort({ PORT: "51234" }, true), 51234);
});

test("BRIDGE_PORT wins in both modes", () => {
  assert.equal(resolvePort({ BRIDGE_PORT: "39001", PORT: "3003" }, false), 39001);
  assert.equal(resolvePort({ BRIDGE_PORT: "39001", PORT: "3003" }, true), 39001);
});

test("an empty or non-numeric value falls back to the default", () => {
  assert.equal(resolvePort({ BRIDGE_PORT: "" }, false), 29170);
  assert.equal(resolvePort({ BRIDGE_PORT: "abc", PORT: "x" }, true), 29170);
});
