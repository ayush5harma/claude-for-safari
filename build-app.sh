#!/usr/bin/env bash
# Build, sign, install, and register the macOS wrapper app that hosts the
# Safari Web Extension in ./extension — entirely from the CLI, no Xcode GUI.
#
# Safari (unlike Chrome) only loads an extension that ships inside a signed app
# bundle; there is no "load unpacked". This script does the whole bundle dance:
#   1. Stage a BUILD COPY of ./extension and generate ua-chrome.js into it.
#   2. safari-web-extension-converter turns that copy into an Xcode project.
#   3. Normalize bundle IDs — the converter derives the APP id from the app
#      NAME but the EXTENSION id from --bundle-identifier, so out of the box the
#      extension is NOT prefixed by the app and Xcode's ValidateEmbeddedBinary
#      fails ("Embedded binary's bundle identifier is not prefixed..."). We
#      force app = $APP_ID and extension = $APP_ID.Extension.
#   4. xcodebuild, signed with whatever Apple cert the login keychain has, or
#      ad-hoc ("-") when there is none.
#   5. Copy to the install directory and register it: LaunchServices for the
#      app, pluginkit for the extension. No launch: the wrapper app's window
#      ("the extension is currently on") is for a person, and a rebuild from a
#      switch or a background session used to put it in front of the user on
#      every run (2026-09-18). Only when pluginkit still does not list the
#      extension is the app launched -- hidden, and quit again.
#
# Re-run after editing ./extension. Idempotent: it rebuilds from scratch.
#
# Two steps CANNOT be scripted (deliberate user consent, like Full Disk Access)
# and are printed at the end: enabling the extension, and — when the build is
# ad-hoc signed rather than Apple-signed — allowing unsigned extensions.
#
# Usage: build-app.sh [--build-only] [--if-changed] [--install-dir DIR]
#                     [--register] [--help]
#   --build-only        build and stop; do not copy the app anywhere
#   --if-changed        exit 0 without building when the installed extension
#                       already matches this checkout (version + .js bytes)
#   --install-dir DIR   where the .app is copied (default: /Applications).
#                       A scratch directory here is how you build without
#                       touching an installed copy.
#   --register          force the LaunchServices + pluginkit registration
#                       even for a non-default install directory
#
# Environment inputs (all optional):
#   SAFARI_USER_AGENT        Chrome UA string to generate into the build copy's
#                            ua-chrome.js. Acts as a FLOOR: the cache below is
#                            preferred when its Chrome major is >= this one.
#   SAFARI_UA_CACHE          file whose first line is a Chrome UA string
#                            (default ~/.cache/claude-safari/chrome-ua).
#                            Point this at whatever keeps a fresh Chrome UA.
#   SAFARI_APP_INSTALL_DIR   default for --install-dir.
#   SAFARI_CODESIGN_IDENTITY exact common name of the signing identity to use;
#                            overrides the discovery below.
#   SAFARI_APP_ID            bundle id (default com.ayushsharma.claude-safari).
#   SAFARI_APP_NAME          app name (default "Claude for Safari").
#   MATCH_GIT_URL            optional, no default: if your team distributes
#   MATCH_GIT_BRANCH         signing certs through fastlane match, these are
#   MATCH_APP_IDENTIFIER     printed back as the exact command to fetch one
#                            when no usable identity is in the keychain.
#                            Nothing here runs fastlane or touches a network.
#
# With NEITHER a UA string nor a cache, the committed extension/ua-chrome.js is
# shipped as is: a slightly stale Chrome major rather than no spoof at all.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$HERE/extension"
APP_DIR="$HERE/app"
APP_NAME="${SAFARI_APP_NAME:-Claude for Safari}"
APP_ID="${SAFARI_APP_ID:-com.ayushsharma.claude-safari}"
UA_CACHE="${SAFARI_UA_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/claude-safari/chrome-ua}"

BUILD_ONLY=0
IF_CHANGED=0
FORCE_REGISTER=0
INSTALL_DIR="${SAFARI_APP_INSTALL_DIR:-/Applications}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-only)  BUILD_ONLY=1; shift ;;
    --if-changed)  IF_CHANGED=1; shift ;;   # exit fast when the installed appex already matches
    --register)    FORCE_REGISTER=1; shift ;;
    --install-dir) INSTALL_DIR="${2:?--install-dir needs a directory}"; shift 2 ;;
    --install-dir=*) INSTALL_DIR="${1#*=}"; shift ;;
    --help|-h)     awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *)             echo "Unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
