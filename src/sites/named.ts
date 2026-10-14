/**
 * Did the owner name this vault entry in their message themselves (addendum
 * D8 of 2026-10-03 for `web_form`, of 2026-10-13 for `run_site_task`)? The name
 * is their own entry in the vault: as a whole word in their words, at least
 * four characters, it is enough as proof. Language neutral: the evidence is the
 * entry's name, not a word around it. Returns the name, else null.
 */
export function ownerNamedSite(site: string, ownerWords: string): string | null {
  // Names in the vault are `[a-z][a-z0-9_-]`: nothing in them is a special character in the pattern.
  return site.length >= 4 && new RegExp(`(^|[^a-z0-9_-])${site}([^a-z0-9_-]|$)`).test(ownerWords.toLowerCase()) ? site : null;
}
