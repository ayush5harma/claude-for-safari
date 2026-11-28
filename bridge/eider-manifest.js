// The Eider install manifest: GET /eider/manifest/<secret>.plist?bundle=&version=&title=&url=
// answers the itms-services manifest for one Eider build whose IPA the
// owner's iPhone serves itself. Loaded by the hub only when
// EIDER_MANIFEST_SECRET is set (HOSTING.md, "Eider install manifest").
//
// Why a hub writes it: iOS 27.3's appstored refuses a manifest the iPhone
// serves itself ("The manifest URL isn't external", measured 2026-11-28 on the
// owner's iPhone for https://127.0.0.1 and for the phone's own Wi-Fi IP), but
// installs from a manifest another host serves whose IPA URL points back at
// the phone (iTorrent, the same day: Mac-hosted manifest, IPA served by the
// phone at https://192.168.1.50:61901/<token>/app.ipa).
//
// appstored sends no credentials, so the route is public. What fences it:
//   - a secret path segment, compared in constant time (sha256 of both sides,
//     so a wrong length leaks nothing either); a wrong or missing one is a
//     404, whatever the method;
//   - every query value is validated before anything is written, and `url`
//     may only name the phone itself: an https IPv4 literal in 10/8,
//     172.16/12, 192.168/16, 100.64/10 or 127/8, an explicit port, and the
//     path /<32 lowercase hex>/app.ipa. The endpoint therefore cannot vouch
//     for an arbitrary internet IPA;
//   - nothing from the query is logged except the (validated) bundle id.
"use strict";
const crypto = require("node:crypto");

const PREFIX = "/eider/manifest/";
const SECRET_RE = /^[0-9a-f]{32,128}$/;
const FIELDS = ["bundle", "version", "title", "url"];
const BUNDLE_RE = /^[A-Za-z0-9.-]{1,255}$/;
// Printable: no control, format, surrogate, private-use or unassigned code
// point (Unicode category C), counted in code points. That also keeps out
// every character XML 1.0 cannot carry (C0 controls, U+FFFE, U+FFFF).
const TEXT_RE = /^[^\p{C}]{1,200}$/u;
// Octets and port without leading zeros: some parsers read 010 as octal, and
// a canonical form is what lets the validated string be written out as is.
const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPA_URL_RE = new RegExp(`^https://${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}:([1-9]\\d{0,4})/[0-9a-f]{32}/app\\.ipa$`);
// [first octet, second octet, prefix length]
const PHONE_NETS = [[10, 0, 8], [172, 16, 12], [192, 168, 16], [100, 64, 10], [127, 0, 8]];

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest();
const sameSecret = (got, want) => crypto.timingSafeEqual(sha256(got), sha256(want));

const inPhoneNet = (a, b) => PHONE_NETS.some(([na, nb, bits]) => {
  // Only the first two octets matter for prefixes of 16 bits or fewer.
  const ip16 = (a << 8) | b;
  const net16 = (na << 8) | nb;
  return ip16 >>> (16 - bits) === net16 >>> (16 - bits);
});

/** @returns {string|null} why `url` is refused, or null when it names the phone itself. */
function ipaUrlProblem(url) {
  const m = IPA_URL_RE.exec(url);
  if (!m) return "url must be https://<IPv4>:<port>/<32 lowercase hex>/app.ipa";
  const port = Number(m[5]);
  if (port > 65535) return "url port is out of range";
  if (!inPhoneNet(Number(m[1]), Number(m[2]))) {
    return "url host must be in 10/8, 172.16/12, 192.168/16, 100.64/10 or 127/8";
  }
  return null;
}

/**
 * Parse and validate the query string (without the leading "?").
 * @returns {{ ok: true, value: {bundle: string, version: string, title: string, url: string} } | { ok: false, error: string }}
 */
function parseQuery(search) {
  const got = new Map();
  for (const [k, v] of new URLSearchParams(search)) {
    if (!FIELDS.includes(k)) return { ok: false, error: "unknown parameter " + JSON.stringify(k.slice(0, 40)) };
    if (got.has(k)) return { ok: false, error: k + " is given more than once" };
    got.set(k, v);
  }
  for (const k of FIELDS) if (!got.has(k)) return { ok: false, error: k + " is required" };
  const value = Object.fromEntries(got);
  if (!BUNDLE_RE.test(value.bundle)) return { ok: false, error: "bundle must match ^[A-Za-z0-9.-]{1,255}$" };
  if (!TEXT_RE.test(value.version)) return { ok: false, error: "version must be 1-200 printable characters" };
  if (!TEXT_RE.test(value.title)) return { ok: false, error: "title must be 1-200 printable characters" };
  const urlProblem = ipaUrlProblem(value.url);
  if (urlProblem) return { ok: false, error: urlProblem };
  return { ok: true, value };
}

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/** The standard itms-services manifest for one software package. */
function renderManifest({ bundle, version, title, url }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${xml(url)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${xml(bundle)}</string>
        <key>bundle-version</key>
        <string>${xml(version)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${xml(title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

const text = (res, code, body, extra = {}) => {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", ...extra });
  res.end(body + "\n");
};

/**
 * @param {string} secret EIDER_MANIFEST_SECRET: 32-128 lowercase hex characters.
 * @param {{ log?: (line: string) => void }} [opts]
 */
function createEiderManifest(secret, { log = () => {} } = {}) {
  if (!SECRET_RE.test(String(secret || ""))) {
    throw new Error("EIDER_MANIFEST_SECRET must be 32-128 lowercase hex characters (openssl rand -hex 16)");
  }
  const owns = (pathname) => pathname.startsWith(PREFIX);
  const serve = (req, res) => {
    const raw = String(req.url || "");
    const q = raw.indexOf("?");
    const pathname = q < 0 ? raw : raw.slice(0, q);
    const m = /^\/eider\/manifest\/([^/]*)\.plist$/.exec(pathname);
    if (!m || !sameSecret(m[1], secret)) return text(res, 404, "not found");
    if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "method not allowed", { allow: "GET, HEAD" });
    const parsed = parseQuery(q < 0 ? "" : raw.slice(q + 1));
    if (!parsed.ok) return text(res, 400, parsed.error);
    const body = renderManifest(parsed.value);
    res.writeHead(200, { "content-type": "text/xml; charset=utf-8", "content-length": Buffer.byteLength(body),
      "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(body);
    log("eider-manifest: served " + parsed.value.bundle);
  };
  return { owns, serve };
}

module.exports = { createEiderManifest, parseQuery, renderManifest, ipaUrlProblem, PREFIX };