# Two registered apps sharing one bundle id shadow each other
# nondeterministically (an Xcode DerivedData copy once won over /Applications
# and the extension "vanished"), so a build into a scratch directory registers
# NOTHING unless asked. One id, one registered path, always.
REGISTER=$FORCE_REGISTER
[ "$INSTALL_DIR" = "/Applications" ] && REGISTER=1

# ── Stage a build copy of the extension ───────────────────────────────────────
# The generated ua-chrome.js goes HERE, never over the tracked file: the build
# that wrote it in place rewrote a committed file every time the Chrome major
# moved, so every build dirtied the checkout.
# A full template, not `-t prefix`: that form is BSD-only, and GNU mktemp
# (first on PATH inside a nix-darwin/home-manager activation, which runs this
# build) refuses it with "too few X's in template" (measured 2026-09-13).
STAGE_EXT="$(mktemp -d "${TMPDIR:-/tmp}/claude-safari-ext.XXXXXX")"
trap 'rm -rf "$STAGE_EXT"' EXIT
cp -R "$EXT/." "$STAGE_EXT/"

# Regenerate the Chrome-UA constant the per-site spoof serves (ua-chrome.js —
# the header rule in background.js and the navigator patch in ua-consistency.js
# both read it, so one definition keeps them agreeing). Prefer the cache file
# (whatever refreshes $SAFARI_UA_CACHE), floored by SAFARI_USER_AGENT when the
# caller provides one. If neither source is usable the staged copy of the
# checked-in file is left AS IS: it carries the committed default, so the build
# degrades to "slightly stale Chrome major" rather than to "no spoof".
_uaf="$STAGE_EXT/ua-chrome.js"
_ua_major() { printf '%s' "$1" | sed -nE 's/.*Chrome\/([0-9]+)\..*/\1/p'; }
_floor="${SAFARI_USER_AGENT:-}"
_floor_major="$(_ua_major "$_floor")"; : "${_floor_major:=0}"
_cached="$(head -1 "$UA_CACHE" 2>/dev/null || true)"
_cached_major="$(_ua_major "$_cached")"; : "${_cached_major:=0}"
_chrome_ua=""
if [ "$_cached_major" -gt 0 ] && [ "$_cached_major" -ge "$_floor_major" ]; then
  _chrome_ua="$_cached"          # fresh and >= the pin — the normal case
elif [ "$_floor_major" -gt 0 ]; then
  _chrome_ua="$_floor"           # no usable cache: SAFARI_USER_AGENT is the floor
fi
if [ -n "$_chrome_ua" ]; then
  # QUOTED heredoc + a placeholder, deliberately. An unquoted heredoc would be
  # needed to expand the string directly, but then the SHELL also interprets
  # the JS body — and a comment containing backticks became command
  # substitution and made every build print "line 32: const: command not
  # found". Quoting the delimiter makes the body inert, and the value is
  # substituted afterwards, so backticks, $ and quotes in the JS can never be
  # executed. `|` as the sed delimiter because the UA contains `/`.
  cat > "$_uaf" <<'UAEOF'
// GENERATED by build-app.sh into the BUILD COPY of the extension — the tracked
// extension/ua-chrome.js is never written by a build.
//
// The Chrome user-agent string served on ua-chrome-sites.js hosts, at both
// layers (declarativeNetRequest header rule in background.js, navigator patch
// in ua-consistency.js — one definition, so they cannot disagree).
//
// Source: $SAFARI_UA_CACHE's first line when its Chrome major is at least the
// one in $SAFARI_USER_AGENT, else $SAFARI_USER_AGENT. With neither, the
// committed default ships unchanged.
//
// A FUNCTION DECLARATION, deliberately — not a const. Safari gives each
// content-script file in the same manifest entry its own lexical scope while
// they share the global object, so a top-level const here is invisible to
// ua-consistency.js (measured on a former ua-safari.js: a function crossed
// fine while the const did not, and the patch silently did nothing).
function chromeUA() {
  return "__CHROME_UA__";
}
UAEOF
  # Write-and-rename rather than `sed -i ''`: that form is BSD-only. Under GNU
  # sed (which can be first in PATH) the empty argument becomes the script and
  # the s-command a file name, sed exits non-zero with "can't read
  # s|__CHROME_UA__|...", and the placeholder ships — observed 2026-09-09: the
  # installed build served "__CHROME_UA__" and every ua-chrome-sites.js host
  # saw honest Safari (the sites' "unsupported browser" gates fired).
  LC_ALL=C sed "s|__CHROME_UA__|${_chrome_ua}|" "$_uaf" > "$_uaf.tmp" && mv "$_uaf.tmp" "$_uaf"
  grep -q '__CHROME_UA__' "$_uaf" && { echo "  ERROR: Chrome UA substitution failed; refusing to build a spoof-less extension" >&2; exit 1; }
