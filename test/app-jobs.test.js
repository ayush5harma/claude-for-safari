// The /app/* surface (bridge/app-jobs.js, docs/APP-JOBS.md) with a stub
// CLAUDE_BIN at the process boundary, so nothing here reaches a model: the
// stub records its argv, stdin, environment keys, cwd and the files in it,
// then prints a canned `claude -p --output-format json` result chosen by a
// marker in its stdin. Sources come from a local HTTPS server with a
// throwaway self-signed certificate (openssl), trusted by the spawned hub
// through NODE_EXTRA_CA_CERTS and by in-process fetches through `ca`. Every
// statement and rule set here is synthetic.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const BRIDGE = path.join(__dirname, "..", "bridge", "claude-safari-bridge.js");
const appJobs = require(path.join(__dirname, "..", "bridge", "app-jobs.js"));

const BRIDGE_TOKEN = "bridge-token-for-tests-0001";
const APP_TOKEN = "app-token-for-tests-00000001";
const SECRET = "SYNTHETIC-STATEMENT-MARKER-7f3a";

const STATEMENT = {
  issuer: "Example Bank", product: "Example Card", cardLast4: "0000", kind: "monthly",
  periodStart: "2026-10-01", periodEnd: "2026-10-31", statementDate: "2026-10-31", dueDate: "2026-11-20",
  totals: { openingBalance: 0, totalDue: 1500, minimumDue: 100, creditLimit: null, availableLimit: null, purchases: 1500, payments: 0 },
  transactions: [{ date: "2026-10-05", description: "EXAMPLE STORE", amount: 1500, direction: "debit", kind: "purchase",
    channel: "online", merchantKey: "example", category: "shopping", paidVia: null, international: false, currency: null, foreignAmount: null }],
  rewardLines: [{ kind: "cashback", label: "Base 1%", amount: 15, unit: "INR" }],
  rewardSummary: null, notes: [],
};
const ruleSet = (url) => ({
  productKey: "test-card", issuer: "Example Bank", product: "Example Card", network: "visa", rewardCurrency: "cashback",
  pointValue: null, effectiveFrom: null, verifiedOn: "2026-11-15", status: "verified",
  sources: [{ url, title: null, checkedOn: "2026-11-15" }],
  earn: [{ id: "base", label: "Base 1%", priority: 0, isBase: true,
    match: { merchants: null, categories: null, channels: null, paidVia: null, international: null },
    rate: 0.01, pointsPer: null, perINR: null, minTxnINR: null, caps: [], creditedTo: "statement",
    countsTowardBase: true, stacks: false, sourceUrl: url, note: null }],
  exclusions: ["fuel"], cardCaps: [], milestones: [], fees: [], creditLagDays: null, notes: [],
});

// The stub claude. Markers in stdin choose its answer.
const STUB = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const STATEMENT = ${JSON.stringify(STATEMENT)};
const ruleSet = ${ruleSet.toString()};
// The hub's startup probe. STUB_HELP_OMITS (comma-separated) plays an older CLI.
const probe = process.argv.includes("--version") ? "version" : process.argv.includes("--help") ? "help" : null;
if (probe === "version") process.stdout.write("9.9.9 (Claude Code stub)\\n");
if (probe === "help") {
  const omit = String(process.env.STUB_HELP_OMITS || "").split(",");
  const flags = ["--restricted", "--tools <tools...>", "--json-schema <schema>", "--no-session-persistence", "--tools-extra"];
  process.stdout.write("Usage: claude [options]\\n\\nOptions:\\n" +
    flags.filter((f) => !omit.includes(f.split(" ")[0])).map((f) => "  " + f + "    some help\\n").join(""));
}
let stdin = "";
if (!probe) process.stdin.setEncoding("utf8");
if (!probe) process.stdin.on("data", (c) => (stdin += c));
if (!probe) process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  const files = {};
  if (path.basename(cwd).startsWith("claude-app-job-")) {
    for (const f of fs.readdirSync(cwd)) files[f] = fs.readFileSync(path.join(cwd, f), f.endsWith(".txt") ? "utf8" : "latin1").slice(0, 4000);
  }
  fs.appendFileSync(path.join(__dirname, "calls.jsonl"),
    JSON.stringify({ argv, stdin, envKeys: Object.keys(process.env), cwd, files, pid: process.pid }) + "\\n");
  const emit = (o) => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, ...o }));
  const retry = stdin.includes("did not match the schema");
  if (stdin.includes("STUB-SLOW") || stdin.includes("cardKey=slow-card")) return setTimeout(() => emit({ structured_output: STATEMENT }), 60000);
  if (stdin.includes("STUB-IS-ERROR") || stdin.includes("cardKey=error-card")) return emit({ is_error: true, result: "Invalid API key - please run /login" });
  if (stdin.includes("STUB-TEXT-RESULT")) return emit({ result: "Here it is:\\n\`\`\`json\\n" + JSON.stringify(STATEMENT) + "\\n\`\`\`" });
  if (stdin.includes("STUB-ALWAYS-INVALID") || (stdin.includes("STUB-INVALID-FIRST") && !retry)) {
    const bad = JSON.parse(JSON.stringify(STATEMENT));
    bad.transactions[0].amount = "BAD-VALUE-9d1c";
    delete bad.kind;
    return emit({ structured_output: bad });
  }
  // Shopping: the plan run proposes pages on the first allowed host (a hostile
  // list, a failure or a real path on request); the answer run puts one verified
  // option on each page it was handed, plus whatever lie the marker asks for.
  if (stdin.startsWith("Shopping plan request")) {
    const host = ((stdin.split("Allowed hosts (https only): ")[1] || "").split("\\n")[0].split(", ")[0]) || "shop.example";
    const u = (h, p) => "https://" + h + p;
    if (stdin.includes("STUB-PLAN-INVALID")) return emit({ structured_output: { fetches: "nope" } });
    const fetches = stdin.includes("STUB-PLAN-HOSTILE") ? [
      { categoryNumber: 1, url: u(host, "/a") }, { categoryNumber: 1, url: "https://evil.example/x" },
      { categoryNumber: 1, url: "http://" + host + "/insecure" }, { categoryNumber: 1, url: u(host, "/a#again") },
      { categoryNumber: 1, url: u(host, "/b") }, { categoryNumber: 1, url: u(host, "/c") }, { categoryNumber: 1, url: u(host, "/d") },
      { categoryNumber: 99, url: u(host, "/e") }, { categoryNumber: 2, url: u("www." + host, "/f") },
      { categoryNumber: 2, url: "https://user:pw@" + host + "/g" }]
      : stdin.includes("STUB-PLAN-PAGE") ? [{ categoryNumber: 1, url: u(host, "/page.html") }, { categoryNumber: 2, url: u(host, "/tc.pdf") }]
      : [{ categoryNumber: 1, url: u(host, "/s?q=one") }, { categoryNumber: 2, url: u(host, "/s?q=two") }];
    return emit({ structured_output: { fetches } });
  }
  if (stdin.startsWith("Shopping refresh request")) {
    const lines = stdin.split("\\n");
    const cats = lines.filter((l) => /^\\d+\\. /.test(l)).map((l) => l.replace(/^\\d+\\. /, "").split(" | constraints:")[0]);
    const pagesFor = (i) => lines.filter((l) => l.startsWith("- source-") && l.endsWith("(for category " + i + ")"))
      .map((l) => l.split(" from ")[1].split(" (for category")[0]);
    if (stdin.includes("STUB-SHOP-WRONG-CATEGORIES") && !retry) {
      return emit({ structured_output: { checkedOn: "1999-01-01", categories: [{ category: "Wrong-9d1c", options: [], recommendation: "x" }], notes: "" } });
    }
    const categories = cats.map((c, i) => {
      const urls = pagesFor(i + 1);
      const options = urls.map((url, j) => ({ name: c + " option " + (j + 1), priceINR: 1000 * (i + 1) + j, seller: "Example Retailer",
        url, saleNote: j ? null : "Example sale", verified: true }));
      const extra = (over) => options.push({ name: "extra", priceINR: 500, seller: null, url: null, saleNote: null, verified: true, ...over });
      if (stdin.includes("STUB-SHOP-LIES")) {
        extra({ name: "never fetched", url: "https://shop.example/never-fetched" });
        extra({ name: "off list", url: "https://evil.example/phish" });
        extra({ name: "no price", priceINR: null, url: urls[0] || null });
      }
      if (!urls.length) extra({ name: "from memory", priceINR: 20000 });
      if (stdin.includes("STUB-SHOP-ZERO") && !retry) extra({ name: "zero", priceINR: 0, verified: false });
      return { category: stdin.includes("STUB-SHOP-CASE") ? c.toUpperCase() : c, options, recommendation: "Buy option 1." };
    });
    return emit({ structured_output: { checkedOn: "1999-01-01", categories, notes: "Stub notes." } });
  }
  if (argv[argv.indexOf("--tools") + 1] === "Read") {
    const url = (/ from (https:\\/\\/\\S+)/.exec(stdin) || [])[1] || "https://unknown.invalid/";
    const rs = ruleSet(url);
    if (stdin.includes("cardKey=inject-card")) {
      // What a hostile source page could talk the model into citing.
      rs.sources = [{ url: "https://evil.example/phish", title: "Click me", checkedOn: null },
        { url: url.replace("https://terms.example", "https://TERMS.example") + "#page=2", title: null, checkedOn: null }];
      rs.earn[0].sourceUrl = "https://evil.example/phish";
      rs.earn[0].caps = [{ period: "cycle", kind: "absolute", amountINR: 500, points: null, ruleId: null, multiple: null, percent: null,
        perMerchant: false, note: null, sourceUrl: "javascript:alert(1)" }];
      rs.fees = [{ id: "fx", label: "FX", match: rs.earn[0].match, percent: 3.5, gstOnFee: true, minTxnINR: null,
        monthlyThresholdINR: null, sourceUrl: url + "#fees", note: null }];
    }
    return emit({ structured_output: { status: "verified", ruleSet: rs, notes: ["synthetic"] } });
  }
  emit({ structured_output: STATEMENT, result: JSON.stringify(STATEMENT) });
});
`;

function makeStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-appjobs-stub-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, STUB);
  fs.chmodSync(bin, 0o755);
  return { dir, bin, calls: () => {
    const f = path.join(dir, "calls.jsonl");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// One hub on a spare port with HOME in a scratch dir; resolves once it answers.
// A hub with app jobs probes its CLI at startup, so every hub gets the stub
// unless the test names its own: no test runs the host's real claude.
let defaultStub = null;
async function startHub(env, { expectExit = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-appjobs-home-"));
  const port = await freePort();
  defaultStub = defaultStub || makeStub();
  const childEnv = { ...process.env, HOME: home, BRIDGE_PORT: String(port), BRIDGE_BIND: "127.0.0.1", CLAUDE_BIN: defaultStub.bin, ...env };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const proc = spawn(process.execPath, [BRIDGE, "--serve"], { env: childEnv, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (c) => { stderr += c; });
  const exited = new Promise((r) => proc.on("exit", (code, signal) => r({ code, signal })));
  const base = `http://127.0.0.1:${port}`;
  const hub = { base, proc, home, exited, stderr: () => stderr,
    stop: async () => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill(); await exited; } fs.rmSync(home, { recursive: true, force: true }); } };
  if (expectExit) return hub;
  for (let i = 0; i < 150; i++) {
    try { await fetch(base + "/nope"); return hub; } catch {}
    await sleep(30);
  }
  throw new Error("hub did not start: " + stderr);
}

const appHeaders = { authorization: "Bearer " + APP_TOKEN, "content-type": "application/json" };
const post = (base, body, headers = appHeaders) =>
  fetch(base + "/app/jobs", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
async function waitJob(base, id, ok = (j) => j.status === "done" || j.status === "failed", tries = 300) {
  let j = null;
  for (let i = 0; i < tries; i++) {
    j = await (await fetch(base + "/app/jobs/" + id, { headers: appHeaders })).json();
    if (ok(j)) return j;
    await sleep(50);
  }
  return j;
}
const statementBody = (text, extra = {}) => ({ type: "statement-extract", input: { text, hint: { issuer: "Example", product: "Card", last4: "0000" }, ...extra } });

// ── Self-signed HTTPS sources ────────────────────────────────────────────────
const PAGE_TEXT = "Cashback terms for the Example Card. ".repeat(12);
let tls = null;          // { dir, key, cert, certFile }
let src = null;          // { server, port, host, url(p) }
const PDF = Buffer.from("%PDF-1.4\n% synthetic terms document for tests\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const BOMB = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024));

before(async () => {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-appjobs-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"),
      "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    tls = { dir, key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")), certFile: path.join(dir, "c.pem") };
  } catch {
    tls = null;
    return;
  }
  const port = await freePort();
  const host = "127.0.0.1:" + port;
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const u = req.url;
    if (u === "/tc.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); return res.end(PDF); }
    if (u === "/octet") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(PDF); }
    if (u === "/page.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<!doctype html><html><head><title>Card &amp; Terms</title><style>.x{color:red}</style></head><body>" +
        "<script>window.hidden = 'SCRIPT-BODY-MUST-GO';</script><h1>Rewards</h1><p>Earn 5&#37; on bills &ndash; capped.</p>" +
        "<table><tr><td>Base</td><td>1%</td></tr></table><p>" + PAGE_TEXT + "</p></body></html>");
    }
    if (u === "/spa.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><body><div id=app></div><script>render()</script></body></html>"); }
    if (u === "/redirect-ok") { res.writeHead(302, { location: "/tc.pdf" }); return res.end(); }
    if (u === "/redirect-out") { res.writeHead(302, { location: "https://not-allowed.example/x" }); return res.end(); }
    if (u === "/loop") { res.writeHead(302, { location: "/loop" }); return res.end(); }
    if (u === "/declared-big") { res.writeHead(200, { "content-type": "application/pdf", "content-length": String(9 * 1024 * 1024) }); return res.end(); }
    if (u === "/chunked-big") {
      res.writeHead(200, { "content-type": "text/plain" });
      const chunk = Buffer.alloc(1024 * 1024, 97);
      for (let i = 0; i < 9; i++) res.write(chunk);
      return res.end();
    }
    if (u === "/slow") { res.writeHead(200, { "content-type": "text/plain" }); res.write("partial"); return; }
    if (u === "/json") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
    if (u === "/forbidden") { res.writeHead(403, { "content-type": "text/html" }); return res.end("<p>bot wall</p>"); }
    if (u === "/reset") return req.socket.destroy();
    if (u === "/redirect-http") { res.writeHead(302, { location: "http://" + req.headers.host + "/tc.pdf" }); return res.end(); }
    if (u === "/redirect-creds") { res.writeHead(302, { location: "https://user:pw@" + req.headers.host + "/tc.pdf" }); return res.end(); }
    const page = "<html><head><title>Packed</title></head><body><p>" + PAGE_TEXT + "</p></body></html>";
    if (u === "/gz") { res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }); return res.end(zlib.gzipSync(page)); }
    if (u === "/br") { res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" }); return res.end(zlib.brotliCompressSync(page)); }
    if (u === "/deflate") { res.writeHead(200, { "content-type": "text/html", "content-encoding": "deflate" }); return res.end(zlib.deflateSync(page)); }
    // 64 MB of zeros, about 64 KB on the wire: the decoded cap must stop it.
    if (u === "/bomb") { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }); return res.end(BOMB); }
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("unavailable");
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  src = { server, port, host, url: (p) => "https://" + host + p };
});

after(() => {
  if (defaultStub) fs.rmSync(defaultStub.dir, { recursive: true, force: true });
  if (src) { src.server.closeAllConnections(); src.server.close(); }
  if (tls) fs.rmSync(tls.dir, { recursive: true, force: true });
});

