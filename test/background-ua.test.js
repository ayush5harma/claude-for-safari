// Drives the background page's site-list apply path against stubbed browser
// APIs. This is the only way to exercise the live-update logic without
// installing the extension in Safari, and it covers the parts that are pure
// control flow: which rule and which registration a list produces, that a
// failed apply is retried rather than latched, and that two applies cannot
// interleave.
//
// The three background scripts are concatenated and run as ONE script, which is
// how a background page actually loads them: classic scripts in one document
// share the global lexical environment, so background.js sees the const and
// function declarations from ua-chrome.js and ua-chrome-sites.js. (Content
// scripts do NOT work that way in Safari -- each file gets its own scope, which
// is why ua-chrome.js exports a function rather than a const. Not this file's
// problem, but do not "simplify" the other one on the strength of this test.)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "extension");

// Values built inside the vm carry the VM realm's prototypes, and
// assert/strict's deepEqual is deepStrictEqual, which compares them. Everything
// crossing the boundary is therefore round-tripped to plain node objects.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const BACKGROUND_SCRIPTS = require(path.join(EXT, "manifest.json")).background.scripts;

function loadBackground(opts = {}) {
  const store = Object.assign({}, opts.store);
  const calls = { dnr: [], register: [], unregister: [], badge: [] };
  const log = [];                       // ordered event log, for the ordering test
  const sitesQueue = (opts.sitesQueue || []).slice();
  let dnrFailuresLeft = opts.dnrFailures || 0;
  const listeners = { message: [], storage: [] };
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const browser = {
    storage: {
      local: {
        async get(keys) {
          const want = Array.isArray(keys) ? keys : [keys];
          const out = {};
          // A queued sequence makes "two applies see two different lists"
          // deterministic; without it the second write always wins the race to
          // the first apply's async read.
          if (sitesQueue.length && want.includes("uaChromeSites")) {
            out.uaChromeSites = sitesQueue.shift();
            return out;
          }
          for (const k of want) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) { Object.assign(store, plain(obj)); },
        async remove(k) { delete store[k]; },
      },
      onChanged: { addListener: (fn) => listeners.storage.push(fn) },
    },
    declarativeNetRequest: {
      async updateDynamicRules(arg) {
        const who = arg.addRules ? arg.addRules[0].condition.requestDomains.join("+") : "sweep";
        log.push("dnr:start:" + who);
        if (opts.dnrDelayMs) await delay(opts.dnrDelayMs);
        calls.dnr.push(plain(arg));
        log.push("dnr:end:" + who);
        if (dnrFailuresLeft > 0) { dnrFailuresLeft -= 1; throw new Error("simulated DNR failure"); }
      },
    },
    scripting: {
      async registerContentScripts(arg) { calls.register.push(plain(arg)); log.push("reg:" + arg[0].matches[0]); },
      async unregisterContentScripts(arg) { calls.unregister.push(plain(arg)); log.push("unreg"); },
    },
    browserAction: {
      setBadgeText: (a) => calls.badge.push(["text", a.text]),
      setTitle: (a) => calls.badge.push(["title", a.title]),
      onClicked: { addListener() {} },
    },
    runtime: { onMessage: { addListener: (fn) => listeners.message.push(fn) } },
    tabs: { async query() { return []; } },
  };
  if (opts.noScripting) delete browser.scripting;

  const ctx = vm.createContext({
    browser, chrome: browser, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    // The poll loop starts at load; park it so it cannot spin during a test.
    fetch: () => new Promise(() => {}),
  });
  const src = BACKGROUND_SCRIPTS.map((f) => fs.readFileSync(path.join(EXT, f), "utf8")).join("\n;\n");
  vm.runInContext(src, ctx, { filename: "background-bundle.js" });
  // Top-level `const`/`let` land in the GLOBAL LEXICAL ENVIRONMENT, not on the
  // context object, so they are unreachable as ctx.NAME and have to be read by
  // evaluating an expression in the same context. (Which is also the proof that
  // the three scripts share one scope, the way a background page loads them.)
  const get = (expr) => { const v = vm.runInContext(expr, ctx); return typeof v === "function" ? v : plain(v); };
  return { ctx, get, calls, log, store, listeners };
}

