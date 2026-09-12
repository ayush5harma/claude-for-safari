// Sites that are served a CHROME user agent. Everywhere else Safari is
// HONEST — byte-identical to Develop > User Agent > "Default (Automatically
// Chosen)", because nothing is set at all. Leave Safari's own
// CustomUserAgent preference unset and this extension is the only thing that
// ever touches the UA.
//
// THE MODEL IS INVERTED, DELIBERATELY (2026-09-01). The obvious design sets a
// global Chrome UA in Safari's own preferences and uses an extension to
// revert listed sites back to Safari. That can never be race-free: neither
// the content scripts nor the declarativeNetRequest rules can be relied on
// for pages loaded immediately after a cold Safari launch (measured: right
// after a relaunch, a page probe reported the shim absent and the site list
// undefined; both appeared only after opening a new window). So the first
// request of a cold launch went out as Chrome no matter what was listed, and
// Cloudflare binds its cf_clearance token to the issuing UA — one raced
// request poisoned claude.ai into a permanent "Just a moment..." challenge
// loop: invisible, sticky, fixed only by clearing the site's data.
//
// With the spoof scoped HERE instead, the race flips direction: a page load
// that beats the extension on a listed site sends honest Safari, and the site
// shows its visible "unsupported browser" refusal, which a reload fixes — a
// soft, self-announcing failure instead of a poisoned token. That trade is
// the whole point of the inversion. claude.ai, accounts.google.com and every
// other site need no entry anywhere: they are default by construction.
//
// WHY A SITE NEEDS CHROME AT ALL — measured 2026-09-01 on the seed entries
// below: with the real Safari UA the product refuses outright ("This browser
// doesn't support live app testing"), and it derives its client_browser from
// navigator.userAgent IN THE PAGE (jquery.browser), so the MAIN-world patch
// in ua-consistency.js is load-bearing, not decorative; the request-header
// half is a declarativeNetRequest rule in background.js. The spoof is still
// detectably inconsistent wherever it is sent — Safari sends no Sec-CH-UA
// client hints and refuses to let an extension add them, and the TLS/JA3 +
// HTTP/2 fingerprints always say Safari — which is the other reason it is
// confined to sites that demand it.
//
// EDIT THIS LIST to add a site, or empty it to turn the spoof off entirely.
// Matching is on the hostname and covers subdomains, so "example.com" also
// matches app.example.com. Then bump the version in manifest.json
// (build-app.sh --if-changed also byte-compares the .js sources, so a rebuild
// catches an unbumped edit too), run `bash build-app.sh`, and REALLY quit and
// relaunch Safari — an extension-bundle change needs a fresh process (check
// `ps lstart`).
const UA_CHROME_SITES = [
  // Live-app-testing consoles refuse Safari outright (measured above).
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

// Hostname match that is not fooled by a suffix collision: "notexample.com"
// must NOT match "example.com", so a bare endsWith is wrong — require a dot
// boundary.
function isChromeUASite(hostname) {
  const h = String(hostname || "").toLowerCase();
  return UA_CHROME_SITES.some(function (d) {
    d = d.toLowerCase();
    return h === d || h.endsWith("." + d);
  });
}

if (typeof window !== "undefined") { window.__UA_CHROME_SITES__ = UA_CHROME_SITES; window.__isChromeUASite__ = isChromeUASite; }
