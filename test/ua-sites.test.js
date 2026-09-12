// Unit tests for the site-list parser and the two builders it feeds:
// the declarativeNetRequest header rule and the registerContentScripts match
// patterns. Run with: node --test test/
//
// Why these are worth testing at all: the parsed list goes straight into a
// declarativeNetRequest condition, and ONE invalid entry makes
// updateDynamicRules reject the whole call -- the spoof would silently vanish
// for every site rather than for the bad one. The parser is the only thing
// standing between a pasted URL and that.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  UA_CHROME_SITES, UA_RULE_ID, UA_RULE_SWEEP_IDS, MAX_UA_SITES,
  normaliseHost, parseSiteList, siteMatchPatterns, buildUaHeaderRule, isChromeUASite,
} = require("../extension/ua-chrome-sites.js");

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

test("normaliseHost accepts a bare hostname", () => {
  assert.equal(normaliseHost("example.com"), "example.com");
  assert.equal(normaliseHost("app.slack.com"), "app.slack.com");
  assert.equal(normaliseHost("a-b.example.co.uk"), "a-b.example.co.uk");
  assert.equal(normaliseHost("xn--80ak6aa92e.com"), "xn--80ak6aa92e.com");  // punycode
});

test("normaliseHost refuses a single-label host, TLD spoofs included", () => {
  // The one that matters: all three reduce to "com", which as a requestDomains
  // entry matches every .com domain and as a match pattern is *://*.com/* --
  // the global spoof the whole design exists to avoid.
  for (const bad of ["com", ".com", "*.com", "*.COM", "https://*.com/", "co", "localhost", "localhost:3000"]) {
    assert.equal(normaliseHost(bad), "", "should reject single-label: " + JSON.stringify(bad));
  }
  // And nothing derived from them survives into either builder.
  assert.deepEqual(siteMatchPatterns(["com", "*.com"]), []);
  assert.equal(buildUaHeaderRule(["com"], CHROME_UA), null);
  assert.deepEqual(parseSiteList("com\n*.com\n.com\nexample.com").sites, ["example.com"]);
});

test("normaliseHost forgives what people actually paste", () => {
  assert.equal(normaliseHost("  Example.COM  "), "example.com");
  assert.equal(normaliseHost("https://example.com/some/path?q=1#f"), "example.com");
  assert.equal(normaliseHost("http://example.com"), "example.com");
  assert.equal(normaliseHost("*.example.com"), "example.com");
  assert.equal(normaliseHost(".example.com."), "example.com");
  assert.equal(normaliseHost("example.com:8443"), "example.com");
  assert.equal(normaliseHost("https://*.example.com:443/x"), "example.com");
});

test("normaliseHost rejects everything that would break a DNR rule", () => {
  for (const bad of [
    "", "   ", "# a comment", "// a comment",
    "not a host", "exa mple.com", "exam_ple.com", "exam!ple.com",
    "-example.com", "example-.com", "example..com",
    "127.0.0.1", "10.0.0.1",              // IPv4 literals
    "[::1]", "::1",                        // IPv6 literals
    "münchen.de", "例え.テスト",            // non-ASCII: punycode is required
    "a".repeat(64) + ".com",               // label over 63
    "a".repeat(250) + ".example.com",      // host over 253
    null, undefined,
  ]) {
    assert.equal(normaliseHost(bad), "", "should reject: " + JSON.stringify(bad));
  }
});

test("parseSiteList keeps order, drops duplicates, reports what it ignored", () => {
  const r = parseSiteList([
    "example.com",
    "# a comment",
    "",
    "https://app.slack.com/client",
    "EXAMPLE.com",          // duplicate after normalising
    "not a host",           // rejected
    "  *.other.org  ",
  ].join("\n"));
  assert.deepEqual(r.sites, ["example.com", "app.slack.com", "other.org"]);
  assert.deepEqual(r.rejected, ["not a host"]);
});

test("parseSiteList handles CRLF and an empty input", () => {
  assert.deepEqual(parseSiteList("a.com\r\nb.com\r\n").sites, ["a.com", "b.com"]);
  assert.deepEqual(parseSiteList("").sites, []);
  assert.deepEqual(parseSiteList("   \n\n  ").sites, []);
  assert.deepEqual(parseSiteList(null).sites, []);
});

test("parseSiteList caps the list and reports the overflow", () => {
  const many = Array.from({ length: MAX_UA_SITES + 5 }, (_, i) => "h" + i + ".example.com");
  const r = parseSiteList(many.join("\n"));
  assert.equal(r.sites.length, MAX_UA_SITES);
  assert.equal(r.rejected.length, 5);
  assert.equal(r.sites[0], "h0.example.com");
});

