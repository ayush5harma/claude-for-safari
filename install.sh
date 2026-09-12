#!/usr/bin/env bash
# Install Claude for Safari: the wrapper app that carries the extension, and
# the resident launchd agent that runs the bridge hub.
#
# Two halves, because they fail independently:
#   APP     build-app.sh converts ./extension into an Xcode project, signs it
#           with whatever Apple cert the login keychain holds (ad-hoc
#           otherwise) and installs it. Needs the full Xcode.
#   BRIDGE  a launchd user agent running `node bridge/claude-safari-bridge.js
#           --serve`, the 127.0.0.1:29170 hub the extension's chat panel talks
#           to. Needs Node 20+. It points at THIS CHECKOUT, so moving or
#           deleting the repo breaks the agent — re-run this script after a
#           move.
#
# Usage: install.sh [--app-only | --bridge-only] [--install-dir DIR]
#                   [--uninstall] [--help]
#   --install-dir DIR  where the .app goes (default /Applications); passed
#                      straight to build-app.sh
#   --uninstall        stop and remove the agent, the ~/.local/bin links and
#                      the installed app. Leaves the extension's own storage
#                      (chat history, hub settings) and ~/.cache alone, and
#                      never touches Safari's settings.
#
# Everything here is per-user: no sudo, nothing outside $HOME except the app in
# /Applications (which is the default only because that is where Safari expects
# to find an installed app; --install-dir moves it).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.ayushsharma.claude-safari-bridge"
APP_NAME="${SAFARI_APP_NAME:-Claude for Safari}"
BRIDGE_SRC="$HERE/bridge/claude-safari-bridge.js"
TEMPLATE="$HERE/launchd/$LABEL.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/claude-safari"
LOG="$LOG_DIR/bridge.launchd.log"
BINDIR="$HOME/.local/bin"
PORT="${BRIDGE_PORT:-29170}"

DO_APP=1
DO_BRIDGE=1
UNINSTALL=0
INSTALL_DIR="${SAFARI_APP_INSTALL_DIR:-/Applications}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-only)      DO_BRIDGE=0; shift ;;
    --bridge-only)   DO_APP=0; shift ;;
    --uninstall)     UNINSTALL=1; shift ;;
    --install-dir)   INSTALL_DIR="${2:?--install-dir needs a directory}"; shift 2 ;;
    --install-dir=*) INSTALL_DIR="${1#*=}"; shift ;;
    --help|-h)       awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *)               echo "Unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# launchctl's modern subcommands take a domain rather than a plist path;
# bootout before bootstrap is what makes a re-run an update instead of an
# "already loaded" error.
agent_stop() { launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true; }

if [ "$UNINSTALL" -eq 1 ]; then
  agent_stop
  if [ -f "$PLIST" ]; then rm -f "$PLIST"; echo "removed $PLIST"; fi
  # Only ever remove a link that points into THIS checkout.
  if [ -L "$BINDIR/claude-tab" ] && [ "$(readlink "$BINDIR/claude-tab")" = "$HERE/bin/claude-tab" ]; then
    rm -f "$BINDIR/claude-tab"; echo "removed $BINDIR/claude-tab"
  fi
  if [ -d "$INSTALL_DIR/$APP_NAME.app" ]; then
    rm -rf "${INSTALL_DIR:?}/$APP_NAME.app"
    echo "removed $INSTALL_DIR/$APP_NAME.app"
  fi
  cat <<EOF
Uninstalled. Left alone on purpose:
  - the extension's stored chat history and hub settings (Safari removes those
    with the app's extension registration)
  - $LOG_DIR (logs, attachments, the chat MCP config)
  - Safari's own settings, including the Develop menu the app build enabled
If Safari still lists the extension, quit Safari completely and reopen it.
EOF
  exit 0
fi

# ── The app ───────────────────────────────────────────────────────────────────
if [ "$DO_APP" -eq 1 ]; then
  echo "== building and installing $APP_NAME =="
  bash "$HERE/build-app.sh" --install-dir "$INSTALL_DIR"
fi

