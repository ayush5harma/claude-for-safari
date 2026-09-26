// claude_safari_upload by `path`: the MCP stdio side reads the file on the
// caller's Mac and sends base64, so the hub (which may be hosted) never sees a
// path. The pure resolver is tested directly; the wiring runs through a real
// hub on a spare port with one fake extension instance that records what it
// was handed.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
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
const file = (name, content) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; };

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
  assert.match(resolveUploadPaths({ files: [{ path: big }] }).error, /more than 48 MB decoded/);
  // The cap is on the call's total, not per file.
  const half = path.join(dir, "half.apk");
  fs.closeSync(fs.openSync(half, "w"));
  fs.truncateSync(half, UPLOAD_MAX_BYTES / 2 + 1);
  assert.match(resolveUploadPaths({ files: [{ path: half }, { path: half }] }).error, /more than 48 MB/);
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
  assert.match(up.description, /48 MB/);
});

// ── Through a real hub ───────────────────────────────────────────────────────
const seen = [];
let hub, home, ctl, loop;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-upload-test-"));
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
