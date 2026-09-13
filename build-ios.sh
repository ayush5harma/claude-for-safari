#!/usr/bin/env bash
# Build the Safari Web Extension for iOS/iPadOS and install it on paired
# physical devices, entirely from the CLI.
#
# WHAT WORKS THERE. Everything in-browser: the per-site Chrome UA spoof
# (declarativeNetRequest header rule + MAIN-world navigator patch — iOS 16.4+
# honors "world": "MAIN"), the site list, the WebRTC legacy-callback shim, and
# — since 0.31 — the Claude panel itself, once its gear points at a hub the
# device can reach (HOSTING.md: a hosted hub, or the Mac over a mesh VPN).
# With no hub configured the background long-poll fails fast against
# 127.0.0.1 and backs off at 3 s until the page is suspended, so it costs
# nothing; the panel reports "hub unreachable" if opened.
#
# SEPARATE from build-app.sh ON PURPOSE: the macOS wrapper is the one that has
# to be rebuildable unattended, and this is a manual, device-facing path with
# different signing (a real DEVELOPMENT_TEAM and automatic provisioning, where
# the Mac build deliberately signs manually with an empty team).
#
# TWO iOS-ONLY PATCHES to the converter's copied resources (the throwaway
# app-ios/ project only — the repo extension/ and the installed Mac app keep
# persistent:true, which Safari macOS honors and the long-poll needs):
#   - background.persistent = false: iOS does not support persistent
#     background pages and refuses to load the extension with one.
#
# SIGNING, two tiers. (1) PREFERRED: a development profile ALREADY IN Xcode's
# profile store that names every target device, is not about to expire, and
# whose team has a signing cert in the login keychain — signed MANUALLY, no
# Apple session needed. A year-long team wildcard profile (`match Development
# *` or equivalent) is ideal: the build it signs lasts a year, and — decisive,
# measured 2026-09-02 — a build from the SAME team is the only one iOS accepts
# as an UPGRADE of the app already installed, because it refuses an upgrade
# whose team differs (MismatchedApplicationIdentifierEntitlement). If your team
# distributes such a profile through fastlane match, fetch it once by hand
# (MATCH_GIT_URL / MATCH_GIT_BRANCH / MATCH_APP_IDENTIFIER / MATCH_PASSWORD are
# the match variables; there is no default here and nothing is automated) and
# it lands in Xcode's store where the picker below finds it. (2) FALLBACK:
# automatic signing. CODE_SIGN_STYLE=Automatic + -allowProvisioningUpdates +
# -allowProvisioningDeviceRegistration lets xcodebuild mint a profile —
# PROVIDED Xcode holds a signed-in Apple ID session for the team (Xcode >
# Settings > Accounts). The team defaults to the OU of the first Apple
# Development cert in the login keychain (SAFARI_IOS_TEAM overrides). A
# personal (free) team works but its apps EXPIRE AFTER 7 DAYS and its profile
# names only the devices it has registered itself. SAFARI_IOS_PROFILE=<name>
# forces tier (1) with a specific profile; SAFARI_IOS_PROFILE=none skips it.
#
# ON-DEVICE, ONCE PER DEVICE (cannot be scripted, like every consent here):
#   1. Settings > General > VPN & Device Management > trust the developer.
#   2. Open the "Claude for Safari" app once.
#   3. Settings > Apps > Safari > Extensions > Claude for Safari: enable, and
#      grant "All Websites" so the UA spoof and the WebRTC shim can run.
#
# Usage: build-ios.sh [--export-only] [device-udid ...]
#   With no device arguments, installs to every physical device devicectl
#   reports as "available (paired)". Regardless of installs, two hand-offs are
#   ALWAYS staged in the export directory (dist/ios by default, or
#   $SAFARI_IOS_EXPORT_DIR — point it at an iCloud folder to reach another
#   Mac): the signable Xcode project zip (sign and install from any Mac — the
#   no-Apple-session case must not strand the build on this machine), and,
#   whenever the signed build succeeds, the .ipa — built against the GENERIC
#   iOS destination, so it refreshes with every device locked or asleep.
#   --export-only skips the device installs.
#
# Environment inputs: SAFARI_IOS_TEAM, SAFARI_IOS_PROFILE (above),
# SAFARI_IOS_EXPORT_DIR, SAFARI_APP_ID, SAFARI_APP_NAME.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$HERE/extension"
APP_DIR="$HERE/app-ios"
APP_NAME="${SAFARI_APP_NAME:-Claude for Safari}"
APP_ID="${SAFARI_APP_ID:-com.ayushsharma.claude-safari}"

