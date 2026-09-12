// Per-site Chrome user agent — the JS half.
//
// Safari's default UA stays HONEST: leave Safari's own CustomUserAgent
// preference unset and every site not listed in ua-chrome-sites.js sees
// exactly what a Safari without this extension sends — race-free by
// construction (the inversion story and measurements live in that file's
// header). On the listed sites, background.js sets the Chrome User-Agent
// request header; this file is the other half: navigator.userAgent in the
// page. BOTH are needed — a typical browser guard derives its client_browser
// from navigator.userAgent via jquery.browser IN THE PAGE, so a header-only
// spoof still gets the visible "unsupported browser" refusal.
//
// WHAT IT DELIBERATELY DOES NOT DO: fake userAgentData, window.chrome, or
// vendor. Safari's own Develop > User Agent > "Google Chrome — macOS" sets a
// plain UA string and nothing else, and that unadorned state is what the
// listed sites were verified against — measured 2026-09-01: products that
// work under Safari's native Chrome override misbehaved with those extra
// patches present. So: the UA string, exactly like the menu item.
//
// IT MUST RUN IN THE PAGE WORLD — an isolated content script's `navigator` is
// not the page's one. The manifest asks for "world": "MAIN" so the BROWSER
// does that injection, which is the only route a strict
// Content-Security-Policy cannot refuse (measured on claude.ai in the
// pre-inversion era: an inline <script> was silently blocked there). The
// injection is kept as a fallback in case `world` is ignored (pre-16.4
// Safari), and documentElement gets a data-ua-fix attribute naming the path
// that actually applied, so "did it run" has an answer rather than a guess.
//
// LAUNCH RACE, ACCEPTED: content scripts are not injected into pages loaded
// immediately after a cold Safari launch (measured), so the first paint of a
// listed site can see honest Safari and refuse — visibly, fixed by a reload.
// That soft failure is the trade that keeps every OTHER site honest and
// race-free; do not "fix" it by reintroducing a global spoof.

(function () {
  "use strict";

  // Only ever ACT on the listed sites. ua-chrome-sites.js and ua-chrome.js
  // are loaded before this script (manifest order); if either is missing or
  // garbled, do nothing rather than half-spoof.
  if (typeof isChromeUASite !== "function" || !isChromeUASite(location.hostname)) return;
  var ua = (typeof chromeUA === "function" && chromeUA()) || "";
  if (!/Chrome\/\d+\./.test(ua)) return;

  // Defined once, then either called directly (MAIN world) or stringified and
  // injected (isolated-world fallback). One body, no chance of the two
  // drifting — so it must stay self-contained.
  function patch(UA) {
    try {
      var def = function (obj, prop, value) {
        try {
          Object.defineProperty(obj, prop, {
            get: function () { return value; },
            configurable: true,
            enumerable: true
          });
        } catch (e) { /* non-configurable: skip rather than throw */ }
      };
      def(navigator, "userAgent", UA);
      // appVersion is the same string minus the leading "Mozilla/"; sniffers
      // that predate userAgent conventions still read it.
      def(navigator, "appVersion", UA.replace(/^Mozilla\//, ""));
    } catch (e) { /* never break the page for this */ }
  }

  // ── Apply, two ways, because we may be in either world ──────────────────
  // Patch directly (correct and sufficient in MAIN), and if that visibly did
  // not take, ALSO inject (covers the isolated case on sites whose CSP allows
  // it — moot for the current seed list, kept for older Safari).
  var marker = "";
  try {
    patch(ua);
    if (navigator.userAgent === ua) marker = "main";
  } catch (e) {}

  if (marker !== "main") {
    try {
      var s = document.createElement("script");
      s.textContent = "(" + patch.toString() + ")(" + JSON.stringify(ua) + ");";
      var root = document.documentElement || document.head || document.body;
      if (root) {
        root.insertBefore(s, root.firstChild);
        s.remove();
        marker = "injected";
      }
    } catch (e) { /* CSP refused it — page is unaffected */ }
  }
  try {
    if (document.documentElement && marker) {
      document.documentElement.setAttribute("data-ua-fix", marker);
    }
  } catch (e) {}
})();
