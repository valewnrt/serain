#!/usr/bin/env bash
# Sets up the Mac companion (D28). Runs on the owner's Mac, started by them:
#
#   ./companion/install.sh
#
# What happens, in this order:
#   1. The current commit is exported to ~/Library/Application Support/Serain Companion/app
#      (never the working tree, as with deploy).
#   2. The Swift helper for calendars, reminders and contacts is built.
#   3. A token and a dedicated SSH key for the tunnel only are generated.
#   4. On the server: user `serain-companion`, allowed nothing except exactly
#      one remote forward on loopback; port and token in /etc/serain/serain.env.
#   5. Two launchd agents: the companion and the tunnel.
#   6. macOS asks for the permissions for calendars, reminders, contacts.
#
# Idempotent. Token and key are kept on a rerun.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="$HOME/Library/Application Support/Serain Companion"
APP_DIR="$HOME_DIR/app"
APPLE_APP="$HOME_DIR/Serain Apple.app"
CONFIG="$HOME_DIR/config.json"
KEY="$HOME_DIR/tunnel_ed25519"
KNOWN_HOSTS="$HOME_DIR/known_hosts"
LOG_DIR="$HOME_DIR/logs"
AGENTS="$HOME/Library/LaunchAgents"
MAC_PORT=47811
SERVER_PORT=47812
TUNNEL_USER=serain-companion

HOST="${SERAIN_HOST:-}"
if [[ -z "$HOST" && -f "$REPO_DIR/.dev.vars" ]]; then
  HOST="$(grep -E '^SERAIN_HOST=' "$REPO_DIR/.dev.vars" | tail -1 | cut -d= -f2- || true)"
fi
if [[ ! "$HOST" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]]; then
  echo "SERAIN_HOST missing (expected root@<host>, via environment or in .dev.vars)" >&2
  exit 1
fi
SERVER_ADDR="${HOST#*@}"

NODE="$(command -v node || true)"
for tool in node pnpm swiftc git ssh ssh-keygen openssl codesign; do
  command -v "$tool" >/dev/null || { echo "$tool is missing on this Mac" >&2; exit 1; }
done
[[ "$("$NODE" -v)" == v22.* ]] || { echo "Node 22 expected, found: $("$NODE" -v)" >&2; exit 1; }

cd "$REPO_DIR"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree has uncommitted changes. Commit first, then install." >&2
  exit 1
fi

echo "== 1/6 Code (Commit $(git rev-parse --short HEAD)) =="
mkdir -p "$HOME_DIR" "$LOG_DIR" "$AGENTS"
chmod 700 "$HOME_DIR"
rm -rf "$APP_DIR.new"
mkdir -p "$APP_DIR.new"
git archive HEAD | tar -x -C "$APP_DIR.new"
(cd "$APP_DIR.new" && pnpm install --frozen-lockfile --prod --silent)
rm -rf "$APP_DIR"
mv "$APP_DIR.new" "$APP_DIR"

echo "== 2/6 Apple helper =="
# Rebuild only when the source changed: the signature is ad hoc, and macOS binds
# the permissions to exactly this binary. A rebuild means granting them again.
# The deployment target comes from the Info.plist. Without it swiftc takes the
# toolchain's own version, which can be newer than the Mac it runs on; macOS
# then refuses to open the app (LaunchServices -10825, 2026-10-14).
MIN_MACOS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' companion/apple/Info.plist)"
APPLE_TARGET="$(uname -m)-apple-macos$MIN_MACOS"
SOURCE_HASH="$( (cat companion/apple/SerainApple.swift companion/apple/Info.plist; echo "$APPLE_TARGET") | shasum -a 256 | cut -d' ' -f1)"
if [[ ! -x "$APPLE_APP/Contents/MacOS/serain-apple" || "$(cat "$HOME_DIR/apple.hash" 2>/dev/null)" != "$SOURCE_HASH" ]]; then
  rm -rf "$APPLE_APP"
  mkdir -p "$APPLE_APP/Contents/MacOS"
  cp companion/apple/Info.plist "$APPLE_APP/Contents/Info.plist"
  swiftc -O -target "$APPLE_TARGET" -o "$APPLE_APP/Contents/MacOS/serain-apple" companion/apple/SerainApple.swift
  codesign --force --sign - --identifier com.serain.apple-helper "$APPLE_APP"
  echo "$SOURCE_HASH" > "$HOME_DIR/apple.hash"
  echo "built"
else
  echo "unchanged, permissions stay"
fi

echo "== 3/6 Token and tunnel key =="
if [[ ! -f "$CONFIG" ]]; then
  TOKEN="$(openssl rand -hex 32)"
  umask 077
  printf '{\n  "token": "%s",\n  "port": %s,\n  "browser": true\n}\n' "$TOKEN" "$MAC_PORT" > "$CONFIG"
