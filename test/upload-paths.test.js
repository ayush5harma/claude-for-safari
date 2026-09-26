// claude_safari_upload by `path`: the MCP stdio side reads the file on the
// caller's Mac and sends base64, so the hub (which may be hosted) never sees a
// path. The pure resolver is tested directly; the wiring runs through a real
// hub on a spare port with one fake extension instance that records what it
// was handed.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// callTool reaches the hub at BRIDGE_PORT, read when the module loads; well
// away from the real hub's 29170 so nothing here touches the user's own.
const PORT = 39000 + Math.floor(Math.random() * 900);
process.env.BRIDGE_PORT = String(PORT);
process.env.BRIDGE_TOKEN = "";
const BRIDGE = path.join(__dirname, "..", "bridge", "claude-safari-bridge.js");
const { resolveUploadPaths, checkUpload, callTool, UPLOAD_MAX_BYTES, TOOLS } = require(BRIDGE);
const HUB = `http://127.0.0.1:${PORT}`;

let dir;
const file = (name, content) => { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
// Run fn with these environment variables set (undefined removes one), then
// put them back: the resolver reads HOME and the roots at call time.
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("a path becomes inline base64 with its basename and a type from its extension", () => {
  const p = file("WikipediaSample.apk", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]));
  const r = resolveUploadPaths({ selector: "#f", files: [{ path: p }] });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.args.files, [{ name: "WikipediaSample.apk", type: "application/vnd.android.package-archive", base64: "UEsDBP8=" }]);
  assert.equal(r.args.selector, "#f");
  // What the hub then accepts is exactly those bytes.
  assert.equal(checkUpload(r.args).bytes, 5);
});

test("a caller's name and type win over the defaults, and an unknown extension gets no type", () => {
  const p = file("build.bin", "hi");
  const [named] = resolveUploadPaths({ files: [{ path: p, name: "app.apk", type: "application/x-custom" }] }).args.files;
  assert.deepEqual(named, { name: "app.apk", type: "application/x-custom", base64: "aGk=" });
  assert.equal(resolveUploadPaths({ files: [{ path: p }] }).args.files[0].type, "");
  const types = Object.fromEntries(["a.aab", "a.ipa", "a.PDF", "a.png", "a.jpg", "a.jpeg", "a.csv", "a.zip", "a.json", "a.txt"]
    .map((n) => [n, resolveUploadPaths({ files: [{ path: file(n, "x") }] }).args.files[0].type]));
  assert.deepEqual(types, { "a.aab": "application/octet-stream", "a.ipa": "application/octet-stream", "a.PDF": "application/pdf",
    "a.png": "image/png", "a.jpg": "image/jpeg", "a.jpeg": "image/jpeg", "a.csv": "text/csv", "a.zip": "application/zip",
    "a.json": "application/json", "a.txt": "text/plain" });
});

test("inline files pass through untouched, beside or without path files", () => {
  const inline = { name: "a.txt", type: "text/plain", base64: "aGk=" };
  const args = { selector: "#f", files: [inline] };
  assert.equal(resolveUploadPaths(args).args, args, "nothing to resolve: the same object");
  const mixed = resolveUploadPaths({ files: [inline, { path: file("b.txt", "yo") }] }).args.files;
  assert.deepEqual(mixed, [inline, { name: "b.txt", type: "text/plain", base64: "eW8=" }]);
});

test("a relative path, a directory, a missing file and an unreadable one are refused by name", () => {
  assert.match(resolveUploadPaths({ files: [{ path: "sample.apk" }] }).error, /absolute path.*"sample\.apk"/);
  assert.match(resolveUploadPaths({ files: [{ path: "~/sample.apk" }] }).error, /absolute path/);
  assert.match(resolveUploadPaths({ files: [{ path: 42 }] }).error, /absolute path/);
  assert.match(resolveUploadPaths({ files: [{ path: dir }] }).error, /is not a regular file/);
  assert.match(resolveUploadPaths({ files: [{ path: path.join(dir, "nope.apk") }] }).error, /no such file/);
  assert.match(resolveUploadPaths({ files: [{ path: file("both.txt", "x"), base64: "eA==" }] }).error, /not both/);
});

