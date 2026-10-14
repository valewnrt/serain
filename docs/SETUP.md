# Setting up Serain from scratch

This guide takes you from nothing to a Serain that answers your iMessages from your own server. The steps are in dependency order: each one only needs what came before. Part A is required, part B is optional, part C covers operations and troubleshooting.

Before you start, read the README sections on [costs](../README.md#costs) and [legal](../README.md#legal). For the reasoning behind the architecture, see [ARCHITECTURE.md](ARCHITECTURE.md).

Plan about two hours for part A. Most of it is waiting for accounts and for the first deploy (it builds the sandbox image on the server).

`pnpm setup:check` shows where you stand at any point: it checks every step of part A on your machine and on the server, changes nothing, never shows a secret, and names the next step with its section here. Run it after each step. If a coding agent helps you set up, it follows [AGENTS.md](../AGENTS.md) and works with `pnpm setup:check --json`.

## Contents

- [A1. Prerequisites](#a1-prerequisites)
- [A2. Checkout and local configuration](#a2-checkout-and-local-configuration)
- [A3. Supabase](#a3-supabase)
- [A4. Photon (iMessage)](#a4-photon-imessage)
- [A5. Claude](#a5-claude)
- [A6. Server](#a6-server)
- [A7. Secrets to the server and `pnpm db:password`](#a7-secrets-to-the-server-and-pnpm-dbpassword)
- [A8. Echo test](#a8-echo-test)
- [A9. Deploy and first message](#a9-deploy-and-first-message)
- [B1. Integration key](#b1-integration-key)
- [B2. IMAP mailboxes](#b2-imap-mailboxes)
- [B3. Serain's own mailbox](#b3-serains-own-mailbox)
- [B4. Google (Gmail and Calendar)](#b4-google-gmail-and-calendar)
- [B5. iCloud Calendar](#b5-icloud-calendar)
- [B6. OpenRouter, web search, browser pilot, videos](#b6-openrouter-web-search-browser-pilot-videos)
- [B7. Web interface](#b7-web-interface)
- [B8. Connections: bank and COROS](#b8-connections-bank-and-coros)
- [B9. Mac companion](#b9-mac-companion)
- [B10. Healthchecks.io](#b10-healthchecksio)
- [B11. Base knowledge about you](#b11-base-knowledge-about-you)
- [C1. Operations](#c1-operations)
- [C2. Updating](#c2-updating)
- [C3. Troubleshooting](#c3-troubleshooting)

---

## Part A: required

### A1. Prerequisites

On your own machine (macOS or Linux; the commands below work on both):

- **Node.js 22** and **pnpm 10** (`corepack enable && corepack prepare pnpm@10.32.1 --activate`)
- **git**, **ssh**, **rsync**
- **psql**, the Postgres client: macOS `brew install libpq && brew link --force libpq`, Ubuntu/Debian `sudo apt install postgresql-client`
- **gitleaks** for the pre-commit hook: macOS `brew install gitleaks`, otherwise see the gitleaks releases

Accounts you will create on the way: Supabase, Photon, Anthropic, and a server (for example Oracle Cloud). You also need an Apple device with iMessage, signed in with the phone number you will put into `OWNER_PHONE`.

### A2. Checkout and local configuration

```bash
git clone <your fork or this repository> serain
cd serain
pnpm install
git config core.hooksPath .githooks     # secret scan before every commit
cp .env.example .dev.vars
chmod 600 .dev.vars
```

`.dev.vars` is gitignored and holds every value on your machine. Type the values in yourself; never paste them into a chat with a model. Every variable the code reads is explained in [`.env.example`](../.env.example), grouped and marked required or optional. Fill in the owner section now:

```ini
OWNER_NAME=Alex                # required: how Serain addresses you
OWNER_PHONE=+4915112345678     # required: your iMessage number, E.164 (the ingress allowlist)
OWNER_TIMEZONE=Europe/Berlin   # required: IANA time zone for reminders and calendar
OWNER_LANGUAGE=en              # optional, default en: only the starting language
OWNER_COUNTRY=DE               # optional, ISO 3166-1 alpha-2; public holidays exist for DE only so far
OWNER_REGION=HH                # optional, only with OWNER_COUNTRY=DE: federal state for regional holidays
OWNER_CITY=Hamburg             # optional: starting point for timetables, weather, searches nearby
```

Serain replies in the language you write in, any language. `OWNER_LANGUAGE` only covers the time before it has seen enough of your messages; the detected language is stored in the database. Fixed texts (previews, confirmations, notices) are built in for English and German and translated once by the model for any other language.

Deploying rolls out a **git commit**, never your working directory (see A9). Keep the checkout a git repository and commit your own changes before deploying.

### A3. Supabase

1. Create a project at [supabase.com](https://supabase.com) (the Free plan is enough). Pick a region close to your server and write down the **database password** you set.
2. In **Project Settings > API Keys**, copy the **secret key** (`sb_secret_...`). Do not use the publishable key or a legacy `service_role` key.
3. Put the values into `.dev.vars`:

   ```ini
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_...
   SUPABASE_DB_PASSWORD=<database password>
   SUPABASE_POOLER_HOST=<session pooler host, see next step>
   ```

4. Click **Connect** in the project's top bar and choose **Session pooler**. The connection string looks like `postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`. Use the session pooler, not the direct connection: the direct connection is IPv6 only. The host part is your `SUPABASE_POOLER_HOST`.
5. Apply all migrations, in order, each in its own transaction, stopping at the first error:

   ```bash
   export SUPABASE_ADMIN_URL='postgresql://postgres.<project-ref>:<database password>@<pooler host>:5432/postgres'
   for f in supabase/migrations/*.sql; do
     echo "== $f"
     psql "$SUPABASE_ADMIN_URL" -v ON_ERROR_STOP=1 --single-transaction -q -f "$f" || break
   done
   unset SUPABASE_ADMIN_URL
   ```

   The last line printed must be the highest-numbered migration without an error after it. The migrations create the tables, row-level security, the vector extension and two restricted roles (`serain_server` for the server's recurring work, `serain_web` for the web interface). Neither role has a password yet.

   Migrations are additive but not meant to be applied twice. Note the number of the last one you applied; after an update you apply only the new ones (see C2).

The Free plan pauses projects that are inactive for a week. A running Serain writes every few minutes, so this only matters while you are still setting up.

### A4. Photon (iMessage)

Photon relays iMessage to Serain over an outbound gRPC stream. On the Free plan you get a number from a shared pool.

1. Sign up at [photon.codes](https://photon.codes) and open the dashboard (app.photon.codes).
2. Create a project for iMessage on the Free plan. Photon assigns a shared number to the project. Save it on your phone as a contact named "Serain".
3. If the dashboard asks for the phone numbers that may talk to the project, enter your own (`OWNER_PHONE`).
4. Copy the project ID and the project secret into `.dev.vars`:

   ```ini
   PHOTON_PROJECT_ID=...
   PHOTON_PROJECT_SECRET=...
   ```

5. **Write to the number first.** A shared line can only message you after you have messaged it once. Send it any text from your iPhone now. If Photon ever changes the number, do this again.

The number belongs to Photon, not to you, and only one process may be connected to the project at a time.

### A5. Claude

**Recommended: API key.** Create a key in the [Anthropic Console](https://console.anthropic.com) and set a **monthly spend limit** there. Serain books Claude API spend against its own monthly cap (`SERAIN_API_BUDGET_USD`, default 20 $) and stops paid calls, including the chat, when it is reached. Its numbers are list-price estimates, so keep the Console limit as a backstop.

```ini
ANTHROPIC_API_KEY=sk-ant-api...
```

**Alternative: your own subscription**, strictly for personal use and at your own risk (see the README's legal section). Install Claude Code, run `claude setup-token`, and put the token into `CLAUDE_CODE_OAUTH_TOKEN` instead. Never use anyone else's token. If both variables are set, the API key wins and the token is ignored. With the token, Claude calls cost nothing per request and the chat keeps running when the monthly cap is reached; everything else paid (OpenRouter, search, Typesafe) still stops there.

### A6. Server

Serain needs a Linux VM with systemd, Docker and AppArmor. The scripts are written and tested for **Ubuntu 24.04** on ARM64 and x86-64. Size: at least 4 GB RAM (8 GB or more recommended: up to three pre-warmed model processes, Chrome and the sandbox), at least 30 GB of disk (the sandbox images are built on the server: one contains the whisper speech model of about 800 MB, the other ten local voices for spoken replies of about 630 MB together). Only port 22 needs to be reachable; Serain opens no port.

#### Example: Oracle Cloud Always Free

1. Create an account at Oracle Cloud (a credit card is required even for the free tier).
2. Create an instance: shape **VM.Standard.A1.Flex** (Ampere, ARM), 2 OCPU and 12 GB are within the Always Free limits for new accounts; image **Canonical Ubuntu 24.04**; add your SSH public key; boot volume 50 GB or more.
3. The default security list allows SSH. Leave everything else closed.

Oracle specifics to know:

- **root login is disabled** in Oracle's image. Enable it once as `ubuntu`:

  ```bash
  ssh ubuntu@<ip> 'sudo cp ~/.ssh/authorized_keys /root/.ssh/authorized_keys'
  ```

- Oracle's image ships its own iptables rules in addition to the VCN security list. Serain needs no changes to either.
- The public IPv4 address is **ephemeral**: it survives reboots but changes when you stop and start the instance. Then update `SERAIN_HOST` (and rerun `./companion/install.sh` if you use the companion).
- On free-tier accounts Oracle may reclaim instances it considers idle. Upgrading to Pay As You Go keeps Always Free resources free, but anything beyond the limits is billed: set a budget alert.

Any other provider with Ubuntu 24.04 works the same way, minus the Oracle specifics.

#### Provisioning

```bash
scp deploy/provision.sh root@<ip>:/root/
ssh root@<ip> bash /root/provision.sh
```

`provision.sh` is idempotent. It installs Node 22 (NodeSource), pnpm, Docker (`docker.io`), unattended security upgrades, creates the system user `serain` (no login, never root), `/opt/serain` and `/etc/serain`, a 2 GB swap file, and restricts SSH to keys only. It assumes apt, systemd and Ubuntu package names; other distributions need adjustments.

Add the SSH target to `.dev.vars`:

```ini
SERAIN_HOST=root@<ip>
```

### A7. Secrets to the server and `pnpm db:password`

The server reads its configuration from `/etc/serain/serain.env`. Copy your `.dev.vars` without the variables that must stay on your machine:

```bash
grep -v -E '^(SERAIN_HOST|SUPABASE_DB_PASSWORD|SUPABASE_POOLER_HOST|SUPABASE_ACCESS_TOKEN|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|WEB_ACCESS_EMAIL)=' .dev.vars \
  | ssh root@<ip> 'umask 077; cat > /etc/serain/serain.env && chown root:serain /etc/serain/serain.env && chmod 640 /etc/serain/serain.env'
```

Never put the database password, cloud tokens or your Google client on the server: a compromised agent must not be able to manage its own infrastructure.

Then give the role `serain_server` a password:

```bash
pnpm db:password
```

It generates a random password, sends only its SCRAM verifier to Supabase (never the password), and writes `SERAIN_DB_URL` into `.dev.vars` and into `/etc/serain/serain.env` on the server. It reads `SUPABASE_URL`, `SUPABASE_DB_PASSWORD`, `SUPABASE_POOLER_HOST` and `SERAIN_HOST` from `.dev.vars`. Rerun it whenever you want to rotate the password, then deploy.

Whenever you change a value later, edit both `.dev.vars` and `/etc/serain/serain.env`, then restart the service.

### A8. Echo test

Before anything costs money, check the channel. In echo mode Serain answers every message with an echo instead of calling a model:

```bash
SERAIN_ECHO_ONLY=1 pnpm dev
```

Text the Photon number from your phone. You should get an echo back within a few seconds, and the terminal shows the message passing the allowlist. Text `serain stop` and `serain resume` to see the kill switch acknowledge both (`serain stop` works in any language; the German `serain stopp` and `serain weiter` work too). Stop the process with Ctrl-C afterwards: **only one process may be connected to Photon at a time.**

If nothing arrives, see [C3](#c3-troubleshooting).

### A9. Deploy and first message

```bash
./deploy/deploy.sh
```

The script refuses to run with uncommitted changes. It runs `pnpm typecheck` and `pnpm test` locally, exports exactly the commit that was `HEAD` (`git archive`), transfers it with rsync to `/opt/serain`, installs dependencies with the frozen lockfile, installs the root-owned sandbox helper and its units, builds the sandbox images (the first build compiles whisper.cpp and downloads the speech model and the Piper voices, which takes a while), installs Chromium for the browser and its AppArmor profile, and restarts the service, waiting up to five minutes if Serain is in the middle of a task. The deployed commit is in `/opt/serain/REVISION`.

Check that everything runs:

```bash
ssh root@<ip> 'systemctl is-active serain serain-sandbox.socket serain-watchdog.timer'
ssh root@<ip> 'journalctl -u serain -n 50 --no-pager'
```

Now text Serain "hi". It answers in the language you wrote in. Part A is done.

---

## Part B: optional

Each section is independent unless it says otherwise. After connecting anything, restart the service (`ssh root@<ip> 'systemctl restart serain'`): credentials are read at startup.

### B1. Integration key

Mail, Google and iCloud credentials are stored sealed in Supabase. The key exists only in the environment.

```bash
pnpm integration key
```

Put the printed line `SERAIN_INTEGRATION_KEY=...` into `.dev.vars` **and** `/etc/serain/serain.env`, the same value in both. The `pnpm integration` commands run on your machine (they may prompt for passwords and open a browser), write directly to Supabase and need your complete `.dev.vars`.

```bash
pnpm integration list
pnpm integration disconnect <id>     # deletes the credential and everything Serain remembered from it
```

Disconnecting takes effect immediately: the running service stops using the credential at once. Restart it so the tools disappear from the model's list as well.

### B2. IMAP mailboxes

Any mailbox with IMAP and SMTP works. Create an app-specific password with your provider if it uses two-factor sign-in (never your login password), then connect with one of the presets:

```bash
pnpm integration connect <preset>    # e.g. gmx; run without a known preset to list them
```

The password is typed hidden, checked against IMAP and SMTP, and stored only sealed. The first mailbox you connect is the default for sending.

### B3. Serain's own mailbox

Optionally Serain gets an address of its own. Mail from there goes out as "Serain", never in your name, and only when Serain explicitly uses that account; it has its own standing approvals and is never cleaned up.

```bash
pnpm integration connect serain
```

### B4. Google (Gmail and Calendar)

Every user needs their own OAuth app. It stays in testing mode: publishing an app with Gmail scopes requires Google's verification and a CASA security assessment.

1. Open the [Google Cloud Console](https://console.cloud.google.com) and create a project (for example "Serain").
2. **APIs & Services > Library**: enable the **Gmail API** and the **Google Calendar API**.
3. **Google Auth Platform** (formerly "OAuth consent screen"):
   - App name "Serain", your email as support and developer contact.
   - Audience: **External**. If you use Google Workspace and the mailbox belongs to your Workspace, choose **Internal** instead: then tokens do not expire weekly.
   - Data access: add the scopes Serain requests:
     - `https://www.googleapis.com/auth/gmail.modify` (read, labels, trash and spam folder; cannot delete permanently)
     - `https://www.googleapis.com/auth/gmail.send`
     - `https://www.googleapis.com/auth/calendar.events`
   - Test users (External only): add your own Google address.
   - Leave the publishing status on **Testing**.
4. **Clients > Create client**, type **Desktop app**. Copy the client ID and secret into `.dev.vars` (only there, never on the server):

   ```ini
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

5. Connect:

   ```bash
   pnpm integration connect google
   ```

   A local callback opens on `127.0.0.1` and your browser shows Google's consent page (on Linux, open the printed URL yourself). Google warns that the app is unverified: continue, and grant **all** requested permissions, otherwise nothing is stored. Then restart the service.

**Weekly reconnect:** in testing mode Google expires the refresh token after 7 days. When Gmail or Google Calendar stop working, run `pnpm integration connect google` again and restart the service.

If iCloud Calendar is connected too, Serain uses iCloud for the calendar and Google only for Gmail.

### B5. iCloud Calendar

1. Two-factor authentication must be on for your Apple Account.
2. At [account.apple.com](https://account.apple.com) > Sign-In and Security > **App-Specific Passwords**, create one named "Serain". You can revoke it there at any time.
3. Connect:

   ```bash
   pnpm integration connect icloud
   ```

   Enter your Apple Account email and the app-specific password (never your Apple Account password). The script lists your calendars and asks for the default; Serain still picks the most fitting calendar per event. Restart the service.

Serain never invites guests through iCloud.

### B6. OpenRouter, web search, browser pilot, videos

All of these are single variables in `.dev.vars` and `/etc/serain/serain.env`, followed by a restart.

| Variable | Where to get it | Unlocks |
|---|---|---|
| `OPENROUTER_API_KEY` | [openrouter.ai](https://openrouter.ai) > Keys. Set a monthly limit on the key. | Fallback model, embeddings for semantic memory search, video analysis (Gemini), a hosted voice for spoken replies (only for languages listed in `SPEECH.voices` in `src/config/models.ts`; otherwise the local voice speaks), image fallback |
| `TAVILY_API_KEY` | [tavily.com](https://tavily.com) | The `web_search` tool |
| `TYPESAFE_API_KEY` and `SERAIN_CHROME_PATH=/usr/local/bin/serain-chromium` | Typesafe | The browser pilot `web_browse` (only public pages go to Typesafe) |
| `SERAIN_MEDIA_DOWNLOAD=1` | Your own decision, see README "Legal" | Downloading TikTok, Instagram and X videos with yt-dlp in the sandbox. Needs `OPENROUTER_API_KEY`. |

Videos from YouTube need only `OPENROUTER_API_KEY`: they are fetched by Google AI Studio (no zero data retention; the request carries only the URL and a fixed instruction). Without `SERAIN_MEDIA_DOWNLOAD=1` nothing is downloaded.

yt-dlp is pinned with a checksum in `deploy/sandbox/Dockerfile`. When TikTok, Instagram or X downloads suddenly fail for videos that play in a browser, a new yt-dlp release is usually needed: update version and checksum there and deploy.

### B7. Web interface

The web interface shows the audit log, lets you edit memory, holds the vault (logins for logged-in sessions, and files) and manages connections. It runs as a Cloudflare Worker behind Cloudflare Access, talks to Postgres as the restricted role `serain_web` through Hyperdrive, and you sign in with a passkey. Access is never optional: the Worker verifies the Access token itself and refuses to serve without it.

You need a Cloudflare account (free), a domain whose DNS is on Cloudflare, and a Supabase personal access token.

1. **Zero Trust:** in the Cloudflare dashboard open Zero Trust once, choose the Free plan and a team name.
2. **API token:** My Profile > API Tokens > Create Custom Token, with these permissions:
   - Account: Workers Scripts Edit, Hyperdrive Edit, Access: Apps and Policies Edit, Access: Organizations, Identity Providers, and Groups Edit, SSL and Certificates Edit, Account Settings Read
   - Zone (your domain): Workers Routes Edit, DNS Edit, Zone Read
   - User: User Details Read, Memberships Read
3. **Supabase access token:** supabase.com > Account > Access Tokens.
4. **`.dev.vars`:**

   ```ini
   SERAIN_WEB_ORIGIN=https://serain.example.com
   CLOUDFLARE_API_TOKEN=...
   CLOUDFLARE_ACCOUNT_ID=...
   WEB_ACCESS_EMAIL=you@example.com     # the only address Access lets in (one-time code by email)
   SUPABASE_ACCESS_TOKEN=...
   ```

   Also put `SERAIN_WEB_ORIGIN` into `/etc/serain/serain.env`.
5. **Keys and database role:**

   ```bash
   pnpm web vault-key       # vault key pair: private part -> .dev.vars, public part -> web/wrangler.toml
   pnpm web db-password     # password of role serain_web -> web/.dev.vars
   ```

   `pnpm web vault-key` creates `web/wrangler.toml` from the template `web/wrangler.toml.example` if it is missing. That file belongs to your instance and is gitignored; nothing in it is edited by hand. `pnpm web db-password` needs `SUPABASE_ACCESS_TOKEN` (on macOS it may live in the keychain instead, see [web/README.md](../web/README.md)).

   Copy `SERAIN_VAULT_KEY` from `.dev.vars` into `/etc/serain/serain.env`. If the private key is ever lost, every vault entry is unreadable: create a new pair and add the entries again.
6. **Cloudflare setup and deploy:**

   ```bash
   pnpm web:setup           # Supabase CA, Hyperdrive, Access app and policy; idempotent; writes domain, team, AUD and Hyperdrive ID into web/wrangler.toml
   pnpm web:deploy          # checks Access, builds, deploys, then verifies from outside that nothing is reachable without Access
   pnpm web enroll https://serain.example.com   # one-time link, valid 15 minutes: open it and create a passkey
   ```

   `pnpm web:check` only verifies, without changing anything. After `pnpm web db-password`, run `pnpm web:setup` again so Hyperdrive gets the new password.
7. Restart the service so it picks up `SERAIN_VAULT_KEY` and `SERAIN_WEB_ORIGIN`, and deploy once if you changed code.

`pnpm web:deploy` deploys only committed code: in a git checkout it refuses while `web/`, `src/vault/`, `src/files/` or `src/connectors/catalog.ts` have uncommitted changes. `web/wrangler.toml` is not part of that check; if you lose it, `pnpm web vault-key` and `pnpm web:setup` write it again.

Locally, `pnpm web:dev` serves the interface on http://localhost:8787 through a verified tunnel to the database; passkeys created there do not work on your domain. `pnpm web passkeys` lists passkeys, `pnpm web revoke <id-prefix>` removes one and ends its sessions. More detail: [web/README.md](../web/README.md).

### B8. Connections: bank and COROS

Connections live in the web interface's **Connections** tab and need B1 (integration key) and B7 (web interface with `SERAIN_VAULT_KEY`). The browser starts a connection, the server completes it, tokens are stored only sealed. Everything is read-only.

**COROS:** click Connect in the tab and sign in with COROS. Serain then reads sleep, HRV, recovery, training load and activities.

**Bank (Enable Banking):** only for your own accounts, non-commercial.

1. Register at [enablebanking.com](https://enablebanking.com) and create an application in the control panel for restricted production use with your own accounts. Redirect URL: `https://serain.example.com/connections/callback` (your `SERAIN_WEB_ORIGIN`). The form also asks for a privacy policy URL and a terms of service URL; they are shown only to the account holder, which is you. Use your own privacy notice if you have one, otherwise the README's [legal section](../README.md#legal), and for the terms the README's [disclaimer](../README.md#disclaimer) (the license and its warranty exclusion are the terms Serain comes with). The control panel downloads a private key file named after the app ID.
2. Import the key, then find your bank's exact name:

   ```bash
   pnpm connector bank-key <app-id>.pem     # writes ENABLE_BANKING_APP_ID and ENABLE_BANKING_KEY into .dev.vars
   pnpm connector bank-check <search term>  # lists matching banks in ENABLE_BANKING_COUNTRY (default DE)
   ```

   Put the exact name into `.dev.vars` as `ENABLE_BANKING_BANK` (and `ENABLE_BANKING_COUNTRY` if your bank is not in Germany), then run `pnpm connector bank-check` without an argument to confirm it.
3. Copy `ENABLE_BANKING_APP_ID`, `ENABLE_BANKING_KEY`, `ENABLE_BANKING_BANK` and `ENABLE_BANKING_COUNTRY` into `/etc/serain/serain.env`, restart, then connect your bank in the tab. You approve access in your bank's app; the approval expires after the period your bank allows (often 180 days); then connect again in the tab.

### B9. Mac companion

The companion runs on your Mac and gives Serain read access to Apple Calendar, Reminders and Contacts, plus a headless Chrome that renders public pages from your home connection. It is reachable only while the Mac is awake, through an SSH reverse tunnel to loopback on the server; no port is opened anywhere.

Requirements: macOS, Xcode Command Line Tools (`xcode-select --install`, for `swiftc` and `codesign`), Node 22, pnpm, and `SERAIN_HOST` in `.dev.vars`.

```bash
./companion/install.sh      # install or update, idempotent
```

It exports the current commit, builds the Swift helper, creates a token and an SSH key used only for the tunnel, creates a server user `serain-companion` that may do nothing but that one forward, writes `SERAIN_COMPANION_PORT` and `SERAIN_COMPANION_TOKEN` into `/etc/serain/serain.env`, restarts the service, installs two launchd agents and asks for the macOS permissions for Calendar, Reminders and Contacts. `./companion/uninstall.sh` removes everything again, including the server side. More detail: [companion/README.md](../companion/README.md).

### B10. Healthchecks.io

The watchdog on the server cannot report a server that is down, and Serain cannot report a broken channel through that channel. A dead man's switch outside both covers this.

1. Create a free account at [healthchecks.io](https://healthchecks.io) and a check with period **5 minutes** and grace **10 minutes**.
2. Put the ping URL into `/etc/serain/serain.env` (and `.dev.vars`) as `HEALTHCHECKS_PING_URL`. It contains a secret UUID: never commit or share it.
3. Set up notifications (email, push) in the Healthchecks.io dashboard and restart Serain.

Serain pings after every heartbeat when process, channel, database and delivery are healthy, and pings `/fail` otherwise. If the pings stop, Healthchecks.io alerts you.

### B11. Base knowledge about you

Serain learns about you from the chat, but a short base text saves weeks of questions. `data.example/` holds a template with an invented owner: `user-model.md` (free text, any language) and `facts.json` (single facts with category, confidence and optional kind and validity).

```bash
cp -r data.example data       # data/ is gitignored and never deployed
# write about yourself in data/user-model.md and data/facts.json
pnpm memory:push              # shows what would change
pnpm memory:push --apply      # writes it into Supabase
```

Pushing is additive: facts that disappeared from the file are reported, not deleted. Later corrections happen in the chat or in the web interface's memory tab.

---

## Part C: operations

### C1. Operations

```bash
ssh root@<ip> 'systemctl status serain'
ssh root@<ip> 'journalctl -u serain -f'                   # live log
ssh root@<ip> 'systemctl restart serain'
ssh root@<ip> 'journalctl -u serain-sandbox -n 30 --no-pager'
ssh root@<ip> 'journalctl -u serain-watchdog -n 30 --no-pager'
ssh root@<ip> 'cat /opt/serain/REVISION'                  # deployed commit
```

The service runs as `serain` with `Restart=always` and survives crashes and reboots. A heartbeat writes component health every five minutes; a separate watchdog timer opens incidents when the service stops or the heartbeat goes stale; when a component recovers, Serain tells you over iMessage.

**Kill switch:** text `serain stop` (in any language). All tools are locked, pending approvals included, until you text `serain resume` (or `serain weiter`). `serain revoke` withdraws all standing approvals. The state lives in the database, so restarts do not lift it.

**Audit log:** every tool call, approval and outbound message is in the table `audit_log` (append-only), visible in the Supabase table editor or in the web interface.

**Backups:** take your own backups, for example `pg_dump` over the session pooler. The sealed credentials are useless without `SERAIN_INTEGRATION_KEY` and `SERAIN_VAULT_KEY`; keep those somewhere safe as well.

**Rotating secrets:** `pnpm db:password` for `serain_server`, `pnpm web db-password` plus `pnpm web:setup` for `serain_web`; API keys by replacing them in both files and restarting.

### C2. Updating

```bash
git pull                     # or merge upstream into your fork
pnpm install
```

Apply only the migrations that are new since your last update, in order, exactly as in A3. Then deploy:

```bash
./deploy/deploy.sh
```

If the web interface changed, also run `pnpm web:deploy`. If the companion changed, rerun `./companion/install.sh`.

### C3. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Anything, before you dig in | `pnpm setup:check` checks every step of part A and names the first one that is off. |
| Service exits at startup naming a missing `Env` variable | A required variable is not set in `/etc/serain/serain.env`. `pnpm setup:check` lists what is missing on the server and what differs from `.dev.vars`. |
| Messages from Serain fail with "Target not allowed" | A shared Photon line may only write after you wrote to it. Text the number once. Also after Photon changes the number. |
| You get every answer twice | Two processes are connected to Photon (usually `pnpm dev` locally while the server runs). Stop one. |
| Service exits right after start, log says Photon rejects the credentials | Wrong or revoked `PHOTON_PROJECT_ID`/`PHOTON_PROJECT_SECRET`. Serain exits on purpose instead of retrying forever. |
| Messages arrive in the log but are ignored | The sender is not exactly `OWNER_PHONE` (E.164, with country code), or the message came from a group. |
| Serain stays silent, the log shows `kill_switch` | The kill switch is engaged: text `serain resume`. If the log says the state was unreadable, Serain locked itself because the database was unreachable; fix the database connection first. |
| `pnpm db:password` cannot connect | Use the session pooler host (port 5432), not the IPv6-only direct host; check `SUPABASE_DB_PASSWORD`. |
| A migration fails | The loop stops at the first error. Fix the cause and continue from that file; never rerun files that were already applied. |
| `deploy.sh` refuses to run | Uncommitted changes. Commit or stash them. It also aborts if `HEAD` changes during the tests. |
| A new integration is ignored | Credentials are read at startup: `systemctl restart serain`. |
| Google stops working after a week | Testing mode expires refresh tokens after 7 days: `pnpm integration connect google`, restart. |
| `web_browse` fails with a Chromium sandbox error | The AppArmor profile `deploy/apparmor/serain-chromium` is missing or not loaded (`deploy.sh` loads it). Never work around it with `--no-sandbox`. |
| `media_watch` fails for TikTok, Instagram or X | `SERAIN_MEDIA_DOWNLOAD` is not `1`, or yt-dlp needs an update (B6). |
| `pnpm web:deploy` refuses | The Access app is missing, its policy allows more than `WEB_ACCESS_EMAIL`, `web/wrangler.toml` does not match the account or `SERAIN_WEB_ORIGIN`, or the web interface code has uncommitted changes. Run `pnpm web:setup`, commit your code changes, retry. |
| Web interface says it is preparing a connection forever | `SERAIN_INTEGRATION_KEY` or `SERAIN_VAULT_KEY` is missing on the server. |
| Replies are slow right after a deploy | The pre-warmed model processes start with the service; the first reply after a restart takes longer. |

When in doubt: read the log (`journalctl -u serain`) and the `audit_log` table before changing anything.