// ── Startup ──────────────────────────────────────────────────────────────────
test("the hub refuses to start with an app token shorter than 16 characters or equal to BRIDGE_TOKEN", async () => {
  for (const env of [{ BRIDGE_APP_TOKEN: "short-token" }, { BRIDGE_TOKEN: APP_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN }]) {
    const hub = await startHub(env, { expectExit: true });
    const { code } = await hub.exited;
    await hub.stop();
    assert.equal(code, 1);
    assert.match(hub.stderr(), /refusing to start: BRIDGE_APP_TOKEN/);
  }
});

test("/app/* is 404 when BRIDGE_APP_TOKEN is not set", async (t) => {
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: undefined });
  t.after(hub.stop);
  const auth = { authorization: "Bearer " + BRIDGE_TOKEN };
  assert.equal((await fetch(hub.base + "/app/health", { headers: auth })).status, 404);
  assert.equal((await fetch(hub.base + "/app/jobs", { method: "POST", headers: auth, body: "{}" })).status, 404);
  assert.equal((await fetch(hub.base + "/health", { headers: auth })).status, 200);
});

// ── Tokens and origins ───────────────────────────────────────────────────────
test("token separation both ways, and native clients only", async (t) => {
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN });
  t.after(hub.stop);
  const app = { authorization: "Bearer " + APP_TOKEN };
  const bridge = { authorization: "Bearer " + BRIDGE_TOKEN };
  const health = await fetch(hub.base + "/app/health", { headers: app });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  const h = await health.json();
  assert.equal(h.ok, true);
  assert.deepEqual(h.types, ["statement-extract", "terms-extract", "shopping-refresh"]);
  assert.equal(h.defaultModel, "sonnet");
  assert.equal(h.limits.maxRunning, 2);
  assert.equal(h.limits.maxQueued, 20);
  assert.equal(h.error, null);
  assert.ok(["checking", "ok"].includes(h.cli.state), JSON.stringify(h.cli));
  // BRIDGE_TOKEN, no token, and a wrong token are all refused on /app/*.
  assert.equal((await fetch(hub.base + "/app/health", { headers: bridge })).status, 401);
  assert.equal((await fetch(hub.base + "/app/health")).status, 401);
  assert.equal((await fetch(hub.base + "/app/health", { headers: { authorization: "Bearer " + APP_TOKEN + "x" } })).status, 401);
  assert.equal((await post(hub.base, statementBody("x"), { ...bridge, "content-type": "application/json" })).status, 401);
  // The app token opens nothing outside /app/*.
  assert.equal((await fetch(hub.base + "/health", { headers: app })).status, 401);
  assert.equal((await fetch(hub.base + "/status", { headers: app })).status, 401);
  assert.equal((await fetch(hub.base + "/call", { method: "POST", headers: { ...app, "content-type": "application/json" },
    body: JSON.stringify({ tool: "tabs", args: {} }) })).status, 401);
  assert.equal((await fetch(hub.base + "/health", { headers: bridge })).status, 200);
  // A browser's headers are refused even with the right token.
  assert.equal((await fetch(hub.base + "/app/health", { headers: { ...app, origin: "https://example.com" } })).status, 403);
  assert.equal((await fetch(hub.base + "/app/health", { headers: { ...app, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await fetch(hub.base + "/app/health", { headers: { ...app, origin: "null" } })).status, 403);
});

test("on a loopback hub with no BRIDGE_TOKEN the app token still opens only /app/*", async (t) => {
  const hub = await startHub({ BRIDGE_TOKEN: undefined, BRIDGE_APP_TOKEN: APP_TOKEN });
  t.after(hub.stop);
  assert.equal((await fetch(hub.base + "/status", { headers: { authorization: "Bearer " + APP_TOKEN } })).status, 401);
  assert.equal((await fetch(hub.base + "/status")).status, 200);
  assert.equal((await fetch(hub.base + "/app/health", { headers: { authorization: "Bearer " + APP_TOKEN } })).status, 200);
});

// ── Input limits and the allowlist ───────────────────────────────────────────
test("input limits and the fetch allowlist are enforced before anything runs", async (t) => {
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin,
    BRIDGE_APP_FETCH_DOMAINS: "terms.example, www.terms.example" });
  t.after(async () => { await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const status = async (body) => (await post(hub.base, body)).status;
  const errorOf = async (body) => (await (await post(hub.base, body)).json()).error;
  const card = (over = {}) => ({ cardKey: "example-card", issuer: "Example Bank", product: "Example Card",
    sources: ["https://terms.example/tc.pdf"], current: null, ...over });
  const terms = (cards, extra = {}) => ({ type: "terms-extract", input: { cards, ...extra } });

  assert.equal(await status({ type: "nope", input: {} }), 400);
  assert.equal(await status({ type: "statement-extract" }), 400);
  assert.equal(await status("not json"), 400);
  assert.equal(await status(statementBody("   ")), 400);
  assert.equal(await status(statementBody("x".repeat(200001))), 413);
  assert.equal(await status({ type: "statement-extract", input: { text: "x", pad: "y".repeat(2.1 * 1024 * 1024) } }), 413);
  assert.equal(await status(statementBody("x", { hint: { last4: "12345" } })), 400);
  assert.equal(await status(statementBody("x", { model: "--dangerously-skip-permissions" })), 400);
  assert.equal(await status(terms([])), 400);
  assert.equal(await status(terms(Array.from({ length: 11 }, (_, i) => card({ cardKey: "card-" + i })))), 400);
  assert.equal(await status(terms([card({ sources: Array(6).fill("https://terms.example/a") })])), 400);
  assert.equal(await status(terms([card({ sources: [] })])), 400);
  assert.match(await errorOf(terms([card({ sources: ["http://terms.example/tc.pdf"] })])), /not an https URL/);
  assert.match(await errorOf(terms([card({ sources: ["https://evil.example/tc.pdf"] })])), /host evil\.example is not on BRIDGE_APP_FETCH_DOMAINS/);
  // The match is on the exact host: a suffix or a different port does not pass.
  assert.equal(await status(terms([card({ sources: ["https://xterms.example/a"] })])), 400);
  assert.equal(await status(terms([card({ sources: ["https://terms.example:8443/a"] })])), 400);
  assert.equal(await status(terms([card({ sources: ["https://user:pw@terms.example/a"] })])), 400);
  assert.equal(await status(terms([card({ cardKey: "Example_Card" })])), 400);
  assert.equal(await status(terms([card({ cardKey: "-leading" })])), 400);
  assert.equal(await status(terms([card(), card()])), 400);
  assert.equal(await status(terms([card({ issuer: "" })])), 400);
  assert.equal(await status(terms([card({ current: "not an object" })])), 400);
  assert.equal(stub.calls().length, 0, "nothing reached the CLI");
  // And with an empty allowlist, terms jobs are off altogether.
  const bare = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin, BRIDGE_APP_FETCH_DOMAINS: "" });
  t.after(bare.stop);
  const r = await post(bare.base, terms([card()]));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /BRIDGE_APP_FETCH_DOMAINS is empty/);
});

// A POST written in the given pieces, each its own chunk on the wire, with no
// content-length, so the hub's own body reader sees where they split.
const postInPieces = (base, pieces) => new Promise((resolve) => {
  const req = http.request(base + "/app/jobs", { method: "POST", headers: appHeaders }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { body += c; });
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.on("error", (e) => resolve({ error: e.code || e.message }));
  (async () => {
    for (const p of pieces) { req.write(p); await sleep(40); }
    req.end();
  })();
});

test("a request body is read as bytes: a character split across chunks arrives whole, and the cap counts bytes", async (t) => {
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin });
  t.after(async () => { await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const body = Buffer.from(JSON.stringify(statementBody("Annual fee \u20b91,500 " + SECRET)));
  const cut = body.indexOf(Buffer.from("\u20b9")) + 1;   // inside the rupee sign's three bytes
  const r = await postInPieces(hub.base, [body.subarray(0, cut), body.subarray(cut)]);
  assert.equal(r.status, 202, JSON.stringify(r));
  const job = await waitJob(hub.base, JSON.parse(r.body).jobId);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.ok(stub.calls()[0].stdin.includes("Annual fee \u20b91,500"), "the rupee sign reached the CLI intact");
  // 800,000 three-byte characters: 2.4 MB on the wire but fewer than 2 MB characters.
  const big = Buffer.from(JSON.stringify({ type: "statement-extract", input: { text: "x", pad: "\u20b9".repeat(800000) } }));
  const r2 = await postInPieces(hub.base, [big.subarray(0, 1000000), big.subarray(1000000)]);
  assert.ok(r2.error || r2.status === 413, "refused: " + JSON.stringify(r2).slice(0, 200));
  await sleep(200);
  assert.equal(stub.calls().length, 1, "the oversized body never became a job");
});

// ── Statement jobs ───────────────────────────────────────────────────────────
test("a statement job runs with no tools, its text on stdin only, and never in the logs", async (t) => {
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin, CODEX_API_KEY: "codex-must-not-leak" });
  t.after(async () => { await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const text = "Statement for card XXXX XXXX XXXX 0000\n" + SECRET + "\n05 Oct EXAMPLE STORE 1,500.00 Dr\n";
  const r = await post(hub.base, statementBody(text));
  assert.equal(r.status, 202);
  const { jobId, status } = await r.json();
  assert.match(jobId, /^[0-9a-f-]{36}$/);
  assert.ok(["queued", "running"].includes(status));
  const job = await waitJob(hub.base, jobId);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(job.type, "statement-extract");
  assert.deepEqual(job.progress, { done: 1, total: 1 });
  assert.equal(job.error, null);
  assert.ok(Date.parse(job.createdAt) && Date.parse(job.finishedAt));
  assert.equal(job.result.schemaVersion, 1);
  assert.deepEqual(appJobs.check(appJobs.STATEMENT_SHAPE, job.result), []);
  assert.equal(job.result.transactions[0].amount, 1500);

  const [call] = stub.calls();
  assert.ok(call.stdin.includes(SECRET), "the text reached stdin");
  assert.ok(call.stdin.includes("last4=0000"), "the hint reached stdin");
  assert.ok(!call.argv.some((a) => a.includes(SECRET)), "the text is not in argv");
  const at = (flag) => call.argv[call.argv.indexOf(flag) + 1];
  assert.equal(at("--tools"), "", "no built-in tools");
  assert.equal(at("--mcp-config"), '{"mcpServers":{}}');
  assert.equal(at("--model"), "sonnet");
  assert.equal(at("--permission-mode"), "dontAsk");
  assert.equal(at("--max-turns"), "4");
  assert.equal(at("--output-format"), "json");
  for (const f of ["-p", "--restricted", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "--json-schema"]) {
    assert.ok(call.argv.includes(f), f);
  }
  for (const f of ["--allowedTools", "--allowed-tools", "--bare", "--dangerously-skip-permissions", "--add-dir"]) {
    assert.ok(!call.argv.includes(f), f);
  }
  assert.deepEqual(JSON.parse(at("--json-schema")), appJobs.toJsonSchema(appJobs.STATEMENT_SHAPE));
  for (const k of ["BRIDGE_TOKEN", "BRIDGE_APP_TOKEN", "CODEX_API_KEY"]) assert.ok(!call.envKeys.includes(k), k + " stripped");
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(os.tmpdir()));

  const logs = hub.stderr();
  assert.match(logs, new RegExp("app-job " + jobId + " statement-extract done"));
  assert.match(logs, /in=\d+/);
  assert.ok(!logs.includes(SECRET), "statement text never logged");
  assert.ok(!logs.includes("EXAMPLE STORE"), "results never logged");

  const got = await fetch(hub.base + "/app/jobs/" + jobId, { headers: appHeaders });
  assert.equal(got.headers.get("cache-control"), "no-store");
  const del = await fetch(hub.base + "/app/jobs/" + jobId, { method: "DELETE", headers: appHeaders });
  assert.equal(del.status, 200);
  assert.equal((await fetch(hub.base + "/app/jobs/" + jobId, { headers: appHeaders })).status, 404);
  assert.equal((await fetch(hub.base + "/app/jobs/not-a-uuid", { headers: appHeaders })).status, 404);
});

test("a schema miss is retried once with its errors (paths, never values) appended to stdin", async (t) => {
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin });
  t.after(async () => { await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });

  const ok = await waitJob(hub.base, (await (await post(hub.base, statementBody("STUB-INVALID-FIRST " + SECRET))).json()).jobId);
  assert.equal(ok.status, "done", JSON.stringify(ok));
  const [first, second] = stub.calls();
  assert.ok(!first.stdin.includes("did not match the schema"));
  assert.ok(second.stdin.startsWith(first.stdin), "the retry carries the original input");
  assert.match(second.stdin, /transactions\[0\]\.amount: expected number greater than 0, got string/);
  assert.match(second.stdin, /- kind: missing/);
  assert.ok(!second.stdin.includes("BAD-VALUE-9d1c"), "the bad value is not echoed");

  const bad = await waitJob(hub.base, (await (await post(hub.base, statementBody("STUB-ALWAYS-INVALID"))).json()).jobId);
  assert.equal(bad.status, "failed");
  assert.equal(bad.result, null);
  assert.match(bad.error, /after one retry: .*transactions\[0\]\.amount/);
  assert.ok(!bad.error.includes("BAD-VALUE-9d1c"));
  assert.equal(stub.calls().length, 4, "two runs per job, no more");

  const cliErr = await waitJob(hub.base, (await (await post(hub.base, statementBody("STUB-IS-ERROR"))).json()).jobId);
  assert.equal(cliErr.status, "failed");
  assert.match(cliErr.error, /Invalid API key/);
  assert.equal(stub.calls().length, 5, "a CLI error is not retried");

  const text = await waitJob(hub.base, (await (await post(hub.base, statementBody("STUB-TEXT-RESULT"))).json()).jobId);
  assert.equal(text.status, "done", "an answer in result text is accepted when it validates");
  assert.match(hub.stderr(), /reason=invalid-output/);
  assert.ok(!hub.stderr().includes(SECRET));
});

