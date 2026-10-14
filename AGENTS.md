# Serain: guide for agents and contributors

This file is read by coding agents (Codex, Cursor and others read `AGENTS.md`; Claude Code reads it through `CLAUDE.md`) and by human contributors. Two kinds of work happen in this repository:

- **Setting Serain up for someone** (you are helping your user run their own instance): read the next section, then follow [docs/SETUP.md](docs/SETUP.md).
- **Working on Serain's code**: skip to [Working rules](#working-rules).

## Setting Serain up for your user

Serain is self-hosted: your user brings every account and key, and the instance belongs to them alone. [docs/SETUP.md](docs/SETUP.md) is the only setup guide, in dependency order (Part A required, Part B optional). Do not invent shortcuts around it.

**Work in a loop with `pnpm setup:check`.** It checks every step of the guide (tools, `.dev.vars`, Supabase, Claude, server, secrets on the server, deployment, optional features), changes nothing, and names the next step with its section of the guide. `pnpm setup:check --json` gives you `next` (the first failing check, with `fix` and `guide`) and every check with a stable `id`. Run it, do the next step or hand it to your user, run it again. `--offline` skips SSH, database and network. It never connects to Photon and never calls a model.

**Secrets never pass through you.**

- Your user enters every key, token and password into `.dev.vars` (gitignored, `chmod 600`) themselves, in their editor. Never ask them to paste a secret into the chat, and never print, `cat`, `grep` or summarise `.dev.vars` or `/etc/serain/serain.env`. `pnpm setup:check` tells you which names are set, never their values.
- When a command needs a secret (the `psql` loop in A3, copying the server env in A7), read it inside the command from `.dev.vars` so its value never appears in your output.
- The variables in the "Local only" section of `.env.example` never go to the server. `pnpm setup:check` fails if they do.

**Only your user can do these**, so stop and ask them, saying exactly what to do and where:

- creating accounts and accepting terms (Supabase, Photon, Anthropic, the server provider), anything with a credit card, and spend limits in the Anthropic Console
- copying keys from dashboards into `.dev.vars`
- everything on their Apple device: saving the Photon number, texting it first (A4), the echo test (A8) and the first message (A9)
- OAuth consent (Google, B4), Cloudflare Access codes, passkeys for the web interface (B7)

**Ask before** provisioning or changing the server, deploying, applying migrations and anything that costs money. Never weaken the security setup to make a step pass: the ingress allowlist, the kill switch, Cloudflare Access, the sandbox and the systemd hardening are never optional, not even "just for testing" (see below).

Setup is done when `pnpm setup:check` reports no failures and your user has texted Serain and got an answer.

## Working rules

Serain is a personal AI agent for exactly one owner, whose only interface is iMessage, and it runs 24/7 on the owner's own server. It is a self-hosted project built like a product. Start with [README.md](README.md), then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (architecture, decisions `D1`, `D2`, ..., rejected alternatives) and [docs/SETUP.md](docs/SETUP.md).

### Priorities (in this order)

1. **Security.** The agent sends mail and will eventually spend money. Check every change against D8 (security levels) in ARCHITECTURE.md. No tool of level `irreversible` or `money` without the confirmation protocol. The ingress allowlist and the kill switch are never optional, not even "just for testing".
2. **Style.** Serain writes like a friend, not like ChatGPT: short, natural, in the owner's language, no filler phrases, no dashes as punctuation, a tapback instead of a message when that is enough. The style prompt is its own piece of work with an eval (`pnpm eval`); never change it in passing.
3. **Autonomy.** Serain should know what the owner would do. It asks only when a wrong assumption is expensive. The memory (user model, facts with provenance) exists for that.

### Language

