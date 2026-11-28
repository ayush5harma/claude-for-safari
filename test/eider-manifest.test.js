// The Eider install manifest (bridge/eider-manifest.js): the validators and
// the plist on their own, then the route on a real hub spawned on a spare port
// with HOME in a scratch directory. The secret and every value are synthetic.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const BRIDGE = path.join(__dirname, "..", "bridge", "claude-safari-bridge.js");
const eider = require(path.join(__dirname, "..", "bridge", "eider-manifest.js"));

const BRIDGE_TOKEN = "bridge-token-for-eider-tests-01";
const SECRET = "0123456789abcdef0123456789abcdef";
const IPA = "https://192.168.1.50:61901/" + "ab".repeat(16) + "/app.ipa";
const GOOD = { bundle: "dev.example.eider", version: "0.1.10", title: "Eider", url: IPA };
const qs = (o) => new URLSearchParams(o).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Validation and rendering ─────────────────────────────────────────────────
test("parseQuery accepts the four fields once each and nothing else", () => {
  assert.deepEqual(eider.parseQuery(qs(GOOD)), { ok: true, value: GOOD });
  for (const k of Object.keys(GOOD)) {
    const { [k]: _, ...rest } = GOOD;
    assert.match(eider.parseQuery(qs(rest)).error, new RegExp(k + " is required"));
  }
  assert.match(eider.parseQuery(qs(GOOD) + "&bundle=x").error, /more than once/);
  assert.match(eider.parseQuery(qs(GOOD) + "&extra=1").error, /unknown parameter/);
});

test("parseQuery refuses a bad bundle, version or title", () => {
  const bad = (over) => eider.parseQuery(qs({ ...GOOD, ...over })).ok;
  for (const bundle of ["", "a b", "a/b", "a_b", "a".repeat(256), "dev.example.eider\n"]) assert.equal(bad({ bundle }), false, bundle);
  assert.equal(bad({ bundle: "A-1.b".padEnd(255, "x") }), true);
  for (const v of ["", "1\n0", "1\u0000", "x".repeat(201), "​1", "￾"]) {
    assert.equal(bad({ version: v }), false, JSON.stringify(v));
    assert.equal(bad({ title: v }), false, JSON.stringify(v));
  }
  // Spaces, punctuation and non-Latin text are printable; 200 code points is the cap.
  assert.equal(bad({ title: "Eider <beta> & \"friends\" 'x' éन" }), true);
  assert.equal(bad({ title: "\u{1F426}".repeat(200) }), true);
});

test("the IPA url must be https, a private or loopback IPv4 literal, an explicit port and /<32 hex>/app.ipa", () => {
  const ok = (url) => eider.ipaUrlProblem(url) === null;
  const hex = "0123456789abcdef".repeat(2);
  for (const host of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.50", "100.64.0.1", "100.127.255.1", "127.0.0.1"]) {
    assert.ok(ok(`https://${host}:61901/${hex}/app.ipa`), host);
  }
  for (const url of [
    `https://8.8.8.8:443/${hex}/app.ipa`,            // public
    `https://172.32.0.1:443/${hex}/app.ipa`,         // just past 172.16/12
    `https://172.15.0.1:443/${hex}/app.ipa`,
    `https://100.128.0.1:443/${hex}/app.ipa`,        // just past 100.64/10
    `https://100.63.0.1:443/${hex}/app.ipa`,
    `https://192.169.0.1:443/${hex}/app.ipa`,
    `https://169.254.1.1:443/${hex}/app.ipa`,        // link-local is not in the list
    `http://192.168.1.50:61901/${hex}/app.ipa`,      // not https
    `https://192.168.1.50/${hex}/app.ipa`,           // no port
    `https://192.168.1.50:0/${hex}/app.ipa`,
    `https://192.168.1.50:65536/${hex}/app.ipa`,
    `https://192.168.1.50:061901/${hex}/app.ipa`,
    `https://192.168.001.50:61901/${hex}/app.ipa`,   // leading zero
    `https://192.168.1.256:61901/${hex}/app.ipa`,
    `https://3232235826:61901/${hex}/app.ipa`,       // 192.168.1.50 as one number
    `https://user@192.168.1.50:61901/${hex}/app.ipa`,
    `https://phone.local:61901/${hex}/app.ipa`,
    `https://[::1]:61901/${hex}/app.ipa`,
    `https://192.168.1.50:61901/${hex.toUpperCase()}/app.ipa`,
    `https://192.168.1.50:61901/${hex.slice(1)}/app.ipa`,
    `https://192.168.1.50:61901/${hex}/other.ipa`,
    `https://192.168.1.50:61901/${hex}/app.ipa?x=1`,
    `https://192.168.1.50:61901/${hex}/app.ipa#x`,
    `https://192.168.1.50:61901/x/../${hex}/app.ipa`,
    `https://192.168.1.50:61901/${hex}/app.ipa\n`,
  ]) assert.equal(ok(url), false, url);
});

test("renderManifest writes the standard manifest and escapes every value", (t) => {
  const xml = eider.renderManifest({ ...GOOD, title: "A & B <\"c\"> 'd'" });
  assert.ok(xml.includes("<string>A &amp; B &lt;&quot;c&quot;&gt; &apos;d&apos;</string>"));
  assert.ok(!xml.includes("A & B"));
  if (process.platform !== "darwin") return t.skip("plutil is macOS-only");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eider-manifest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "m.plist");
  fs.writeFileSync(file, xml);
  execFileSync("plutil", ["-lint", file]);
  const parsed = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
  assert.deepEqual(parsed, { items: [{
    assets: [{ kind: "software-package", url: IPA }],
    metadata: { "bundle-identifier": GOOD.bundle, "bundle-version": GOOD.version, kind: "software", title: "A & B <\"c\"> 'd'" },
  }] });
});