elif [ ! -f "$_uaf" ]; then
  echo "  WARNING: no Chrome UA available (no cache, no SAFARI_USER_AGENT) and" >&2
  echo "           extension/ua-chrome.js is missing — the per-site spoof will be OFF." >&2
fi

# --if-changed: skip the whole converter+xcodebuild dance when the installed
# extension already matches this checkout. Version compare first, then a
# byte-compare of the .js sources: the same manifest version can hide changed
# sources — the generated ua-chrome.js moves when the Chrome major does, and a
# site-list edit is easy to make without remembering a version bump (observed
# 2026-09-01: an installed build matched the repo's version while the site list
# differed). The converter copies .js resources VERBATIM (verified by cmp
# against the installed appex), so bytes are a fair test; manifest.json is NOT
# byte-compared because the converter rewrites it.
if [ "$IF_CHANGED" -eq 1 ]; then
  WANT=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
    "$STAGE_EXT/manifest.json" 2>/dev/null || echo "?")
  APPEX_RES="$INSTALL_DIR/$APP_NAME.app/Contents/PlugIns/$APP_NAME Extension.appex/Contents/Resources"
  HAVE=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
    "$APPEX_RES/manifest.json" 2>/dev/null || echo "none")
  if [ "$WANT" = "$HAVE" ] && [ "$WANT" != "?" ]; then
    stale=""
    for _f in "$STAGE_EXT"/*.js; do
      cmp -s "$_f" "$APPEX_RES/$(basename "$_f")" || { stale="$(basename "$_f")"; break; }
    done
    if [ -z "$stale" ]; then
      echo "$APP_NAME $HAVE already current — skipping build"
      exit 0
    fi
    echo "$APP_NAME: version $HAVE unchanged but $stale differs — rebuilding"
  else
    echo "$APP_NAME: installed=$HAVE repo=$WANT — rebuilding"
  fi
fi

# Signing identity decides whether Safari accepts the extension PERMANENTLY.
# What Safari actually needs is an Apple-issued cert chain and a real Team ID
# on the .appex; with one, the extension just appears and persists. Ad-hoc
# ("-") sets TeamIdentifier=not set and forces the per-restart "Allow Unsigned
# Extensions" toggle — NOT permanent.
#
# Resolution: explicit SAFARI_CODESIGN_IDENTITY wins; else the first usable
# identity in PREFERRED_KINDS order; else ad-hoc.
#
# "iPhone Developer" is in that list, last. An earlier version of this comment
# claimed an iOS cert "does not count — Safari rejects it for a Mac
# extension". That was WRONG, and it cost a working extension: verified
# 2026-08-25, an iPhone Developer cert signs the macOS app AND the .appex
# (full Apple WWDR -> Apple Root CA chain, a real TeamIdentifier, adhoc flag
# gone), and Safari lists and runs the extension permanently. Note `spctl -a
# -t exec` still reports "rejected" — that is Gatekeeper judging an
# un-notarized development build for distribution, and is NOT what gates the
# Safari extension list. Keep it LAST so a real macOS cert always wins.
#
# `security find-identity -v` is NOT a validity filter. macOS still prints a
# REVOKED or EXPIRED cert, counts it under "valid identities found", and only
# appends a marker to the line:
#   1) 1F03...C3 "Apple Development: you (ABCDE)" (CSSMERR_TP_CERT_REVOKED)
# Grepping by kind alone therefore picks a dead cert and hands it to
# xcodebuild, which fails the whole build with "Signing certificate is
# invalid" — instead of degrading to the ad-hoc path that would still produce
# a working extension. That is exactly what broke the build once (2026-08-25).
# Skip any CSSMERR_-marked line.
PREFERRED_KINDS=(
  "Developer ID Application"   # notarizable, best
  "Apple Development"          # unified Apple cert, macOS-capable
  "Mac Developer"              # legacy macOS
  "iPhone Developer"           # iOS-only kind, but proven to work — see above
)

REVOKED_CERTS=$(security find-identity -v -p codesigning 2>/dev/null \
  | grep -E "$(IFS='|'; echo "${PREFERRED_KINDS[*]}")" \
  | grep 'CSSMERR_' || true)

pick_identity() {
  local kind matches line
  for kind in "${PREFERRED_KINDS[@]}"; do
    matches=$(security find-identity -v -p codesigning 2>/dev/null | grep -F "$kind" || true)
    [ -n "$matches" ] || continue
    line=$(printf '%s\n' "$matches" | grep -v 'CSSMERR_' | head -1)
    if [ -n "$line" ]; then
      # extract the quoted common name
      printf '%s\n' "$line" | sed -E 's/^[^"]*"([^"]+)".*/\1/'
      return 0
    fi
  done
  printf '%s\n' "-"
}
SIGN_ID="${SAFARI_CODESIGN_IDENTITY:-$(pick_identity)}"