test("an unreadable file is refused", { skip: process.getuid && process.getuid() === 0 ? "root reads anything" : false }, () => {
  const p = file("locked.txt", "secret");
  fs.chmodSync(p, 0o000);
  try {
    assert.match(resolveUploadPaths({ files: [{ path: p }] }).error, /cannot read .*locked\.txt/);
  } finally { fs.chmodSync(p, 0o600); }
});

test("files over the cap are refused from their size, before any is read", () => {
  // Sparse: the size is real to stat, and nothing is written or read.
  const big = path.join(dir, "huge.apk");
  fs.closeSync(fs.openSync(big, "w"));
  fs.truncateSync(big, UPLOAD_MAX_BYTES + 1);
  assert.match(resolveUploadPaths({ files: [{ path: big }] }).error, /more than 24 MB decoded/);
  // The cap is on the call's total, not per file.
  const half = path.join(dir, "half.apk");
  fs.closeSync(fs.openSync(half, "w"));
  fs.truncateSync(half, UPLOAD_MAX_BYTES / 2 + 1);
  assert.match(resolveUploadPaths({ files: [{ path: half }, { path: half }] }).error, /more than 24 MB/);
});

test("a file outside the upload roots is refused, and a symlink is judged by where it points", () => {
  const allowed = path.join(dir, "roots", "allowed");
  const inside = file("roots/allowed/app.apk", "in");
  const outside = file("roots/elsewhere/secret.txt", "out");
  const link = path.join(allowed, "innocent.apk");
  fs.symlinkSync(outside, link);
  const inLink = path.join(allowed, "alias.apk");
  fs.symlinkSync(inside, inLink);
  withEnv({ CLAUDE_SAFARI_UPLOAD_ROOTS: allowed }, () => {
    assert.equal(resolveUploadPaths({ files: [{ path: inside }] }).args.files[0].base64, "aW4=");
    assert.match(resolveUploadPaths({ files: [{ path: outside }] }).error, /outside the upload roots.*CLAUDE_SAFARI_UPLOAD_ROOTS/);
    assert.match(resolveUploadPaths({ files: [{ path: link }] }).error, /outside the upload roots/,
      "a link inside a root that points out of it is refused");
    const [viaLink] = resolveUploadPaths({ files: [{ path: inLink }] }).args.files;
    assert.deepEqual([viaLink.name, viaLink.base64], ["alias.apk", "aW4="], "a link within the roots works, named as given");
  });
  // Several roots, colon-separated; a relative entry is ignored rather than
  // read against whatever the cwd is.
  withEnv({ CLAUDE_SAFARI_UPLOAD_ROOTS: "relative/dir:" + path.join(dir, "roots", "elsewhere") + ":" + allowed }, () => {
    assert.equal(resolveUploadPaths({ files: [{ path: outside }] }).error, undefined);
  });
});