fi
chmod 600 "$CONFIG"
TOKEN="$("$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)' "$CONFIG")"
[[ ${#TOKEN} -ge 32 ]] || { echo "Token in $CONFIG missing or too short" >&2; exit 1; }
if [[ ! -f "$KEY" ]]; then
  ssh-keygen -q -t ed25519 -N "" -C "serain-companion@$(scutil --get LocalHostName 2>/dev/null || hostname)" -f "$KEY"
fi
chmod 600 "$KEY"
# Take over the server's host key that this Mac already knows, instead of trusting blindly.
ssh-keygen -F "$SERVER_ADDR" 2>/dev/null | grep -v '^#' > "$KNOWN_HOSTS" || true
[[ -s "$KNOWN_HOSTS" ]] || { echo "No known host key for $SERVER_ADDR in ~/.ssh/known_hosts" >&2; exit 1; }

echo "== 4/6 Server: tunnel user, sshd rule, env =="
# Token and key go over stdin, never over the command line (ps).
{
  echo "PUBKEY='$(cat "$KEY.pub")'"
  echo "TOKEN='$TOKEN'"
  echo "SERVER_PORT='$SERVER_PORT'"
  echo "TUNNEL_USER='$TUNNEL_USER'"
  cat <<'REMOTE'
set -euo pipefail
HOME_DIR="/var/lib/$TUNNEL_USER"
if ! id -u "$TUNNEL_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$HOME_DIR" --no-create-home --shell /usr/sbin/nologin "$TUNNEL_USER"
fi
# Directory and key file belong to root: the user cannot add a second key or
# further rights for itself.
install -d -o root -g "$TUNNEL_USER" -m 750 "$HOME_DIR"
install -d -o root -g "$TUNNEL_USER" -m 750 "$HOME_DIR/.ssh"
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:%s",permitopen="127.0.0.1:1" %s\n' "$SERVER_PORT" "$PUBKEY" > "$HOME_DIR/.ssh/authorized_keys"
chown root:"$TUNNEL_USER" "$HOME_DIR/.ssh/authorized_keys"
chmod 640 "$HOME_DIR/.ssh/authorized_keys"

cat > /etc/ssh/sshd_config.d/serain-companion.conf <<CONF
# Mac companion (D28): this user may open exactly one remote forward on loopback.
Match User $TUNNEL_USER
  AllowTcpForwarding remote
  PermitListen 127.0.0.1:$SERVER_PORT
  GatewayPorts no
  X11Forwarding no
  AllowAgentForwarding no
  PermitTTY no
  PasswordAuthentication no
  ForceCommand /usr/sbin/nologin
  ClientAliveInterval 30
  ClientAliveCountMax 2
CONF
sshd -t
systemctl reload ssh

ENV_FILE=/etc/serain/serain.env
cp -p "$ENV_FILE" "$ENV_FILE.bak-companion"
grep -v -E '^SERAIN_COMPANION_(PORT|TOKEN)=' "$ENV_FILE.bak-companion" > "$ENV_FILE.new"
printf 'SERAIN_COMPANION_PORT=%s\nSERAIN_COMPANION_TOKEN=%s\n' "$SERVER_PORT" "$TOKEN" >> "$ENV_FILE.new"
chown root:serain "$ENV_FILE.new"
chmod 640 "$ENV_FILE.new"
mv "$ENV_FILE.new" "$ENV_FILE"
systemctl restart serain
echo "Server set up."
REMOTE
} | ssh "$HOST" bash -s

echo "== 5/6 launchd =="
write_agent() {
  local label="$1"; shift
  local plist="$AGENTS/$label.plist"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$label</string>"
    echo '  <key>ProgramArguments</key><array>'
    for arg in "$@"; do echo "    <string>$arg</string>"; done
    echo '  </array>'
    echo "  <key>WorkingDirectory</key><string>$APP_DIR</string>"
    echo '  <key>RunAtLoad</key><true/>'
    echo '  <key>KeepAlive</key><true/>'
    echo '  <key>ThrottleInterval</key><integer>15</integer>'
    echo '  <key>ProcessType</key><string>Background</string>'
    echo "  <key>StandardOutPath</key><string>$LOG_DIR/$label.log</string>"
    echo "  <key>StandardErrorPath</key><string>$LOG_DIR/$label.log</string>"
    echo '</dict></plist>'
  } > "$plist"
  # `bootout` returns before the service is really gone; a `bootstrap` right
  # after it fails with "Bootstrap failed: 5: Input/output error" (happened on
  # the second run, 2026-09-20). First wait until launchd no longer knows it,
  # then load, with a few attempts.
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break
    sleep 0.5
  done
  local attempt
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; then return 0; fi
    sleep 1
  done
  echo "launchd does not accept $label (launchctl bootstrap gui/$(id -u) \"$plist\")" >&2
  return 1
}
write_agent com.serain.companion "$NODE" "$APP_DIR/node_modules/tsx/dist/cli.mjs" "$APP_DIR/companion/main.ts"
# ssh reads UserKnownHostsFile as a list separated by spaces. The path is under
# "Application Support": without the quotes INSIDE the value it falls apart into
# three files that do not exist, and the tunnel fails with "No ED25519 host key
# is known" (happened on the first installation, 2026-09-20).
write_agent com.serain.companion-tunnel /usr/bin/ssh -N -T \
  -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes \
  -o "UserKnownHostsFile=\"$KNOWN_HOSTS\"" -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R "127.0.0.1:$SERVER_PORT:127.0.0.1:$MAC_PORT" "$TUNNEL_USER@$SERVER_ADDR"

echo "== 6/6 macOS permissions =="
echo "macOS will now ask three times (calendars, reminders, contacts). Please allow."
STATUS_FILE="$(mktemp)"
# Without -W: `open` cannot attach to a program that finishes immediately.
# We wait for the answer file instead.
/usr/bin/open -n --stdout "$STATUS_FILE" -a "$APPLE_APP" --args authorize
for _ in $(seq 1 400); do [[ -s "$STATUS_FILE" ]] && break; sleep 1; done
cat "$STATUS_FILE"; echo; rm -f "$STATUS_FILE"

echo "== Check =="
sleep 3
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -sS --max-time 5 -K - "http://127.0.0.1:$MAC_PORT/v1/hello" && echo "  <- Mac"
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | ssh "$HOST" "curl -sS --max-time 5 -K - http://127.0.0.1:$SERVER_PORT/v1/hello" && echo "  <- server through the tunnel"
echo "Done. Logs: $LOG_DIR"