test("the shape checker is strict on types and lenient on vocabulary", () => {
  const { check, STATEMENT_SHAPE, toJsonSchema } = appJobs;
  assert.deepEqual(check(STATEMENT_SHAPE, { ...STATEMENT, kind: "quarterly" }), []);
  // ...except where the bridge or the app branches on the word.
  const txn = (over) => ({ ...STATEMENT, transactions: [{ ...STATEMENT.transactions[0], ...over }] });
  assert.deepEqual(check(STATEMENT_SHAPE, txn({ category: "space-travel", channel: "telepathy" })), [], "lenient vocabularies stay lenient");
  assert.deepEqual(check(STATEMENT_SHAPE, txn({ direction: "sideways" })), ["transactions[0].direction: expected one of debit, credit, got string"]);
  assert.deepEqual(check(STATEMENT_SHAPE, txn({ kind: "bonus" })),
    ["transactions[0].kind: expected one of purchase, refund, payment, cashback, fee, interest, tax, emi, reversal, other, got string"]);
  assert.deepEqual(check(STATEMENT_SHAPE, txn({ direction: null })), ["transactions[0].direction: expected one of debit, credit, got null"]);
  assert.deepEqual(check(appJobs.TERMS_ANSWER_SHAPE, { status: "partial", ruleSet: null, notes: [] }),
    ["status: expected one of verified, unverified, failed, got string"]);
  assert.deepEqual(check(appJobs.TERMS_RESULT_SHAPE.cards[0],
    { cardKey: "a", status: "maybe", checkedOn: "2026-11-15", sources: [], ruleSet: null, notes: [] }),
    ["status: expected one of verified, unverified, failed, got string"]);
  const txnSchema = toJsonSchema(STATEMENT_SHAPE).properties.transactions.items.properties;
  assert.deepEqual(txnSchema.direction, { type: "string", enum: ["debit", "credit"] });
  assert.equal(txnSchema.kind.enum.length, 10);
  assert.deepEqual(check(STATEMENT_SHAPE, { ...STATEMENT, dueDate: null }), []);
  assert.deepEqual(check(STATEMENT_SHAPE, { ...STATEMENT, dueDate: "2026-02-30" }), ["dueDate: expected YYYY-MM-DD date, got string"]);
  assert.deepEqual(check(STATEMENT_SHAPE, { ...STATEMENT, kind: 3 }), ["kind: expected one of monthly, annual, unknown, got number"]);
  assert.deepEqual(check(STATEMENT_SHAPE, { ...STATEMENT, notes: "x" }), ["notes: expected array, got string"]);
  assert.deepEqual(check(STATEMENT_SHAPE, []), ["(root): expected object, got array"]);
  assert.deepEqual(check(STATEMENT_SHAPE, { ...STATEMENT, rewardSummary: { pointsOpening: 1 } }).slice(0, 1), ["rewardSummary.pointsEarned: missing"]);
  // Every object in the generated schema requires all of its keys.
  const walk = (s) => {
    if (s.type === "object") { assert.deepEqual(s.required, Object.keys(s.properties)); Object.values(s.properties).forEach(walk); }
    if (s.items) walk(s.items);
    if (s.anyOf) s.anyOf.forEach(walk);
  };
  walk(toJsonSchema(STATEMENT_SHAPE));
  walk(toJsonSchema(appJobs.TERMS_ANSWER_SHAPE));
});

// ── The statement prompt and schema carry the extraction rules ───────────────
// The model is never called here. These pin the text that steers it, so a
// later edit cannot silently drop a rule that an end-to-end run over real
// statements showed was needed.
const statementArg = (flag) => { const a = appJobs.statementArgs("sonnet"); return a[a.indexOf(flag) + 1]; };

test("the statement schema has a nullable paidVia that accepts new vocabulary", () => {
  const { check, STATEMENT_SHAPE } = appJobs;
  const withVia = (paidVia) => ({ ...STATEMENT, transactions: [{ ...STATEMENT.transactions[0], paidVia }] });
  for (const v of ["airtel-thanks", "amazon-pay", "smartbuy", "card-direct", "upi", null, "some-new-route"]) {
    assert.deepEqual(check(STATEMENT_SHAPE, withVia(v)), [], String(v));
  }
  assert.deepEqual(check(STATEMENT_SHAPE, withVia(3)),
    ["transactions[0].paidVia: expected one of airtel-thanks, amazon-pay, smartbuy, card-direct, upi, got number"]);
  const { paidVia: _omitted, ...noVia } = STATEMENT.transactions[0];
  assert.deepEqual(check(STATEMENT_SHAPE, { ...STATEMENT, transactions: [noVia] }), ["transactions[0].paidVia: missing"]);

  const txn = JSON.parse(statementArg("--json-schema")).properties.transactions.items;
  assert.ok(txn.required.includes("paidVia"), "paidVia is required like every key");
  assert.deepEqual(txn.properties.paidVia.anyOf, [
    { type: "string", enum: ["airtel-thanks", "amazon-pay", "smartbuy", "card-direct", "upi"] }, { type: "null" }]);
});

test("the statement prompt carries each extraction rule", () => {
  const prompt = statementArg("--system-prompt");
  const rules = {
    "dates are filled only when printed, never derived": [/only when the statement prints it/, /Never derive any of them from the transaction dates/],
    "every printed row is returned, none skipped": [/EVERY transaction row the statement prints/, /never skip, merge, sample or summarise rows/],
    "balance totals are signed from the cardholder's side": [/signed from the cardholder's side/, /\(Cr, "credit balance", "NO PYMT REQD"\) is negative/],
    "rewardLines are only what this statement earned or credited": [/only rewards earned or credited in this statement/,
      /Opening, closing and available reward balances are not rewardLines.*only in rewardSummary/],
    "a UPI row is never unknown and splits online / scan": [/UPI.*is never unknown/, /upi-online when the merchant is an online service or app/,
      /otherwise upi-scan/],
    "card rows are online, pos or contactless": [/card not present\) is online/, /card-present payment is pos/, /contactless only when the statement says so/],
    "paidVia routes": [/airtel-thanks when/, /AIRTEL PAYMENTS BANK/, /amazon-pay for/, /smartbuy for HDFC SmartBuy/, /upi for a row paid by UPI/, /null otherwise/],
    "Airtel Thanks rows are telecom unless a utility biller": [/category telecom, unless .*electricity, gas or water biller.*utilities/],
    "merchant keys drop aggregator prefixes": [/"PTM\*ZOMATO", "ZOMATO LIMITED" and "ZOMATO"/, /"zomato"/, /swiggy, blinkit, amazon, apple and airtel/],
  };
  for (const [rule, patterns] of Object.entries(rules)) {
    for (const re of patterns) assert.match(prompt, re, rule);
  }
  // The old, looser wording must not come back next to the new rules.
  assert.doesNotMatch(prompt, /every reward line the statement prints/);
  assert.doesNotMatch(prompt, /channel is unknown unless/);
});

// ── Contract with the iPhone app's rule models ───────────────────────────────
// The app (CardRuleModels.swift) decodes the same CardRuleSet JSON the terms
// job emits. check() alone cannot see drift: it ignores keys its shape does not
// name and accepts any vocabulary string, so a field or value the hub cannot
// express would pass. These helpers close both gaps, for the contract test
// against the app's own catalog and for the fixture below.
const Nullable = appJobs.nullable(null).constructor;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// The terms result is checked against this shape (the bridge stamps schemaVersion).
const RULE_SET_CHECKED = appJobs.TERMS_RESULT_SHAPE.cards[0].ruleSet.shape;

// The app decodes an absent key to a default, so its bundled catalog omits keys
// where the hub's shape requires every key. Fill them as the app's decoder does
// (value(_:or:) in CardRuleModels.swift), so check() sees what the app means.
const APP_DEFAULTS = { priority: 0, isBase: false, countsTowardBase: true, stacks: false, perMerchant: false, gstOnFee: true };
function withAppDefaults(shape, value) {
  if (shape instanceof Nullable) return value === null ? null : withAppDefaults(shape.shape, value);
  if (Array.isArray(shape)) return Array.isArray(value) ? value.map((v) => withAppDefaults(shape[0], v)) : value;
  if (!isObject(shape) || !isObject(value)) return value;
  const out = { ...value };
  for (const [key, sub] of Object.entries(shape)) {
    if (key in value) out[key] = withAppDefaults(sub, value[key]);
    else if (key in APP_DEFAULTS) out[key] = APP_DEFAULTS[key];
    else if (sub instanceof Nullable || (typeof sub === "string" && sub.endsWith("?"))) out[key] = null;
    else if (Array.isArray(sub)) out[key] = [];
    else if (isObject(sub)) out[key] = withAppDefaults(sub, {});
  }
  return out;
}

// Fields the shape has no name for and strings outside a vocabulary it lists.
function drift(shape, value, at = "") {
  if (shape instanceof Nullable) return value === null ? [] : drift(shape.shape, value, at);
  if (Array.isArray(shape)) return Array.isArray(value) ? value.flatMap((v, i) => drift(shape[0], v, at + "[" + i + "]")) : [];
  if (typeof shape === "string") {
    const vocabulary = shape.replace(/\?$/, "").split("|");
    return vocabulary.length > 1 && typeof value === "string" && !vocabulary.includes(value)
      ? [at + ": " + JSON.stringify(value) + " is not in the hub's vocabulary"] : [];
  }
  if (!isObject(value)) return [];
  const path = (k) => (at ? at + "." + k : k);
  return Object.keys(value).flatMap((k) => (k in shape ? drift(shape[k], value[k], path(k)) : [path(k) + ": the hub's shape has no such field"]));
}
const contractProblems = (ruleSet) =>
  [...appJobs.check(RULE_SET_CHECKED, withAppDefaults(RULE_SET_CHECKED, ruleSet)), ...drift(RULE_SET_CHECKED, ruleSet)];

// The companion app's catalog lives in another repository, so its path comes only
// from the environment; CONTRIBUTING.md keeps local paths out of the repo.
const APP_CATALOG = process.env.APP_CARD_CATALOG || "";

test("every rule set in the app's bundled catalog passes the hub's rule-set checker", (t) => {
  if (!APP_CATALOG || !fs.existsSync(APP_CATALOG)) {
    return t.skip("set APP_CARD_CATALOG to the companion app's CardRulesCatalog.json to run this contract test; " +
      "it runs only where that checkout exists, so CI skips it");
  }
  const catalog = JSON.parse(fs.readFileSync(APP_CATALOG, "utf8"));
  assert.ok(Array.isArray(catalog.ruleSets) && catalog.ruleSets.length > 0, "the catalog holds rule sets");
  for (const rs of catalog.ruleSets) {
    assert.deepEqual(contractProblems(rs), [], rs.productKey);
    // Units: rate and reward.rate are fractions, Cap.percent and Fee.percent are percentages. check() cannot see a 25 where
    // 0.25 is meant, but no real rate exceeds 1 and no real percentage is a tiny fraction.
    const rates = [...rs.earn.map((e) => e.rate), ...(rs.milestones ?? []).flatMap((m) => [m.reward.rate, m.repeatReward?.rate])];
    for (const r of rates.filter((v) => v != null)) assert.ok(r >= 0 && r <= 1, rs.productKey + ": rate " + r + " is not a fraction");
    const percents = [...(rs.cardCaps ?? []), ...rs.earn.flatMap((e) => e.caps ?? []), ...(rs.fees ?? [])].map((x) => x.percent);
    for (const p of percents.filter((v) => v != null)) assert.ok(p > 0 && p <= 100, rs.productKey + ": percent " + p + " is not a percentage");
  }
});

// A rule set that uses every field beyond the original spec: points caps, a card-year cap, notes on
// caps, milestones and fees, repeatReward, a rate-boost reward, an unknown period, a fee with no
// stated rate, and creditLagDays. Synthetic.
const NO_MATCH = { merchants: null, categories: null, channels: null, paidVia: null, international: null };
const fixtureCap = (over) => ({ period: "cycle", kind: "absolute", amountINR: null, points: null, ruleId: null, multiple: null,
  percent: null, perMerchant: false, note: null, sourceUrl: null, ...over });
const fixtureReward = (over) => ({ kind: "points", valueINR: null, points: null, rate: null, note: null, ...over });
const FIXTURE_RULE_SET = {
  schemaVersion: 1, productKey: "fixture-points", issuer: "Example Bank", product: "Example Points Card", network: "rupay",
  rewardCurrency: "points", pointValue: { cashINR: 0.5, bestINR: 1, note: null },
  effectiveFrom: null, verifiedOn: null, status: "unverified", sources: [],
  earn: [{ id: "base", label: "4 points per Rs 150", priority: 0, isBase: true, match: NO_MATCH,
    rate: null, pointsPer: 4, perINR: 150, minTxnINR: null,
    caps: [fixtureCap({ period: "card-year", points: 20000, note: "20,000 points a card year" })],
    creditedTo: "points", countsTowardBase: true, stacks: false, sourceUrl: null, note: null }],
  exclusions: [],
  cardCaps: [fixtureCap({ points: 50000, note: "50,000 points per cycle" }), fixtureCap({ period: "unknown", kind: "unknown" })],
  milestones: [
    { id: "spend", label: "Spend milestone", period: "unknown", thresholdINR: 100000, repeatEveryINR: 50000, maxPerPeriod: 4,
      reward: fixtureReward({ points: 2000 }), repeatReward: fixtureReward({ points: 1000, note: "per further step" }),
      eligibleExcludes: [], sourceUrl: null, note: "Period not stated." },
    { id: "boost", label: "Rate boost", period: "month", thresholdINR: 50000, repeatEveryINR: null, maxPerPeriod: null,
      reward: fixtureReward({ kind: "rate-boost", rate: 0.03 }), repeatReward: null,
      eligibleExcludes: ["fuel"], sourceUrl: null, note: null },
  ],
  fees: [{ id: "service-fee", label: "Service fee", match: NO_MATCH, percent: null, gstOnFee: true, minTxnINR: null,
    monthlyThresholdINR: null, sourceUrl: null, note: "Rate not stated." }],
  creditLagDays: 45, notes: [],
};

test("a rule set with the app's extra fields passes, and a wrong type in any of them does not", () => {
  const { check, toJsonSchema } = appJobs;
  const fixture = () => structuredClone(FIXTURE_RULE_SET);
  const edit = (fn) => { const rs = fixture(); fn(rs); return check(RULE_SET_CHECKED, rs); };
  assert.deepEqual(contractProblems(FIXTURE_RULE_SET), []);

  // Every key stays required, null is how a fact is unknown.
  assert.deepEqual(edit((rs) => delete rs.creditLagDays), ["creditLagDays: missing"]);
  assert.deepEqual(edit((rs) => { rs.creditLagDays = null; }), []);
  assert.deepEqual(edit((rs) => delete rs.cardCaps[0].points), ["cardCaps[0].points: missing"]);
  assert.deepEqual(edit((rs) => delete rs.earn[0].caps[0].note), ["earn[0].caps[0].note: missing"]);
  assert.deepEqual(edit((rs) => delete rs.milestones[0].repeatReward), ["milestones[0].repeatReward: missing"]);
  assert.deepEqual(edit((rs) => delete rs.milestones[1].reward.rate), ["milestones[1].reward.rate: missing"]);
  assert.deepEqual(edit((rs) => delete rs.milestones[0].note), ["milestones[0].note: missing"]);
  assert.deepEqual(edit((rs) => delete rs.fees[0].note), ["fees[0].note: missing"]);

  // Types are still checked.
  assert.deepEqual(edit((rs) => { rs.creditLagDays = "45"; }), ["creditLagDays: expected integer, got string"]);
  assert.deepEqual(edit((rs) => { rs.creditLagDays = 4.5; }), ["creditLagDays: expected integer, got number"]);
  assert.deepEqual(edit((rs) => { rs.cardCaps[0].points = "50000"; }), ["cardCaps[0].points: expected number, got string"]);
  assert.deepEqual(edit((rs) => { rs.milestones[0].repeatReward = "none"; }), ["milestones[0].repeatReward: expected object, got string"]);
  assert.deepEqual(edit((rs) => { rs.milestones[1].reward.rate = "3%"; }), ["milestones[1].reward.rate: expected number, got string"]);
  assert.deepEqual(edit((rs) => { rs.fees[0].percent = "1"; }), ["fees[0].percent: expected number, got string"]);
  assert.deepEqual(edit((rs) => { rs.milestones[0].period = 3; }).length, 1);

  // Vocabulary stays lenient: a string the hub has not heard of passes check() ...
  assert.deepEqual(edit((rs) => { rs.milestones[0].period = "fortnight"; rs.cardCaps[0].period = "lifetime"; }), []);
  // ... and the drift guard is what names it, along with a field the shape lacks.
  const stray = fixture();
  stray.milestones[0].period = "fortnight";
  stray.cardCaps[0].bonus = 1;
  assert.deepEqual(drift(RULE_SET_CHECKED, stray), [
    "cardCaps[0].bonus: the hub's shape has no such field", `milestones[0].period: "fortnight" is not in the hub's vocabulary`]);

  // The generated --json-schema offers the model the new fields and values.
  const schema = JSON.parse(JSON.stringify(toJsonSchema(appJobs.TERMS_ANSWER_SHAPE)));
  const rs = schema.properties.ruleSet.anyOf[0].properties;
  assert.ok("creditLagDays" in rs);
  assert.ok("points" in rs.cardCaps.items.properties && "note" in rs.cardCaps.items.properties);
  const milestone = rs.milestones.items.properties;
  assert.ok("repeatReward" in milestone && "note" in milestone && "rate" in milestone.reward.properties);
  assert.ok(milestone.period.enum.includes("unknown") && milestone.period.enum.includes("month"));
  assert.ok(rs.cardCaps.items.properties.period.enum.includes("card-year"));
  assert.ok("note" in rs.fees.items.properties);
});