test("credential locations are refused even inside a root, and through a link", () => {
  const home = path.join(dir, "fakehome");
  const ok = file("fakehome/Downloads/ok.txt", "ok");
  const denied = [file("fakehome/.ssh/id_ed25519", "k"), file("fakehome/.gnupg/secring.gpg", "k"),
    file("fakehome/.aws/credentials", "k"), file("fakehome/.mcp-auth/token.json", "k"),
    file("fakehome/.netrc", "k"), file("fakehome/Documents/age-key.txt", "k"), file("fakehome/Documents/keys/my-age-key", "k")];
  const link = path.join(home, "Downloads", "harmless.txt");
  fs.symlinkSync(path.join(home, ".ssh", "id_ed25519"), link);
  // ~/.ssh kept elsewhere (the fleet keeps SSH material in iCloud) and linked in.
  const cloud = file("cloud/ssh/id_rsa", "k");
  fs.symlinkSync(path.dirname(cloud), path.join(home, ".ssh-cloud"));
  withEnv({ HOME: home, CLAUDE_SAFARI_UPLOAD_ROOTS: home + ":" + path.join(dir, "cloud") }, () => {
    assert.equal(resolveUploadPaths({ files: [{ path: ok }] }).error, undefined);
    for (const p of [...denied, link]) {
      assert.match(resolveUploadPaths({ files: [{ path: p }] }).error || "", /credentials .*never uploaded/, p);
    }
    fs.renameSync(path.join(home, ".ssh"), path.join(home, ".ssh-local"));
    fs.symlinkSync(path.dirname(cloud), path.join(home, ".ssh"));
    try {
      assert.match(resolveUploadPaths({ files: [{ path: cloud }] }).error || "", /never uploaded/,
        "a file in the directory ~/.ssh links to is refused by its real path");
    } finally { fs.unlinkSync(path.join(home, ".ssh")); fs.renameSync(path.join(home, ".ssh-local"), path.join(home, ".ssh")); }
  });
});

test("a FIFO is refused as not a regular file, without blocking on the open", () => {
  const fifo = path.join(dir, "pipe.apk");
  execFileSync("mkfifo", [fifo]);
  assert.match(resolveUploadPaths({ files: [{ path: fifo }] }).error, /is not a regular file/);
});

test("a path that reaches the hub unresolved is refused there, never read", () => {
  assert.match(checkUpload({ selector: "#f", files: [{ path: "/etc/hosts" }] }).error, /read by the MCP server/);
});

test("the MCP side refuses a bad path without calling the hub", async () => {
  const r = await callTool("claude_safari_upload", { selector: "#f", files: [{ path: "relative.apk" }] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^Error: upload: `path` must be an absolute path/);
});

test("the upload schema takes a path or base64 per file, neither required", () => {
  const up = TOOLS.find((t) => t.name === "claude_safari_upload");
  const item = up.inputSchema.properties.files.items;
  assert.ok(item.properties.path && item.properties.base64 && item.properties.name && item.properties.type);
  assert.equal(item.required, undefined);
  assert.match(up.description, /path/);
  assert.match(up.description, /24 MB/);
});

test("the panel's MCP child refuses a path: a page-driven turn must not read this Mac's files", async () => {
  // The chat panel's headless turn talks to this same server, started with
  // --panel from chat-mcp.json; its prompt carries page text nobody vetted.
  const p = file("secret.txt", "do not upload");
  const child = spawn(process.execPath, [BRIDGE, "--panel"], { env: { ...process.env, HOME: dir }, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  const reply = new Promise((resolve) => child.stdout.on("data", (c) => { out += c; if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0])); }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "claude_safari_upload", arguments: { selector: "#f", files: [{ path: p }] } } }) + "\n");
  const msg = await reply;
  child.kill();
  assert.equal(msg.result.isError, true);
  assert.match(msg.result.content[0].text, /panel/);
});

test("a child that inherits CLAUDE_SAFARI_PANEL=1 refuses a path too, flag or not", async () => {
  const p = file("secret2.txt", "do not upload");
  const child = spawn(process.execPath, [BRIDGE], { env: { ...process.env, HOME: dir, CLAUDE_SAFARI_PANEL: "1" }, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  const reply = new Promise((resolve) => child.stdout.on("data", (c) => { out += c; if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0])); }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "claude_safari_upload", arguments: { selector: "#f", files: [{ path: p }] } } }) + "\n");
  const msg = await reply;
  child.kill();
  assert.equal(msg.result.isError, true);
  assert.match(msg.result.content[0].text, /panel/);
});

test("the hub runs the panel's claude with CLAUDE_SAFARI_PANEL=1", async () => {
  const r = await fetch(HUB + "/chat", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hi" }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).reply, "panel=1");
});

test("the hub writes the panel's MCP config with --panel", async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(home, ".cache", "claude-safari", "chat-mcp.json"), "utf8"));
  assert.deepEqual(cfg.mcpServers["claude-safari"].args.slice(1), ["--panel"]);
});

