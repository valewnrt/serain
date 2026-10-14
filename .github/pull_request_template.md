## What and why

<!-- What changes, and why. Link the issue if there is one. -->

## How it was tested

<!-- Tests added or changed. For channel changes: a real iMessage sent and the
reply seen, or say explicitly that it could not be tested. -->

## Checklist

- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] `pnpm fuzz` passes (for tools, registry, connectors, channel or untrusted content)
- [ ] New services are drivers registered in `src/connectors/drivers/index.ts`; new tools that open pages are in `test/fuzz/link-previews.test.ts`
- [ ] Checked against D8: no `irreversible` or `money` tool without the confirmation protocol, allowlist and kill switch untouched, untrusted content cannot cause an effect
- [ ] No secrets, phone numbers, addresses, real names or real message contents in code, tests or docs
- [ ] Style prompt and persona unchanged (or discussed in an issue first); prompt, style or model changes come with a `pnpm eval` comparison
- [ ] New fixed texts to the owner go through the catalog with English and German (`src/i18n/README.md`); word-based safety checks stay fail closed outside English and German
- [ ] Commits follow Conventional Commits with an English subject
- [ ] I agree that this contribution is licensed under AGPL-3.0-only (see CONTRIBUTING.md)