// ── Terms jobs ───────────────────────────────────────────────────────────────
test("a terms job fetches allowlisted sources into a per-card temp dir, runs Read only, and removes the dir", async (t) => {
  if (!tls) return t.skip("openssl is not available to mint a test certificate");
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin,
    BRIDGE_APP_FETCH_DOMAINS: src.host, NODE_EXTRA_CA_CERTS: tls.certFile });
  t.after(async () => { await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const r = await post(hub.base, { type: "terms-extract", input: { cards: [
    { cardKey: "example-card", issuer: "Example Bank", product: "Example Card",
      sources: [src.url("/tc.pdf"), src.url("/page.html"), src.url("/redirect-ok")], current: ruleSet(src.url("/tc.pdf")) },
    { cardKey: "dead-card", issuer: "Example Bank", product: "Dead Card",
      sources: [src.url("/missing"), src.url("/redirect-out")] },
  ] } });
  assert.equal(r.status, 202);
  const job = await waitJob(hub.base, (await r.json()).jobId);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.deepEqual(job.progress, { done: 2, total: 2 });
  assert.deepEqual(appJobs.check(appJobs.TERMS_RESULT_SHAPE, job.result), []);
  const [good, dead] = job.result.cards;

  assert.equal(good.cardKey, "example-card");
  assert.equal(good.status, "verified");
  assert.equal(good.ruleSet.schemaVersion, 1);
  assert.match(good.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(good.sources.map((s) => [s.ok, s.fetchedVia]), [[true, "direct"], [true, "direct"], [true, "direct"]]);
  assert.equal(good.sources[1].title, "Card & Terms");

  assert.equal(dead.status, "failed");
  assert.equal(dead.ruleSet, null);
  assert.deepEqual(dead.notes, ["none of the sources could be read"]);
  // A 503 is a failure a browser might get past, but the fallback is off by default.
  assert.equal(dead.sources[0].note, "direct fetch failed (HTTP 503); the Safari fallback is off on this hub");
  // A refused redirect is never handed to Safari, on or off.
  assert.equal(dead.sources[1].note, "direct fetch failed (redirected to host not-allowed.example is not on BRIDGE_APP_FETCH_DOMAINS)");

  const calls = stub.calls();
  assert.equal(calls.length, 1, "a card with nothing read never reaches the CLI");
  const [call] = calls;
  const at = (flag) => call.argv[call.argv.indexOf(flag) + 1];
  assert.equal(at("--tools"), "Read");
  assert.equal(at("--max-turns"), "24");
  assert.ok(call.argv.includes("--restricted") && call.argv.includes("--strict-mcp-config"));
  assert.ok(!call.argv.includes("--allowedTools") && !call.argv.includes("--add-dir"));
  assert.match(path.basename(call.cwd), /^claude-app-job-/);
  assert.deepEqual(Object.keys(call.files).sort(), ["source-1.pdf", "source-2.txt", "source-3.pdf"]);
  assert.ok(call.files["source-1.pdf"].startsWith("%PDF-"), "a PDF is saved as it came");
  const page = call.files["source-2.txt"];
  assert.match(page, /Earn 5% on bills – capped\./);
  assert.match(page, /Base\t1%/);
  assert.ok(!page.includes("SCRIPT-BODY-MUST-GO") && !page.includes("color:red") && !page.includes("<"), "HTML reduced to text");
  assert.match(call.stdin, /source-1\.pdf from https:\/\/127\.0\.0\.1/);
  assert.match(call.stdin, /"productKey":"test-card"/, "the current rule set rides on stdin");
  assert.ok(!fs.existsSync(call.cwd), "the temp dir is gone");
});

// A fake extension instance: long-polls the hub with BRIDGE_TOKEN, records
// every call it is handed, and keeps a few tabs (ids from 7; a navigate with
// newTab opens the next one, an existing tab shows whatever it was last
// navigated to). read(url) supplies the page a read of a tab returns. The
// owner's side: activate(id) makes a tab the one its window shows, close(id)
// removes it, and `tabs` lists them as the extension reports them.
function fakeExtension(hub, read) {
  const ctl = new AbortController();
  const served = [];
  const open = new Map();   // tabId -> { url, active }
  let nextTab = 7;
  const ext = { authorization: "Bearer " + BRIDGE_TOKEN, "x-claude-instance": "fake-ext", "x-claude-version": "0.44" };
  const answer = (call) => {
    const a = call.args || {};
    if (call.tool === "navigate") {
      if (a.newTab) { const tabId = nextTab++; open.set(tabId, { url: a.url, active: !!a.active }); return { result: { tabId, windowId: 1, url: a.url, opened: "new tab", active: !!a.active } }; }
      const tab = open.get(a.tabId);
      if (!tab) return { error: "no tab " + a.tabId };
      tab.url = a.url;
      return { result: { tabId: a.tabId, windowId: 1, url: a.url, opened: "current tab", active: tab.active } };
    }
    if (call.tool === "read") {
      const tab = open.get(a.tabId);
      return tab ? { result: { tabId: a.tabId, ...read(tab.url) } } : { error: "no tab " + a.tabId };
    }
    if (call.tool === "tabs") {
      return { result: [...open].map(([tabId, t]) => ({ tabId, windowId: 1, active: t.active, url: t.url, title: "t", favIconUrl: null, owned: true })) };
    }
    return { result: call.tool === "probeActive" ? { tabId: 3, owned: true } : null };
  };
  (async () => {
    while (!ctl.signal.aborted) {
      let r;
      try { r = await fetch(hub.base + "/pull", { method: "POST", headers: ext, signal: ctl.signal }); } catch { await sleep(20); continue; }
      if (r.status !== 200) continue;
      const call = await r.json();
      served.push({ tool: call.tool, args: call.args, at: Date.now() });
      await fetch(hub.base + "/result", { method: "POST", headers: { ...ext, "content-type": "application/json" },
        body: JSON.stringify({ id: call.id, ...answer(call) }) }).catch(() => {});
    }
  })();
  return {
    served,
    navigations: () => served.filter((c) => c.tool === "navigate").map((c) => c.args),
    activate: (id) => { for (const [k, t] of open) t.active = k === id; },
    close: (id) => { open.delete(id); },
    stop: () => ctl.abort(),
    polling: async () => {
      for (let i = 0; i < 100; i++) {
        const st = await (await fetch(hub.base + "/status", { headers: { authorization: "Bearer " + BRIDGE_TOKEN } })).json();
        if (st.instances && st.instances.length) return;
        await sleep(30);
      }
      throw new Error("the fake extension never registered");
    },
  };
}
const renders = (url) => ({ url, title: "Rendered Terms", text: "Rendered by Safari. " + PAGE_TEXT });

test("without BRIDGE_APP_SAFARI_FALLBACK=1 the app token never makes Safari navigate", async (t) => {
  if (!tls) return t.skip("openssl is not available to mint a test certificate");
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin,
    BRIDGE_APP_FETCH_DOMAINS: src.host, NODE_EXTRA_CA_CERTS: tls.certFile, BRIDGE_APP_SAFARI_FALLBACK: undefined });
  const ext = fakeExtension(hub, renders);
  t.after(async () => { ext.stop(); await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  await ext.polling();
  const h = await (await fetch(hub.base + "/app/health", { headers: appHeaders })).json();
  assert.equal(h.safariFallback, false);
  const r = await post(hub.base, { type: "terms-extract", input: { cards: [
    { cardKey: "spa-card", issuer: "Example Bank", product: "Example Card", sources: [src.url("/spa.html"), src.url("/forbidden")] }] } });
  const job = await waitJob(hub.base, (await r.json()).jobId);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.deepEqual(job.result.cards[0].sources.map((x) => x.note), [
    "direct fetch failed (the page has almost no text without running its scripts); the Safari fallback is off on this hub",
    "direct fetch failed (HTTP 403); the Safari fallback is off on this hub"]);
  assert.deepEqual(ext.served, [], "the extension was handed nothing");
});

test("with the fallback on, a job reads its failed sources through ONE background tab and blanks it at the end", async (t) => {
  if (!tls) return t.skip("openssl is not available to mint a test certificate");
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin,
    BRIDGE_APP_FETCH_DOMAINS: src.host, NODE_EXTRA_CA_CERTS: tls.certFile, BRIDGE_APP_SAFARI_FALLBACK: "1" });
  const ext = fakeExtension(hub, renders);
  t.after(async () => { ext.stop(); await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  await ext.polling();
  const h = await (await fetch(hub.base + "/app/health", { headers: appHeaders })).json();
  assert.equal(h.safariFallback, true);
  assert.equal(h.limits.safariPagesPerJob, 5);
  assert.equal(h.limits.safariPagesPerHour, 20);
  const spa = src.url("/spa.html"), forbidden = src.url("/forbidden"), out = src.url("/redirect-out");
  const r = await post(hub.base, { type: "terms-extract", input: { cards: [
    { cardKey: "spa-card", issuer: "Example Bank", product: "Example Card", sources: [spa, forbidden, out] }] } });
  const job = await waitJob(hub.base, (await r.json()).jobId, undefined, 600);
  assert.equal(job.status, "done", JSON.stringify(job));
  const [card] = job.result.cards;
  assert.equal(card.status, "verified");
  assert.deepEqual(card.sources, [
    { url: spa, title: "Rendered Terms", fetchedVia: "safari", ok: true,
      note: "direct fetch failed (the page has almost no text without running its scripts)" },
    { url: forbidden, title: "Rendered Terms", fetchedVia: "safari", ok: true, note: "direct fetch failed (HTTP 403)" },
    { url: out, title: null, fetchedVia: "direct", ok: false,
      note: "direct fetch failed (redirected to host not-allowed.example is not on BRIDGE_APP_FETCH_DOMAINS)" }]);
  // One tab: opened in the background once, re-navigated, then blanked; the
  // refused redirect never reached Safari.
  await until(() => ext.navigations().length === 3);
  const navs = ext.navigations().map(({ url, tabId, newTab, active }) => ({ url, tabId, newTab, active }));
  assert.deepEqual(navs, [
    { url: spa, tabId: undefined, newTab: true, active: false },
    { url: forbidden, tabId: 7, newTab: false, active: false },
    { url: "about:blank", tabId: 7, newTab: false, active: false }]);
  assert.ok(ext.served.filter((c) => c.tool === "read").every((c) => c.args.tabId === 7), "every read is pinned to the job's tab");
  assert.match(stub.calls()[0].files["source-1.txt"], /^Rendered by Safari\./);
});

test("a job's tab is left alone once the owner has switched to it or closed it", async (t) => {
  if (!tls) return t.skip("openssl is not available to mint a test certificate");
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin,
    BRIDGE_APP_FETCH_DOMAINS: src.host, NODE_EXTRA_CA_CERTS: tls.certFile, BRIDGE_APP_SAFARI_FALLBACK: "1" });
  const spa = src.url("/spa.html"), forbidden = src.url("/forbidden"), reset = src.url("/reset");
  // The owner switches to the job's tab after the first page and closes the
  // second tab after the second; the third source must not touch either.
  const ext = fakeExtension(hub, (url) => {
    if (url === spa) ext.activate(7);
    if (url === forbidden) ext.close(8);
    return renders(url);
  });
  t.after(async () => { ext.stop(); await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  await ext.polling();
  const r = await post(hub.base, { type: "terms-extract", input: { cards: [
    { cardKey: "spa-card", issuer: "Example Bank", product: "Example Card", sources: [spa, forbidden, reset] }] } });
  const job = await waitJob(hub.base, (await r.json()).jobId, undefined, 800);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.deepEqual(job.result.cards[0].sources.map((x) => x.fetchedVia), ["safari", "safari", "safari"]);
  await until(() => ext.navigations().length === 4);
  const navs = ext.navigations().map(({ url, tabId, newTab, active }) => ({ url, tabId, newTab, active }));
  assert.deepEqual(navs, [
    { url: spa, tabId: undefined, newTab: true, active: false },
    { url: forbidden, tabId: undefined, newTab: true, active: false },
    { url: reset, tabId: undefined, newTab: true, active: false },
    { url: "about:blank", tabId: 9, newTab: false, active: false }]);
  assert.deepEqual(ext.served.filter((c) => c.tool === "read").map((c) => c.args.tabId), [7, 8, 9], "each read is pinned to its own tab");
});

test("a tab the owner is looking at when the job ends is not blanked", async (t) => {
  if (!tls) return t.skip("openssl is not available to mint a test certificate");
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin,
    BRIDGE_APP_FETCH_DOMAINS: src.host, NODE_EXTRA_CA_CERTS: tls.certFile, BRIDGE_APP_SAFARI_FALLBACK: "1" });
  const ext = fakeExtension(hub, (url) => { ext.activate(7); return renders(url); });
  t.after(async () => { ext.stop(); await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  await ext.polling();
  const r = await post(hub.base, { type: "terms-extract", input: { cards: [
    { cardKey: "spa-card", issuer: "Example Bank", product: "Example Card", sources: [src.url("/spa.html")] }] } });
  const job = await waitJob(hub.base, (await r.json()).jobId, undefined, 600);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.ok(await until(() => ext.served.some((c) => c.tool === "tabs")), "the release looked before it touched the tab");
  await sleep(300);
  assert.deepEqual(ext.navigations().map((n) => n.url), [src.url("/spa.html")], "no about:blank went to the owner's tab");
});

test("SIGTERM to the hub blanks a running job's tab before it exits", async (t) => {
  if (!tls) return t.skip("openssl is not available to mint a test certificate");
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin,
    BRIDGE_APP_FETCH_DOMAINS: src.host, NODE_EXTRA_CA_CERTS: tls.certFile, BRIDGE_APP_SAFARI_FALLBACK: "1" });
  // A page that never gets enough text: the job is in its read loop.
  const ext = fakeExtension(hub, (url) => ({ url, title: null, text: "Loading..." }));
  t.after(async () => { ext.stop(); await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  await ext.polling();
  const r = await post(hub.base, { type: "terms-extract", input: { cards: [
    { cardKey: "spa-card", issuer: "Example Bank", product: "Example Card", sources: [src.url("/spa.html")] }] } });
  assert.equal(r.status, 202);
  await until(() => ext.served.some((c) => c.tool === "read"));
  hub.proc.kill("SIGTERM");
  const { signal } = await hub.exited;
  assert.equal(signal, "SIGTERM", "the hub still dies by the signal it was sent");
  assert.deepEqual(ext.navigations().filter((n) => n.url === "about:blank").map((n) => n.tabId), [7], "the tab was blanked once");
});

test("DELETE during the Safari phase frees the slot at once and blanks the tab", async (t) => {
  if (!tls) return t.skip("openssl is not available to mint a test certificate");
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin,
    BRIDGE_APP_FETCH_DOMAINS: src.host, NODE_EXTRA_CA_CERTS: tls.certFile, BRIDGE_APP_SAFARI_FALLBACK: "1" });
  // A page that never gets enough text, so the read loop would go on for 20 s.
  const ext = fakeExtension(hub, (url) => ({ url, title: null, text: "Loading..." }));
  t.after(async () => { ext.stop(); await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  await ext.polling();
  const r = await post(hub.base, { type: "terms-extract", input: { cards: [
    { cardKey: "spa-card", issuer: "Example Bank", product: "Example Card", sources: [src.url("/spa.html")] }] } });
  const { jobId } = await r.json();
  await until(() => ext.served.some((c) => c.tool === "read"));
  const t0 = Date.now();
  assert.equal((await fetch(hub.base + "/app/jobs/" + jobId, { method: "DELETE", headers: appHeaders })).status, 200);
  const health = async () => (await fetch(hub.base + "/app/health", { headers: appHeaders })).json();
  let h = await health();
  while (h.running && Date.now() - t0 < 3000) { await sleep(20); h = await health(); }
  assert.equal(h.running, 0, "the slot is free");
  assert.ok(Date.now() - t0 < 1000, "within a second, not after the 20 s read loop");
  assert.ok(await until(() => ext.navigations().some((n) => n.url === "about:blank" && n.tabId === 7)), "the tab was blanked");
  assert.equal(stub.calls().length, 0, "Claude never ran");
});

// ── The fetcher ──────────────────────────────────────────────────────────────
test("the fetcher re-checks every redirect and caps time, size and hops", async (t) => {
  if (!tls) return t.skip("openssl is not available to mint a test certificate");
  const allow = new Set([src.host]);
  const get = (p, extra = {}) => appJobs.fetchSource(src.url(p), { allow, ca: tls.cert, ...extra });
  const pdf = await get("/redirect-ok");
  assert.equal(pdf.ext, ".pdf");
  assert.equal(pdf.url, src.url("/tc.pdf"));
  assert.equal((await get("/octet")).ext, ".pdf", "a PDF served as octet-stream is sniffed");
  await assert.rejects(get("/redirect-out"), /redirected to host not-allowed\.example/);
  await assert.rejects(get("/loop"), /more than 5 redirects/);
  await assert.rejects(get("/declared-big"), /larger than 8 MB/);
  await assert.rejects(get("/chunked-big"), /larger than 8 MB/);
  await assert.rejects(get("/json"), /unsupported content type application\/json/);
  await assert.rejects(get("/spa.html"), /almost no text/);
  await assert.rejects(get("/slow", { totalMs: 300 }), /took longer than 0.3 s/);
  // Compressed bodies are decoded, and the 8 MB cap counts DECODED bytes.
  for (const p of ["/gz", "/br", "/deflate"]) {
    const page = await get(p);
    assert.equal(page.title, "Packed", p);
    assert.match(page.data.toString(), /Cashback terms for the Example Card\./, p);
  }
  await assert.rejects(get("/bomb"), /larger than 8 MB/);
  // Each failure carries a kind, and only a browser-fixable one may go to Safari.
  const kindOf = async (p, extra) => { try { await get(p, extra); return "resolved"; } catch (e) { return [e.kind, e.status, appJobs.browserCanFix(e)]; } };
  assert.deepEqual(await kindOf("/spa.html"), ["no-text", null, true]);
  assert.deepEqual(await kindOf("/forbidden"), ["http", 403, true]);
  assert.deepEqual(await kindOf("/missing"), ["http", 503, true]);
  assert.deepEqual(await kindOf("/reset"), ["reset", null, true]);
  assert.deepEqual(await kindOf("/redirect-out"), ["refused", null, false]);
  assert.deepEqual(await kindOf("/redirect-http"), ["refused", null, false]);
  assert.deepEqual(await kindOf("/redirect-creds"), ["refused", null, false]);
  assert.deepEqual(await kindOf("/loop"), ["other", null, false]);
  assert.deepEqual(await kindOf("/json"), ["other", null, false]);
  assert.deepEqual(await kindOf("/chunked-big"), ["other", null, false]);
  // A signal cancels a fetch in flight.
  const ctl = new AbortController();
  const pending = get("/slow", { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(pending, (e) => e.kind === "cancelled");
  await assert.rejects(appJobs.fetchSource("http://" + src.host + "/tc.pdf", { allow, ca: tls.cert }), /not an https URL/);
  // A listener that never completes a TLS handshake trips the connect timeout.
  const silent = net.createServer(() => {}).listen(0, "127.0.0.1");
  await new Promise((r) => silent.once("listening", r));
  t.after(() => silent.close());
  const host = "127.0.0.1:" + silent.address().port;
  await assert.rejects(appJobs.fetchSource("https://" + host + "/", { allow: new Set([host]), connectMs: 200 }), /no connection within 0.2 s/);
});

test("HTML is reduced to text in linear time and keeps its structure", () => {
  // Every unit here made the old regex stripper quadratic: 160 KB of "<script "
  // took 2.0 s and 40 KB of "<" 0.8 s (measured 2026-11-15), so a hostile 8 MB
  // page, the fetch cap, would have held the hub's event loop for over an hour.
  // The bound is loose on purpose: the test files run in parallel and share
  // the CPU, and linear stays far under it (0.01-0.45 s each, measured alone).
  // The last four are elements that never close, or close with no <body> after:
  // the cases that must resume past the opening tag without a scan to the end.
  for (const unit of ["<script ", "<!--", "<", "<title>", "<p ", "<head>", "&abcdefgh", "</div ", "\t \t\n",
    "<svg>", "<script></scripts", "<head></head>", "<head><body"]) {
    const html = unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length));
    const t0 = Date.now();
    appJobs.htmlToText(html);
    const ms = Date.now() - t0;
    assert.ok(ms < 5000, JSON.stringify(unit) + " x 8 MB took " + ms + " ms");
  }
  const { title, text } = appJobs.htmlToText("<!DOCTYPE html><HTML><Head><TITLE>T &amp; C</TITLE><Style>.x{}</Style></Head>" +
    "<BODY>a < b<br>c<!-- gone --><UL><LI>one</LI><li>two</ul><Table><TR><TD>Base</TD><td>1%</td></TR></Table>" +
    "<header-line>kept</header-line><SCRIPT type=x>bad()</script ><p>after &#8377;5 &rupee;</p><noscript>no</noscript>tail<p");
  assert.equal(title, "T & C");
  assert.equal(text, "a < b\nc\n- one\n\n- two\n\tBase\t1%\n\nkept after \u20b95 \u20b9\ntail");
  assert.deepEqual(appJobs.htmlToText("<html><body><div id=app></div></body></html>"), { title: null, text: "" });
});

test("a raw-text element that never closes does not swallow the page", () => {
  // The first linear-time rewrite skipped an unclosed <head> or <svg> to the
  // end of the page, so a minified page without </head> (legal HTML: the
  // parser infers it) or with a self-closing <svg class=i /> before the body
  // came out empty where the regex version kept about 300 characters.
  const text = (html) => appJobs.htmlToText(html).text;
  const noHeadClose = "<!DOCTYPE html><html><head><meta charset=utf-8><title>T</title><style>.x{}</style>" +
    "<script>HEAD-SCRIPT()</script><body><p>Body text survives.</p></body></html>";
  assert.equal(text(noHeadClose), "Body text survives.");
  assert.equal(appJobs.htmlToText(noHeadClose).title, "T");
  assert.equal(text("<html><head><title>T</title><body class=x>No head close, no style.</body>"), "No head close, no style.");
  assert.equal(text("<html><head><title>T</title></head><body><p>Closed head.</p></body></html>"), "Closed head.",
    "a head that closes still hides its content");
  assert.equal(text("<html><head><title>T</title></head><header>Banner</header>"), "Banner", "</head never matches </header");
  assert.equal(text("<html><body><svg class=i /><p>After a self-closing svg.</p></body></html>"), "After a self-closing svg.");
  assert.equal(text("<body><svg viewBox='0 0 1 1'/>one<svg />two"), "one two");
  assert.equal(text("<body><svg><path d='M0'/></svg>kept<svg><p>never closed, still text</p>"),
    "kept never closed, still text");
  assert.equal(text("<body><script>no close</p><p>text after an unclosed script</p>"), "no close\ntext after an unclosed script");
});

test("a terms result links only to the card's requested sources", async (t) => {
  const stub = makeStub();
  const jobs = inProcess(stub);
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const id = jobs.submit({ type: "terms-extract", input: { cards: [{ cardKey: "inject-card", issuer: "Example Bank",
    product: "Example Card", sources: ["https://terms.example/tc.pdf"] }] } }).body.jobId;
  const job = await until(() => { const j = jobs.get(id); return j && j.status === "done" ? j : null; });
  assert.ok(job, "done");
  assert.deepEqual(appJobs.check(appJobs.TERMS_RESULT_SHAPE, job.result), []);
  const { ruleSet: rs, notes } = job.result.cards[0];
  const want = "https://terms.example/tc.pdf";
  assert.deepEqual(rs.sources.map((x) => x.url), [want], "the injected source is dropped; the other is respelled");
  assert.equal(rs.earn[0].sourceUrl, null);
  assert.equal(rs.earn[0].caps[0].sourceUrl, null);
  assert.equal(rs.fees[0].sourceUrl, want, "a fragment of a requested URL is still that URL");
  assert.match(notes[notes.length - 1], /^3 cited link\(s\) that were not among the requested sources were removed$/);
  const flat = JSON.stringify(job.result);
  assert.ok(!flat.includes("evil.example") && !flat.includes("javascript:"));
});

// ── Lifecycle, in process ────────────────────────────────────────────────────
const inProcess = (stub, extra = {}) => appJobs.createAppJobs({
  claudeBin: stub.bin, env: { PATH: process.env.PATH, HOME: os.homedir(), BRIDGE_TOKEN: "x", BRIDGE_APP_TOKEN: "y" }, cliProbe: false,
  fetchDomains: "terms.example", log: () => {},
  fetchSource: async (url) => ({ url, ext: ".pdf", data: PDF, title: null }), ...extra });
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(20); }
  return fn();
}

