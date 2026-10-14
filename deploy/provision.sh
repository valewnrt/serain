#!/usr/bin/env bash
# Sets up a fresh Ubuntu 24.04 server for Serain. Idempotent.
# Runs as root on the server: bash provision.sh
set -euo pipefail

APP_USER=serain
APP_DIR=/opt/serain
ENV_DIR=/etc/serain

echo "== Packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git rsync unattended-upgrades

echo "== Automatic security updates =="
# An agent with mail and payment rights must not run on an unpatched OS.
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== Node 22 =="
if ! command -v node >/dev/null || [[ "$(node -v)" != v22.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

echo "== pnpm =="
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm -v

echo "== Docker (sandbox for code execution, D8.7) =="
if ! command -v docker >/dev/null; then
  apt-get install -y -qq docker.io
  systemctl enable --now docker
fi
docker --version

echo "== User $APP_USER =="
# Dedicated system user, no login. Serain never runs as root (D8.9).
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi

echo "== Directories =="
mkdir -p "$APP_DIR" "$APP_DIR/data" "$ENV_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 750 "$APP_DIR"
chmod 700 "$ENV_DIR"

echo "== Swap (4 GB RAM is tight once Playwright comes in) =="
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== SSH: key only, no root password =="
install -d /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/10-serain.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
EOF
systemctl reload ssh || systemctl reload sshd

echo "== done =="