const settle = () => new Promise((r) => setImmediate(r));
const send = async (env, msg) => {
  for (const fn of env.listeners.message) {
    const r = fn(msg);
    if (r !== undefined) return plain(await r);
  }
  return undefined;
};

test("the three background scripts compose and see each other's declarations", () => {
  const env = loadBackground();
  assert.equal(typeof env.get("chromeUA"), "function");
  assert.ok(Array.isArray(env.get("UA_CHROME_SITES")));
  assert.equal(typeof env.get("applyUaSites"), "function");
  assert.equal(typeof env.get("buildUaHeaderRule"), "function");
  // background.js reaching ua-chrome-sites.js's const is the whole point.
  assert.ok(env.get("chromeUA()").includes("Chrome/"));
});

test("with nothing saved, the defaults are applied to both layers", async () => {
  const env = loadBackground();
  await settle(); await settle();
  const defaults = env.get("UA_CHROME_SITES");

  const rule = env.calls.dnr.at(-1).addRules[0];
  assert.deepEqual(rule.condition.requestDomains, defaults);
  assert.ok(rule.condition.resourceTypes.includes("main_frame"));
  assert.deepEqual(env.calls.dnr.at(-1).removeRuleIds, env.get("UA_RULE_SWEEP_IDS"));

  const reg = env.calls.register.at(-1)[0];
  assert.equal(reg.world, "MAIN");
  assert.equal(reg.runAt, "document_start");
  assert.equal(reg.allFrames, true);
  assert.deepEqual(reg.js, ["ua-chrome.js", "ua-consistency.js", "webrtc-legacy-compat.js"]);
  assert.deepEqual(reg.matches, plain(env.get("siteMatchPatterns")(defaults)));
  // Unregister always runs first: register() rejects an id that already exists.
  assert.ok(env.calls.unregister.length >= 1);

  assert.ok(String(env.store.uaSpoofStatus).startsWith("ok:"));
  assert.ok(String(env.store.uaScopeStatus).startsWith("ok:"));
});

test("a saved list wins, and an empty saved list really means none", async () => {
  const env = loadBackground({ store: { uaChromeSites: ["example.com"] } });
  await settle(); await settle();
  assert.deepEqual(env.calls.dnr.at(-1).addRules[0].condition.requestDomains, ["example.com"]);
  assert.deepEqual(env.calls.register.at(-1)[0].matches,
    ["*://example.com/*", "*://*.example.com/*"]);

  const env2 = loadBackground({ store: { uaChromeSites: [] } });
  await settle(); await settle();
  // No addRules at all, and the sweep still runs so a previous rule is cleared.
  assert.equal(env2.calls.dnr.at(-1).addRules, undefined);
  assert.deepEqual(env2.calls.dnr.at(-1).removeRuleIds, env2.get("UA_RULE_SWEEP_IDS"));
  assert.equal(env2.calls.register.length, 0);
  assert.equal(env2.store.uaScopeStatus, "no-chrome-sites");
});

test("uaSitesSet normalises, stores and applies; uaSitesReset restores", async () => {
  const env = loadBackground();
  await settle(); await settle();
  const before = env.calls.dnr.length;

  const r = await send(env, { op: "uaSitesSet", text: "https://Example.COM/x\n*.com\nnot a host\nb.org\n" });
  await settle();
  assert.deepEqual(r.sites, ["example.com", "b.org"]);
  // "*.com" is a single label after normalising and must never reach a rule.
  assert.ok(r.rejected.includes("*.com"));
  assert.ok(r.rejected.includes("not a host"));
  assert.deepEqual(env.store.uaChromeSites, ["example.com", "b.org"]);
  assert.ok(env.calls.dnr.length > before);
  assert.deepEqual(env.calls.dnr.at(-1).addRules[0].condition.requestDomains, ["example.com", "b.org"]);

  const back = await send(env, { op: "uaSitesReset" });
  await settle();
  assert.deepEqual(back.sites, env.get("UA_CHROME_SITES"));
  assert.equal(back.usingDefaults, true);
  assert.equal("uaChromeSites" in env.store, false);
  assert.deepEqual(env.calls.dnr.at(-1).addRules[0].condition.requestDomains, env.get("UA_CHROME_SITES"));
});