// A fake Safari driver: each session records its reads and its release.
function fakeSafari(read = async (url) => renders(url)) {
  const sessions = [];
  return {
    sessions,
    driver: { available: () => true, session: () => {
      const s = { reads: [], released: 0 };
      sessions.push(s);
      return { read: (url, o) => { s.reads.push(url); return read(url, o); }, release: async () => { s.released += 1; } };
    } },
  };
}
const fails = (kind, status = null) => async (url) => { throw new appJobs.FetchError(kind + " " + url, kind, status); };
const termsJob = (cards) => ({ type: "terms-extract", input: { cards: cards.map(([cardKey, sources]) => ({ cardKey,
  issuer: "Example Bank", product: "Example Card", sources: sources.map((p) => "https://terms.example" + p) })) } });
const doneJob = (jobs, id, ms) => until(() => { const j = jobs.get(id); return j && (j.status === "done" || j.status === "failed") ? j : null; }, ms);

test("close() releases a running job's Safari tab once, waits for the answer, and refuses new jobs", async (t) => {
  const stub = makeStub();
  const safari = fakeSafari(() => new Promise(() => {}));   // a read that never answers
  let answered = false;
  const driver = { ...safari.driver, session: () => {
    const s = safari.driver.session();
    return { ...s, release: async () => { await sleep(100); answered = true; return s.release(); } };
  } };
  const jobs = inProcess(stub, { safari: driver, fetchSource: fails("no-text") });
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const id = jobs.submit(termsJob([["card-one", ["/a"]]])).body.jobId;
  assert.ok(await until(() => safari.sessions[0] && safari.sessions[0].reads.length), "the job is reading through Safari");
  await jobs.close();
  assert.equal(answered, true, "close() waited for the release to be answered");
  assert.equal(safari.sessions[0].released, 1);
  await sleep(100);
  assert.equal(safari.sessions[0].released, 1, "the job's own finally does not release it a second time");
  assert.equal(jobs.get(id), null);
  assert.deepEqual(jobs.submit(termsJob([["card-two", ["/b"]]])), { status: 503, body: { error: "the hub is stopping" } });
});

test("the fallback runs only for browser-fixable failures, through one session per job, within its page caps", async (t) => {
  const stub = makeStub();
  const safari = fakeSafari();
  const kinds = { "/a": ["no-text"], "/b": ["http", 403], "/c": ["http", 429], "/d": ["reset"], "/e": ["refused"],
    "/f": ["http", 404], "/g": ["other"], "/h": ["http", 503], "/i": ["no-text"] };
  const jobs = inProcess(stub, { safari: safari.driver, safariPerJob: 5, safariPerHour: 7,
    fetchSource: async (url) => { const [kind, status] = kinds[new URL(url).pathname]; throw new appJobs.FetchError(kind, kind, status || null); } });
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const id = jobs.submit(termsJob([["card-one", ["/a", "/b", "/e", "/f", "/g"]], ["card-two", ["/c", "/d", "/h", "/i"]]])).body.jobId;
  const job = await doneJob(jobs, id);
  assert.equal(job.status, "done", JSON.stringify(job));
  const notes = job.result.cards.flatMap((c) => c.sources.map((x) => [new URL(x.url).pathname, x.fetchedVia, x.note]));
  assert.deepEqual(notes, [
    ["/a", "safari", "direct fetch failed (no-text)"],
    ["/b", "safari", "direct fetch failed (http)"],
    ["/e", "direct", "direct fetch failed (refused)"],
    ["/f", "direct", "direct fetch failed (http)"],
    ["/g", "direct", "direct fetch failed (other)"],
    ["/c", "safari", "direct fetch failed (http)"],
    ["/d", "safari", "direct fetch failed (reset)"],
    ["/h", "safari", "direct fetch failed (http)"],
    ["/i", "direct", "direct fetch failed (no-text); the Safari fallback's 5 pages for this job are used up"]]);
  assert.equal(safari.sessions.length, 1, "one tab for the whole job");
  assert.equal(safari.sessions[0].reads.length, 5);
  assert.ok(await until(() => safari.sessions[0].released === 1), "released once, at the end");
  // The hour has 2 of its 7 pages left, across jobs.
  const id2 = jobs.submit(termsJob([["card-three", ["/a", "/b", "/c"]]])).body.jobId;
  const job2 = await doneJob(jobs, id2);
  assert.deepEqual(job2.result.cards[0].sources.map((x) => x.fetchedVia), ["safari", "safari", "direct"]);
  assert.match(job2.result.cards[0].sources[2].note, /the Safari fallback's 7 pages for this hour are used up$/);
  assert.ok(await until(() => safari.sessions[1] && safari.sessions[1].released === 1));
});

test("a page Safari ends on outside the allowlist is discarded", async (t) => {
  const stub = makeStub();
  const safari = fakeSafari(async () => ({ url: "https://evil.example/landing", title: "Elsewhere", text: PAGE_TEXT }));
  const jobs = inProcess(stub, { safari: safari.driver, fetchSource: fails("no-text") });
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const job = await doneJob(jobs, jobs.submit(termsJob([["card-one", ["/a"]]])).body.jobId);
  const [card] = job.result.cards;
  assert.equal(card.status, "failed");
  assert.deepEqual(card.sources[0], { url: "https://terms.example/a", title: null, fetchedVia: "direct", ok: false,
    note: "direct fetch failed (no-text https://terms.example/a); Safari: Safari ended on host evil.example is not on BRIDGE_APP_FETCH_DOMAINS" });
  assert.equal(stub.calls().length, 0, "nothing reached Claude");
});

test("the per-card deadline holds in the fetch and Safari phases", async (t) => {
  const stub = makeStub();
  const never = () => new Promise(() => {});
  const safari = fakeSafari(never);
  const jobs = inProcess(stub, { safari: safari.driver, termsCardTimeoutMs: 400,
    fetchSource: async (url) => (url.endsWith("/hang") ? never() : fails("no-text")(url)) });
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const t0 = Date.now();
  const job = await doneJob(jobs, jobs.submit(termsJob([["card-one", ["/hang"]], ["card-two", ["/spa"]]])).body.jobId);
  assert.ok(Date.now() - t0 < 2000, "two 0.4 s cards ended in " + (Date.now() - t0) + " ms");
  assert.equal(job.status, "done");
  assert.deepEqual(job.result.cards.map((c) => c.sources[0].note), [
    "direct fetch failed (ran out of time)",
    "direct fetch failed (no-text https://terms.example/spa); Safari: ran out of time"]);
  assert.ok(await until(() => safari.sessions[0].released === 1));
});

test("DELETE during the fetch phase frees the slot at once and aborts the fetch", async (t) => {
  const stub = makeStub();
  let signal = null;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-appjobs-root-"));
  const jobs = inProcess(stub, { tmpRoot, fetchSource: (url, o) => { signal = o.signal; return new Promise(() => {}); } });
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); fs.rmSync(tmpRoot, { recursive: true, force: true }); });
  const id = jobs.submit(termsJob([["card-one", ["/a"]]])).body.jobId;
  await until(() => signal);
  assert.equal(fs.readdirSync(tmpRoot).length, 1, "the card's temp dir exists while it fetches");
  const t0 = Date.now();
  assert.equal(jobs.remove(id), true);
  assert.equal(signal.aborted, true, "the fetch's signal fired");
  assert.ok(await until(() => jobs.stats().running === 0, 1000), "the slot is free");
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(fs.readdirSync(tmpRoot), [], "and its temp dir is gone");
});