command -v xcrun >/dev/null 2>&1 || { echo "ERROR: Xcode required" >&2; exit 1; }
xcrun --find safari-web-extension-converter >/dev/null 2>&1 || {
  echo "ERROR: safari-web-extension-converter needs the full Xcode." >&2; exit 1; }

# Team id = OU of the first non-revoked Apple Development identity. The cert's
# CN suffix is NOT the team (same trap build-app.sh documents); the OU is.
TEAM="${SAFARI_IOS_TEAM:-}"
if [ -z "$TEAM" ]; then
  _cn="$(security find-identity -v -p codesigning 2>/dev/null \
        | grep -F "Apple Development" | grep -v 'CSSMERR_' | head -1 \
        | sed -E 's/^[^"]*"([^"]+)".*/\1/')"
  [ -n "$_cn" ] && TEAM="$(security find-certificate -c "$_cn" -p 2>/dev/null \
        | openssl x509 -noout -subject 2>/dev/null \
        | sed -nE 's/.*OU *= *([A-Z0-9]+).*/\1/p')"
fi
# Target devices: arguments, else every available paired physical device.
# PAIRED is kept separately from DEVICES: the profile picker below must cover
# every device this Mac knows, so that an --export-only .ipa installs on all
# of them, not just on whichever ones were named for an install.
EXPORT_ONLY=0
DEVICES=()
PAIRED=()
while IFS= read -r u; do PAIRED+=("$u"); done < <(
  xcrun devicectl list devices 2>/dev/null \
    | awk '/available \(paired\)/ && /physical/ { for (i=1;i<=NF;i++) if ($i ~ /^[0-9A-F-]{16,40}$/) print $i }')
for a in "$@"; do
  case "$a" in
    --export-only) EXPORT_ONLY=1 ;;
    *) DEVICES+=("$a") ;;
  esac
