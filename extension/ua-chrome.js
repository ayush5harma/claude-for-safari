// The Chrome user-agent string served on ua-chrome-sites.js hosts, at both
// layers (declarativeNetRequest header rule in background.js, navigator patch
// in ua-consistency.js — one definition, so they cannot disagree).
//
// THIS FILE IS THE COMMITTED DEFAULT, with the Chrome major pinned below.
// build-app.sh regenerates it into the BUILD COPY of the extension from
// $SAFARI_USER_AGENT, or from the cache file at $SAFARI_UA_CACHE when that
// carries a newer Chrome major — and never writes over this tracked file, so
// a build can never dirty the checkout. Hand-edit the string to move the pin;
// a build with neither env source ships exactly what is here, which degrades
// to "slightly stale Chrome major" rather than to "no spoof".
//
// A FUNCTION DECLARATION, deliberately — not a const. Safari gives each
// content-script file in the same manifest entry its own lexical scope while
// they share the global object, so a top-level const here is invisible to
// ua-consistency.js (measured on the former ua-safari.js: a function crossed
// fine while the const did not, and the patch silently did nothing).
function chromeUA() {
  return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
}
