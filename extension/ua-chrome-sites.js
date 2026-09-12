// The sites that are served a CHROME user agent — the DEFAULT list, the parser
// for the user's own list, and the builders the background page turns a list
// into. Everywhere not on the effective list Safari is HONEST: byte-identical
// to Develop > User Agent > "Default (Automatically Chosen)", because nothing
// is set at all. Leave Safari's own CustomUserAgent preference unset and this
// extension is the only thing that ever touches the UA.
//
// THE LIST IS A SETTING (0.36). It lives in browser.storage.local under
// "uaChromeSites" and is edited in the panel's gear ("Sites served as Chrome");
// UA_CHROME_SITES below is the default and the fallback when nothing is saved.
// The background page applies a change LIVE — it rebuilds the declarativeNet-
// Request header rule and re-registers the MAIN-world scripts — so no rebuild
// and no Safari restart is needed. A page that is already open keeps the
// treatment it loaded with until it is reloaded.
//
// This file is loaded ONLY in the background page now. Before 0.36 it also
// shipped into every page's MAIN world so the content scripts could self-gate
// on it; they are scoped by their registration's `matches` instead, so the list
// no longer travels into web pages at all.
//
// THE MODEL IS INVERTED, DELIBERATELY (2026-09-01). The obvious design sets a
// global Chrome UA in Safari's own preferences and uses an extension to revert
// listed sites back to Safari. That can never be race-free: neither the content
// scripts nor the declarativeNetRequest rules can be relied on for pages loaded
// immediately after a cold Safari launch (measured: right after a relaunch, a
// page probe reported the shim absent and the site list undefined; both
// appeared only after opening a new window). So the first request of a cold
// launch went out as Chrome no matter what was listed, and Cloudflare binds its
// cf_clearance token to the issuing UA — one raced request poisoned claude.ai
// into a permanent "Just a moment..." challenge loop: invisible, sticky, fixed
// only by clearing the site's data.
//
// With the spoof scoped to a list instead, the race flips direction: a page
// load that beats the extension on a listed site sends honest Safari, and the
// site shows its visible "unsupported browser" refusal, which a reload fixes —
// a soft, self-announcing failure instead of a poisoned token. That trade is
// the whole point of the inversion. claude.ai, accounts.google.com and every
// other site need no entry anywhere: they are default by construction.
//
// WHY A SITE NEEDS CHROME AT ALL — measured 2026-09-01 on the seed entries
// below: with the real Safari UA the product refuses outright ("This browser
// doesn't support live app testing"), and it derives its client_browser from
// navigator.userAgent IN THE PAGE (jquery.browser), so the MAIN-world patch in
// ua-consistency.js is load-bearing, not decorative; the request-header half is
// the declarativeNetRequest rule in background.js. The spoof is still
// detectably inconsistent wherever it is sent — Safari sends no Sec-CH-UA
// client hints and refuses to let an extension add them, and the TLS/JA3 +
// HTTP/2 fingerprints always say Safari — which is the other reason it is
// confined to sites that demand it.

// A bare hostname matches itself and its subdomains, so "example.com" also
// covers app.example.com. Empty the list in the gear to turn the spoof off.
const UA_CHROME_SITES = [
  // Some consoles refuse Safari outright (measured above).
  "browserstack.com",
  // Slack's web client keys feature support (huddles, calls) off the browser
  // and points Safari at Chrome or the desktop app; that gate reads
  // navigator.userAgent in the client, which lives on this host. Deliberately
  // ONLY the app host, not all of slack.com: workspace sign-in, the marketing
  // site and the wss-*.slack.com socket hosts stay honest Safari — the
  // narrower the contradiction surface, the better. Signed out, app.slack.com
  // redirects to the marketing site, which is unlisted and correctly honest.
  "app.slack.com",
];

// One rule covers every listed domain (requestDomains takes an array), so there
// is no id range to manage. The sweep still clears 9200-9299 because earlier
// builds wrote one rule per domain in that range and DYNAMIC RULES PERSIST
// across updates: without the sweep, a domain removed from the list would keep
// its rule from the previous install forever. 9001 and 9100 were the
// client-hint probe and the exception-era rule.
const UA_RULE_ID = 9200;
const UA_RULE_SWEEP_IDS = Array.from({ length: 100 }, (_, i) => 9200 + i).concat([9001, 9100]);
// A ceiling on a user-editable list: every entry becomes two match patterns on
// a document_start MAIN-world registration, and a runaway paste should fail
// visibly in the gear rather than quietly wedge every page load.
const MAX_UA_SITES = 200;

