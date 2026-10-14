# Security policy

Serain reads mail, sends messages on its owner's behalf and is designed to eventually spend money. Security reports are taken seriously and handled before anything else.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request.**

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report.

Please include:

- what an attacker can achieve, and under which conditions (for example "an email with this content makes Serain send a mail without confirmation")
- steps to reproduce, ideally with invented data
- the commit you tested
- whether you have told anyone else

Never include real secrets, real phone numbers or real message contents. If you found a leaked secret in the repository or its history, say where, not what.

You will get an acknowledgement as soon as possible. Please give the maintainers reasonable time to fix the issue before disclosing it publicly; we will agree on a disclosure date with you and credit you if you want.

## Scope

In scope: the code in this repository, its default configuration, and the documented setup in [docs/SETUP.md](docs/SETUP.md), including the web interface (`web/`), the Mac companion (`companion/`), the deploy scripts and the sandbox (`deploy/`).

Out of scope: vulnerabilities in third-party services and SDKs themselves (Photon, Anthropic, Supabase, Cloudflare, Google, Apple, OpenRouter and others; please report those to the vendor), instances that deviate from the documented setup, and attacks that require control over the owner's phone, server or accounts.

## Security model in brief

- **Tool levels:** every tool is `read`, `write_reversible`, `irreversible` or `money`. The last two cannot run without the confirmation protocol: a preview built by code from validated arguments, confirmed by the owner.
- **Ingress allowlist:** only the owner's phone number reaches the model; groups and unknown senders are dropped before any model call.
- **Kill switch:** `serain stop`, matched by code outside the model in every language and persisted in the database, locks all tools and pending approvals until the owner releases it (`serain resume`).
- **Languages:** consent and codewords are read by code from fixed word lists (English, German and the owner's current language); safety checks that depend on words are fail closed in languages without word lists.
- **Untrusted content:** mail, web pages, calendars and connected services are marked untrusted and must never cause an effect on their own.
- **Audit log:** append-only, without private contents.
- **Secrets:** sealed at rest, kept out of prompts, logs and child process environments.
- **Isolation:** unprivileged service user, hardened systemd unit, network-less Docker sandbox behind a separate helper, web interface only behind Cloudflare Access plus the Worker's own token check.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (D8).

## What counts as a vulnerability

For example:

- bypassing the confirmation protocol: an `irreversible` or `money` action without a valid confirmation by the owner, a preview that does not match what is executed, or a standing approval that covers more than its exact target
- bypassing the ingress allowlist: anyone other than the owner reaching the model or a tool, including through groups, spoofed numbers or the channel adapter
- bypassing or lifting the kill switch without the owner
- a message in some language that counts as consent although it is not one, or a word-based safety check that skips a preview in a language without word lists
- prompt injection that leads to an effect: content from a mail, web page, calendar entry, file or connected service that makes Serain send, delete, move, book, pay, write to a service, or exfiltrate data
- leaking secrets or private data into logs, the audit log, prompts, tool results, link previews or third parties
- escaping the sandbox or reaching the network from it
- getting past Cloudflare Access or the passkey login of the web interface, or reading vault contents outside the server
- privilege escalation on the server through Serain's services or deploy scripts

Style problems, wrong answers and hallucinations are bugs, not vulnerabilities, unless they lead to one of the above.