test("createEiderManifest refuses a secret that is not 32-128 lowercase hex", () => {
  for (const s of ["", "short", SECRET.toUpperCase(), SECRET.slice(1), SECRET + "g", "a".repeat(129)]) {
    assert.throws(() => eider.createEiderManifest(s), /EIDER_MANIFEST_SECRET/, s);
  }
  assert.doesNotThrow(() => eider.createEiderManifest(SECRET));
});

// ── The route on a real hub ──────────────────────────────────────────────────
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

async function startHub(env, { expectExit = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-eider-home-"));
  const port = await freePort();
  const childEnv = { ...process.env, HOME: home, BRIDGE_PORT: String(port), BRIDGE_BIND: "127.0.0.1", ...env };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const proc = spawn(process.execPath, [BRIDGE, "--serve"], { env: childEnv, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (c) => { stderr += c; });
  const exited = new Promise((r) => proc.on("exit", (code, signal) => r({ code, signal })));
  const base = `http://127.0.0.1:${port}`;
  const hub = { base, exited, stderr: () => stderr,
    stop: async () => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill(); await exited; } fs.rmSync(home, { recursive: true, force: true }); } };
  if (expectExit) return hub;
  for (let i = 0; i < 150; i++) {
    try { await fetch(base + "/nope"); return hub; } catch {}
    await sleep(30);
  }
  throw new Error("hub did not start: " + stderr);
}

test("the hub refuses to start with a malformed EIDER_MANIFEST_SECRET", async () => {
  const hub = await startHub({ BRIDGE_TOKEN, EIDER_MANIFEST_SECRET: "not-hex" }, { expectExit: true });
  const { code } = await hub.exited;
  await hub.stop();
  assert.equal(code, 1);
  assert.match(hub.stderr(), /refusing to start: EIDER_MANIFEST_SECRET/);
});

test("without EIDER_MANIFEST_SECRET the prefix is behind the Bearer gate like any path", async (t) => {
  const hub = await startHub({ BRIDGE_TOKEN, EIDER_MANIFEST_SECRET: undefined });
  t.after(hub.stop);
  const url = `${hub.base}/eider/manifest/${SECRET}.plist?${qs(GOOD)}`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: "Bearer " + BRIDGE_TOKEN } })).status, 404);
});

test("the manifest is public, secret-gated and validated, and the rest of the hub is unchanged", async (t) => {
  const hub = await startHub({ BRIDGE_TOKEN, EIDER_MANIFEST_SECRET: SECRET });
  t.after(hub.stop);
  const at = (secret, query = qs(GOOD), init) => fetch(`${hub.base}/eider/manifest/${secret}.plist?${query}`, init);

  const r = await at(SECRET);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/xml/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.text();
  assert.equal(body, eider.renderManifest(GOOD));
  const head = await at(SECRET, qs(GOOD), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  // A wrong or missing secret is a plain 404, whatever the method or query.
  for (const s of [SECRET.slice(0, -1) + "0", SECRET + "0", "", SECRET.toUpperCase(), "%30" + SECRET.slice(1)]) {
    assert.equal((await at(s)).status, 404, s);
  }
  assert.equal((await at("x", "", { method: "POST" })).status, 404);
  assert.equal((await fetch(`${hub.base}/eider/manifest/${SECRET}`)).status, 404);
  assert.equal((await fetch(`${hub.base}/eider/manifest/${SECRET}.plist/x`)).status, 404);
  assert.equal((await fetch(`${hub.base}/eider/manifest/`)).status, 404);
  assert.equal((await at(SECRET, qs(GOOD), { method: "POST" })).status, 405);

  // Validation: 400 with a reason that never echoes the value.
  const publicIpa = { ...GOOD, url: "https://8.8.8.8:443/" + "ab".repeat(16) + "/app.ipa" };
  const refused = await at(SECRET, qs(publicIpa));
  assert.equal(refused.status, 400);
  assert.doesNotMatch(await refused.text(), /8\.8\.8\.8/);
  assert.equal((await at(SECRET, qs({ ...GOOD, bundle: "a b" }))).status, 400);
  assert.equal((await at(SECRET, qs({ ...GOOD, title: "x\ny" }))).status, 400);
  assert.equal((await at(SECRET, "")).status, 400);

  // The Bearer gate and every other route are as they were.
  assert.equal((await fetch(hub.base + "/health")).status, 401);
  assert.equal((await fetch(hub.base + "/status")).status, 401);
  assert.equal((await fetch(hub.base + "/health", { headers: { authorization: "Bearer " + BRIDGE_TOKEN } })).status, 200);
  assert.equal((await fetch(hub.base + "/eider/other")).status, 401);

  // Only the bundle id reaches the log.
  await sleep(50);
  assert.match(hub.stderr(), /eider-manifest: served dev\.example\.eider/);
  for (const v of [GOOD.version, "ab".repeat(16), SECRET, "8.8.8.8"]) assert.ok(!hub.stderr().includes(v), v + " not logged");
});