test("finished jobs are purged after purgeMs", async (t) => {
  const stub = makeStub();
  const jobs = inProcess(stub, { purgeMs: 150 });
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const { body } = jobs.submit(statementBody("synthetic"));
  const done = await until(() => { const j = jobs.get(body.jobId); return j && j.status === "done" ? j : null; });
  assert.ok(done, "finished");
  await sleep(300);
  assert.equal(jobs.get(body.jobId), null);
});

test("DELETE kills a running child, and a deleted terms job leaves no temp dir", async (t) => {
  const stub = makeStub();
  const jobs = inProcess(stub);
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const a = jobs.submit(statementBody("STUB-SLOW")).body.jobId;
  const call = await until(() => stub.calls()[0]);
  assert.ok(alive(call.pid));
  assert.equal(jobs.get(a).status, "running");
  assert.equal(jobs.remove(a), true);
  assert.equal(jobs.get(a), null);
  assert.ok(await until(() => !alive(call.pid)), "the child is gone");

  const b = jobs.submit({ type: "terms-extract", input: { cards: [{ cardKey: "slow-card", issuer: "Example Bank",
    product: "Example Card", sources: ["https://terms.example/tc.pdf"] }] } }).body.jobId;
  const termsCall = await until(() => stub.calls()[1]);
  assert.ok(fs.existsSync(termsCall.cwd), "the temp dir exists while the card runs");
  assert.deepEqual(Object.keys(termsCall.files), ["source-1.pdf"]);
  assert.equal(jobs.remove(b), true);
  assert.ok(await until(() => !fs.existsSync(termsCall.cwd)), "the temp dir is removed");
  assert.ok(await until(() => !alive(termsCall.pid)));
  assert.equal(jobs.remove(b), false);
});

test("two jobs run at once, the queue holds maxQueued, and beyond that is 429", async (t) => {
  const stub = makeStub();
  const jobs = inProcess(stub, { maxQueued: 3 });
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = jobs.submit(statementBody("STUB-SLOW " + i));
    assert.equal(r.status, 202);
    ids.push(r.body.jobId);
  }
  const full = jobs.submit(statementBody("STUB-SLOW extra"));
  assert.equal(full.status, 429);
  assert.match(full.body.error, /2 running and 3 queued/);
  assert.deepEqual(jobs.stats(), { running: 2, queued: 3, jobs: 5 });
  await until(() => stub.calls().length === 2);
  await sleep(200);
  assert.equal(stub.calls().length, 2, "only two children");
  assert.deepEqual(ids.map((id) => jobs.get(id).status), ["running", "running", "queued", "queued", "queued"]);
  // A slot freed by DELETE goes to the next queued job.
  jobs.remove(ids[0]);
  await until(() => stub.calls().length === 3);
  assert.equal(jobs.get(ids[2]).status, "running");
  assert.deepEqual(jobs.stats(), { running: 2, queued: 2, jobs: 4 });
  // Deleting a queued job just drops it.
  assert.equal(jobs.remove(ids[4]), true);
  assert.equal(jobs.stats().queued, 1);
});

test("one terms job runs at a time, so a statement job behind two of them still gets a slot", async (t) => {
  const stub = makeStub();
  const jobs = inProcess(stub);
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const slowTerms = () => jobs.submit({ type: "terms-extract", input: { cards: [{ cardKey: "slow-card", issuer: "Example Bank",
    product: "Example Card", sources: ["https://terms.example/tc.pdf"] }] } }).body.jobId;
  const a = slowTerms();
  const b = slowTerms();
  const c = jobs.submit(statementBody("STUB-SLOW statement")).body.jobId;
  await until(() => stub.calls().length === 2);
  await sleep(200);
  assert.deepEqual([a, b, c].map((id) => jobs.get(id).status), ["running", "queued", "running"]);
  assert.equal(stub.calls().length, 2);
  assert.ok(stub.calls().some((x) => x.stdin.includes("STUB-SLOW statement")), "the statement job's child started");
  assert.equal(jobs.health().limits.maxTermsRunning, 1);
  // When the running terms job ends, the queued one takes its place.
  jobs.remove(a);
  await until(() => jobs.get(b).status === "running");
  assert.equal(jobs.get(b).status, "running");
});

test("a statement job that outlives its timeout fails and its child is killed", async (t) => {
  const stub = makeStub();
  const jobs = inProcess(stub, { statementTimeoutMs: 400 });
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const id = jobs.submit(statementBody("STUB-SLOW")).body.jobId;
  const job = await until(() => { const j = jobs.get(id); return j.status === "failed" ? j : null; });
  assert.ok(job, "failed");
  assert.equal(job.error, "timed out after 0.4 s");
  assert.ok(await until(() => !alive(stub.calls()[0].pid)));
});

test("the hub probes its claude CLI's flags at startup and reports the version", async (t) => {
  const stub = makeStub();
  t.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin });
  t.after(hub.stop);
  const health = async (h) => (await fetch(h.base + "/app/health", { headers: appHeaders })).json();
  let h = await health(hub);
  for (let i = 0; i < 100 && h.cli.state === "checking"; i++) { await sleep(30); h = await health(hub); }
  assert.deepEqual({ ok: h.ok, error: h.error, cli: h.cli },
    { ok: true, error: null, cli: { state: "ok", version: "9.9.9 (Claude Code stub)", missing: [] } });
  assert.match(hub.stderr(), /app-jobs: claude CLI 9\.9\.9 \(Claude Code stub\): every flag app jobs use is there/);
  assert.equal(stub.calls().length, 0, "the probe is not a job");

  // An older CLI without --json-schema and --restricted: jobs stay off, and say why.
  const old = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin, STUB_HELP_OMITS: "--json-schema,--restricted" });
  t.after(old.stop);
  h = await health(old);
  for (let i = 0; i < 100 && h.cli.state === "checking"; i++) { await sleep(30); h = await health(old); }
  assert.equal(h.ok, false);
  assert.deepEqual(h.cli, { state: "unusable", version: "9.9.9 (Claude Code stub)", missing: ["--restricted", "--json-schema"] });
  assert.match(h.error, /has no --restricted, --json-schema, which app jobs rely on; app jobs are off/);
  const r = await post(old.base, statementBody("x"));
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /has no --restricted, --json-schema/);
  assert.equal(stub.calls().length, 0);
});

test("jobs queued while the probe runs start once it passes, or fail with its error", async (t) => {
  const stub = makeStub();
  t.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
  const make = (env) => appJobs.createAppJobs({ claudeBin: stub.bin, env: { PATH: process.env.PATH, HOME: os.homedir(), ...env }, log: () => {} });
  const good = make({});
  t.after(() => good.close());
  const id = good.submit(statementBody("queued during the probe")).body.jobId;
  assert.equal(good.get(id).status, "queued");
  assert.ok(await until(() => good.get(id).status === "done"), "ran once the probe passed");
  const bad = make({ STUB_HELP_OMITS: "--no-session-persistence" });
  t.after(() => bad.close());
  const id2 = bad.submit(statementBody("queued during the probe")).body.jobId;
  const failed = await until(() => { const j = bad.get(id2); return j.status === "failed" ? j : null; });
  assert.match(failed.error, /has no --no-session-persistence/);
  assert.equal(bad.submit(statementBody("after")).status, 503);
  // A flag that only prefixes another (--tools-extra) does not count as --tools.
  const prefix = make({ STUB_HELP_OMITS: "--tools" });
  t.after(() => prefix.close());
  assert.ok(await until(() => prefix.health().cli.state === "unusable"));
  assert.deepEqual(prefix.health().cli.missing, ["--tools"]);
  const gone = appJobs.createAppJobs({ claudeBin: path.join(stub.dir, "no-such-claude"), log: () => {} });
  t.after(() => gone.close());
  assert.ok(await until(() => gone.health().cli.state === "unusable"));
  assert.match(gone.health().error, /could not start the claude CLI \(ENOENT\)/);
  assert.equal(stub.calls().filter((c) => c.stdin.includes("queued during the probe")).length, 1, "only the good hub's job ran");
});

test("today is computed in BRIDGE_APP_TIME_ZONE, not the host's zone", async () => {
  // 18:30 UTC is midnight in India: one second either side is a different day there.
  assert.equal(appJobs.localDate("Asia/Kolkata", new Date("2026-11-14T18:29:59Z")), "2026-11-14");
  assert.equal(appJobs.localDate("Asia/Kolkata", new Date("2026-11-14T18:30:00Z")), "2026-11-15");
  assert.equal(appJobs.localDate("UTC", new Date("2026-11-14T18:30:00Z")), "2026-11-14");
  assert.equal(appJobs.localDate("America/New_York", new Date("2026-01-01T04:59:59Z")), "2025-12-31");
  const jobs = appJobs.createAppJobs({ cliProbe: false, log: () => {} });
  assert.equal(jobs.health().timeZone, "Asia/Kolkata", "the default");
  assert.throws(() => appJobs.createAppJobs({ timeZone: "Mars/Olympus", log: () => {} }), /BRIDGE_APP_TIME_ZONE "Mars\/Olympus" is not an IANA time zone/);
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, BRIDGE_APP_TIME_ZONE: "Mars/Olympus" }, { expectExit: true });
  const { code } = await hub.exited;
  await hub.stop();
  assert.equal(code, 1);
  assert.match(hub.stderr(), /refusing to start: BRIDGE_APP_TIME_ZONE "Mars\/Olympus" is not an IANA time zone/);
});

test("SIGTERM to the hub kills a running card's child and removes its temp dir", async (t) => {
  if (!tls) return t.skip("openssl is not available to mint a test certificate");
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin,
    BRIDGE_APP_FETCH_DOMAINS: src.host, NODE_EXTRA_CA_CERTS: tls.certFile });
  t.after(async () => { await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const r = await post(hub.base, { type: "terms-extract", input: { cards: [
    { cardKey: "slow-card", issuer: "Example Bank", product: "Example Card", sources: [src.url("/tc.pdf")] }] } });
  assert.equal(r.status, 202);
  const call = await until(() => stub.calls()[0]);
  assert.ok(call, "the card's child started");
  assert.ok(fs.existsSync(call.cwd) && alive(call.pid));
  hub.proc.kill("SIGTERM");
  const { signal } = await hub.exited;
  assert.equal(signal, "SIGTERM", "the hub dies by the signal it was sent");
  assert.equal(fs.existsSync(call.cwd), false, "the temp dir is gone");
  assert.ok(await until(() => !alive(call.pid)), "the child is gone");
});

test("a CLI error in one terms card fails only that card", async (t) => {
  const stub = makeStub();
  const jobs = inProcess(stub);
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const id = jobs.submit(termsJob([["error-card", ["/a"]], ["good-card", ["/b"]]])).body.jobId;
  const job = await doneJob(jobs, id);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(job.error, null);
  const [bad, good] = job.result.cards;
  assert.equal(bad.status, "failed");
  assert.equal(bad.ruleSet, null);
  assert.deepEqual(bad.notes, ["extraction failed: the claude CLI reported an error: Invalid API key - please run /login"]);
  assert.deepEqual(bad.sources.map((x) => x.ok), [true], "its source was read; the CLI failed after");
  assert.equal(good.status, "verified");
  assert.equal(good.ruleSet.sources[0].url, "https://terms.example/b");
  assert.equal(stub.calls().length, 2, "the error is not retried");
});

test("the child environment drops every bridge setting and the Codex key", () => {
  const env = appJobs.childEnv({ PATH: "/bin", BRIDGE_TOKEN: "a", BRIDGE_APP_TOKEN: "b", BRIDGE_APP_FETCH_DOMAINS: "c",
    CODEX_API_KEY: "d", CLAUDE_CODE_OAUTH_TOKEN: "kept" });
  assert.deepEqual(env, { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "kept" });
});

// ── Shopping jobs ────────────────────────────────────────────────────────────
// The stub's shopping answers are keyed on markers in the request's `prompt`
// (STUB-PLAN-*, STUB-SHOP-*); no test here reaches a retail site or a model.
const SHOP_MARKER = "SHOP-PRIVATE-MARKER-4c2e";
const shopBody = (over = {}, categories) => ({ type: "shopping-refresh", input: { city: "Example City", month: "November 2026",
  currency: "INR", categories: categories || [{ category: "Refrigerator", constraints: "double door, 250 to 300 litres" },
    { category: "Study desk", constraints: "" }], ...over } });
const argOf = (call, flag) => call.argv[call.argv.indexOf(flag) + 1];
const finished = (jobs, body) => doneJob(jobs, jobs.submit(body).body.jobId);

// A fetcher for in-process runs: records what the job asked for and under which
// allowlist, and fails the URLs `fail` returns an error for.
function shopFetcher(fail = () => null) {
  const calls = [];
  return { calls, fetch: async (url, o) => {
    calls.push({ url, allow: [...o.allow], listName: o.listName });
    const failure = fail(url);
    if (failure) throw failure;
    return { url, ext: ".txt", data: Buffer.from(("Example listing at " + url + ". Price Rs 1,000. ").repeat(20)), title: null };
  } };
}
function shopSetup(t, extra = {}, fail) {
  const stub = makeStub();
  const fetcher = shopFetcher(fail);
  const lines = [];
  const jobs = inProcess(stub, { shopDomains: "shop.example", fetchSource: fetcher.fetch, log: (l) => lines.push(l), ...extra });
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  return { stub, fetcher, lines, jobs };
}

