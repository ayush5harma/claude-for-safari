#!/usr/bin/env bash
# Deploy the bridge hub to Heroku — HOSTING.md Path 1 (a Basic dyno is about
# $7/month and never sleeps; Eco dynos sleep, and a sleeping hub is broken).
#
# Idempotent: creates the app on first run (name remembered in
# ~/.config/claude-bridge/app so re-runs redeploy the same app), pushes the
# CURRENT bridge source, asserts config vars without clobbering an existing
# BRIDGE_TOKEN, and verifies /health over TLS with the token before printing
# the gear settings for each device.
#
# Needs: `heroku login` done once (browser), and CLAUDE_CODE_OAUTH_TOKEN —
# from `claude setup-token` on the Mac — either already set on the app or
# passed in the environment of this run. Without it the hub deploys and
# answers /health, but chat turns fail until it is set.
#
# Usage: deploy-heroku.sh [app-name]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_SRC="$HERE/../bridge/claude-safari-bridge.js"
[ -f "$BRIDGE_SRC" ] || { echo "ERROR: bridge source not found" >&2; exit 1; }
command -v heroku >/dev/null 2>&1 || { echo "ERROR: heroku CLI not installed" >&2; exit 1; }

# The Heroku CLI writes a git credential helper into the GLOBAL git config on
# apps:create. When that file is read-only — a managed dotfile, a symlink into
# a read-only store — the write fails ("could not lock config file") and takes
# the whole command down with it, AFTER the app has already been created,
# which is how a first run left a stray app behind. Point the global config at
# a throwaway file: the helper is unnecessary here (git authenticates from
# ~/.netrc) and the user's real config is never touched.
GIT_CONFIG_GLOBAL="$(mktemp)"; export GIT_CONFIG_GLOBAL
trap 'rm -f "$GIT_CONFIG_GLOBAL"' EXIT
heroku auth:whoami >/dev/null 2>&1 || { echo "ERROR: not logged in — run: heroku login" >&2; exit 1; }

CFG_DIR="$HOME/.config/claude-bridge"
mkdir -p "$CFG_DIR"
if [ -n "${1:-}" ]; then
  APP="$1"
elif [ -s "$CFG_DIR/app" ]; then
  APP="$(cat "$CFG_DIR/app")"
else
  # App names are a global namespace; a random suffix avoids collisions.
  APP="claude-bridge-$(openssl rand -hex 3)"
fi

# Remember the name BEFORE creating it: if anything downstream fails, a re-run
# must resume on the SAME app rather than rolling a new random name and
# stranding the old one (that is exactly what happened on the first run).
printf '%s\n' "$APP" > "$CFG_DIR/app"
if ! heroku apps:info -a "$APP" >/dev/null 2>&1; then
  echo "creating app $APP"
  # Tolerate a non-zero exit whose only casualty is a side effect (see the
  # GIT_CONFIG_GLOBAL note above); the authority on success is apps:info.
  heroku apps:create "$APP" >/dev/null 2>&1 || true
  heroku apps:info -a "$APP" >/dev/null 2>&1 || { echo "ERROR: could not create $APP" >&2; exit 1; }
fi

# Token: keep the existing one across deploys (the devices already carry it);
# mint one only on first deploy.
TOKEN="$(heroku config:get BRIDGE_TOKEN -a "$APP" 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  TOKEN="$(openssl rand -hex 24)"
  echo "minted a new BRIDGE_TOKEN"
fi

CFG=(BRIDGE_BIND=0.0.0.0 BRIDGE_TOKEN="$TOKEN" BRIDGE_CODEX_PANEL=1 BRIDGE_CODEX_REQUIRE_API_KEY=1
  CLAUDE_BIN=/app/node_modules/.bin/claude CODEX_BIN=/app/node_modules/.bin/codex)
# An `[ test ] && arr+=(...)` one-liner would be a complete AND-OR list whose
# failure (the common case: token not in this environment) trips `set -e` and
# kills the deploy. Use a real if.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  CFG+=(CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN")
fi
heroku config:set -a "$APP" "${CFG[@]}" >/dev/null
echo "config vars asserted"

# Stage a minimal app dir and push it. A fresh scratch clone per run keeps
# this stateless; Heroku's build cache still makes repeat builds fast.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"; rm -f "$GIT_CONFIG_GLOBAL"' EXIT
cp "$BRIDGE_SRC" "$STAGE/claude-safari-bridge.js"
cp "$HERE/heroku/package.json" "$HERE/heroku/Procfile" "$STAGE/"
git -C "$STAGE" init -q
git -C "$STAGE" -c user.email=bridge@local -c user.name=bridge add -A
git -C "$STAGE" -c user.email=bridge@local -c user.name=bridge commit -qm "bridge hub"
echo "pushing (build takes a minute)..."
git -C "$STAGE" push -q "https://git.heroku.com/$APP.git" HEAD:refs/heads/main -f

# Basic never sleeps; Eco does, and a sleeping hub is a broken hub.
heroku ps:type web=basic -a "$APP" >/dev/null 2>&1 \
  || echo "NOTE: could not set the Basic dyno type — check the account's billing, then: heroku ps:type web=basic -a $APP"

URL="$(heroku apps:info -a "$APP" --json | /usr/bin/python3 -c 'import json,sys;print(json.load(sys.stdin)["app"]["web_url"].rstrip("/"))')"
for _ in 1 2 3 4 5 6; do
  sleep 5
  if curl -fsS -H "Authorization: Bearer $TOKEN" "$URL/health" >/dev/null 2>&1; then
    echo ""
    echo "hub is UP: $URL"
    echo "Panel gear settings on each device:"
    echo "  Hub URL:  $URL"
    echo "  Token:    $TOKEN"
    if ! heroku config:get CLAUDE_CODE_OAUTH_TOKEN -a "$APP" 2>/dev/null | grep -q .; then
      echo "STILL NEEDED for chats: claude setup-token, then"
      echo "  heroku config:set CLAUDE_CODE_OAUTH_TOKEN=<token> -a $APP"
    fi
    if ! heroku config -a "$APP" --json 2>/dev/null | jq -e 'has("CODEX_API_KEY")' >/dev/null; then
      echo "STILL NEEDED for Codex: Dashboard > $APP > Settings > Config Vars"
      echo "  add CODEX_API_KEY without putting it in a shell command"
    fi
    exit 0
  fi
done
echo "hub not answering /health yet — check: heroku logs --tail -a $APP" >&2
exit 1
