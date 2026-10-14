/**
 * A list one item per line, with "•" as in format.ts (style round of
 * 2026-10-13: a list as round bullets one below the other). The sentence goes
 * on around it: `lead` before, `tail` after. A single item stays in the
 * sentence, a list of one point would only be longer. `lead` and `tail` are
 * whole texts of the caller (one catalog message each), never fragments glued
 * into a sentence here.
 */
export function bulleted(lead: string, items: readonly string[], tail = ""): string[] {
  if (items.length === 1) return [[lead, items[0], tail].filter(Boolean).join(" ")];
  return [lead, ...items.map((item) => `• ${item}`), ...(tail ? [tail] : [])];
}