# A revoked/expired macOS cert is the difference between a permanent extension
# and one that needs re-toggling after every Safari restart, so never let it
# pass as a silent downgrade.
if [ -n "$REVOKED_CERTS" ]; then
  echo "  WARNING: ignoring unusable macOS signing cert(s):" >&2
  printf '%s\n' "$REVOKED_CERTS" | sed 's/^/    /' >&2
  if [ "$SIGN_ID" = "-" ]; then
    echo "    -> no usable Apple cert left; building AD-HOC (per-restart toggle)." >&2
    echo "    -> issue a new one: Xcode > Settings > Accounts > Manage Certificates" >&2
    echo "       > + > Apple Development, then re-run this script." >&2
  fi
fi
# fastlane match, only if the caller opted in. Some teams distribute their
# development certs through a match repo instead of issuing one per machine;
# there is no default here and nothing is automated, because the repo, its
# branch and its passphrase are the team's, not this project's. Fetching is a
# one-time manual step, then the cert is in the login keychain like any other
# and the discovery above finds it.
if [ "$SIGN_ID" = "-" ] && [ -n "${MATCH_GIT_URL:-}" ]; then
  echo "  No Apple cert in the keychain, and MATCH_GIT_URL is set. Fetch one with:" >&2
  echo "    MATCH_GIT_URL='$MATCH_GIT_URL' \\" >&2
  echo "    MATCH_GIT_BRANCH='${MATCH_GIT_BRANCH:-<branch>}' \\" >&2
  echo "    MATCH_APP_IDENTIFIER='${MATCH_APP_IDENTIFIER:-*}' MATCH_PASSWORD='<passphrase>' \\" >&2
  echo "    fastlane match development --readonly --clone_branch_directly" >&2
  echo "  Then re-run this script; it picks the cert up automatically." >&2
fi

command -v xcrun >/dev/null 2>&1 || { echo "ERROR: Xcode command-line tools required" >&2; exit 1; }
xcrun --find safari-web-extension-converter >/dev/null 2>&1 || {
  echo "ERROR: safari-web-extension-converter needs the full Xcode, not just the CLT." >&2
  echo "  Install Xcode from the App Store, open it once to finish its setup," >&2
  echo "  run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer, then retry." >&2
  exit 1
}
xcrun --find xcodebuild >/dev/null 2>&1 || { echo "ERROR: xcodebuild not found" >&2; exit 1; }

# ── 1. Convert ────────────────────────────────────────────────────────────────
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
# --no-open: without it the converter opens the generated project in Xcode's
# GUI every time, which a build from a switch or a background session has no
# business doing (the user watched Xcode appear during a rebuild, 2026-09-18).
xcrun safari-web-extension-converter "$STAGE_EXT" \
  --project-location "$APP_DIR" \
  --app-name "$APP_NAME" \
  --bundle-identifier "$APP_ID" \
  --macos-only --copy-resources --no-prompt --no-open --force

PROJ="$(find "$APP_DIR" -maxdepth 3 -name '*.xcodeproj' -print -quit)"
[ -n "$PROJ" ] || { echo "ERROR: converter produced no .xcodeproj" >&2; exit 1; }
# Xcode 27.2's converter writes the project as project.xcproj (a JSON-shaped
# file) instead of project.pbxproj; a build from a fresh copy of this repo
# found only the new file and died reading the old name (measured
# 2026-09-18, the first fleet rebuild after the Xcode update -- a checkout
# that had built before still carried a pbxproj under the gitignored app/,
# which is why the failure only showed from the store copy).
PBX="$PROJ/project.pbxproj"
[ -f "$PROJ/project.xcproj" ] && PBX="$PROJ/project.xcproj"
[ -f "$PBX" ] || { echo "ERROR: $PROJ holds neither project.pbxproj nor project.xcproj" >&2; exit 1; }

