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
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

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
    countsTowardBase: true, sourceUrl: url, note: null }],
  exclusions: ["fuel"], cardCaps: [], milestones: [], fees: [], creditLagDays: null, notes: [],
});

// The stub claude. Markers in stdin choose its answer.
const STUB = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const STATEMENT = ${JSON.stringify(STATEMENT)};
const ruleSet = ${ruleSet.toString()};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
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
  if (stdin.includes("STUB-IS-ERROR")) return emit({ is_error: true, result: "Invalid API key - please run /login" });
  if (stdin.includes("STUB-TEXT-RESULT")) return emit({ result: "Here it is:\\n\`\`\`json\\n" + JSON.stringify(STATEMENT) + "\\n\`\`\`" });
  if (stdin.includes("STUB-ALWAYS-INVALID") || (stdin.includes("STUB-INVALID-FIRST") && !retry)) {
    const bad = JSON.parse(JSON.stringify(STATEMENT));
    bad.transactions[0].amount = "BAD-VALUE-9d1c";
    delete bad.kind;
    return emit({ structured_output: bad });
  }
  if (argv[argv.indexOf("--tools") + 1] === "Read") {
    const url = (/ from (https:\\/\\/\\S+)/.exec(stdin) || [])[1] || "https://unknown.invalid/";
    return emit({ structured_output: { status: "verified", ruleSet: ruleSet(url), notes: ["synthetic"] } });
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
async function startHub(env, { expectExit = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-safari-appjobs-home-"));
  const port = await freePort();
  const childEnv = { ...process.env, HOME: home, BRIDGE_PORT: String(port), BRIDGE_BIND: "127.0.0.1", ...env };
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
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("unavailable");
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  src = { server, port, host, url: (p) => "https://" + host + p };
});

after(() => {
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
  assert.deepEqual(h.types, ["statement-extract", "terms-extract"]);
  assert.equal(h.defaultModel, "sonnet");
  assert.equal(h.limits.maxRunning, 2);
  assert.equal(h.limits.maxQueued, 20);
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
const APP_DEFAULTS = { priority: 0, isBase: false, countsTowardBase: true, perMerchant: false, gstOnFee: true };
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

const APP_CATALOG = process.env.APP_CARD_CATALOG || path.join(os.homedir(),
  ".cache/system-config/hub/wt-cards/Core/Sources/AdvikaCore/Resources/CardRulesCatalog.json");

test("every rule set in the app's bundled catalog passes the hub's rule-set checker", (t) => {
  if (!fs.existsSync(APP_CATALOG)) {
    return t.skip("the iPhone app's CardRulesCatalog.json is not at " + APP_CATALOG + " (set APP_CARD_CATALOG to its path); " +
      "this contract test runs only where the app checkout exists, so CI skips it");
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
    creditedTo: "points", countsTowardBase: true, sourceUrl: null, note: null }],
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
  assert.match(dead.sources[0].note, /HTTP 503/);
  assert.match(dead.sources[1].note, /redirected to host not-allowed\.example is not on BRIDGE_APP_FETCH_DOMAINS/);
  assert.match(dead.sources[1].note, /no Safari extension is polling/);

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

test("a source the hub cannot fetch is read through a background Safari tab when an extension polls", async (t) => {
  if (!tls) return t.skip("openssl is not available to mint a test certificate");
  const stub = makeStub();
  const hub = await startHub({ BRIDGE_TOKEN, BRIDGE_APP_TOKEN: APP_TOKEN, CLAUDE_BIN: stub.bin,
    BRIDGE_APP_FETCH_DOMAINS: src.host, NODE_EXTRA_CA_CERTS: tls.certFile });
  const ctl = new AbortController();
  t.after(async () => { ctl.abort(); await hub.stop(); fs.rmSync(stub.dir, { recursive: true, force: true }); });
  const target = src.url("/spa.html");
  const served = [];
  const ext = { authorization: "Bearer " + BRIDGE_TOKEN, "x-claude-instance": "fake-ext", "x-claude-version": "0.44" };
  (async () => {
    while (!ctl.signal.aborted) {
      let r;
      try { r = await fetch(hub.base + "/pull", { method: "POST", headers: ext, signal: ctl.signal }); } catch { await sleep(20); continue; }
      if (r.status !== 200) continue;
      const call = await r.json();
      served.push({ tool: call.tool, args: call.args });
      const result = call.tool === "navigate" ? { tabId: 7, windowId: 1, url: call.args.url, opened: "new tab", active: false }
        : call.tool === "read" ? { tabId: 7, url: target, title: "Rendered Terms", text: "Rendered by Safari. " + PAGE_TEXT }
          : call.tool === "probeActive" ? { tabId: 3, owned: true } : null;
      await fetch(hub.base + "/result", { method: "POST", headers: { ...ext, "content-type": "application/json" },
        body: JSON.stringify({ id: call.id, result }) }).catch(() => {});
    }
  })();
  for (let i = 0; i < 100; i++) {
    const st = await (await fetch(hub.base + "/status", { headers: { authorization: "Bearer " + BRIDGE_TOKEN } })).json();
    if (st.instances && st.instances.length) break;
    await sleep(30);
  }
  const r = await post(hub.base, { type: "terms-extract", input: { cards: [
    { cardKey: "spa-card", issuer: "Example Bank", product: "Example Card", sources: [target] }] } });
  const job = await waitJob(hub.base, (await r.json()).jobId, undefined, 600);
  assert.equal(job.status, "done", JSON.stringify(job));
  const [card] = job.result.cards;
  assert.equal(card.status, "verified");
  assert.deepEqual(card.sources, [{ url: target, title: "Rendered Terms", fetchedVia: "safari", ok: true,
    note: "direct fetch failed (the page has almost no text without running its scripts)" }]);
  const nav = served.find((c) => c.tool === "navigate");
  assert.deepEqual({ url: nav.args.url, newTab: nav.args.newTab, active: nav.args.active }, { url: target, newTab: true, active: false });
  assert.ok(served.some((c) => c.tool === "read" && c.args.tabId === 7), "the read is pinned to the tab it opened");
  assert.match(stub.calls()[0].files["source-1.txt"], /^Rendered by Safari\./);
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
  await assert.rejects(appJobs.fetchSource("http://" + src.host + "/tc.pdf", { allow, ca: tls.cert }), /not an https URL/);
  // A listener that never completes a TLS handshake trips the connect timeout.
  const silent = net.createServer(() => {}).listen(0, "127.0.0.1");
  await new Promise((r) => silent.once("listening", r));
  t.after(() => silent.close());
  const host = "127.0.0.1:" + silent.address().port;
  await assert.rejects(appJobs.fetchSource("https://" + host + "/", { allow: new Set([host]), connectMs: 200 }), /no connection within 0.2 s/);
});

// ── Lifecycle, in process ────────────────────────────────────────────────────
const inProcess = (stub, extra = {}) => appJobs.createAppJobs({
  claudeBin: stub.bin, env: { PATH: process.env.PATH, HOME: os.homedir(), BRIDGE_TOKEN: "x", BRIDGE_APP_TOKEN: "y" },
  fetchDomains: "terms.example", log: () => {},
  fetchSource: async (url) => ({ url, ext: ".pdf", data: PDF, title: null }), ...extra });
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(20); }
  return fn();
}

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

test("the child environment drops every bridge setting and the Codex key", () => {
  const env = appJobs.childEnv({ PATH: "/bin", BRIDGE_TOKEN: "a", BRIDGE_APP_TOKEN: "b", BRIDGE_APP_FETCH_DOMAINS: "c",
    CODEX_API_KEY: "d", CLAUDE_CODE_OAUTH_TOKEN: "kept" });
  assert.deepEqual(env, { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "kept" });
});