// One line of the gear's textarea -> a bare lowercase hostname, or "" when the
// line carries nothing usable. Deliberately forgiving about what people paste:
// a full URL, a "*." wildcard prefix, a trailing dot, a port, and leading or
// trailing space all normalise to the hostname. Deliberately strict about what
// comes out, because the result goes straight into a declarativeNetRequest
// condition, and ONE invalid entry makes updateDynamicRules reject the whole
// call — the spoof would silently vanish for every site, not just the bad one.
//
// ASCII ONLY, which means an international domain has to be entered in its
// punycode form (xn--...): the label check below refuses non-ASCII outright
// rather than guessing at an encoding, because what reaches requestDomains has
// to be exactly what the browser will compare against.
function normaliseHost(line) {
  let h = String(line == null ? "" : line).trim().toLowerCase();
  if (!h || h.startsWith("#") || h.startsWith("//")) return "";   // blank line or comment
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");                   // scheme
  h = h.split(/[/?#]/)[0];                                        // path, query, fragment
  h = h.replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");  // *. and stray dots
  h = h.replace(/:\d+$/, "");                                     // port
  if (!h || h.length > 253) return "";
  // A SINGLE LABEL IS REFUSED, and this is the important one. "*.com", ".com"
  // and "com" all normalise to "com", which as a requestDomains entry matches
  // every .com domain and as a match pattern becomes *://*.com/* -- the global
  // spoof this file's header exists to explain the absence of, arrived at by
  // typing three characters into a settings box. It also drops "localhost",
  // which is fine: a UA spoof against a local dev server is not what this is
  // for. (It does NOT stop a deliberately broad two-label entry like "co.uk";
  // ruling that out needs the public-suffix list, which is not worth shipping
  // for a hand-edited list.)
  if (!h.includes(".")) return "";
  if (h.includes(":")) return "";                                 // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return "";               // IPv4 literal
  // Labels: letters, digits and inner hyphens, at most 63 characters each.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(h)) return "";
  return h;
}

// The gear's textarea -> { sites, rejected }. Order is preserved, duplicates
// collapse, and every line that produced nothing is reported back so the gear
// can say which ones were ignored instead of silently dropping them.
function parseSiteList(text) {
  const sites = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of String(text == null ? "" : text).split(/\r?\n/)) {
    const h = normaliseHost(raw);
    if (!h) {
      if (raw.trim() && !raw.trim().startsWith("#") && !raw.trim().startsWith("//")) rejected.push(raw.trim());
      continue;
    }
    if (seen.has(h)) continue;
    seen.add(h);
    if (sites.length >= MAX_UA_SITES) { rejected.push(raw.trim()); continue; }
    sites.push(h);
  }
  return { sites, rejected };
}

// Match patterns for scripting.registerContentScripts. BOTH spellings per host:
// the "*." form is specified to cover the bare domain as well, but emitting the
// bare host too costs nothing and does not depend on that reading. http and
// https only — a UA spoof is meaningless on file: or about:.
function siteMatchPatterns(sites) {
  const out = [];
  for (const h of sites || []) {
    if (!normaliseHost(h)) continue;
    out.push("*://" + h + "/*");
    out.push("*://*." + h + "/*");
  }
  return out;
}

// The declarativeNetRequest rule that sets the Chrome User-Agent REQUEST header
// on the listed domains. requestDomains matches a domain AND its subdomains, so
// "example.com" covers app.example.com without an extra entry. Returns null
// when there is nothing to install, which is the caller's signal to sweep and
// stop rather than to write an empty rule.
function buildUaHeaderRule(sites, ua) {
  const domains = (sites || []).map(normaliseHost).filter(Boolean);
  if (!domains.length || !/Chrome\/\d+\./.test(String(ua || ""))) return null;
  return {
    id: UA_RULE_ID,
    priority: 100,                              // beat anything added later
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "user-agent", operation: "set", value: String(ua) }],
    },
    condition: {
      requestDomains: domains,
      resourceTypes: [
        "main_frame", "sub_frame", "xmlhttprequest", "script",
        "stylesheet", "image", "font", "media", "websocket", "other",
      ],
    },
  };
}

// Hostname match that is not fooled by a suffix collision: "notexample.com"
// must NOT match "example.com", so a bare endsWith is wrong — require a dot
// boundary. Kept for callers that need to answer "is this host covered" without
// consulting the browser (the unit test, and any future in-page check).
function isChromeUASite(hostname, sites) {
  const h = String(hostname || "").toLowerCase();
  const list = Array.isArray(sites) ? sites : UA_CHROME_SITES;
  return list.some(function (d) {
    d = String(d || "").toLowerCase();
    return !!d && (h === d || h.endsWith("." + d));
  });
}

if (typeof module !== "undefined" && module.exports) {
  // For the node unit test only; `module` is undefined in every browser context
  // this file is loaded in.
  module.exports = {
    UA_CHROME_SITES, UA_RULE_ID, UA_RULE_SWEEP_IDS, MAX_UA_SITES,
    normaliseHost, parseSiteList, siteMatchPatterns, buildUaHeaderRule, isChromeUASite,
  };
}
