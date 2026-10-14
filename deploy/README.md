# Operations

Serain runs as a long-lived Node process on its own Linux VM: systemd service `serain`, user `serain`, Docker for the sandbox. Inbound, the server only needs SSH, because the channel (Photon) runs over an outbound gRPC stream (D38). The scripts here set up the VM and deploy; they run on your own computer (macOS or Linux) and talk to the server over SSH.

## Server

Tested on **Ubuntu 24.04** on ARM (aarch64) and x86_64. Ubuntu is a given because `provision.sh` uses `apt`, NodeSource and `unattended-upgrades`, and `deploy.sh` loads an AppArmor profile (`apparmor_parser`). Other distributions only work with adjustments.

Size: at least 2 vCPU and 4 GB RAM (the service is capped at 3 GB, plus the sandbox containers), 30 GB disk (the two sandbox images alone hold a speech model of about 800 MB and ten voices of about 630 MB). More RAM does not hurt if the browser (`web_browse`) runs often.

Any provider works. One possible route is **Oracle Cloud Always Free** (Ampere A1, ARM). What is different there compared to an ordinary Ubuntu VM:

- **Quota:** the docs state 2 OCPU and 12 GB RAM for all A1 VMs combined for new accounts; anything above that is billed. Signing up requires a credit card. Create a budget alarm (e.g. at 1 €) on the root compartment.
- **Idle instances** of Always Free accounts are reclaimed by Oracle. An account on Pay-As-You-Go is not affected, but pays for whatever exceeds the quota.
- **root is locked:** in the image you log in as `ubuntu`. Unlock it once (see below).
- **Two firewalls:** the VCN's security list and, in addition, iptables rules in the image (`/etc/iptables/rules.v4`, everything except SSH is rejected). Serain needs nothing inbound except port 22, so leave both as they are. If you open a port later, you have to do it in both places.
- **The public IPv4 is ephemeral:** it survives reboots but changes when the instance is stopped and started again. Then update `SERAIN_HOST` in `.dev.vars` and the tunnel of the Mac companion (`companion/`). A reserved IP avoids this.

## First setup

On Oracle (and anywhere root is locked in the image), unlock it once as the default user:

```bash
ssh ubuntu@<host> 'sudo cp ~/.ssh/authorized_keys /root/.ssh/authorized_keys'
```

Then set up the VM (idempotent, can be repeated at any time):

```bash
scp deploy/provision.sh root@<host>:/root/
ssh root@<host> bash /root/provision.sh
```

`provision.sh` installs Node 22, pnpm, Docker and automatic security updates, creates the user `serain` and 2 GB of swap, and allows SSH with keys only.

The database is set up from your own computer, not from the server: apply `supabase/migrations/` with `psql` over the session pooler as described in [docs/SETUP.md](../docs/SETUP.md) (A3; after an update only the new files, C2). There is no migration runner in the repo.

Afterwards, add `SERAIN_HOST=root@<host>` to `.dev.vars` and create the server's env file (never via Git, never in the repo). Which variables exist and which are required is listed in `.env.example`. What only the setup scripts on your own computer need does not belong on the server: `SERAIN_HOST`, `GOOGLE_CLIENT_*` (stored sealed with the integration), `SUPABASE_DB_PASSWORD`, `SUPABASE_POOLER_HOST`, `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_*` and `WEB_ACCESS_EMAIL`. `SERAIN_DB_URL` (the tick over Postgres as `serain_server`, addendum to D50 of 2026-10-11) is written to the server by `pnpm db:password` itself.

```bash
grep -v -E '^(SERAIN_HOST|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|SUPABASE_DB_PASSWORD|SUPABASE_POOLER_HOST|SUPABASE_ACCESS_TOKEN|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|WEB_ACCESS_EMAIL)=' .dev.vars | ssh root@<host> 'umask 077; cat > /etc/serain/serain.env && chown root:serain /etc/serain/serain.env && chmod 640 /etc/serain/serain.env'
pnpm db:password
```

## Deploying

```bash
./deploy/deploy.sh   # host from SERAIN_HOST or from .dev.vars (SERAIN_HOST=root@<host>)
```

The script needs a Git checkout and deploys a **commit**, never the working tree: it aborts if there are uncommitted changes, runs the tests (`pnpm typecheck`, `pnpm test`), exports exactly the commit that was HEAD at the start (`git archive`), transfers that export via rsync and restarts the service. If Serain is busy (a turn, a task), it waits up to five minutes before restarting. Which commit is running is then recorded in `/opt/serain/REVISION`.

