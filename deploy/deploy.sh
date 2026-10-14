#!/usr/bin/env bash
# Deploys the local state to the server. Runs on your own computer (macOS
# or Linux) in a Git checkout, never on the server.
#
# No git pull on the server: the server needs no access to the repo.
# Transfer is via rsync; secrets stay out and live there in
# /etc/serain/serain.env, which only root and serain may read.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The host comes from the environment or from .dev.vars (gitignored), so the
# server address is neither in the repo nor has to be looked up on every deploy.
HOST="${SERAIN_HOST:-}"
if [[ -z "$HOST" && -f "$REPO_DIR/.dev.vars" ]]; then
  HOST="$(grep -E '^SERAIN_HOST=' "$REPO_DIR/.dev.vars" | tail -1 | cut -d= -f2- || true)"
fi
if [[ ! "$HOST" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]]; then
  echo "SERAIN_HOST missing or incomplete (expected root@<host>, via environment or in .dev.vars)" >&2
  exit 1
fi
APP_DIR=/opt/serain

cd "$REPO_DIR"

# What gets deployed is a commit, never the working tree: otherwise editing in
# the same folder can continue during the tests, and one state is tested while
# another is copied. Hence: only with a clean tree, and what gets transferred is
# an export of exactly the commit that was HEAD at the start.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree has uncommitted changes. Commit (or stash) first, then deploy:" >&2
  git status --short >&2
  exit 1
fi
REV="$(git rev-parse HEAD)"
EXPORT_DIR="$(mktemp -d)"
trap 'rm -rf "$EXPORT_DIR"' EXIT
git archive "$REV" | tar -x -C "$EXPORT_DIR"
echo "$REV" > "$EXPORT_DIR/REVISION"

# The instance (docs/INSTANCE.md), if there is one: the same rule, a commit of the
# repository it lives in, never its working tree. Usually `instance` is a symlink
# into the owner's private repository; what goes to the server is a plain copy.
instance_state() { [[ -n "$INSTANCE_TOP" ]] && echo "$(git -C "$INSTANCE_TOP" rev-parse HEAD) $(git -C "$INSTANCE_TOP" status --porcelain -- "$INSTANCE_PATH")"; }
INSTANCE_TOP=""
INSTANCE_PATH="."
if [[ -e "$REPO_DIR/instance" ]]; then
  INSTANCE_REAL="$(cd "$REPO_DIR/instance" && pwd -P)"
  if ! INSTANCE_TOP="$(git -C "$INSTANCE_REAL" rev-parse --show-toplevel 2>/dev/null)"; then
    echo "instance/ ($INSTANCE_REAL) is not in a Git repository. Deployed is only what is committed." >&2
    exit 1
  fi
  INSTANCE_PATH="${INSTANCE_REAL#"$INSTANCE_TOP"}"
  INSTANCE_PATH="${INSTANCE_PATH#/}"
  INSTANCE_PATH="${INSTANCE_PATH:-.}"
  if [[ -n "$(git -C "$INSTANCE_TOP" status --porcelain -- "$INSTANCE_PATH")" ]]; then
    echo "The instance has uncommitted changes. Commit there first, then deploy:" >&2
    git -C "$INSTANCE_TOP" status --short -- "$INSTANCE_PATH" >&2
    exit 1
  fi
  INSTANCE_REV="$(git -C "$INSTANCE_TOP" rev-parse HEAD)"
  INSTANCE_STATE="$(instance_state)"
  mkdir "$EXPORT_DIR/instance"
  if [[ "$INSTANCE_PATH" == "." ]]; then
    git -C "$INSTANCE_TOP" archive "$INSTANCE_REV" | tar -x -C "$EXPORT_DIR/instance"
  else
    git -C "$INSTANCE_TOP" archive "$INSTANCE_REV:$INSTANCE_PATH" | tar -x -C "$EXPORT_DIR/instance"
  fi
  echo "$INSTANCE_REV" > "$EXPORT_DIR/instance/REVISION"
  echo "Instance: ${INSTANCE_TOP/#$HOME/~}/$INSTANCE_PATH at ${INSTANCE_REV:0:7}"
fi

echo "== Tests before deploying (commit ${REV:0:7}) =="
pnpm typecheck
pnpm test
if [[ "$(git rev-parse HEAD)" != "$REV" || -n "$(git status --porcelain)" || "$(instance_state)" != "${INSTANCE_STATE:-}" ]]; then
  echo "The state changed during the tests. Aborting, nothing transferred." >&2
  exit 1
fi

echo "== Transferring to $HOST:$APP_DIR =="
# Without -o/-g (so not -a): with -a, $APP_DIR itself takes over the owner of the
# export folder (the local UID, mode 0700 from mktemp) until the chown -R further
# down runs. In between, the running service cannot get into its own directory,
# and the Agent SDK does not find its binary. Without -o/-g, the ownership of
# $APP_DIR stays, new files belong to root and are readable, and the chown cleans
# up afterwards.
rsync -rlptz --delete \
  --exclude 'node_modules/' \
  --exclude '.dev.vars' \
  --exclude 'data/' \
  --exclude '*.log' \
  "$EXPORT_DIR/" "$HOST:$APP_DIR/"