test("uaSitesGet reports the saved list, the defaults and the status", async () => {
  const env = loadBackground({ store: { uaChromeSites: ["a.com"] } });
  await settle(); await settle();
  const r = await send(env, { op: "uaSitesGet" });
  assert.deepEqual(r.sites, ["a.com"]);
  assert.deepEqual(r.defaults, env.get("UA_CHROME_SITES"));
  assert.equal(r.usingDefaults, false);
  assert.ok(String(r.status.dnr).startsWith("ok:"));
});

test("a failed apply is RETRIED, not latched as done", async () => {
  // The bug this guards: recording the applied key before the work means one
  // transient updateDynamicRules rejection makes the guard say "already
  // applied" forever, and nothing re-applies until the user saves by hand.
  const env = loadBackground({ dnrFailures: 1 });
  await settle(); await settle();
  assert.equal(env.calls.dnr.length, 1);
  assert.ok(String(env.store.uaSpoofStatus).startsWith("failed:"));

  await env.get("applyUaSites")();          // same list, so a latched key would skip
  await settle();
  assert.equal(env.calls.dnr.length, 2, "the failed apply should have been retried");
  assert.ok(String(env.store.uaSpoofStatus).startsWith("ok:"));

  // Once it has succeeded, the guard does its job and stops the churn.
  await env.get("applyUaSites")();
  await settle();
  assert.equal(env.calls.dnr.length, 2, "a successful apply should not repeat");
});

test("concurrent applies are serialised, last list wins", async () => {
  // The guard this proves: applyUaSites is async and gets triggered twice in a
  // row by a single save (it applies directly AND storage.onChanged fires). If
  // the two runs overlapped, the rule from one list could end up beside the
  // registration from the other. A slow updateDynamicRules widens the window
  // that would expose it; a queued sequence of stored lists makes each run see
  // a different one deterministically.
  const env = loadBackground({
    sitesQueue: [["boot.example"], ["one.com"], ["two.com"]],
    dnrDelayMs: 15,
  });
  await settle(); await settle();

  const p1 = env.get("applyUaSites")();
  const p2 = env.get("applyUaSites")();
  await Promise.all([p1, p2]);
  await settle();

  // Each list's DNR call must START and END, and be followed by its own
  // registration, before the next list's DNR call starts.
  const seq = env.log.filter((e) => e.startsWith("dnr:") || e.startsWith("reg:"));
  const one = seq.indexOf("dnr:start:one.com");
  const two = seq.indexOf("dnr:start:two.com");
  assert.ok(one >= 0 && two > one, "both lists applied, in order: " + seq.join(" "));
  assert.ok(seq.indexOf("dnr:end:one.com") < two, "one.com's rule finished before two.com started");
  assert.ok(seq.indexOf("reg:*://one.com/*") < two, "one.com's registration landed before two.com started");
  assert.ok(seq.indexOf("reg:*://two.com/*") > two, "two.com registered after its own rule");

  // And the end state is the last list, on both layers.
  assert.deepEqual(env.calls.dnr.at(-1).addRules[0].condition.requestDomains, ["two.com"]);
  assert.deepEqual(env.calls.register.at(-1)[0].matches, ["*://two.com/*", "*://*.two.com/*"]);
});

test("without the scripting API the header layer still applies and says so", async () => {
  const env = loadBackground({ noScripting: true });
  await settle(); await settle();
  assert.ok(env.calls.dnr.at(-1).addRules, "the header rule must still be installed");
  assert.equal(env.store.uaScopeStatus, "scripting-unavailable");
});

test("a storage change from elsewhere re-applies", async () => {
  const env = loadBackground();
  await settle(); await settle();
  const before = env.calls.dnr.length;
  env.store.uaChromeSites = ["changed.example"];
  for (const fn of env.listeners.storage) fn({ uaChromeSites: { newValue: ["changed.example"] } }, "local");
  await settle(); await settle();
  assert.ok(env.calls.dnr.length > before);
  assert.deepEqual(env.calls.dnr.at(-1).addRules[0].condition.requestDomains, ["changed.example"]);
});