// ── Through a real hub ───────────────────────────────────────────────────────
const seen = [];
let hub, home, ctl, loop;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-upload-test-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-hub-test-"));
  // A stand-in for the claude CLI that answers a panel turn with the marker
  // it was started with.
  const fakeClaude = path.join(home, "fake-claude");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\nprintf '{\"result\":\"panel=%s\"}' \"$CLAUDE_SAFARI_PANEL\"\n", { mode: 0o755 });
  hub = spawn(process.execPath, [BRIDGE, "--serve"],
    { env: { ...process.env, HOME: home, CLAUDE_BIN: fakeClaude, BRIDGE_PORT: String(PORT), BRIDGE_BIND: "127.0.0.1", BRIDGE_TOKEN: "", BRIDGE_PANEL_TOOLS: "" },
      stdio: ["ignore", "ignore", "inherit"] });
  let exited = null;
  hub.on("exit", (code) => { exited = code; });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(HUB + "/health")).ok; } catch { await new Promise((f) => setTimeout(f, 50)); }
  }
  assert.equal(exited, null, "the spawned hub died (port taken?)");
  assert.ok(up, "hub came up on " + HUB);
  ctl = new AbortController();
  const headers = { "x-claude-instance": "inst-upload" };
  loop = (async () => {
    for (;;) {
      let r;
      try { r = await fetch(HUB + "/pull", { method: "POST", headers, signal: ctl.signal }); }
      catch { if (ctl.signal.aborted) return; await new Promise((f) => setTimeout(f, 50)); continue; }
      if (r.status !== 200) continue;
      const call = await r.json();
      seen.push(call);
      const out = call.tool === "upload"
        ? { result: { uploaded: call.args.files.map((f) => ({ name: f.name, size: Buffer.from(f.base64, "base64").length })) } }
        : { error: "unknown tool: " + call.tool };
      await fetch(HUB + "/result", { method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ id: call.id, ...out }) }).catch(() => {});
    }
  })();
  for (let i = 0; i < 100; i++) {
    const st = await (await fetch(HUB + "/status")).json();
    if (st.instances && st.instances.length === 1) break;
    await new Promise((f) => setTimeout(f, 50));
  }
});
after(async () => {
  if (ctl) ctl.abort();
  if (hub) hub.kill();
  await Promise.allSettled([loop]);
  for (const d of [dir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test("a 20 MB file by path reaches the extension as base64, with no path in the call", async () => {
  // The size of the APK that motivated this (20,373,104 bytes).
  const bytes = crypto.randomBytes(20373104);
  const p = file("WikipediaSample.apk", bytes);
  const r = await callTool("claude_safari_upload", { selector: "#apk", files: [{ path: p }] });
  assert.equal(r.isError, undefined, r.content[0].text.slice(0, 300));
  assert.deepEqual(JSON.parse(r.content[0].text), { uploaded: [{ name: "WikipediaSample.apk", size: 20373104 }] });
  const call = seen.filter((c) => c.tool === "upload").pop();
  assert.equal(call.args.selector, "#apk");
  assert.equal(call.args.files.length, 1);
  assert.deepEqual(Object.keys(call.args.files[0]).sort(), ["base64", "name", "type"]);
  assert.equal(call.args.files[0].type, "application/vnd.android.package-archive");
  assert.ok(Buffer.from(call.args.files[0].base64, "base64").equals(bytes), "the bytes arrive intact");
  assert.equal(JSON.stringify(call).includes(dir), false, "the local path never left the MCP side");
});

test("an inline upload still works end to end", async () => {
  const r = await callTool("claude_safari_upload", { selector: "#f", files: [{ name: "a.txt", type: "text/plain", base64: "aGk=" }] });
  assert.deepEqual(JSON.parse(r.content[0].text), { uploaded: [{ name: "a.txt", size: 2 }] });
});
