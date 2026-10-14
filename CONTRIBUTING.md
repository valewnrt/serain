# Contributing to Serain

Thanks for your interest. Serain is a self-hosted personal agent for exactly one owner, reachable over iMessage. Contributions that make it safer, more reliable, easier to set up or better at its job are welcome.

Before you start, read [README.md](README.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [AGENTS.md](AGENTS.md). AGENTS.md holds the working rules for humans and AI coding agents alike (Claude Code reads it through `CLAUDE.md`); the security rules there are not negotiable.

## Languages

- Serain itself replies in the language the owner writes in, any language. Fixed texts to the owner (previews, confirmations, notices) go through the catalog in `src/i18n/` and ship in English and German; other languages are translated once by the model and cached. A new fixed text always needs both English and German (`test/i18n-catalog.test.ts` checks it). How to add texts, words or a language: [src/i18n/README.md](src/i18n/README.md).
- Safety checks that read the owner's words have word lists for English and German and must stay fail closed in every other language (when in doubt, the preview).
- Prompts, prompt tags, tool descriptions, documentation, code comments, commit messages, issues and pull requests are in English.

## Setup

```bash
pnpm install                         # Node 22, pnpm 10
git config core.hooksPath .githooks  # secret scan before every commit (needs gitleaks)
pnpm typecheck
pnpm test
```

You do not need any accounts to run the tests: `vitest.config.ts` sets dummy credentials, and no test reaches a real service. To run Serain against real accounts, follow [docs/SETUP.md](docs/SETUP.md); `SERAIN_ECHO_ONLY=1 pnpm dev` tests the channel without model costs.

## Tests and fuzzing

- `pnpm typecheck` and `pnpm test` must pass. CI runs both plus gitleaks.
- `pnpm fuzz` runs 2,000 fuzz cases (`test/fuzz/`); `pnpm test` runs them with a fixed seed. Run `pnpm fuzz` for changes to tools, the registry, connectors, the channel or anything that handles untrusted content.
- A new service is a driver in `src/connectors/drivers/` registered in `src/connectors/drivers/index.ts`, never wired directly into the runtime. The fuzz tests then cover it automatically.
- A new tool that opens web pages must be classified and added to `test/fuzz/link-previews.test.ts`.
- `pnpm web:e2e` tests the web interface against a throwaway database. Never point tests at a real Supabase project.
- Do not weaken or delete tests to make them pass.
- Changes to prompts, the style block, tool descriptions, models or thinking per role need an eval before and after: `pnpm eval` (suites `chat`, `tools`, `dates`, `judge`; see `eval/cli.ts`), plus `pnpm eval:memory` or `pnpm eval:mail` for memory and mail. Evals run with the fixed persona "Alex" (`eval/persona.ts`), call real models with your own keys and cost money; every run has a hard spend cap (`--cap`). Put the comparison in the pull request.

## Security rules for pull requests

Every change is checked against D8 (security levels) in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In particular:

- No tool of level `irreversible` or `money` without a confirmation spec. Previews are built by code from validated arguments, never from model text.
- The ingress allowlist and the kill switch stay in front of every model call and every tool, with no bypass, flag or test mode.
- Content from mail, web pages, calendars and connected services is untrusted. It must never cause an effect without the owner's confirmation.
- No secrets in prompts, logs, tool results or the audit log.
- No weakening of the sandbox, the systemd hardening or Cloudflare Access.

If you find a security problem, do not open a public issue or pull request; follow [SECURITY.md](SECURITY.md).

## Commits

- [Conventional Commits](https://www.conventionalcommits.org/) with an English subject, for example `feat(calendar): support recurring events on CalDAV` or `fix(channel): retry once after an upstream abort`. The body explains why.
- One logical change per commit and per pull request. A bug fix is not an invitation to refactor.
- Check every diff for secrets, phone numbers, addresses, names of real people and real message content. Use invented values in tests (the owner is "Alex", numbers like `+4915112345678`, domains under `example.com`).

## What will not be accepted

- Multi-user support, shared accounts or tenancy.
- Turning Serain into a hosted service, or anything that only makes sense for one.
- Bypassing bot protection, CAPTCHAs, rate limits or technical protection measures; logging in to platforms to scrape them.
- Collecting or relaying other people's Claude tokens or credentials.
- Telemetry or any data flow to the project or third parties that the owner did not set up.
- Changes to the style prompt or persona made in passing, or prompt changes without an eval. Style changes are a deliberate, separate step with an eval; open an issue first.
- New paid dependencies or services without prior discussion.

When in doubt, open an issue and ask before you write code.

## License of contributions

Serain is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). By submitting a contribution you agree that it is licensed under the same license, and you confirm that you have the right to submit it.

The author reserves the option to offer Serain under additional licenses in the future (dual licensing). To keep that possible, the maintainer may ask you to agree, before a larger contribution is merged, that it may also be distributed under such terms. You will always be asked explicitly; nothing is assumed, and you can decline, in which case the contribution simply is not merged.