done
[ "$EXPORT_ONLY" -eq 0 ] && [ ${#DEVICES[@]} -eq 0 ] && DEVICES=("${PAIRED[@]}")
if [ "$EXPORT_ONLY" -eq 0 ] && [ ${#DEVICES[@]} -eq 0 ]; then
  echo "NOTE: no paired iOS devices — exporting only" >&2
  EXPORT_ONLY=1
fi

# ── Signing tier 1: an existing profile that covers the devices ─────────────
# Walks Xcode's profile store, keeps profiles whose app id is this bundle (or
# the team wildcard), that outlive the next 30 days, that name every device
# in DEVICES + PAIRED, and whose team has a non-revoked signing identity in
# the keychain; picks the one expiring LAST. Nothing here touches the network.
PROFILE_UUID=""; PROFILE_NAME=""; SIGN_ID=""; SIGN_TEAM=""; PROFILE_FILE=""; PROFILE_APPID=""
pick_profile() {
  local want="${SAFARI_IOS_PROFILE:-}"
  [ "$want" = "none" ] && return 0
  local need=() best_exp=0 p plist appid team exp name uuid devs id cn ou u ok
  need=("${DEVICES[@]}" "${PAIRED[@]}")
  for p in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.mobileprovision \
           "$HOME/Library/MobileDevice/Provisioning Profiles"/*.mobileprovision; do
    [ -f "$p" ] || continue
    plist="$(security cms -D -i "$p" 2>/dev/null)" || continue
    appid="$(printf '%s' "$plist" | plutil -extract Entitlements.application-identifier raw -o - - 2>/dev/null)"
    team="${appid%%.*}"
    case "$appid" in "$team.*"|"$team.$APP_ID") ;; *) continue ;; esac
    name="$(printf '%s' "$plist" | plutil -extract Name raw -o - - 2>/dev/null)"
    [ -n "$want" ] && [ "$name" != "$want" ] && continue
    uuid="$(printf '%s' "$plist" | plutil -extract UUID raw -o - - 2>/dev/null)"
    exp="$(printf '%s' "$plist" | plutil -extract ExpirationDate raw -o - - 2>/dev/null)"
    exp="$(/bin/date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$exp" '+%s' 2>/dev/null || echo 0)"
    [ "$exp" -gt $(( $(date +%s) + 30*86400 )) ] || continue
    devs="$(printf '%s' "$plist" | plutil -extract ProvisionedDevices json -o - - 2>/dev/null)"
    ok=1; for u in "${need[@]}"; do case "$devs" in *"$u"*) ;; *) ok=0 ;; esac; done
    [ "$ok" -eq 1 ] || continue
    # A signing identity for this team: OU in the cert subject is the team.
    id=""
    while IFS= read -r cn; do
      ou="$(security find-certificate -c "$cn" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed -nE 's/.*OU *= *([A-Z0-9]+).*/\1/p')"
      [ "$ou" = "$team" ] && { id="$cn"; break; }
    done < <(security find-identity -v -p codesigning 2>/dev/null | grep -v 'CSSMERR_' | sed -nE 's/^[^"]*"([^"]+)".*/\1/p')
    [ -n "$id" ] || continue
    if [ "$exp" -gt "$best_exp" ]; then
      best_exp=$exp; PROFILE_UUID="$uuid"; PROFILE_NAME="$name"; SIGN_ID="$id"; SIGN_TEAM="$team"
      PROFILE_FILE="$p"; PROFILE_APPID="$appid"
    fi
  done
}
pick_profile
if [ -n "$PROFILE_UUID" ]; then
  echo "Signing: MANUAL, profile '$PROFILE_NAME' (team $SIGN_TEAM, $SIGN_ID)"
else
  [ -n "$TEAM" ] || { echo "ERROR: no usable provisioning profile and no Apple Development cert (SAFARI_IOS_TEAM overrides)" >&2; exit 1; }
  echo "Signing: AUTOMATIC, team $TEAM (no stored profile covers the devices)"
fi
echo "Devices: ${DEVICES[*]:-none (export only)}  Paired: ${PAIRED[*]:-none}"

# ── 1. Convert (iOS + macOS project; only the iOS scheme is built) ───────────
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
xcrun safari-web-extension-converter "$EXT" \
  --project-location "$APP_DIR" \
  --app-name "$APP_NAME" \
  --bundle-identifier "$APP_ID" \
  --copy-resources --no-prompt --force

PROJ="$(find "$APP_DIR" -maxdepth 3 -name '*.xcodeproj' -print -quit)"
[ -n "$PROJ" ] || { echo "ERROR: converter produced no .xcodeproj" >&2; exit 1; }

# ── 2. iOS resource patch: non-persistent background ─────────────────────────
while IFS= read -r mf; do
  /usr/bin/python3 - "$mf" <<'PY'
import json, sys
p = sys.argv[1]
m = json.load(open(p))
if m.get("background", {}).get("persistent"):
    m["background"]["persistent"] = False
    open(p, "w").write(json.dumps(m, indent=2) + "\n")
    print(f"  persistent:false -> {p}")
PY
done < <(find "$APP_DIR" -name manifest.json -path "*Resources*")

# ── 3. Normalize bundle ids (same rule as build-app.sh) ──────────────────────
/usr/bin/python3 - "$PROJ/project.pbxproj" "$APP_ID" <<'PY'
import re, sys
pbx, app_id = sys.argv[1], sys.argv[2]
s = open(pbx).read()
def fix(m):
    val = m.group(1)
    new = f"{app_id}.Extension" if val.endswith(".Extension") else app_id
    return f'PRODUCT_BUNDLE_IDENTIFIER = "{new}";'
s = re.sub(r'PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;', fix, s)
open(pbx, "w").write(s)
PY

SCHEME="$(xcodebuild -list -project "$PROJ" 2>/dev/null | sed -n '/Schemes:/,$p' | grep -m1 "(iOS)" | sed 's/^[[:space:]]*//')"
[ -n "$SCHEME" ] || { echo "ERROR: no iOS scheme in the generated project" >&2; exit 1; }

# ── 4. Stage the signable project for hand-off ───────────────────────────────
# The zip is the hand-off: open it on ANY Mac with Xcode, pick your team on
# both targets, plug the device in, press Run — Xcode mints the development
# profile and installs. Point SAFARI_IOS_EXPORT_DIR at a synced folder to get
# it onto another machine; INSTALL.txt beside it carries the exact steps.
EXPORT_DIR="${SAFARI_IOS_EXPORT_DIR:-$HERE/dist/ios}"
VER="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$EXT/manifest.json" 2>/dev/null || echo dev)"
if mkdir -p "$EXPORT_DIR" 2>/dev/null; then
  ZIP="$EXPORT_DIR/ClaudeForSafari-iOS-$VER.zip"
  rm -f "$ZIP"
  (cd "$APP_DIR" && /usr/bin/zip -qry "$ZIP" . -x "build/*" "xcodebuild-*.log" "install-*.log")
  cat > "$EXPORT_DIR/INSTALL.txt" <<EOF
Claude for Safari — iOS/iPadOS extension $VER (generated $(date '+%Y-%m-%d'))

Everything works on iPhone and iPad: the per-site Chrome UA spoof (the hosts
listed in extension/ua-chrome-sites.js), the WebRTC shim, and the Claude panel
— point the panel's gear at a hub the device can reach (HOSTING.md) and give
it the hub's token.

Fastest — ClaudeForSafari-iOS-$VER.ipa beside this file is signed for every
device the team has registered; install it from a Mac without Xcode's GUI:
  drag it onto the device in Finder, or
  xcrun devicectl device install app --device <udid> ClaudeForSafari-iOS-$VER.ipa

To sign and install from any Mac with Xcode (also registers a NEW device):
  1. Unzip ClaudeForSafari-iOS-$VER.zip, open the .xcodeproj.
  2. For BOTH targets (app + extension): Signing & Capabilities >
     Automatically manage signing > pick your team.
  3. Plug the iPhone/iPad in (unlocked), select it as the run destination, Run.
  4. On the device, once: Settings > General > VPN & Device Management >
     trust the developer; open the app once; Settings > Apps > Safari >
     Extensions > Claude for Safari: ON, allow All Websites.
Free-team installs expire after 7 days; re-run from either the project or
'bash build-ios.sh' on the Mac with the devices paired.
EOF
  echo "exported signable project: $ZIP"
else
  echo "  NOTE: could not create $EXPORT_DIR — skipped the signable-project export" >&2
  EXPORT_DIR=""
fi

# ── 5. One signed build, against the generic iOS destination ─────────────────
# Automatic signing mints (or reuses) the team's development profile, which
# names every UDID already registered to the team, and the .app it produces
# serves both the installs and the .ipa. GENERIC rather than a device
# destination on purpose: a device destination needs that device reachable
# and unlocked just to BUILD, which on 2026-09-01 stalled the whole export
# behind a dozing iPad. The one thing a generic build cannot do is register a
# NEW device — step 6 falls back to a device build for exactly that case.
build_ios() {  # $1 = xcodebuild destination, $2 = log tag
  if [ -n "$PROFILE_UUID" ]; then
    # Manual: the same wildcard/dev profile signs the app AND the .appex.
    xcodebuild -project "$PROJ" -scheme "$SCHEME" -configuration Release \
      -destination "$1" \
      -derivedDataPath "$APP_DIR/build" \
      CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$SIGN_ID" \
      DEVELOPMENT_TEAM="$SIGN_TEAM" PROVISIONING_PROFILE_SPECIFIER="$PROFILE_UUID" \
      build >"$APP_DIR/xcodebuild-$2.log" 2>&1
  else
    xcodebuild -project "$PROJ" -scheme "$SCHEME" -configuration Release \
      -destination "$1" \
      -derivedDataPath "$APP_DIR/build" \
      -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
      CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM" \
      build >"$APP_DIR/xcodebuild-$2.log" 2>&1
  fi
}
build_failed() {  # $1 = log tag
  echo "  BUILD FAILED ($1) — tail of $APP_DIR/xcodebuild-$1.log:" >&2
  tail -12 "$APP_DIR/xcodebuild-$1.log" | sed 's/^/    /' >&2
  echo "  If it says 'No Account for Team': open Xcode > Settings > Accounts," >&2
  echo "  sign in the Apple ID for team $TEAM, then re-run this script." >&2
}
built_app() {
  find "$APP_DIR/build/Build/Products" -maxdepth 2 -name '*.app' -path '*iphoneos*' -print -quit
}
# WILDCARD PROFILES NEED A RE-SIGN. Xcode writes the app's
# application-identifier entitlement as <team>.<bundle id> even when the
# profile is <team>.*, and iOS compares that string LITERALLY against the
# installed app's when upgrading: an app installed from a wildcard profile
# carries the literal "<team>.*" (signed straight from the profile's
# entitlements), so an Xcode-signed build was refused as an upgrade with
# MismatchedApplicationIdentifierEntitlement (2026-09-02) — the second
# flavour of that error, after the cross-team one. Re-signing the .appex and
# the .app with the profile's OWN entitlements block (application-identifier
# and keychain-access-groups as the literal wildcard, get-task-allow, the
# team id) makes every build from this profile upgrade-compatible with every
# other, and is exactly what the profile authorises.
resign_wildcard() {  # $1 = built .app
  case "$PROFILE_APPID" in *'.*') ;; *) return 0 ;; esac
  local ent; ent="$(mktemp "${TMPDIR:-/tmp}/ent.XXXXXX").plist"   # full template: `-t prefix` is BSD-only
  security cms -D -i "$PROFILE_FILE" 2>/dev/null | plutil -extract Entitlements xml1 -o "$ent" - || return 0
  local x
  for x in "$1"/PlugIns/*.appex "$1"; do
    [ -e "$x" ] || continue
    codesign -f -s "$SIGN_ID" --entitlements "$ent" --timestamp=none "$x" >/dev/null 2>&1 \
      || { echo "  WARNING: re-sign failed for ${x##*/}; the build keeps Xcode's entitlements" >&2; rm -f "$ent"; return 0; }
  done
  rm -f "$ent"
  echo "  re-signed with the wildcard profile's entitlements (application-identifier $PROFILE_APPID)"
}
# The dev-signed .app zipped as Payload/ IS an ipa: installable as-is (no
# re-signing) from Finder, Apple Configurator, or `devicectl device install
# app`, on any device the embedded provisioning profile names. Only ONE
# version is kept in the hand-off folder — an older ipa beside the new one is
# the wrong one half the time it is tapped.
export_ipa() {  # $1 = built .app
  [ -d "${EXPORT_DIR:-}" ] || return 0
  local ipa="$EXPORT_DIR/ClaudeForSafari-iOS-$VER.ipa"
  rm -rf "$APP_DIR/Payload" "$ipa"
  mkdir -p "$APP_DIR/Payload"
  cp -R "$1" "$APP_DIR/Payload/"
  (cd "$APP_DIR" && /usr/bin/zip -qry "$ipa" Payload)
  rm -rf "$APP_DIR/Payload"
  find "$EXPORT_DIR" -maxdepth 1 -name 'ClaudeForSafari-iOS-*' ! -name "ClaudeForSafari-iOS-$VER.*" -delete
  echo "exported signed ipa: $ipa"
}

