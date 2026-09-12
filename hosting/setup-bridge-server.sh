#!/usr/bin/env bash
# One-shot bridge-hub server setup for a fresh Ubuntu VM (Path 2 in
# ../HOSTING.md): Node LTS + the Claude CLI + the dependency-free hub as a
# systemd service, fronted by Caddy for automatic TLS.
#
# Run AS ROOT on the VM, with the two secrets and the domain in the
# environment — nothing is baked into this file:
#
#   BRIDGE_TOKEN=$(openssl rand -hex 24) \
#   CLAUDE_CODE_OAUTH_TOKEN=<from `claude setup-token` on the Mac> \
#   BRIDGE_DOMAIN=bridge.example.tech \
#   bash setup-bridge-server.sh
#
# BRIDGE_DOMAIN must already resolve to this VM (A record) or Caddy cannot
# obtain its certificate. The hub itself binds loopback only; Caddy is the
# sole exposed listener — so the TLS story and the "never exposed without a
# token" rule both hold even if the unit is misconfigured.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
: "${BRIDGE_TOKEN:?set BRIDGE_TOKEN (openssl rand -hex 24)}"
: "${CLAUDE_CODE_OAUTH_TOKEN:?set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)}"
: "${BRIDGE_DOMAIN:?set BRIDGE_DOMAIN (a name pointing at this VM)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_SRC="$HERE/../bridge/claude-safari-bridge.js"
[ -f "$BRIDGE_SRC" ] || { echo "bridge source not found beside this script" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg

# Node LTS from nodesource (Ubuntu's node is often too old for the CLI).
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# Caddy from its official repo — automatic TLS with zero config beyond the
# site block below.
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy
fi

# A dedicated non-root user owns the hub and the Claude session state; its
# home is the persistent disk that keeps --resume continuity across reboots.
id -u bridge >/dev/null 2>&1 || useradd -m -s /bin/bash bridge
install -o bridge -g bridge -m 0755 "$BRIDGE_SRC" /home/bridge/claude-safari-bridge.js
sudo -u bridge npm install -g --prefix /home/bridge/.npm-global @anthropic-ai/claude-code >/dev/null

# Secrets live in an EnvironmentFile the unit reads, 0600 root-owned.
install -m 0600 /dev/null /etc/claude-bridge.env
cat > /etc/claude-bridge.env <<EOF
BRIDGE_TOKEN=$BRIDGE_TOKEN
CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN
EOF

cat > /etc/systemd/system/claude-bridge.service <<'EOF'
[Unit]
Description=Claude for Safari bridge hub
After=network-online.target
Wants=network-online.target

[Service]
User=bridge
EnvironmentFile=/etc/claude-bridge.env
Environment=BRIDGE_BIND=127.0.0.1
Environment=BRIDGE_PORT=29170
Environment=PATH=/home/bridge/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
Environment=CLAUDE_BIN=/home/bridge/.npm-global/bin/claude
ExecStart=/usr/bin/node /home/bridge/claude-safari-bridge.js --serve
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$BRIDGE_DOMAIN {
    reverse_proxy 127.0.0.1:29170
}
EOF

systemctl daemon-reload
systemctl enable --now claude-bridge
systemctl restart caddy

sleep 2
if curl -fsS -H "Authorization: Bearer $BRIDGE_TOKEN" "http://127.0.0.1:29170/health" >/dev/null; then
  echo "hub up. Panel gear settings on each device:"
  echo "  Hub URL:  https://$BRIDGE_DOMAIN"
  echo "  Token:    (the BRIDGE_TOKEN you passed in)"
else
  echo "hub did not answer /health — check: journalctl -u claude-bridge -n 50" >&2
  exit 1
fi
