# Serain

**A personal AI agent you text over iMessage.** One owner, self-hosted, running 24/7 on your own server. Serain writes like a friend, not like a chatbot: short, natural, in your language, a tapback instead of a message when that is enough.

[serain.si](https://serain.si) · [Connectors](https://serain.si/connectors/) · [Deutsche Fassung: README.de.md](README.de.md)

> Serain is a private project built with the care of a product. It is not a hosted service, has no multi-user mode, and you bring every account and key yourself. Read [Legal](#legal) and [Costs](#costs) before you start.

## What Serain does

Serain answers in the language you write in: German in, German out; Turkish in, Turkish out. `OWNER_LANGUAGE` (default `en`) is only the starting point until Serain has seen your messages. Fixed texts such as previews and confirmation questions ship in English and German; for any other language they are translated once and cached. Content that matters, like the text and recipients of an email, is always shown verbatim. You confirm with 👍, whatever the language. Checks that read your words (a "yes" that confirms, a sender you named yourself) know English and German, plus the translated words of your current language where that is safe; in any other case Serain errs on the side of a preview.

Highlights:

- **Email cleanup with a preview.** Serain finds newsletters and spam senders across your mailbox, unsubscribes through the unsubscribe header (or the unsubscribe link, opened by the server's browser), moves mail to the trash or the spam folder, and first shows you one preview for the whole job. A keep list is enforced in code. Nothing is ever permanently deleted.
- **Mail that reads itself.** Reads every folder of your IMAP mailboxes and Gmail, opens PDF attachments in a sandbox, tells you about replies you are waiting for, deadlines and bookings it notices, and sends mail on your behalf only after you confirm the exact recipients and text.
- **Calendar.** iCloud (CalDAV) or Google Calendar: free slots, creating, moving and deleting events, recurring series, picking the right calendar per event.
- **Reminders and scheduled tasks.** "Remind me tomorrow at 8", "check the train every morning", watchers that report back when something changes.
- **Web research.** Search, page fetching, and a real browser on the server for pages that need one, with link previews of the sources it actually opened.
- **Videos.** Watches YouTube, and optionally TikTok, Instagram and X, with picture and sound (optional, see [Legal](#legal)).
- **Memory.** Facts with provenance, a compact model of you that is consolidated every night, and procedures it learns ("next time do it like this"). You can inspect and correct all of it.
- **Voice messages** in both directions: transcribed locally in the sandbox (the spoken language is detected), answered with a local voice in German, English, Spanish, French, Italian, Dutch, Polish, Portuguese, Russian or Turkish, otherwise in text.
- **Confirmation for everything with an effect.** See [Security model](#security-model).

Optional extras: a web interface (audit log, memory, a sealed vault for logins and files, connections), a Mac companion for Apple Calendar, Reminders and Contacts, a COROS watch, and read-only access to your own bank account.

## Architecture

Serain is a long-lived Node.js 22 process (TypeScript, strict) under systemd on a small Linux VM. iMessage arrives through [Photon](https://photon.codes) over an outbound gRPC stream, so the server opens no port except SSH. A chat model (Claude through the Claude Agent SDK, with pre-warmed processes for fast replies) talks to you and holds your personal data; an executor model does web research and browsing and never sees your mailbox or memory. Code runs in a Docker sandbox without network. State lives in Supabase Postgres: memory with pgvector, the append-only audit log, approvals, schedules and sealed credentials. The optional web interface is a Cloudflare Worker behind Cloudflare Access; the optional Mac companion is reachable only through an SSH reverse tunnel on loopback. Details and the reasoning behind each decision (the `D` numbers you will see in the code): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security model

Serain can send email and will eventually be allowed to spend money. Security is the first priority, ahead of style and autonomy.

- **Tool levels.** Every tool declares a level: `read`, `write_reversible`, `irreversible` or `money`. The tool registry refuses to register or run an `irreversible` or `money` tool without a confirmation spec. It fails closed.
- **Confirmation protocol.** Before an irreversible action, the tool's own code builds the preview from the validated arguments, never from model text. You see the exact recipients, text or senders, and the way back. Serain acts only after your 👍 (or a plain "yes"). Previews expire. Some tools allow a standing approval ("yes, always") for one exact target; `money` never does.
- **Ingress allowlist.** Only your phone number (`OWNER_PHONE`) reaches the model. Group chats and unknown senders are dropped before any model call and before any tool.
- **Kill switch.** Text `serain stop` and all tools are locked, including approvals that were still pending, until you text `serain resume`. `serain stop` works whatever language you write in (the German `serain stopp` and `serain weiter` work too, and so do the words of your current language). `serain revoke` withdraws every standing approval. The words are matched by code outside the model and the state is stored in the database, so a restart cannot lift it; if the state cannot be read, Serain locks itself.
- **Untrusted content.** Email, web pages, calendar entries and connected services are marked as untrusted. Once a turn has read untrusted content it accepts no new instructions from that content; writing to connected services is only allowed in clean turns you started, and links are only sent to pages a tool actually opened.
- **Audit log.** Every tool call, approval, kill switch event and outbound message is written to an append-only table. Private results (mail contents, calendar titles, bank data) never appear in it.
- **Secrets.** Credentials are sealed in the database with a key that lives only in the server's environment; vault entries are sealed in your browser to the server's public key. Child processes (the Claude CLI, Chrome) get an allowlisted environment. Secrets are redacted from logs and never reach a prompt.
- **Isolation.** The service runs as an unprivileged user under a hardened systemd unit. The sandbox runs with `--network none`, read-only and without capabilities, started by a separate root-owned helper; the service user is not in the `docker` group. Outbound messages are rate limited.

Found a way around any of this? See [SECURITY.md](SECURITY.md).

## What you need

| | Component | What it unlocks |
|---|---|---|
| **Required** | [Supabase](https://supabase.com) project (Free plan works) | Database: memory, audit log, approvals, schedules |
| **Required** | Linux VM with Docker (Ubuntu 24.04, ARM64 or x86-64, 4 GB RAM minimum, 8 GB recommended) | Runs Serain, the sandbox and the browser |
| **Required** | [Photon](https://photon.codes) account (Free plan, shared number) | The iMessage channel |
| **Required** | Claude access: an [Anthropic API key](https://console.anthropic.com) (or your own subscription token, see [Legal](#legal)) | The chat and executor models |
| **Required** | An Apple device with iMessage for you | Talking to Serain |
| Optional | Web interface: Cloudflare account and your own domain | Audit log, memory editor, vault (logged-in sessions, files), connections |
| Optional | Mac companion (macOS with Xcode Command Line Tools) | Apple Calendar, Reminders, Contacts, a browser with your home IP |
| Optional | Google Cloud OAuth app (testing mode) | Gmail and Google Calendar |
| Optional | iCloud app-specific password | iCloud Calendar over CalDAV |
| Optional | Any IMAP/SMTP mailbox | Reading, cleaning up and sending mail |
| Optional | A separate mailbox for Serain | Serain writes as itself, never in your name |
| Optional | [OpenRouter](https://openrouter.ai) API key | Fallback model, semantic memory search (embeddings), videos (Gemini), a hosted voice for spoken replies |
| Optional | [Tavily](https://tavily.com) API key | Web search |
| Optional | Typesafe API key | Browser pilot for multi-step web tasks |
| Optional | [Enable Banking](https://enablebanking.com) app (needs the web interface) | Read-only access to your own bank account |
| Optional | COROS account (needs the web interface) | Sleep, HRV, training load from your COROS watch |
| Optional | [Healthchecks.io](https://healthchecks.io) check | An alarm outside iMessage when the server or the channel is down |

## Costs

Only the code is free. Everything else is your own account with its own terms.

| Item | Cost |
|---|---|
| Serain | Free (AGPL-3.0) |
| Claude API | Pay per token; depends entirely on how much you use Serain. Serain counts it against its monthly cap (`SERAIN_API_BUDGET_USD`, default 20 $) and stops paid calls, the chat included, when the cap is reached (from 80 % it saves: no proactive check-ins, cheaper fallback models). Set the same limit in the Anthropic Console as a backstop. |
| Claude subscription (alternative) | Your existing personal plan, see [Legal](#legal) |
| Supabase | Free plan is enough for one user |
| Photon | Free plan with a shared number |
| Server | Oracle Cloud Always Free costs nothing but requires a credit card at sign-up; any other VPS with 4 GB RAM or more works too (typically a few euros a month) |
| Domain (only for the web interface) | Roughly 5 to 15 € a year; Cloudflare Workers, Access (up to 50 users) and Hyperdrive are free |
| OpenRouter (optional) | Pay per use. Counts against the same monthly cap; set a limit on the key itself too. An hour of YouTube costs about 0.17 $. |
| Tavily, Healthchecks.io, Enable Banking, Google Cloud | Free tiers are enough |
| Typesafe (optional) | Pay per use |

## Legal

This is not legal advice. This section summarises what the author found when checking the terms of every service involved. You run your own instance and you are responsible for how you use it.

- **Claude Agent SDK.** Serain depends on `@anthropic-ai/claude-agent-sdk`, which is proprietary ("All rights reserved") and governed by Anthropic's terms. It is installed from npm as a dependency, never vendored into this repository, and it is not covered by the AGPL.
- **Claude login.** The default is an **Anthropic API key**. Anthropic's documentation asks developers to use API key authentication and reserves subscription logins for ordinary use. Using your own subscription token (`CLAUDE_CODE_OAUTH_TOKEN`) is possible for strictly personal use, at your own risk. Never collect, share or forward anyone else's tokens.
- **Names.** Serain is not affiliated with, endorsed by or sponsored by Anthropic or Apple. "Claude", "iMessage" and related names are trademarks of their owners.
- **Photon.** The Spectrum SDK is MIT licensed. The service requires your own account, and reselling it is not allowed. On the Free plan the number is shared from Photon's pool and does not belong to you; Photon may change it. Your messages pass through Photon's infrastructure and are not end-to-end encrypted on every leg; read Photon's terms and privacy policy.
- **iMessage automation** is a grey area. Apple's iCloud terms prohibit accessing the service by automated means. Use Serain only for yourself; the risk, including losing access to an Apple account, is yours.
- **Google (Gmail, Calendar).** Each user creates their own OAuth app. In testing mode refresh tokens expire after 7 days, so you reconnect weekly. There is no shared client ID: publishing an app with Gmail scopes requires Google's verification and a CASA security assessment. Google Workspace users can set the app to "Internal" instead.
- **Video downloads (yt-dlp).** yt-dlp is released under the Unlicense. Downloading from TikTok, Instagram and X is **off by default** and only enabled with `SERAIN_MEDIA_DOWNLOAD=1`, at your own risk; the platforms' terms generally prohibit downloading. YouTube is never downloaded: Google AI Studio fetches the public URL itself. YouTube's terms prohibit downloads, and German case law (OLG Hamburg, 5 U 54/23) treats circumventing YouTube's technical protection as a violation of §95a UrhG. Serain does not bypass bot protection and does not log in to these platforms.
- **Gemini.** Videos are analysed by Gemini through OpenRouter. Everything except YouTube goes only to zero-data-retention endpoints. YouTube goes to Google AI Studio, which offers no zero data retention; that request carries only the public URL and a fixed instruction, never your question or anything from your memory. Do not enable videos if that is not acceptable to you.
- **Enable Banking.** Free for accessing your own accounts, non-commercial use only. Serain reads balances and transactions; it cannot make transfers.
- **Data protection (GDPR).** Running Serain for yourself falls under the household exemption (Art. 2(2)(c) GDPR); the author of this code is not the controller of your data. If you use Serain for business purposes, you are the controller and responsible for compliance, including the data of everyone whose emails and appointments Serain processes.

## Disclaimer

This software is provided "as is", without warranty of any kind, as stated in sections 15 and 16 of the [license](LICENSE). Serain acts on your behalf with real accounts: it reads your mail, sends messages, changes your calendar and may cause costs with third-party providers. You are responsible for configuring it, for every action you confirm, and for complying with the terms of every service you connect. The author is not liable for damages, costs, lost data, blocked accounts or legal consequences arising from its use.

## Quickstart

The full guide, in dependency order, is [docs/SETUP.md](docs/SETUP.md); `pnpm setup:check` shows at every step where you stand and what comes next. A coding agent such as Claude Code or Codex can walk you through it: it follows [AGENTS.md](AGENTS.md), and your keys stay with you. In short:

1. Create a Supabase project and apply `supabase/migrations/` with `psql`.
2. Create a Photon project (iMessage, Free plan) and an Anthropic API key.
3. `cp .env.example .dev.vars` and fill in the required values (`OWNER_NAME`, `OWNER_PHONE`, `OWNER_TIMEZONE`, Photon, Supabase, Claude).
4. Provision an Ubuntu 24.04 VM with `deploy/provision.sh`, copy the secrets, run `pnpm db:password`.
5. Test the channel locally with `SERAIN_ECHO_ONLY=1 pnpm dev`, then roll out with `./deploy/deploy.sh`.
6. Text your Photon number "hi".
7. Optionally tell Serain who you are: `cp -r data.example data`, write about yourself, `pnpm memory:push --apply`.

## Development

```bash
pnpm install
pnpm typecheck                    # server, web worker and web client
pnpm test                         # unit, integration and fuzz tests (fixed seed)
pnpm fuzz                         # 2,000 fuzz cases
pnpm dev                          # run locally against your .dev.vars
SERAIN_ECHO_ONLY=1 pnpm dev       # echo instead of the model: tests the channel at no cost
pnpm web:dev                      # web interface on http://localhost:8787
pnpm web:e2e                      # end-to-end test of the web interface (throwaway database)
pnpm eval --list                  # evals for prompts and models (real model calls, cost money)
```

Only **one** process may be connected to Photon at a time. If the service runs on the server, stop it (`systemctl stop serain`) before `pnpm dev`, otherwise both receive every message and you get two replies.

Tests never touch real accounts: `vitest.config.ts` sets dummy values for every credential. Evals play the invented owner "Alex" (`eval/persona.ts`) and call real models with your keys; changes to prompts or style need one. Code, comments and prompts are in English.

## Project structure

```
src/agent/        model layer (Claude Agent SDK, OpenRouter fallback), prompts, tools, turns
src/channel/      Channel interface and the Photon adapter
src/security/     allowlist, kill switch, approvals, untrusted content, link checks
src/db/           Supabase and Postgres access, audit log
src/memory/       facts, user model, embeddings, procedures
src/mail/         IMAP/SMTP and Gmail, cleanup, findings
src/calendar/     CalDAV and Google Calendar
src/executor/     the executor: web research and browsing
src/browser/      server-side Chrome
src/connectors/   connected services (catalog and drivers)
src/sandbox/      client for the Docker sandbox helper
src/scheduler/    reminders, scheduled tasks, watchers
src/health/       heartbeat, watchdog, dead man's switch
src/config/       environment, owner settings, models, limits
src/i18n/         languages: detection, catalog of fixed texts, words the code reads
web/              web interface (Cloudflare Worker and client)
site/             serain.si, the project's website and connector directory
companion/        Mac companion
deploy/           provisioning, deployment, systemd units, sandbox image
supabase/         migrations
test/             tests, including test/fuzz
eval/             evaluations for models and prompts
scripts/          setup and maintenance commands
instance/         your own additions, outside the repository (docs/INSTANCE.md)
data.example/     template for your own base knowledge (copy to data/, gitignored)
```

## Status

Serain is at an early stage. Every instance has exactly one owner. The agent speaks any language you write in. Its style prompt is in English; changes to it go through the chat eval (`pnpm eval`).

Roadmap:

- Easier setup: a setup script, and a way to run the web interface without a domain of your own.
- Public holidays for more countries (Germany only so far).
- More voices for spoken replies.

## Contributing

Contributions are welcome within the project's scope: a self-hosted agent for one owner. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Security issues go through private reporting, see [SECURITY.md](SECURITY.md). This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Copyright (C) 2026 Valentin Weinert

Serain is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`) as published by the Free Software Foundation. It is distributed without any warranty; see the license for details. You may use, study, modify and share Serain. If you run a modified version as a network service for others, you must offer them its source code under the same license. The point: nobody can turn Serain into a closed hosted service.

**Commercial licenses.** If the AGPL's terms do not fit what you want to do, for example building Serain into a product or service without publishing your source code, the author offers commercial licenses. Contact details are in the [imprint](https://serain.si/imprint/). Contributions are accepted under the [Contributor License Agreement](CLA.md), which keeps both possible.

Not affiliated with Anthropic or Apple.
