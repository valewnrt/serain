/**
 * Environment for child processes (D8.7, D35). The Agent SDK's Claude CLI and
 * Chrome would otherwise get all of `process.env`, including `SUPABASE_SECRET_KEY`,
 * `SERAIN_VAULT_KEY` and `SERAIN_INTEGRATION_KEY`. A Chrome taken over by a
 * foreign page, or a CLI tool that does break loose one day, would then have
 * everything.
 *
 * Allowlist instead of a name filter: a filter on `KEY|SECRET|TOKEN` would let
 * `OWNER_PHONE` and `HEALTHCHECKS_PING_URL` through, and every new variable would
 * be open until someone thinks of the filter. Whatever else a process needs,
 * the caller passes explicitly.
 */
const PASSED = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME"] as const;

export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of PASSED) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return { ...result, ...extra };
}