- Serain replies in the language the owner writes in, any language. `OWNER_LANGUAGE` (default `en`) is only the starting language until Serain has detected it from the owner's messages (`src/i18n/language.ts`, stored in `agent_state`). Developer guide: [src/i18n/README.md](src/i18n/README.md); overview: chapter 8 of ARCHITECTURE.md.
- Fixed texts to the owner past the model (previews, confirmations, kill switch, health, budget) go through the catalog (`t()`, `src/i18n/messages/<module>.ts`), always with English **and** German; other languages are translated once by the model, checked line by line and cached. Content (recipients, mail text, amounts, names) is a placeholder and stays verbatim.
- Words the code reads (`yes`/`no`/`always`, `serain stop`/`resume`/`revoke`) live in `src/i18n/messages/words.ts`: the union of English, German and the current language is accepted, a word that is both yes and no counts as no, 👍/👎 work in every language. Changing them is a security change (D8).
- Language-dependent safety heuristics keep word lists for `en` and `de` and are fail closed in every other language (always the preview).
- Never hard-code user-facing text in a single language, never hard-code the owner's name (`owner.name`, `owner.possessive`, `owner.genitive` from `src/config/owner.ts`), the time zone (`OWNER_TIMEZONE` from `src/time.ts`), a place or a domain. Dates and numbers through `Intl` with `currentLocale()`.
- Prompts, prompt tags (`<context>`, `<untrusted source="…">`, `<addendum>`, …), tool descriptions, docs, code comments and commit messages are English.
- Tests and evals use the invented owner "Alex", set in `vitest.config.ts` and `eval/persona.ts`.

### Security rules

- **Tool levels** (`read`, `write_reversible`, `irreversible`, `money`) are declared per tool. The registry refuses `irreversible` and `money` without a `ConfirmSpec`. Keep it fail closed.
- **Previews** are built by the tool's code from validated arguments, never from model text. They ask the question themselves, short, names instead of addresses where the address decides nothing (`senderLabel` in `src/mail/brand.ts`, never from the model, never the display name). Lists of two or more items go one per line with "•" (`bulleted`, `src/text/list.ts`). Below that only the way back and, where allowed, "yes, always". What matters (recipients and text of a mail, unsubscribe mails to strangers, spam senders with address, form fields) stays in.
- **Skipping a preview** only when the owner named the exact action in their own words and the code can prove it (`namedByOwner`, only `irreversible`, never `money`, only in turns the owner started). It is logged as `approval_waived`.
- **Untrusted content** (mail, web, calendar, Apple data, connected services) comes from tools marked `returnsUntrusted`; private results (`privateResult`) never reach the audit log. Writing to connected services only with `ownerOriginOnly` and `cleanTurnOnly`. Calendar titles of other events never go unframed into a prompt, only times.
- **Links** to the owner only to pages a tool with `opensPages` opened in this task, without tracking parameters (`linkPreviews` in the registry). A new tool that opens pages needs a classification and belongs in `test/fuzz/link-previews.test.ts`.
- **Secrets** never in prompts, logs or tool results that reach the model. Child processes get `childEnv()` (allowlist). New secret env values are registered with `redactValue`.
- **Sandbox:** the service never starts a container itself; only the root-owned helper does, always without network. Never weaken the systemd hardening, never run Chromium with `--no-sandbox`.
- **Bot protection** is detected, never bypassed. No logins on video platforms, no CAPTCHA solving.

### How we work

- **Right the first time.** No workarounds, no band-aids. Propose the structural fix; a patch only when stated as such, with a pointer to the real fix.
- **Know, don't guess.** On errors read the logs (journal, `audit_log`, Supabase) and reproduce first, then fix.
- **"Done" means tested in the running system**, not just typechecked. For channel changes: a real iMessage sent and the answer seen. If something cannot be tested, say so explicitly.
- **No half-finished implementations.** No dead branches, no "TODO later" markers.
- **Scope discipline.** A bug fix is not an invitation to refactor.

### Tests and fuzzing (D53)

