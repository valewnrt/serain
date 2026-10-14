#!/usr/bin/env bash
# Removes the Mac companion again: agents, files on the Mac, user, sshd rule
# and env lines on the server. The macOS permissions are revoked by
# `tccutil reset All com.serain.apple-helper`.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${SERAIN_HOST:-$(grep -E '^SERAIN_HOST=' "$REPO_DIR/.dev.vars" 2>/dev/null | tail -1 | cut -d= -f2- || true)}"
for label in com.serain.companion com.serain.companion-tunnel; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
rm -rf "$HOME/Library/Application Support/Serain Companion"
tccutil reset All com.serain.apple-helper >/dev/null 2>&1 || true
if [[ "$HOST" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]]; then
  ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
rm -f /etc/ssh/sshd_config.d/serain-companion.conf
sshd -t && systemctl reload ssh
pkill -u serain-companion 2>/dev/null || true
userdel serain-companion 2>/dev/null || true
rm -rf /var/lib/serain-companion
sed -i.bak-companion -E '/^SERAIN_COMPANION_(PORT|TOKEN)=/d' /etc/serain/serain.env
systemctl restart serain
REMOTE
fi
echo "Companion removed."