test("siteMatchPatterns emits both spellings, http and https only", () => {
  assert.deepEqual(siteMatchPatterns(["example.com"]), [
    "*://example.com/*",
    "*://*.example.com/*",
  ]);
  assert.deepEqual(siteMatchPatterns(["a.com", "b.org"]), [
    "*://a.com/*", "*://*.a.com/*",
    "*://b.org/*", "*://*.b.org/*",
  ]);
  // A pattern is never emitted for something that would not survive the parser.
  assert.deepEqual(siteMatchPatterns(["not a host", "", null]), []);
  assert.deepEqual(siteMatchPatterns([]), []);
  assert.deepEqual(siteMatchPatterns(undefined), []);
});

test("buildUaHeaderRule builds one rule covering every domain", () => {
  const rule = buildUaHeaderRule(["example.com", "app.slack.com"], CHROME_UA);
  assert.equal(rule.id, UA_RULE_ID);
  assert.equal(rule.priority, 100);
  assert.equal(rule.action.type, "modifyHeaders");
  assert.deepEqual(rule.action.requestHeaders, [
    { header: "user-agent", operation: "set", value: CHROME_UA },
  ]);
  assert.deepEqual(rule.condition.requestDomains, ["example.com", "app.slack.com"]);
  // main_frame is what makes the top-level navigation go out as Chrome; it was
  // measured working on a DYNAMIC rule on Safari 27 (2026-09-01, server-side
  // header echo), which is the only kind this extension has ever installed.
  assert.ok(rule.condition.resourceTypes.includes("main_frame"));
  assert.ok(rule.condition.resourceTypes.includes("sub_frame"));
  assert.ok(rule.condition.resourceTypes.includes("xmlhttprequest"));
});

test("buildUaHeaderRule returns null when there is nothing to install", () => {
  assert.equal(buildUaHeaderRule([], CHROME_UA), null);
  assert.equal(buildUaHeaderRule(undefined, CHROME_UA), null);
  assert.equal(buildUaHeaderRule(["not a host"], CHROME_UA), null);
  // A UA that is not a Chrome UA must not be installed as one: this is the
  // "__CHROME_UA__ placeholder shipped" failure, caught here rather than live.
  assert.equal(buildUaHeaderRule(["example.com"], ""), null);
  assert.equal(buildUaHeaderRule(["example.com"], "__CHROME_UA__"), null);
  assert.equal(buildUaHeaderRule(["example.com"], "Mozilla/5.0 Safari/605.1.15"), null);
});

test("buildUaHeaderRule normalises the domains it is handed", () => {
  const rule = buildUaHeaderRule(["https://Example.COM/path", "*.b.org", "not a host"], CHROME_UA);
  assert.deepEqual(rule.condition.requestDomains, ["example.com", "b.org"]);
});

test("isChromeUASite matches subdomains but not a suffix collision", () => {
  const list = ["example.com"];
  assert.equal(isChromeUASite("example.com", list), true);
  assert.equal(isChromeUASite("app.example.com", list), true);
  assert.equal(isChromeUASite("a.b.example.com", list), true);
  assert.equal(isChromeUASite("EXAMPLE.COM", list), true);
  assert.equal(isChromeUASite("notexample.com", list), false);
  assert.equal(isChromeUASite("example.com.evil.net", list), false);
  assert.equal(isChromeUASite("example.org", list), false);
  assert.equal(isChromeUASite("", list), false);
  assert.equal(isChromeUASite("anything.com", []), false);
});

test("the built-in default list is itself valid", () => {
  assert.ok(UA_CHROME_SITES.length > 0);
  // Every default must survive the parser unchanged -- including the
  // single-label rule, so a default can never be the thing that widens the
  // spoof to a whole TLD.
  for (const h of UA_CHROME_SITES) {
    assert.equal(normaliseHost(h), h, h + " is not already normalised");
    assert.ok(h.includes("."), h + " is a single label");
  }
  assert.deepEqual(parseSiteList(UA_CHROME_SITES.join("\n")).sites, UA_CHROME_SITES);
  const rule = buildUaHeaderRule(UA_CHROME_SITES, CHROME_UA);
  assert.deepEqual(rule.condition.requestDomains, UA_CHROME_SITES);
  assert.equal(siteMatchPatterns(UA_CHROME_SITES).length, UA_CHROME_SITES.length * 2);
});

test("the sweep covers every id an older build could have written", () => {
  // Builds before 0.36 wrote one rule per domain at 9200+i, and dynamic rules
  // persist across updates: a domain removed from the list keeps its rule
  // unless the sweep clears the whole range.
  assert.ok(UA_RULE_SWEEP_IDS.includes(UA_RULE_ID));
  assert.ok(UA_RULE_SWEEP_IDS.includes(9299));
  assert.ok(UA_RULE_SWEEP_IDS.includes(9001));
  assert.ok(UA_RULE_SWEEP_IDS.includes(9100));
});