- `pnpm typecheck` (server, worker, client) and `pnpm test` must be green before every commit.
- Fuzz tests live in `test/fuzz/`, run in `pnpm test` with a fixed seed, and `pnpm fuzz` runs 2,000 cases. They are generic over `connectorDrivers` and all tool factories: a new service goes into `src/connectors/drivers/index.ts`, never directly into the runtime.
- Every tool call has a time limit (`TOOL_TIMEOUT_MS`, or `timeoutMs` on the tool).
- Never weaken or delete a test because it is red.
- Tests never reach real services: `vitest.config.ts` sets dummy credentials. `pnpm web:e2e` uses a throwaway database, never Supabase (the audit log is append-only).
- Changes to prompts, style, models or thinking per role need an eval before and after: `pnpm eval` (suites `chat`, `tools`, `dates`, `judge`), `pnpm eval:memory`, `pnpm eval:mail`. Evals play the fixed persona "Alex" (`eval/persona.ts`), call real models and cost money; every run has a hard cap (`--cap`).

### Git

- Conventional Commits with an English subject, e.g. `feat(memory): store facts with provenance`. The body explains why.
- AI agents: never push, open pull requests or add remotes unless the human asks.
- Before every commit check the diff for secrets, phone numbers, addresses, names of third parties and real chat content. They belong in `.dev.vars` (gitignored) or in the database, never in the repository.
- The pre-commit hook runs gitleaks plus a literal comparison with the values in `.dev.vars` (`scripts/secret-scan.ts`). Enable it once per checkout: `git config core.hooksPath .githooks`. Names of third parties and chat content still need a manual check.
- Migrations in `supabase/migrations/` are additive and run against PGlite in `test/migrations.test.ts` before anyone applies them.

### Project setup