echo "== Sandbox helper to /usr/local/lib/serain-sandbox (root-owned, D20) =="
# Directly from your own computer, never via /opt/serain: the service `serain` may write there,
# and whatever the helper executes runs with Docker rights.
ssh "$HOST" 'install -d -o root -g root -m 755 /usr/local/lib/serain-sandbox'
# Only flags that macOS's rsync (openrsync) knows too: no --chown, no
# --chmod. Without -o/-g/-p, the receiver creates the files as root; ownership
# and permissions are set explicitly by the next step.
rsync -rtz --delete "$EXPORT_DIR/deploy/sandbox/" "$HOST:/usr/local/lib/serain-sandbox/"
ssh "$HOST" 'chown -R root:root /usr/local/lib/serain-sandbox && chmod 755 /usr/local/lib/serain-sandbox && chmod 644 /usr/local/lib/serain-sandbox/*'

echo "== AppArmor profile for Chromium (D35) =="
# Directly from your own computer for the same reason: the profile decides which binary
# gets user namespaces.
rsync -tz "$EXPORT_DIR/deploy/apparmor/serain-chromium" "$HOST:/etc/apparmor.d/serain-chromium"
ssh "$HOST" 'chown root:root /etc/apparmor.d/serain-chromium && chmod 644 /etc/apparmor.d/serain-chromium && apparmor_parser -r /etc/apparmor.d/serain-chromium'

echo "== Dependencies and restart =="
ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/serain
# --frozen-lockfile: the server installs exactly what was tested locally.
pnpm install --frozen-lockfile --prod=false
mkdir -p /opt/serain/data
chown -R serain:serain /opt/serain
# Sandbox (D20): a dedicated user in the group docker. The image is never built
# without network: it is built here, and run with --network none.
if ! id -u serain-sandbox >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin serain-sandbox
fi
usermod -aG docker serain-sandbox
docker build -q -t serain-sandbox:1 /usr/local/lib/serain-sandbox
# Speech output (D59): its own image, Piper needs glibc.
docker build -q -t serain-tts:1 -f /usr/local/lib/serain-sandbox/Dockerfile.tts /usr/local/lib/serain-sandbox
# Browser for `web_browse` (D35): the Chromium that belongs to the installed playwright-core version,
# root-owned outside /opt/serain. There is no Google Chrome for ARM, and this way it is the same route
# on every architecture. It is downloaded only when the version changes; the fixed path
# /usr/local/bin/serain-chromium is the value for SERAIN_CHROME_PATH.
export PLAYWRIGHT_BROWSERS_PATH=/opt/serain-browsers
node node_modules/playwright-core/cli.js install --with-deps chromium >/dev/null
chmod -R a+rX /opt/serain-browsers
ln -sfn "$(node -e 'console.log(require("playwright-core").chromium.executablePath())')" /usr/local/bin/serain-chromium
# The sandbox units also come from the root-owned directory, not from /opt/serain.
install -m 644 /usr/local/lib/serain-sandbox/serain-sandbox.socket /etc/systemd/system/serain-sandbox.socket
install -m 644 /usr/local/lib/serain-sandbox/serain-sandbox.service /etc/systemd/system/serain-sandbox.service
install -m 644 /opt/serain/deploy/serain.service /etc/systemd/system/serain.service
install -m 644 /opt/serain/deploy/serain-watchdog.service /etc/systemd/system/serain-watchdog.service
install -m 644 /opt/serain/deploy/serain-watchdog.timer /etc/systemd/system/serain-watchdog.timer
systemctl daemon-reload
systemctl enable --now serain-sandbox.socket
systemctl restart serain-sandbox.service
systemctl enable serain
# Do not restart in the middle of a task or turn: a restart aborts it, and the owner waits
# for an answer that never comes. We wait as long as the service itself reports that it is
# working (src/health/work.ts), at most five minutes. Counting processes by name does not work:
# since the warm pool (D50), prewarmed claude processes are always waiting.
# No file, or a dead process in it, means: nobody is working. Only known kinds and numbers
# are printed, never text from the file.
work_state() {
  node -e '
    const fs = require("node:fs");
    let report;
    try { report = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
    try { process.kill(report.pid, 0); } catch { process.exit(0); }
    const kinds = ["inbound", "turn", "task", "attachment", "followup", "model", "browser"];
    const busy = kinds.filter((kind) => Number.isInteger(report.work?.[kind]) && report.work[kind] > 0);
    if (busy.length > 0) console.log(busy.map((kind) => `${kind}=${report.work[kind]}`).join(" "));
    else if (Number.isInteger(report.busy) && report.busy > 0) console.log(`busy=${report.busy}`);
  ' /run/serain/work.json
}
for _ in $(seq 1 60); do
  BUSY="$(work_state)"
  [ -z "$BUSY" ] && break
  echo "Serain is busy ($BUSY), waiting with the restart ..."
  sleep 5
done
if [ -n "$BUSY" ]; then
  echo "Serain is still busy after five minutes ($BUSY), restarting anyway."
fi
systemctl restart serain
systemctl enable --now serain-watchdog.timer
REMOTE

echo "== Status =="
ssh "$HOST" 'sleep 3; echo "Commit: $(cut -c1-7 /opt/serain/REVISION)"; [ -f /opt/serain/instance/REVISION ] && echo "Instance: $(cut -c1-7 /opt/serain/instance/REVISION)"; systemctl is-active serain serain-sandbox.socket serain-sandbox.service; journalctl -u serain -n 15 --no-pager'