test("a shopping request is validated before anything runs: sizes, currency, unknown keys, control characters", async (t) => {
  const { stub, jobs } = shopSetup(t);
  const refused = (status, pattern, body) => {
    const r = jobs.submit(body);
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.match(r.body.error, pattern);
  };
  const cats = (n) => Array.from({ length: n }, (_, i) => ({ category: "Item " + i, constraints: "" }));
  refused(400, /input\.city/, shopBody({ city: "" }));
  refused(400, /input\.city/, shopBody({ city: "Example\nCity" }));
  refused(400, /input\.city/, shopBody({ city: "x".repeat(101) }));
  refused(400, /input\.city/, shopBody({ city: 7 }));
  refused(400, /input\.month/, shopBody({ month: "x".repeat(41) }));
  refused(400, /input\.month/, shopBody({ month: undefined }));
  refused(400, /currency must be "INR"/, shopBody({ currency: "USD" }));
  refused(400, /currency must be "INR"/, shopBody({ currency: undefined }));
  refused(400, /1 to 12 categories/, shopBody({ categories: [] }));
  refused(400, /1 to 12 categories/, shopBody({ categories: cats(13) }));
  refused(400, /1 to 12 categories/, shopBody({ categories: "Refrigerator" }));
  refused(400, /categories\[0\] must be an object/, shopBody({ categories: ["Refrigerator"] }));
  refused(400, /categories\[1\] takes only category and constraints/, shopBody({ categories: [...cats(1), { category: "B", constraint: "typo" }] }));
  refused(400, /categories\[0\]\.category/, shopBody({ categories: [{ category: "  ", constraints: "" }] }));
  refused(400, /categories\[0\]\.category/, shopBody({ categories: [{ category: "x".repeat(101), constraints: "" }] }));
  refused(400, /categories\[0\]\.constraints/, shopBody({ categories: [{ category: "A", constraints: "x".repeat(501) }] }));
  refused(400, /categories\[0\]\.constraints/, shopBody({ categories: [{ category: "A", constraints: ["not", "a string"] }] }));
  refused(400, /categories\[0\]\.constraints/, shopBody({ categories: [{ category: "A", constraints: "line\nbreak" }] }));
  refused(400, /input\.colour is not a field of shopping-refresh/, shopBody({ colour: "red" }));
  refused(400, /input\.prompt must be a string/, shopBody({ prompt: 5 }));
  refused(413, /input\.prompt is longer than 4096/, shopBody({ prompt: "x".repeat(4097) }));
  refused(400, /input\.prompt carries a control character/, shopBody({ prompt: "bell\u0007" }));
  refused(400, /input\.model/, shopBody({ model: "--dangerously-skip-permissions" }));
  refused(400, /input must be an object/, { type: "shopping-refresh" });
  assert.equal(stub.calls().length, 0, "nothing reached the CLI");

  // The limits themselves are accepted: 12 categories without constraints, a 4,096-character prompt with a line break.
  const job = await finished(jobs, shopBody({ prompt: "x".repeat(4095) + "\n" }, Array.from({ length: 12 }, (_, i) => ({ category: "Item " + i }))));
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(job.result.categories.length, 12);
});

test("the shopping result schema: an unknown price is null, never 0, and every key is present", () => {
  const option = (over = {}) => ({ name: "Example", priceINR: 27990, seller: "Example Retailer", url: "https://www.shop.example/p",
    saleNote: null, verified: true, ...over });
  const result = (options) => ({ checkedOn: "2026-11-23", categories: [{ category: "Refrigerator", options, recommendation: "Buy it." }], notes: "" });
  const problems = (v) => appJobs.check(appJobs.SHOPPING_RESULT_SHAPE, v);
  assert.deepEqual(problems(result([option(), option({ priceINR: null, seller: null, url: null, verified: false })])), []);
  assert.deepEqual(problems(result([])), [], "no option fitting is an answer");
  assert.match(problems(result([option({ priceINR: 0 })]))[0], /^categories\[0\]\.options\[0\]\.priceINR: expected number greater than 0$/);
  assert.match(problems(result([option({ priceINR: "27,990" })]))[0], /priceINR: expected number greater than 0, got string/);
  assert.match(problems(result([option({ verified: "yes" })]))[0], /verified: expected boolean, got string/);
  const { verified, ...noVerified } = option();
  assert.deepEqual(problems(result([noVerified])), ["categories[0].options[0].verified: missing"]);
  assert.match(problems({ ...result([]), checkedOn: "2026-02-30" })[0], /checkedOn: expected YYYY-MM-DD date/);
  assert.match(problems({ ...result([]), notes: ["a"] })[0], /notes: expected string, got array/);

  // The CLI is held to the same shape, and a run with nothing to read has no tool.
  const withPages = appJobs.shoppingArgs("sonnet", 4);
  const schema = JSON.parse(argOf({ argv: withPages }, "--json-schema"));
  assert.deepEqual(schema.required, ["checkedOn", "categories", "notes"]);
  assert.equal(schema.additionalProperties, false);
  const optionSchema = schema.properties.categories.items.properties.options.items;
  assert.deepEqual(optionSchema.required, ["name", "priceINR", "seller", "url", "saleNote", "verified"]);
  assert.deepEqual(optionSchema.properties.priceINR.anyOf.map((x) => x.type), ["number", "null"]);
  assert.equal(optionSchema.properties.verified.type, "boolean");
  assert.equal(argOf({ argv: withPages }, "--tools"), "Read");
  assert.equal(argOf({ argv: withPages }, "--max-turns"), "16");
  const noPages = appJobs.shoppingArgs("sonnet", 0);
  assert.equal(argOf({ argv: noPages }, "--tools"), "");
  assert.equal(argOf({ argv: noPages }, "--max-turns"), "4");
  for (const argv of [withPages, noPages, appJobs.shopPlanArgs("sonnet")]) {
    for (const flag of ["--restricted", "--no-session-persistence", "--strict-mcp-config", "--json-schema", "--system-prompt"]) {
      assert.ok(argv.includes(flag), flag);
    }
    assert.equal(argOf({ argv }, "--permission-mode"), "dontAsk");
    assert.equal(argOf({ argv }, "--mcp-config"), '{"mcpServers":{}}');
  }
  assert.equal(argOf({ argv: appJobs.shopPlanArgs("sonnet") }, "--tools"), "", "planning reads nothing");
  assert.deepEqual(JSON.parse(argOf({ argv: appJobs.shopPlanArgs("sonnet") }, "--json-schema")).required, ["fetches"]);
});

test("with no shopping allowlist a job fetches nothing, the model gets no tool, and no price is verified", async (t) => {
  const { stub, fetcher, lines, jobs } = shopSetup(t, { shopDomains: undefined });
  const job = await finished(jobs, shopBody({ prompt: SHOP_MARKER + " STUB-SHOP-LIES" }));
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.deepEqual(appJobs.check(appJobs.SHOPPING_RESULT_SHAPE, job.result), []);
  assert.equal(fetcher.calls.length, 0, "the terms allowlist is not the shopping one: nothing was fetched");
  assert.equal(stub.calls().length, 1, "no planning run either");
  assert.equal(argOf(stub.calls()[0], "--tools"), "");
  assert.match(stub.calls()[0].stdin, /Source files: none\./);
  assert.deepEqual(job.progress, { done: 3, total: 3 });
  const options = job.result.categories.flatMap((c) => c.options);
  assert.ok(options.length >= 2);
  assert.ok(options.every((o) => o.verified === false && o.url === null), JSON.stringify(options));
  assert.match(job.result.notes, /\(BRIDGE_APP_SHOP_DOMAINS is empty\): no page was fetched and every price is unverified\./);
  assert.match(job.result.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(job.result.checkedOn, "1999-01-01", "the bridge's date replaces the model's");
  assert.ok(lines.some((l) => /shopping-refresh queued categories=2 prompt=/.test(l)));
  assert.ok(lines.every((l) => !l.includes(SHOP_MARKER) && !l.includes("Example City")), "the request's text is never logged");
  assert.equal(jobs.health().shopDomains.length, 0);
});

test("a shopping job fetches only allowlisted https pages, once, three per category, and verifies only what it fetched", async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-appjobs-root-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const { stub, fetcher, lines, jobs } = shopSetup(t, { tmpRoot });
  const job = await finished(jobs, shopBody({ prompt: "STUB-PLAN-HOSTILE STUB-SHOP-LIES " + SHOP_MARKER }));
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.deepEqual(appJobs.check(appJobs.SHOPPING_RESULT_SHAPE, job.result), []);
  // Of the plan's ten pages: another host, plain http, a repeat of /a with a
  // fragment, a fourth page for category 1, a category that does not exist and
  // credentials in the URL never reach the fetcher.
  assert.deepEqual(fetcher.calls.map((c) => c.url), ["https://shop.example/a", "https://shop.example/b", "https://shop.example/c",
    "https://www.shop.example/f"]);
  assert.deepEqual(fetcher.calls[0].allow, ["shop.example", "www.shop.example"]);
  assert.equal(fetcher.calls[0].listName, "BRIDGE_APP_SHOP_DOMAINS");
  const [plan, answer] = stub.calls();
  assert.equal(stub.calls().length, 2);
  assert.match(plan.stdin, /Allowed hosts \(https only\): shop\.example, www\.shop\.example/);
  assert.equal(argOf(plan, "--tools"), "");
  assert.equal(argOf(answer, "--tools"), "Read");
  assert.equal(argOf(answer, "--max-turns"), "16", "12 turns plus one per page");
  assert.deepEqual(Object.keys(answer.files).sort(), ["source-1.txt", "source-2.txt", "source-3.txt", "source-4.txt"]);
  assert.match(answer.stdin, /- source-4\.txt from https:\/\/www\.shop\.example\/f \(for category 2\)/);

  const [fridge, desk] = job.result.categories;
  assert.deepEqual(fridge.options.map((o) => [o.name, o.verified, o.url]), [
    ["Refrigerator option 1", true, "https://shop.example/a"],
    ["Refrigerator option 2", true, "https://shop.example/b"],
    ["Refrigerator option 3", true, "https://shop.example/c"],
    ["never fetched", false, "https://shop.example/never-fetched"],   // on the list, so its link stays, but no page was read
    ["off list", false, null],
    ["no price", false, "https://shop.example/a"]]);
  assert.deepEqual(desk.options.map((o) => [o.verified, o.url]), [[true, "https://www.shop.example/f"],
    [false, "https://shop.example/never-fetched"], [false, null], [false, "https://www.shop.example/f"]]);
  assert.equal(fridge.options[0].priceINR, 1000);
  assert.equal(fridge.options[5].priceINR, null);
  assert.equal(JSON.stringify(job.result).includes("evil.example"), false);
  assert.match(job.result.notes, /^Stub notes\. /);
  assert.match(job.result.notes, /2 link\(s\) that were not on the shopping allowlist were removed\./);
  assert.match(job.result.notes, /6 option\(s\) called verified had no price or no fetched page behind them and are marked unverified\./);
  assert.match(job.result.notes, /6 proposed page\(s\) were not fetched/);
  assert.deepEqual(job.progress, { done: 3, total: 3 });
  assert.deepEqual(fs.readdirSync(tmpRoot), [], "the temp dir is gone");
  assert.ok(lines.some((l) => /shopping-refresh done .* pages=4\/4/.test(l)));
  assert.ok(lines.every((l) => !l.includes(SHOP_MARKER)));
});

test("pages that cannot be fetched are noted, and a job with none readable has no tool and no verified price", async (t) => {
  const some = shopSetup(t, {}, (url) => (url.endsWith("two") ? new appJobs.FetchError("HTTP 404", "http", 404) : null));
  const job = await finished(some.jobs, shopBody());
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.deepEqual(job.result.categories.map((c) => c.options.map((o) => [o.verified, o.url])),
    [[[true, "https://shop.example/s?q=one"]], [[false, null]]]);
  assert.match(job.result.notes, /1 of 2 page\(s\) could not be read\./);
  const answer = some.stub.calls()[1];
  assert.equal(argOf(answer, "--tools"), "Read");
  assert.match(answer.stdin, /Pages that could not be read:\n- https:\/\/shop\.example\/s\?q=two/);

  const none = shopSetup(t, {}, () => new appJobs.FetchError("HTTP 503", "http", 503));
  const bare = await finished(none.jobs, shopBody({ prompt: "STUB-SHOP-LIES" }));
  assert.equal(bare.status, "done", JSON.stringify(bare));
  assert.equal(none.fetcher.calls.length, 2);
  assert.equal(none.stub.calls().length, 2, "a plan and an answer");
  assert.equal(argOf(none.stub.calls()[1], "--tools"), "", "nothing to read, so no tool");
  assert.match(none.stub.calls()[1].stdin, /Source files: none\./);
  assert.match(bare.result.notes, /2 of 2 page\(s\) could not be read\./);
  assert.ok(bare.result.categories.flatMap((c) => c.options).every((o) => o.verified === false));
});

test("the hub's hourly shopping page budget is shared across jobs", async (t) => {
  const { stub, fetcher, jobs } = shopSetup(t, { shopPerHour: 3 });
  const first = await finished(jobs, shopBody());
  assert.match(first.result.notes, /^Stub notes\.$/, "two pages, both read");
  const second = await finished(jobs, shopBody());
  assert.equal(second.status, "done", JSON.stringify(second));
  assert.equal(fetcher.calls.length, 3, "the third page of the hour was the last");
  assert.match(second.result.notes, /1 of 2 page\(s\) could not be read\./);
  assert.equal(stub.calls().filter((c) => argOf(c, "--tools") === "Read").length, 2);
});

test("an answer that skips or renames a category is retried with an index-only error; a name's case is forgiven", async (t) => {
  const { stub, jobs } = shopSetup(t, { shopDomains: undefined });
  const job = await finished(jobs, shopBody({ prompt: "STUB-SHOP-WRONG-CATEGORIES STUB-SHOP-CASE" }));
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(stub.calls().length, 2);
  assert.match(stub.calls()[1].stdin, /categories: expected 2 entries, one per requested category in the order listed, got 1/);
  assert.ok(!stub.calls()[1].stdin.includes("Wrong-9d1c"), "the retry names a count, never the answer's text");
  assert.deepEqual(job.result.categories.map((c) => c.category), ["Refrigerator", "Study desk"], "respelled as requested");

  const zero = await finished(jobs, shopBody({ prompt: "STUB-SHOP-ZERO" }));
  assert.equal(zero.status, "done", JSON.stringify(zero));
  assert.match(stub.calls()[3].stdin, /categories\[0\]\.options\[\d+\]\.priceINR: expected number greater than 0/);
  assert.ok(zero.result.categories.flatMap((c) => c.options).every((o) => o.priceINR !== 0));
});

test("a planning run that cannot answer costs the job its pages, not the job", async (t) => {
  const { stub, fetcher, jobs } = shopSetup(t);
  const job = await finished(jobs, shopBody({ prompt: "STUB-PLAN-INVALID" }));
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(fetcher.calls.length, 0);
  assert.equal(stub.calls().length, 3, "the plan and its one retry, then the answer");
  assert.equal(argOf(stub.calls()[2], "--tools"), "");
  assert.match(job.result.notes, /Choosing pages to read failed \(the answer did not match the schema after one retry: fetches: expected array, got string\), so no page was read\./);
  assert.ok(job.result.categories.flatMap((c) => c.options).every((o) => o.verified === false));
});

