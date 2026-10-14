/** Normalise E.164 so allowlist comparisons are exact. */
export function normalizeE164(input: string): string | null {
  const stripped = input.trim().replace(/[\s\-().]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(stripped)) return stripped;
  if (/^[1-9]\d{7,14}$/.test(stripped)) return `+${stripped}`;
  return null;
}
