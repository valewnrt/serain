# Serain web interface

Audit, Memory, Vault, Connections. One user, sign-in by passkey only. Decision and security model: D49 in `docs/ARCHITECTURE.md`. The web interface is optional; Serain runs without it.

All commands run on your own machine in the repo, never on the server. They need `.dev.vars` with the server's credentials (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `OWNER_NAME`, …) and, for the database role, a Supabase management token: `SUPABASE_ACCESS_TOKEN` in `.dev.vars` or, on macOS, in the keychain (`security add-generic-password -s supabase-serain -a "$USER" -w`).

## Configuration: `web/wrangler.toml`

This file belongs to each instance and is gitignored. The repo holds the template `web/wrangler.toml.example`. `pnpm web vault-key` creates `web/wrangler.toml` from it if it is missing and fills in the public vault key and the time zone (`OWNER_TIMEZONE`); `pnpm web:setup` adds domain, Access and Hyperdrive for production. Nothing has to be entered by hand.

## Local

Once:

```bash
pnpm web vault-key      # vault key pair: private → .dev.vars, public → web/wrangler.toml
pnpm web db-password    # password of the serain_web role → web/.dev.vars (DATABASE_URL, DATABASE_UPSTREAM)
```

Start and set up a passkey:

```bash
pnpm web:dev            # http://localhost:8787, with database tunnel (TLS verified against the Supabase CA)
pnpm web enroll         # one-time link, 15 minutes, open in the browser, Touch ID or similar
```

More: `pnpm web passkeys`, `pnpm web revoke <id-prefix>` (the passkey's sessions end immediately).

## Testing

```bash
pnpm web:e2e            # real Worker, real Chrome, virtual passkey, throwaway database
```

Never against Supabase: the audit log is append-only, every test run would stay there forever. The run needs neither `.dev.vars` nor `web/wrangler.toml` (it uses the template), but it does need Chrome or Chromium (`SERAIN_CHROME_PATH`, otherwise the usual locations on macOS and Linux) and internet access for a public demo login page. With `SERAIN_E2E_SHOTS=<folder>` it saves screenshots.

## Letting Serain use the vault

On the server, put `SERAIN_VAULT_KEY` (the same value as in `.dev.vars`) into `/etc/serain/serain.env`, then deploy. Without it there is no `run_site_task`. If the private key is lost, all entries are worthless: generate a new pair and create the entries again.

## Connections (D51)

The tab starts the flow, the server completes it; for that it needs `SERAIN_INTEGRATION_KEY` and `SERAIN_VAULT_KEY`. The provider sends the owner back to `<origin>/connections/callback`; only `http://localhost:8787` and `SERAIN_WEB_ORIGIN` are allowed (`webOrigins` in `src/connectors/catalog.ts`). The bank only knows `<SERAIN_WEB_ORIGIN>/connections/callback`; locally, you paste the address into the dialog after approving. Once for the bank: create an app at Enable Banking (Restricted Production, redirect URL as above), then `pnpm connector bank-key <file.pem>` and `pnpm connector bank-check`.

## Your own domain (Cloudflare)

Cloudflare Access sits in front of the Worker (only the one email address from `WEB_ACCESS_EMAIL`, one-time code by email). The Worker checks the Access token itself once more (`web/src/access.ts`) and responds with 403 without a valid token, and with 503 without an Access configuration. The database is reached via Hyperdrive: pooler in session mode, TLS `verify-full` against `web/supabase-ca-2021.crt`, no cache. The Worker does not accept a database address on the network without Hyperdrive.

You need your own domain whose zone is in your Cloudflare account (Workers, Access up to 50 users and Hyperdrive are free). The web interface can run on the domain itself or on a subdomain, e.g. `https://serain.example.com`.

Once:

1. Cloudflare API token (My Profile > API Tokens > Custom Token). Account: Workers Scripts Edit, Hyperdrive Edit, Access: Apps and Policies Edit, Access: Organizations, Identity Providers, and Groups Edit, SSL and Certificates Edit, Account Settings Read, Account Analytics Read (only for `pnpm site:stats`). Zone (your own): Workers Routes Edit, DNS Edit, Zone Read. User: User Details Read, Memberships Read.
2. In `.dev.vars`: `SERAIN_WEB_ORIGIN` (e.g. `https://serain.example.com`, without a path), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WEB_ACCESS_EMAIL` (the address for the one-time code). `SERAIN_WEB_ORIGIN` also goes into `/etc/serain/serain.env`: the server builds redirect URLs and links from it.
3. Enable Zero Trust once in the dashboard (Free plan, choose a team name).
4. `pnpm web vault-key` and `pnpm web db-password` as above, if not done yet.

Then:

```bash
pnpm web:setup          # Supabase CA, Hyperdrive, Access with its policy; idempotent, writes domain, team, AUD and Hyperdrive ID into web/wrangler.toml
pnpm web:check          # check only: Access policy, team, AUD, domain, Hyperdrive ID match; changes nothing
pnpm web:deploy         # checks Access, builds, deploys, checks from outside that nothing gets through without Access
pnpm web enroll https://serain.example.com   # set up the passkey there again; the ones from localhost do not apply
```

**Moving to another domain** (say from `https://example.com` to `https://app.example.com`): change `SERAIN_WEB_ORIGIN` in `.dev.vars` and `/etc/serain/serain.env`, restart the service, then `pnpm web:setup` moves the Access application named Serain to the new host instead of adding a second one, and `pnpm web:deploy` moves the Worker. Passkeys are bound to the host: enroll again with `pnpm web enroll <new origin>` and remove the old ones with `pnpm web revoke`. A provider with a fixed return address (the bank, D51) needs `<new origin>/connections/callback` registered with it.

`web:deploy` refuses as long as the Access application is missing, its policy allows more than exactly `WEB_ACCESS_EMAIL`, `web/wrangler.toml` does not match the account or `SERAIN_WEB_ORIGIN`, or (in a Git checkout) the web interface has uncommitted changes. After `pnpm web db-password`, run `pnpm web:setup` once, otherwise Hyperdrive keeps the old password.