The first time, it also builds the sandbox images and downloads the Chromium for `web_browse`; that takes a few minutes.

## Running

```bash
ssh root@<host> 'systemctl status serain'
ssh root@<host> 'journalctl -u serain -f'
ssh root@<host> 'systemctl restart serain'
```

The service runs as user `serain`, never as root, with `Restart=always` and `systemctl enable`, so it survives crashes and reboots.

## Health check and incident log (W11)

Three layers, see `src/health/`:

- **Heartbeat in the process** (`src/health/heartbeat.ts`, started by `runtime.ts`
  on connect): every 5 minutes writes the status of `process`, `channel`
  and `db` to `component_status`, plus `model` after every successful model call
  (purely informational, not a monitored value). If the process notices that a
  component is healthy again, it closes an open incident and sends the owner a
  short message through `OutboundGate` (at most 1 notice per component every
  30 min, on top of the general rate limit in `outbound.ts`). Notices only go
  out after **10 minutes** of disruption (`INCIDENT_NOTIFY_MIN_DURATION_MS`,
  matching the grace time of the Healthchecks.io check), and several incidents
  closed at the same time are bundled into **one** message. Anything shorter is
  only recorded in `incidents`.
  Plus `delivery` (D44): whether messages really go out at the channel. The
  `OutboundGate` counts what `channel.send` throws (not its own rate limit,
  not duplicates); unhealthy at 3 failures in a row or ≥ 50 % of ≥ 4
  attempts in 30 min, healthy again only after a success. Every change is
  recorded as `delivery_health` in the audit log. After a restart, an open
  `delivery` incident stays open until a message went out.
- **Watchdog outside the process** (`src/health/watchdog.ts`, run by
  `serain-watchdog.timer` every 5 minutes as its own short process, not part
  of `serain.service`): checks `systemctl is-active serain` and the freshness of
  `component_status` (threshold 15 min = 3 missed heartbeats). It opens
  incidents and never closes any: closing them, including the notice to the
  owner, stays with the running process, which is the only one with a channel.
  **A restart is not an outage:** if the service has been running for less than
  15 minutes, a missing heartbeat counts as the startup phase; a process stopped
  via `stop()` leaves the marker `planned` in `component_status.process`, and
  the watchdog stays quiet about it. If the service is down unplanned, there is
  exactly one incident for `process`, not an additional one each for channel
  and database.
- **`incidents` table** (migration `0002_health.sql`): one incident per
  component can be open at a time (unique index); root cause and note are
  stored on it.

Set up by `deploy/deploy.sh`. To check:

```bash
ssh root@<host> 'systemctl status serain-watchdog.timer'
ssh root@<host> 'journalctl -u serain-watchdog -n 30 --no-pager'
```

**Alert path for a total outage (optional, recommended):** if the server fails
completely (or the channel does), there is no alert without a second path that
is independent of the server and Supabase: the watchdog runs on the same server
it monitors. That is what **Healthchecks.io (Free) as a dead man's switch** is
for: create a check (period 5 min, grace 10 min). The in-process heartbeat
(`src/health/heartbeat.ts`, the decision itself in `src/health/deadman.ts`)
pings the ping URL after every run if `process`, `channel`, `db` and
`delivery` are all ok, otherwise `<url>/fail`; if the ping stops arriving,
Healthchecks.io raises the alarm itself. Through `delivery`, this is also the
alert path when the channel's stream is up but no message arrives: the channel
itself cannot report that.

The URL is stored as `HEALTHCHECKS_PING_URL` in `/etc/serain/serain.env` (locally
`.dev.vars`), carries a secret UUID and must never go into the repo or the log.
If it is missing, Serain runs normally, just without this external alert path,
and logs a one-time hint at startup. How Healthchecks.io notifies you (mail,
push, …) is configured in its dashboard.

## Sandbox (D20)

`serain` never starts a container itself. The helper (`deploy/sandbox/`) lives
root-owned in `/usr/local/lib/serain-sandbox/`, runs as `serain-sandbox`
(group `docker`) and listens on `/run/serain-sandbox.sock` (`root:serain`, 0660).
`deploy.sh` transfers it directly from your own computer, builds the images
`serain-sandbox:1` (whisper.cpp with a multilingual model that detects the
spoken language, media parsers, yt-dlp) and `serain-tts:1` (Piper with one
voice each for de, en, es, fr, it, nl, pl, pt, ru and tr, about 63 MB per
voice) and starts socket and service.