test("shopping and terms jobs share the one long-job slot, so a statement job behind them still runs", async (t) => {
  const stub = makeStub();
  const jobs = inProcess(stub);
  t.after(() => { jobs.close(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const a = jobs.submit(shopBody({ prompt: "STUB-SLOW" })).body.jobId;
  const b = jobs.submit(termsJob([["slow-card", ["/a"]]])).body.jobId;
  const c = jobs.submit(statementBody("STUB-SLOW statement")).body.jobId;
  await until(() => stub.calls().length === 2);
  await sleep(200);
  assert.deepEqual([a, b, c].map((id) => jobs.get(id).status), ["running", "queued", "running"]);
  assert.equal(stub.calls().length, 2);
  jobs.remove(a);
  await until(() => jobs.get(b).status === "running");
  assert.equal(jobs.get(b).status, "running", "the terms job takes the slot the shopping job freed");
});

test("DELETE during a shopping job's fetch phase frees the slot, aborts the fetch and removes the temp dir", async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-appjobs-root-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  let signal = null;
  const { jobs } = shopSetup(t, { tmpRoot, fetchSource: (url, o) => { signal = o.signal; return new Promise(() => {}); } });
  const id = jobs.submit(shopBody()).body.jobId;
  await until(() => signal);
  assert.equal(fs.readdirSync(tmpRoot).length, 1, "the job's temp dir exists while it fetches");
  assert.equal(jobs.remove(id), true);
  assert.equal(signal.aborted, true);
  assert.ok(await until(() => jobs.stats().running === 0, 1000), "the slot is free");
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test("a shopping allowlist entry admits the host and its www form only", () => {
  const allow = appJobs.parseShopDomains("amazon.in, Flipkart.com www.croma.com\n");
  assert.deepEqual([...allow].sort(), ["amazon.in", "flipkart.com", "www.amazon.in", "www.croma.com", "www.flipkart.com"]);
  const check = (u) => appJobs.checkSourceUrl(u, allow, "BRIDGE_APP_SHOP_DOMAINS");
  for (const u of ["https://amazon.in/s?k=x", "https://www.amazon.in/s?k=x", "https://www.flipkart.com/search?q=x", "https://www.croma.com/p"]) {
    assert.equal(check(u).error, undefined, u);
  }
  for (const u of ["https://evil-amazon.in/", "https://evil.amazon.in/", "https://amazon.in.evil.example/", "https://croma.com/",
    "https://amazon.in:8443/", "http://amazon.in/", "https://user:pw@amazon.in/"]) {
    assert.ok(check(u).error, u);
  }
  assert.equal(check("https://evil.example/").error, "host evil.example is not on BRIDGE_APP_SHOP_DOMAINS");
  assert.equal(appJobs.checkSourceUrl("https://evil.example/", allow).error, "host evil.example is not on BRIDGE_APP_FETCH_DOMAINS", "terms jobs keep their message");
  assert.equal(appJobs.parseShopDomains(undefined).size, 0);
});

test("the fetcher re-checks a shopping fetch's redirects and names the shopping list", async (t) => {
  if (!tls) return t.skip("openssl is not available to mint a test certificate");
  const get = (p, allow) => appJobs.fetchSource(src.url(p), { allow: new Set(allow), listName: "BRIDGE_APP_SHOP_DOMAINS", ca: tls.cert });
  await assert.rejects(get("/redirect-out", [src.host]), /redirected to host not-allowed\.example is not on BRIDGE_APP_SHOP_DOMAINS/);
  await assert.rejects(get("/tc.pdf", ["other.example"]), /host 127\.0\.0\.1:\d+ is not on BRIDGE_APP_SHOP_DOMAINS/);
  assert.equal((await get("/tc.pdf", [src.host])).ext, ".pdf");
});

test("a shopping job over HTTP reads an allowlisted page and a PDF through the real fetcher", async (t) => {
  if (!tls) return t.skip("openssl is not available to mint a test certificate");
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin,
    BRIDGE_APP_SHOP_DOMAINS: src.host, NODE_EXTRA_CA_CERTS: tls.certFile });
  t.after(async () => { await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const health = await (await fetch(hub.base + "/app/health", { headers: appHeaders })).json();
  assert.ok(health.types.includes("shopping-refresh"));
  assert.deepEqual(health.shopDomains, [src.host, "www." + src.host]);
  assert.deepEqual(health.fetchDomains, [], "the two allowlists are separate");
  assert.equal(health.limits.shopCategories, 12);
  assert.equal(health.limits.shopPagesPerCategory, 3);
  assert.equal((await post(hub.base, shopBody({ currency: "USD" }))).status, 400);
  assert.equal((await post(hub.base, shopBody({ prompt: "x".repeat(4097) }))).status, 413);

  const r = await post(hub.base, shopBody({ prompt: "STUB-PLAN-PAGE" }));
  assert.equal(r.status, 202);
  const { jobId } = await r.json();
  const job = await waitJob(hub.base, jobId);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(job.type, "shopping-refresh");
  assert.deepEqual(appJobs.check(appJobs.SHOPPING_RESULT_SHAPE, job.result), []);
  const answer = stub.calls().find((c) => argOf(c, "--tools") === "Read");
  assert.deepEqual(Object.keys(answer.files).sort(), ["source-1.txt", "source-2.pdf"]);
  assert.match(answer.files["source-1.txt"], /Earn 5% on bills/);
  assert.ok(!answer.files["source-1.txt"].includes("SCRIPT-BODY-MUST-GO"));
  assert.deepEqual(job.result.categories.flatMap((c) => c.options.map((o) => [o.verified, o.url])),
    [[true, src.url("/page.html")], [true, src.url("/tc.pdf")]]);
  assert.equal((await fetch(hub.base + "/app/jobs/" + jobId, { method: "DELETE", headers: appHeaders })).status, 200);
});

// ── Assistant jobs ───────────────────────────────────────────────────────────
// Every question, context and answer here is synthetic; nothing reaches a model.
const ALL_KINDS = new Set(appJobs.ASSISTANT_KINDS);
const normalize = (value, kinds = ALL_KINDS) => appJobs.normalizeAssistant(value, kinds);
const reply = (actions, answer = "Synthetic answer.") => ({ answer, actions });

// One valid action per kind, with every optional field present.
const GOOD_ACTIONS = [
  { kind: "createReminder", why: "Asked for a reminder.", title: "Call the plumber", due: "2026-12-01T09:30", notes: "Ask about the tap." },
  { kind: "rescheduleReminder", why: "Moved as asked.", reminderID: "rem-0001", due: "2026-12-02" },
  { kind: "completeReminder", why: "Done.", reminderID: "rem-0002" },
  { kind: "appendReminderNote", why: "Adds a detail.", reminderID: "rem-0003", notes: "Bring the receipt." },
  { kind: "createEvent", why: "Asked for a block.", title: "Site visit", start: "2026-12-03T10:00", end: "2026-12-03T11:00", notes: "Meet at the gate." },
  { kind: "moveEvent", why: "Moved as asked.", eventID: "evt-0001", start: "2026-12-04T10:00", end: "2026-12-04T11:00" },
  { kind: "addTodo", why: "Asked for a to-do.", title: "Order the sofa", due: "2026-12-05", notes: "Compare two shops." },
  { kind: "rescheduleTodo", why: "Moved as asked.", todoID: "todo-0001", due: "2026-12-06" },
  { kind: "completeTodo", why: "Done.", todoID: "todo-0002" },
  { kind: "addMoveInItem", why: "Asked to add it.", itemName: "Study desk", category: "Furniture", budgetINR: 12000, needs: "Fits a 120 cm wall." },
  { kind: "markInterestPaid", why: "Paid as stated.", interestID: "int-0001", paidOn: "2026-11-10" },
];

test("assistant output: every action kind passes with its exact fields and nothing is dropped", () => {
  assert.deepEqual(appJobs.ASSISTANT_KINDS, GOOD_ACTIONS.map((a) => a.kind), "the table lists the contract's kinds");
  const out = normalize(reply(GOOD_ACTIONS));
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.result, { answer: "Synthetic answer.", actions: GOOD_ACTIONS.slice(0, 8), dropped: 3 },
    "all eleven are valid, but eight is the most the app is handed");
  for (const a of GOOD_ACTIONS) {
    const one = normalize(reply([a]));
    assert.deepEqual(one.result.actions, [a], a.kind);
    assert.equal(one.result.dropped, 0, a.kind);
  }
});

test("assistant output: optional fields may be absent or null, and a field the kind does not take is left out", () => {
  const out = normalize(reply([
    { kind: "createReminder", why: "Asked.", title: "Call", due: null, notes: null, reminderID: "stray", extra: { nested: true } },
    { kind: "addMoveInItem", why: "Asked.", itemName: "Desk", category: "Furniture" },
  ])).result;
  assert.deepEqual(out.actions, [{ kind: "createReminder", why: "Asked.", title: "Call" },
    { kind: "addMoveInItem", why: "Asked.", itemName: "Desk", category: "Furniture" }]);
  assert.equal(out.dropped, 0);
});

test("assistant output: an unknown or disallowed kind is dropped and counted", () => {
  const allowed = new Set(["createReminder", "addTodo"]);
  const out = normalize(reply([
    { kind: "createReminder", why: "Asked.", title: "Keep" },
    { kind: "deleteEverything", why: "Hostile.", target: "all" },
    { kind: "completeTodo", why: "Not on this request's list.", todoID: "todo-0001" },
    { kind: 7, why: "Not a string.", title: "x" },
    { kind: "constructor", why: "Not an own kind.", title: "x" },
    { kind: "addTodo", why: "Asked.", title: "Keep too" },
  ]), allowed).result;
  assert.deepEqual(out.actions.map((a) => a.title), ["Keep", "Keep too"]);
  assert.equal(out.dropped, 4);
});

test("assistant output: an action with a missing or malformed required field is dropped", () => {
  const bad = [
    { kind: "createReminder", why: "No title." },
    { kind: "createReminder", why: "Blank title.", title: "   " },
    { kind: "createReminder", why: "Title is a number.", title: 5 },
    { kind: "createReminder", why: "Bad due.", title: "x", due: "tomorrow" },
    { kind: "createReminder", why: "Impossible date.", title: "x", due: "2026-02-30" },
    { kind: "createReminder", why: "Impossible time.", title: "x", due: "2026-12-01T25:00" },
    { kind: "createReminder", why: "Seconds are not in the contract.", title: "x", due: "2026-12-01T09:30:00" },
    { kind: "createReminder", why: "Notes is not a string.", title: "x", notes: ["a"] },
    { kind: "rescheduleReminder", why: "No id.", due: "2026-12-02" },
    { kind: "rescheduleReminder", why: "No due.", reminderID: "rem-0001" },
    { kind: "completeReminder", why: "Empty id.", reminderID: "" },
    { kind: "completeReminder", why: "An id too long to be one.", reminderID: "r".repeat(201) },
    { kind: "completeTodo", why: "Id is a number.", todoID: 12 },
    { kind: "createEvent", why: "No end.", title: "x", start: "2026-12-03T10:00" },
    { kind: "moveEvent", why: "No start.", eventID: "evt-0001", end: "2026-12-03T10:00" },
    { kind: "addMoveInItem", why: "No category.", itemName: "Desk" },
    { kind: "addMoveInItem", why: "Budget is text.", itemName: "Desk", category: "Furniture", budgetINR: "12,000" },
    { kind: "addMoveInItem", why: "Negative budget.", itemName: "Desk", category: "Furniture", budgetINR: -1 },
    { kind: "addMoveInItem", why: "Needs is a number.", itemName: "Desk", category: "Furniture", budgetINR: null, needs: 5 },
    { kind: "markInterestPaid", why: "No date.", interestID: "int-0001" },
    { kind: "createReminder", title: "No why." },
    { kind: "createReminder", why: "  ", title: "Blank why." },
    "a string", null, 12, ["createReminder"],
  ];
  const out = normalize(reply([...bad, { kind: "completeTodo", why: "Fine.", todoID: "todo-0001" }])).result;
  assert.deepEqual(out.actions, [{ kind: "completeTodo", why: "Fine.", todoID: "todo-0001" }]);
  assert.equal(out.dropped, bad.length);
});

test("assistant output: long text is clamped, a one-line field is folded, an id is never cut", () => {
  const out = normalize(reply([
    { kind: "createReminder", why: "w ".repeat(300), title: "T\n\n  itle  " + "x".repeat(300), notes: "n".repeat(2000) + "\nsecond line" },
    { kind: "addMoveInItem", why: "Asked.", itemName: "Desk", category: "c".repeat(150), needs: "line one\nline two" },
  ], "a".repeat(5000))).result;
  assert.equal(out.answer.length, 2000);
  assert.ok(out.answer.endsWith("…"));
  const [a, b] = out.actions;
  assert.equal(a.why.length, 200);
  assert.ok(a.why.endsWith("…") && !a.why.includes("  "));
  assert.equal(a.title.length, 200);
  assert.ok(a.title.startsWith("T itle xxx"));
  assert.equal(a.notes.length, 1000);
  assert.equal(b.category.length, 100);
  assert.equal(b.needs, "line one\nline two", "free text keeps its line breaks");
  // A cut never leaves half of a surrogate pair.
  const emoji = normalize(reply([], "😀".repeat(1500))).result.answer;
  assert.ok(emoji.length <= 2000 && !/[\ud800-\udbff]…$/.test(emoji) && emoji.endsWith("…"));
  assert.equal(normalize(reply([], "  fine  ")).result.answer, "fine");
});

test("assistant output: more than eight valid actions are cut to eight and the rest counted as dropped", () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ kind: "addTodo", why: "Asked.", title: "Item " + i }));
  const out = normalize(reply([{ kind: "nope" }, ...many])).result;
  assert.equal(out.actions.length, 8);
  assert.equal(out.actions[7].title, "Item 7");
  assert.equal(out.dropped, 4, "one unknown kind and three beyond the eighth");
});

test("assistant output: no usable answer is an error, and a missing or null actions list is an empty one", () => {
  const e = (v) => normalize(v).errors;
  assert.deepEqual(e({ actions: [] }), ["answer: expected a non-empty string, got undefined"]);
  assert.deepEqual(e({ answer: "   ", actions: [] }), ["answer: expected a non-empty string, got string"]);
  assert.deepEqual(e({ answer: { text: "x" }, actions: [] }), ["answer: expected a non-empty string, got object"]);
  assert.deepEqual(e("just prose"), ["answer: expected a non-empty string, got string"]);
  assert.deepEqual(e(["answer"]), ["answer: expected a non-empty string, got array"]);
  assert.deepEqual(e({ answer: "x", actions: "createReminder" }), ["actions: expected array, got string"]);
  assert.deepEqual(e({ answer: "x", actions: { kind: "addTodo" } }), ["actions: expected array, got object"]);
  assert.deepEqual(e({ answer: 5, actions: 5 }).length, 2);
  assert.deepEqual(normalize({ answer: "x" }).result, { answer: "x", actions: [], dropped: 0 });
  assert.deepEqual(normalize({ answer: "x", actions: null }).result, { answer: "x", actions: [], dropped: 0 });
  assert.ok(!JSON.stringify(e({ answer: 5 })).includes("5"), "errors name a path and a type, never a value");
});

test("the assistant's JSON schema has one object per allowed kind, with that kind's exact fields", () => {
  const schema = appJobs.assistantJsonSchema(["createReminder", "markInterestPaid"]);
  assert.deepEqual(schema.required, ["answer", "actions"]);
  assert.equal(schema.additionalProperties, false);
  const [reminder, interest] = schema.properties.actions.items.anyOf;
  assert.deepEqual(reminder.required, ["kind", "why", "title"]);
  assert.deepEqual(Object.keys(reminder.properties), ["kind", "why", "title", "due", "notes"]);
  assert.deepEqual(reminder.properties.kind.enum, ["createReminder"]);
  assert.equal(reminder.additionalProperties, false);
  assert.deepEqual(interest.required, ["kind", "why", "interestID", "paidOn"]);
  assert.equal(interest.properties.paidOn.type, "string");
  assert.equal(schema.properties.actions.items.anyOf.length, 2, "a kind the request did not allow is not offered");
  const full = appJobs.assistantJsonSchema(appJobs.ASSISTANT_KINDS);
  assert.equal(full.properties.actions.items.anyOf.length, 11);
  assert.equal(full.properties.actions.items.anyOf.find((x) => x.properties.kind.enum[0] === "addMoveInItem").properties.budgetINR.type, "number");
  // Every constraint the schema leaves to the checker is one a schema can state without maxLength or maxItems.
  assert.ok(!/maxLength|maxItems|minItems|minLength|"const"/.test(JSON.stringify(full)));
});