- Node 22, pnpm, TypeScript strict, tsx. `pnpm typecheck`, `pnpm test`, `pnpm dev`. `pnpm setup:check` shows where an instance's setup stands; a new setup step, a new required variable or a new local-only variable needs its check there (`scripts/setup-check.ts`, which reads `.env.example`).
- A long-lived Node process under systemd (user `serain`, Docker for the sandbox) on a Linux VM, rolled out with `./deploy/deploy.sh` (a commit, never the working directory). Details in `deploy/README.md`.
- Supabase Postgres. Recurring work (scheduler, pollers, heartbeat) runs over Postgres as role `serain_server` (`src/db/pg.ts`), never over PostgREST: every REST request costs egress and log quota on the Free plan. Every wait loop against Supabase has a time limit.
- Models: Claude through the Claude Agent SDK (`ANTHROPIC_API_KEY` by default, billed and capped by `SERAIN_API_BUDGET_USD`; or the owner's own `CLAUDE_CODE_OAUTH_TOKEN`; the key wins if both are set), fallback OpenRouter. The model per role lives in `src/config/models.ts`, nowhere else. Only zero-data-retention providers on OpenRouter; the single named exception is YouTube via Google AI Studio (`YOUTUBE_PROVIDER_POLICY`), with only the URL and a fixed instruction. Never vendor the Agent SDK.
- Hard limits (budgets, rate limits, timeouts) live in `src/config/limits.ts`. Who the owner is (name, time zone, country, region, city, starting language, web origin) lives in `src/config/owner.ts`, secrets in `src/config/env.ts`; every variable is documented in `.env.example`.
- No new paid service without the maintainer's explicit OK.

### Runtime rules worth knowing

- **Response time (D50):** pre-warmed Agent SDK processes (`prewarmTurn`, slots `chat`, `executor`, `task_result`), a 1-second window that late messages can supersede (tools with effects commit the turn, `repeatable` only for pure read tools), events without a window. Where the time goes is recorded per turn in `model_call.detail.latency` (`reply` is what the owner experiences). Thinking per role in `src/config/models.ts`, changed only after an eval.
- **Steering (D57):** if the owner writes into a committed turn, the registry attaches the message as `<addendum>` to the next tool result; it counts only once the model has responded to it (`noteResponse`), and the turn does not end before that. After untrusted content a turn accepts nothing more. Whatever it did not see runs right after as its own turn.
- **Crashes (D52):** the owner's message stays `pending` (`messages.turn_status`) until its turn is done; tasks live in `tasks`. On startup open work is resumed (with a note on what was already done); aborted tasks and running confirmations are reported, never silently repeated. A turn that failed without effect (`TurnProgress.committed`) runs once more after 5 minutes, also across restarts (`turn_retry` in the audit log); likewise if its answer did not (fully) arrive (`TurnProgress.undelivered`). Any new path that settles a message without a turn must call `settleInbound`.
- **Tapbacks:** the model names a signal, the code picks the emoji (`src/channel/signals.ts`): `ok` 👍, `love` ❤️, `haha` 😂, `scheduled` ⏰, `watching` 👀; only the code sets `working` 🔍, `done` ✅, `failed` ❌. Values to copy go out via `copy` on the message tools as their own bubble. New signals and fixed texts to the owner are a style decision.
- **Channel:** `Channel` interface in `src/channel/`, adapter `photon` (Spectrum SDK, outbound gRPC stream). Bold, italic, strikethrough, effects and `edit_message`; only messages sent by the message tools can be edited, never a preview. Texts go through Photon's SDK with a `clientMessageId` and are retried once after an `[upstream]` abort, without duplicates. Only one process may be connected to Photon at a time.
- **Integrations:** credentials are sealed in `integrations` with `SERAIN_INTEGRATION_KEY` (env only), connected on the owner's machine with `pnpm integration connect ...`. Mail and calendar belong to the chat model and are `returnsUntrusted`. Cleanup (D37) moves to trash or the spam folder, unsubscribes via header or a link the code picks (never from the spam folder), only after a preview, and never deletes permanently; the keep list is enforced in code. Attachments open only in the sandbox.
- **Videos (D61):** `media_watch` belongs to the executor. YouTube via Google AI Studio by URL; TikTok, Instagram and X only with `SERAIN_MEDIA_DOWNLOAD=1`, downloaded by yt-dlp in the sandbox through a filter proxy, shrunk by ffmpeg without network.
- **Sources and screenshots:** link previews and screenshots only as described above; screenshots only when the owner asks, kept in memory only, and in logged-in sessions `screenshotBlocker` blocks what it recognises as credentials.
- **Instance (D64):** what only one owner needs (own services, own mail rules) lives in `instance/` (gitignored, usually a symlink into the owner's private repository), never in tracked files. Instance files import only types from the core (`@serain/…`). Guide: `docs/INSTANCE.md`. Tests that check the core's own catalog or rules mock `@instance/…` empty.
- **Connections (D51):** catalog in `src/connectors/catalog.ts`, one driver per service in `src/connectors/drivers/`. Tools, levels and descriptions are ours, never the provider's. Results are `returnsUntrusted` and `privateResult`.
- **Playbooks (D56):** built-in procedures (`src/agent/playbooks.ts`) enter the `<context>` by keyword, never the system prompt; security rules never live in them. Sign-in codes for logged-in sessions are intercepted in `onInbound` before storage (`src/sites/codes.ts`); the model never sees them.
- **Web interface (D49):** Cloudflare Worker in `web/`, Access is never optional and the Worker verifies the token itself; database only via Hyperdrive or loopback, as role `serain_web`, never with the secret key. The vault is sealed in the browser to the server's public key; only the server (`SERAIN_VAULT_KEY`) can open it. What appears in the audit tab is decided by the view `web_audit`. Monochrome, light only, serif font only for the logo.
- **Mac companion (D28):** `companion/`, read-only Apple data plus a headless Chrome behind a filter proxy, reachable only through an SSH reverse tunnel to loopback. Apple data belongs to the chat model and is `returnsUntrusted`; the executor only gets `mac_browser`. Every capability must also work from the server alone; the companion is an addition, never a requirement.