A new local voice is three entries, kept in sync by `test/sandbox.test.ts`:
the voice with its checksums in `PIPER_VOICES` in `Dockerfile.tts`, its path
in `VOICES` in `helper.mjs`, and its language in `PIPER_VOICES` in
`src/media/speech.ts`. Then deploy; the image is rebuilt on the server.

```bash
ssh root@<host> 'systemctl status serain-sandbox.socket serain-sandbox.service'
ssh root@<host> 'journalctl -u serain-sandbox -n 30 --no-pager'   # one line per job
ssh root@<host> 'id serain'                                       # must NOT be in docker
```

## Integrations (D30 to D35)

Credentials for mail and calendar are stored sealed in Supabase (`integrations`), the key only in the env. Connecting and disconnecting happens on your own computer, not on the server: that is where a password gets typed or a browser opens.

- **Key (once):** `pnpm integration key`, then add the line to `.dev.vars` and to `/etc/serain/serain.env`, the same value in both. Without it, Serain starts normally, just without integrations.
- **Mailbox over IMAP/SMTP:** allow IMAP at your provider and, where two-factor login exists, create an app-specific password. Then `pnpm integration connect <provider>`: presets exist for `gmx`, `webde`, `posteo` and `mailbox`; for any other name the script asks for the IMAP and SMTP servers. The password is typed hidden, verified and stored only sealed.
- **Google (Gmail, Google Calendar):** your own OAuth app in the Google Cloud Console: enable the Gmail API and Calendar API, create an OAuth client of type desktop app, put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.dev.vars` (only there; the server does not need them in its env, they are stored sealed with the integration). Then `pnpm integration connect google`. While the app is in "Testing" status, refresh tokens expire after 7 days; then connect again.
- **iCloud Calendar (CalDAV, D54):** an app-specific password at account.apple.com, then `pnpm integration connect icloud`.
- **After connecting,** `systemctl restart serain`: credentials are read at startup. **Disconnecting** (`pnpm integration disconnect <id>`) takes effect immediately, even without a restart, and deletes the credentials and remembered mail data.
- **Vault (D49):** `SERAIN_VAULT_KEY` from `.dev.vars` (generated with `pnpm web vault-key`) in `serain.env`. Without it there are no logged-in sessions (`run_site_task`). The sites' Chrome profiles live in `/opt/serain/data/site-profiles`.
- **Connections (D51):** need `SERAIN_INTEGRATION_KEY` and `SERAIN_VAULT_KEY` (the browser seals the provider's response to the vault key); without both, a connection in the web interface stays at the step where Serain prepares the authorization. For the bank, additionally `ENABLE_BANKING_APP_ID` and `ENABLE_BANKING_KEY` from `pnpm connector bank-key`.
- **Videos (`media_watch`, D61):** Serain watches YouTube without downloading, through Gemini. TikTok, Instagram and X are downloaded by yt-dlp in the sandbox, and that is **off by default**: turn it on with `SERAIN_MEDIA_DOWNLOAD=1` in `serain.env`, at your own risk (the platforms prohibit downloading in their terms). yt-dlp is pinned in the sandbox image (`YTDLP_VERSION`, `YTDLP_SHA256` in the Dockerfile). If `media_watch` suddenly reports that loading failed for videos that work in the browser, a new yt-dlp version is usually due: enter version and checksum from the release's `SHA2-256SUMS`, then deploy. `serain.service` sets `SERAIN_MEDIA_PROXY_DIR=/run/serain/media-proxy`; without it there is only YouTube. Images from TikTok photo carousels and photos on X are fetched by `media_fetch` through internal methods of the extractors (`_extract_web_data_and_status`, `_extract_status`), and it replaces `TwitterIE._call_syndication_api` (D61); after a yt-dlp update, test one photo carousel and one photo post on X. The helper logs one line per job (`media_fetch`, `video_compact`, `image_to_jpeg`).
- **Browser (`web_browse`):** `deploy.sh` installs the Chromium matching the `playwright-core` version into `/opt/serain-browsers` (there is no Google Chrome for ARM, so this is the same route on every architecture) and the AppArmor profile `deploy/apparmor/serain-chromium` (D35). In `serain.env`: `SERAIN_CHROME_PATH=/usr/local/bin/serain-chromium` and `TYPESAFE_API_KEY`. Chromium runs with its own sandbox; if that fails under the service's hardening, the answer is the profile or an adjustment of the unit, never `--no-sandbox`.