# ── The bridge agent ──────────────────────────────────────────────────────────
if [ "$DO_BRIDGE" -eq 1 ]; then
  echo "== installing the bridge agent ($LABEL) =="
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || { echo "ERROR: node not found on PATH (Node 20+ required)" >&2; exit 1; }
  # The plist must name the node BINARY: the bridge's `#!/usr/bin/env node`
  # shebang resolves against launchd's PATH, which has no Node on it.
  NODE="$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")"
  [ -f "$BRIDGE_SRC" ] || { echo "ERROR: $BRIDGE_SRC missing" >&2; exit 1; }
  [ -f "$TEMPLATE" ] || { echo "ERROR: $TEMPLATE missing" >&2; exit 1; }

  mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents" "$BINDIR"

  # Carry the hub's settings from THIS environment into the agent. launchd
  # agents inherit nothing useful, so a hand-edited plist was the only way to
  # expose the hub -- and every re-run of this script overwrote those edits.
  # Now the exposure is the command line:
  #   BRIDGE_BIND=<mesh ip> BRIDGE_TOKEN=$(openssl rand -hex 24) \
  #     bash install.sh --bridge-only
  # A variable that is unset here is simply left out, so the hub keeps its own
  # defaults. XML-escape the values: a token is random hex, but BRIDGE_BIND and
  # CLAUDE_BIN are free text.
  xml_escape() { printf '%s' "$1" | LC_ALL=C sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
  ENV_XML=""
  for _v in BRIDGE_BIND BRIDGE_PORT BRIDGE_TOKEN BRIDGE_PANEL_TOOLS CLAUDE_BIN; do
    _val="$(eval "printf '%s' \"\${$_v-}\"")"
    [ -n "$_val" ] || continue
    ENV_XML="$ENV_XML
    <key>$_v</key><string>$(xml_escape "$_val")</string>"
  done
  if [ -n "$ENV_XML" ]; then
    ENV_XML="<key>EnvironmentVariables</key>
  <dict>$ENV_XML
  </dict>"
    echo "agent environment: $(for _v in BRIDGE_BIND BRIDGE_PORT BRIDGE_TOKEN BRIDGE_PANEL_TOOLS CLAUDE_BIN; do
      _val="$(eval "printf '%s' \"\${$_v-}\"")"
      [ -n "$_val" ] && printf '%s ' "$_v"; done)"
  fi

  # Both files below can carry BRIDGE_TOKEN, so neither may exist at the
  # default umask even briefly: ~/Library/LaunchAgents is world-readable and a
  # 0644 plist hands the hub's token to every user on the machine. umask around
  # the staging write (it is created by a redirect, so chmod would be too late)
  # and an explicit chmod on the rendered plist before it is moved into place.
  #
  # `|` as the sed delimiter: every replacement is a path. __ENV__ is replaced
  # with a multi-line block, so it goes through a file rather than an -e
  # expression.
  ( umask 077; printf '%s' "$ENV_XML" > "$PLIST.env" )
  ( umask 077
    sed -e "s|__NODE__|$NODE|g" -e "s|__BRIDGE__|$BRIDGE_SRC|g" -e "s|__LOG__|$LOG|g" \
      -e "/__ENV__/r $PLIST.env" -e "/__ENV__/d" \
      "$TEMPLATE" > "$PLIST.tmp" )
  rm -f "$PLIST.env"
  chmod 600 "$PLIST.tmp"
  plutil -lint "$PLIST.tmp" >/dev/null || { rm -f "$PLIST.tmp"; echo "ERROR: rendered plist is not valid" >&2; exit 1; }
  mv "$PLIST.tmp" "$PLIST"

  agent_stop
  launchctl bootstrap "gui/$UID" "$PLIST"
  launchctl kickstart -k "gui/$UID/$LABEL"

  ln -sfn "$HERE/bin/claude-tab" "$BINDIR/claude-tab"
  echo "linked $BINDIR/claude-tab"

  # Verify by effect, not by launchctl's exit status: the agent can bootstrap
  # cleanly and then die on the first line. Probe whatever the hub was told to
  # bind, with the token when one was configured -- /health is token-gated like
  # every other endpoint.
  HOST="${BRIDGE_BIND:-127.0.0.1}"
  CURL_AUTH=()
  [ -n "${BRIDGE_TOKEN:-}" ] && CURL_AUTH=(-H "Authorization: Bearer $BRIDGE_TOKEN")
  ok=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "${CURL_AUTH[@]}" "http://$HOST:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 0.5
  done
  if [ "$ok" -eq 1 ]; then
    MODE="$(curl -fsS "${CURL_AUTH[@]}" "http://$HOST:$PORT/health" 2>/dev/null \
      | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("panelTools","?"))' 2>/dev/null || echo "?")"
    echo "bridge hub answering on http://$HOST:$PORT/health (panel tool grant: $MODE)"
  else
    echo "WARNING: the hub did not answer /health. Check: tail -20 $LOG" >&2
  fi
fi

cat <<EOF

Next, the steps no script can take for you:
  1. Quit Safari completely (Cmd+Q) and reopen it — an extension-bundle change
     needs a fresh process.
  2. Safari > Settings... > Extensions > enable "$APP_NAME", then
     "Always Allow on Every Website". Repeat per Safari profile.
  3. Optional, for the claude_safari_* tools in Claude Code:
       claude mcp add claude-safari -- node "$BRIDGE_SRC"
  4. Make sure $BINDIR is on your PATH for the claude-tab command.
EOF