# ── 2. Normalize bundle IDs ───────────────────────────────────────────────────
# Every PRODUCT_BUNDLE_IDENTIFIER ending in .Extension becomes $APP_ID.Extension;
# everything else becomes $APP_ID. Deterministic regardless of what the
# converter derived from the (space-containing) app name. Both spellings: the
# pbxproj's `KEY = "value";` and the xcproj's `"KEY": "value"`.
/usr/bin/python3 - "$PBX" "$APP_ID" <<'PY'
import re, sys
pbx, app_id = sys.argv[1], sys.argv[2]
s = open(pbx).read()
def target(val):
    return f"{app_id}.Extension" if val.endswith(".Extension") else app_id
s = re.sub(r'PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;',
           lambda m: f'PRODUCT_BUNDLE_IDENTIFIER = "{target(m.group(1))}";', s)
s = re.sub(r'"PRODUCT_BUNDLE_IDENTIFIER": "([^"]+)"',
           lambda m: f'"PRODUCT_BUNDLE_IDENTIFIER": "{target(m.group(1))}"', s)
open(pbx, "w").write(s)
PY
echo "Bundle IDs normalized:"
grep -oE 'PRODUCT_BUNDLE_IDENTIFIER"?[ :=]+"[^";]+"' "$PBX" | sort -u | sed 's/^/  /'

# ── 3. Build ──────────────────────────────────────────────────────────────────
# MANUAL signing for every identity kind, all with an empty team and no
# provisioning profile. Verified the hard way, in order:
#   - App Sandbox is a NON-restricted macOS entitlement: no profile needed, any
#     Apple-issued cert can sign it manually. NEVER disable ENABLE_APP_SANDBOX
#     to dodge a signing error — macOS refuses to register a non-sandboxed
#     .appex at all: the build succeeds, pluginkit stays silent, and the
#     extension is simply invisible to Safari with no error anywhere.
#   - Automatic signing is a dead end headless: xcodebuild has no Apple ID
#     session ("No Account for Team"), and a free personal team cannot mint
#     Mac profiles from the CLI anyway.
#   - DEVELOPMENT_TEAM must stay EMPTY with a manual identity: the cert CN's
#     parenthesised suffix is NOT the team id (the team lives in the cert's OU
#     — codesign reports it as TeamIdentifier), so passing the suffix makes
#     Xcode reject its own cert ("No certificate for team ... matching ...").
SCHEME="$(xcodebuild -list -project "$PROJ" 2>/dev/null | awk '/Schemes:/{getline; gsub(/^[ \t]+/,""); print; exit}')"
[ -n "$SCHEME" ] || SCHEME="$APP_NAME"

if [ "$SIGN_ID" = "-" ]; then
  echo "Building scheme '$SCHEME' (ad-hoc — Safari will require the per-restart unsigned-extensions toggle)..."
else
  echo "Building scheme '$SCHEME' (signed: $SIGN_ID — permanent in Safari)..."
fi
xcodebuild -project "$PROJ" -scheme "$SCHEME" -configuration Release \
  -derivedDataPath "$APP_DIR/build" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="$SIGN_ID" \
  DEVELOPMENT_TEAM="" \
  PROVISIONING_PROFILE_SPECIFIER="" \
  build

APP="$(find "$APP_DIR/build/Build/Products/Release" -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$APP" ] || { echo "ERROR: build produced no .app" >&2; exit 1; }
# `cmd && echo` is NOT an abort: at the top level a failing left-hand side of an
# && list is exempt from set -e (measured), so a broken signature printed
# nothing and the script installed the bundle anyway.
codesign -v --deep --strict "$APP" || { echo "ERROR: signature verification failed for $APP" >&2; exit 1; }
echo "Signature OK: $APP"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister"
# ALWAYS deregister the DerivedData copy, on every exit path. Two registered
# apps with one bundle id shadow each other nondeterministically (an Xcode
# Debug copy once won over /Applications and the extension "vanished"), and
# xcodebuild registers the build-dir app ITSELF: its RegisterWithLaunchServices
# phase runs `lsregister -f -R -trusted` on the product, measured 2026-09-12, so
# even a --build-only or scratch-directory build silently takes the bundle id
# away from whatever is installed unless this undoes it. One id, one registered
# path, always.
"$LSREGISTER" -u "$APP" 2>/dev/null || true

