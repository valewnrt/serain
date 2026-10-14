/**
 * Shortens text to at most `max` characters plus a note. Never cuts a
 * surrogate pair in two: half an emoji at the end would be an invalid escape
 * in `jsonb`, and the whole audit entry would be lost.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return `${text.slice(0, end)}\n… (truncated, ${text.length} characters)`;
}
