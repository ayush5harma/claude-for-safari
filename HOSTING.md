# Hosting the bridge — Claude panel on iPhone and iPad

The panel UI already runs on iOS/iPadOS (`build-ios.sh`). What does not exist
there is the brain: the panel talks to the bridge hub, which spawns the real
`claude` CLI — on the Mac, at `127.0.0.1:29170`. On a phone, 127.0.0.1 is the
phone. Making the panel work off-Mac means giving it a hub it can reach.

Everything needed on the extension/bridge side is built in:

- The panel's gear (header) opens **hub settings**: a hub URL and a token,
  stored in extension storage; the background page uses them for every bridge
  call and sends the token as `Authorization: Bearer`.
- The bridge takes `BRIDGE_BIND` / `BRIDGE_PORT` (or a PaaS `PORT`) /
  `BRIDGE_TOKEN`, requires the Bearer token on every request when set
  (constant-time compare), refuses to bind off-loopback without one, and
  serves `GET /health` for the settings pane's reachability check.
- Panel chats carry their page context and attachments IN the request, so a
  remote hub needs no path back into Safari. (The `claude_safari_*` MCP tools
  used by Mac Claude Code sessions remain a local-Mac feature.)

What remains is choosing where the hub runs. Three options, cheapest first. In
all of them the hub spawns `claude` under YOUR Claude account — usage bills to
that plan, and the token is what stands between the internet and it, so make it
long and random: `openssl rand -hex 24`.

## Path 0 — your own Mac over a mesh VPN (free, works tonight)

If you already run a mesh VPN with an iOS client (NetBird, Tailscale and
friends all qualify), no cloud is involved at all: the phone joins the mesh and
talks to the Mac's bridge directly. The trade: chats only work while the Mac is
awake.

1. On the phone/iPad: install the VPN client, sign into the same account, and
   note the Mac's mesh IP.
2. On the Mac, re-install the agent with the two envs set. `install.sh` copies
   `BRIDGE_BIND`, `BRIDGE_PORT`, `BRIDGE_TOKEN`, `BRIDGE_PANEL_TOOLS` and
   `CLAUDE_BIN` out of its own environment into the plist it renders:

   ```sh
   BRIDGE_BIND=<mesh-ip> BRIDGE_TOKEN=$(openssl rand -hex 24) \
     bash install.sh --bridge-only
   ```

   Use the mesh IP, **not** `0.0.0.0`, which would also answer the LAN. The
   bridge refuses to bind off-loopback without a token. Do not hand-edit
   `~/Library/LaunchAgents/com.ayushsharma.claude-safari-bridge.plist`: every
   `install.sh` run re-renders it and the edits are lost — re-run the command
   above instead.
3. In the panel on each device: gear > Hub URL `http://<mesh-ip>:29170` +
   the token > Save. The status line should read "hub reachable".

Decide `BRIDGE_PANEL_TOOLS` here too. It defaults to `read`, which is what you
want for a hub reachable from more than one device; `all` lets a panel turn
drive the browser, and the prompt of a panel turn contains page text nobody
vetted (README, "Security").

Plain http is acceptable here only because WireGuard already encrypts the mesh
path end to end.

## Path 1 — Heroku (a Basic dyno, about $7/month)

`hosting/deploy-heroku.sh` does the whole thing and is idempotent (re-run it to
ship a bridge change). A Basic dyno is always-on; Eco dynos sleep, and a
sleeping hub is a broken hub. TLS comes with Heroku's own app domain.

The GitHub Student Developer Pack has carried a Heroku credit (read from the
pack's public catalog on 2026-09-01: "a credit of $13 USD per month for 24
months"), which covers a Basic dyno outright. Claim state is per account —
check what your signed-in pack page actually shows.

1. Once: `heroku login`. **If it fails with "IP address mismatch"** — as it
   does behind a mesh VPN or a proxy — the CLI and the browser are leaving by
   different routes, and no amount of retrying fixes it: the callback is bound
   to the CLI's outbound IP. Use a dashboard API token instead (Account
   Settings > Applications > Create authorization) written into `~/.netrc` for
   `api.heroku.com` and `git.heroku.com`. No IP binding, no timeout.
2. `bash hosting/deploy-heroku.sh` — creates the app (name remembered in
   `~/.config/claude-bridge/app`), mints and PRESERVES `BRIDGE_TOKEN` across
   deploys, pushes the hub, pins the Basic dyno, and verifies `/health` over
   TLS before printing the gear settings.
3. `claude setup-token` on the Mac, then
   `heroku config:set CLAUDE_CODE_OAUTH_TOKEN=<token> -a <app>`. **Read the
   token from a WIDE terminal**: captured through a default-width pty the
   value wraps mid-string and a truncated copy fails as "401 OAuth access
   token is invalid" — which reads like a rejected token rather than a
   mangled one.
4. Panel gear > Hub URL (the `https://...` URL the deploy script printed) +
   the token.

One trap the script already handles, which cost a stray app on a first run: the
Heroku CLI writes a git credential helper into the global git config, and if
that file is read-only (a managed dotfile, a store symlink) the command fails
*after* creating the app — so the script redirects `GIT_CONFIG_GLOBAL` to a
throwaway file and persists the app name BEFORE creating it, making a re-run
resume rather than roll a new name.

Caveats named honestly: a dyno restarts daily (chats are stateless per turn, so
this only drops an in-flight turn); `--resume` continuity depends on the dyno's
ephemeral disk, so multi-turn memory survives within a dyno day, not across
restarts.

Actions on the phone's tabs (click, fill, navigate, read, screenshot) go
through the same hub: the panel's `claude -p` loads the bridge as its only MCP
server, and that MCP child posts each tool call back to the hub, which hands it
to the phone's extension over the long-poll. (Until 2026-09-02 the child sent
no Bearer token on those posts, so on a token-gated hub every tool call was a
401 while the chat itself worked; the fix is in the bridge.) The extension must
be polling for a call to land — on iOS that means Safari in the foreground with
the panel open.

## Path 2 — a VM

For a persistent disk (stable `--resume` history) run the hub on a small Ubuntu
VM: `hosting/setup-bridge-server.sh` is the one-shot — installs Node and the
Claude CLI, writes a systemd unit with the envs, and fronts it with Caddy for
automatic TLS on a domain you point at the VM.

## Security model, restated for the exposed case

- No token, no service: the bridge exits rather than listen off-loopback
  unauthenticated, and 401s every request without the exact Bearer token.
- TLS comes from the fronting layer (Heroku router, Caddy); the hub itself
  stays plain HTTP behind it.
- Rotation is two edits: new token on the server env, new token in each
  panel's gear settings.
- The hub's blast radius is "run claude as the server's account" — keep the
  server single-purpose and the token out of chat logs.