echo "── building (scheme: $SCHEME, generic iOS destination)"
if ! build_ios "generic/platform=iOS" generic; then
  build_failed generic
  exit 1
fi
APP="$(built_app)"
[ -n "$APP" ] || { echo "ERROR: no iphoneos .app produced" >&2; exit 1; }
resign_wildcard "$APP"
export_ipa "$APP"
[ "$EXPORT_ONLY" -eq 1 ] && exit 0

# ── 6. Install on each device ────────────────────────────────────────────────
# From the generic build first. A device the profile does not yet name fails
# the install with a provisioning error: for that one, rebuild AGAINST the
# device (registers its UDID and re-signs), install again, and re-export the
# .ipa so it carries the newcomer too.
fail=0
for UDID in "${DEVICES[@]}"; do
  echo "── installing on $UDID"
  if xcrun devicectl device install app --device "$UDID" "$APP" >"$APP_DIR/install-$UDID.log" 2>&1; then
    echo "  installed on $UDID"; continue
  fi
  if [ -z "$PROFILE_UUID" ] && grep -qiE 'provision|verif|0xe800' "$APP_DIR/install-$UDID.log"; then
    echo "  the profile does not name this device — rebuilding against it to register it"
    if build_ios "id=$UDID" "$UDID"; then
      APP="$(built_app)"
      export_ipa "$APP"
      if xcrun devicectl device install app --device "$UDID" "$APP" >"$APP_DIR/install-$UDID.log" 2>&1; then
        echo "  installed on $UDID"; continue
      fi
    else
      build_failed "$UDID"
    fi
  fi
  echo "  INSTALL FAILED for $UDID — tail of $APP_DIR/install-$UDID.log:" >&2
  tail -8 "$APP_DIR/install-$UDID.log" | sed 's/^/    /' >&2
  echo "  If the device is locked or asleep: unlock it, keep it awake, re-run —" >&2
  echo "  the .ipa above is already current, so only this push is left." >&2
  fail=1
done

[ "$fail" -eq 0 ] && cat <<'EOF'

Installed. On each device, once:
  1. Settings > General > VPN & Device Management > trust the developer.
  2. Open "Claude for Safari" once.
  3. Settings > Apps > Safari > Extensions > Claude for Safari: ON,
     then allow "All Websites".
Free-team builds expire after 7 days — re-run this script to reinstall.
EOF
exit "$fail"
