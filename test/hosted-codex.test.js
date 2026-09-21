// The hosted Codex path, with a fake CLI at the process boundary. This proves
// the measured 2026-09-22 contract without spending API usage: the hub gates
// Codex explicitly, forwards selected Safari context, scopes CODEX_API_KEY to
// the child, parses JSONL, and returns the resumable thread id.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BRIDGE = path.join(__dirname, "..", "bridge", "claude-safari-bridge.js");

test("hosted Codex receives an explicitly selected turn and returns its thread", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-codex-test-"));
  const fake = path.join(home, "codex");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const prompt = process.argv.at(-1) || "";
if (prompt.includes("force-error")) {
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"partial output must not become success"}}));
  console.log(JSON.stringify({type:"error",message:"simulated auth failure"}));
  process.exit(1);
}
const ok = process.env.CODEX_API_KEY === "scoped-test-key" &&
  !process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.BRIDGE_TOKEN &&
  process.argv.includes("--ignore-user-config") &&
  !process.argv.some((arg) => arg.includes("mcp_servers")) &&
  prompt.includes("PAGE TEXT") && prompt.includes("selected page words") &&
  prompt.includes("attached tab words");
console.log(JSON.stringify({type:"thread.started",thread_id:"0199abcd-1234-7890-abcd-1234567890ab"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:ok ? "context received" : "context missing"}}));
`);
  fs.chmodSync(fake, 0o755);
  const port = 41000 + Math.floor(Math.random() * 1000);
  const hub = spawn(process.execPath, [BRIDGE, "--serve"], {
    env: { ...process.env, HOME: home, BRIDGE_PORT: String(port), BRIDGE_BIND: "127.0.0.1",
      BRIDGE_TOKEN: "bridge-test-token", BRIDGE_CODEX_PANEL: "1", CODEX_BIN: fake,
      CODEX_API_KEY: "scoped-test-key", CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  t.after(() => { hub.kill(); fs.rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: "Bearer bridge-test-token" };
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health", { headers })).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const health = await (await fetch(base + "/health", { headers })).json();
  assert.equal(health.providers.codex, true);
  const response = await fetch(base + "/chat", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ provider: "codex", prompt: "summarise", model: "gpt-6-astra",
      page: { url: "https://example.test", title: "Selected", text: "selected page words" },
      tabs: [{ url: "https://tab.test", title: "Attached", text: "attached tab words" }] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reply: "context received",
    sessionId: "0199abcd-1234-7890-abcd-1234567890ab",
  });

  const failed = await fetch(base + "/chat", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ provider: "codex", prompt: "force-error" }),
  });
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).error, /simulated auth failure/);
});

test("a remote hub without a Codex API key does not advertise Codex", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-codex-readiness-"));
  const fake = path.join(home, "codex");
  fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(fake, 0o755);
  const port = 42000 + Math.floor(Math.random() * 1000);
  const env = { ...process.env, HOME: home, BRIDGE_PORT: String(port), BRIDGE_BIND: "0.0.0.0",
    BRIDGE_TOKEN: "bridge-test-token", BRIDGE_CODEX_PANEL: "1", CODEX_BIN: fake };
  delete env.CODEX_API_KEY;
  const hub = spawn(process.execPath, [BRIDGE, "--serve"], {
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  t.after(() => { hub.kill(); fs.rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: "Bearer bridge-test-token" };
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health", { headers })).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const health = await (await fetch(base + "/health", { headers })).json();
  assert.equal(health.codexEnabled, false);
  assert.equal(health.providers.codex, false);
});