if [ "$BUILD_ONLY" -eq 1 ]; then
  echo "Built (not installed): $APP"
  exit 0
fi

# ── 4. Install + register ─────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
DEST="$INSTALL_DIR/$APP_NAME.app"
rm -rf "$DEST"
cp -R "$APP" "$DEST"
echo "Installed: $DEST"

if [ "$REGISTER" -eq 0 ]; then
  cat <<EOF

Not registered with LaunchServices (install dir is not /Applications), and the
build-dir copy xcodebuild registered has been deregistered again, so whatever is
installed keeps the bundle id. Pass --register to register this build instead.
EOF
  exit 0
fi

"$LSREGISTER" -f "$DEST"
APPEX="$(find "$DEST/Contents/PlugIns" -maxdepth 1 -name '*.appex' -print -quit)"
[ -n "$APPEX" ] && pluginkit -a "$APPEX" 2>/dev/null
# pluginkit lists a freshly added extension about a second later (measured
# 2026-09-18: an immediate check missed it and the fallback launch below ran
# on every build), so give it a few seconds before concluding anything.
# Capture first, never `pluginkit -m | grep -q`: under pipefail grep's exit
# at the first match hands pluginkit a SIGPIPE and the pipeline reads as
# "not registered" although it is (measured 2026-09-18 -- the warning below
# printed on every build while pluginkit -m plainly listed the extension).
registered() { case "$(pluginkit -m 2>/dev/null)" in *"$APP_ID.Extension"*) return 0 ;; esac; return 1; }
for _ in 1 2 3 4 5 6 7 8 9 10; do registered && break; sleep 0.5; done
if ! registered; then
  # The one thing a launch does that registration does not: on a Mac that has
  # never run the app, Safari lists the extension only after the app has been
  # launched once. Hidden (-j) and in the background (-g), then quit.
  open -g -j "$DEST"
  sleep 3
  osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
fi

# Enable Safari's Develop menu now (persistent) so the unsigned-extension
# toggle is reachable after the required restart. Harmless when a real cert is
# used. Takes effect on Safari's next launch.
defaults write com.apple.Safari IncludeDevelopMenu -bool true 2>/dev/null || true
defaults write com.apple.Safari WebKitDeveloperExtrasEnabledPreferenceKey -bool true 2>/dev/null || true

echo ""
for _ in 1 2 3 4 5 6 7 8 9 10; do registered && break; sleep 0.5; done
if registered; then
  echo "Registered: pluginkit sees $APP_ID.Extension"
else
  echo "WARNING: installed to $DEST but pluginkit does not list the extension yet."
  echo "   It usually appears a few seconds after first launch; re-check with:"
  echo "     pluginkit -m | grep claude"
fi

if [ "$SIGN_ID" = "-" ]; then
  cat <<EOF

IMPORTANT — an ad-hoc build stays HIDDEN from Safari's Extensions list until
you allow unsigned extensions, and that requires a Safari restart:
  1. Quit Safari completely (Cmd+Q) and reopen it. (Tabs are restored;
     window-save-state is on.)
  2. Safari > Develop menu > "Allow Unsigned Extensions".  (Session-only:
     it resets on every Safari restart, so re-tick it after a relaunch. The
     Develop menu was just enabled for you.)
  3. Safari > Settings... > Extensions > enable "$APP_NAME", then
     "Always Allow on Every Website".
To make this PERMANENT (no toggle) you need ANY Apple-issued cert in the login
keychain — a Developer ID Application, Apple Development or Mac Developer cert,
or (proven to work here) an iPhone Developer cert. The free route is Xcode >
Settings > Accounts > add a personal Apple ID > Manage Certificates > + > Apple
Development. Install one and re-run; this script picks it up automatically, no
env var needed. To force a specific one:
  SAFARI_CODESIGN_IDENTITY="<exact common name>" bash build-app.sh
EOF
else
  cat <<EOF

Signed with "$SIGN_ID" — no unsigned-extension toggle needed:
  1. Safari > Settings... > Extensions > enable "$APP_NAME", then
     "Always Allow on Every Website".
EOF
fi

cat <<EOF

Then the claude_safari_* MCP tools light up in any Claude Code session that has
the bridge registered (see README.md, "The claude-safari MCP bridge"). A "!"
badge on the toolbar button means something needs attention — hover it for the
reason.
EOF
