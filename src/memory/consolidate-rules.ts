import { MEMORY } from "../config/memory.js";
import { owner } from "../config/owner.js";

/**
 * What a consolidation (H1, D40) has to deliver, without database and without
 * model, so that tests and the eval check exactly these rules.
 *
 * The four sections are ordered by purpose and separate who the owner is
 * (stable) from what holds right now (expires).
 *
 * **The learned part is structured data written as text.** The model returns
 * the four sections as lists (`LearnedSections`), the code writes them
 * (`renderLearned`) under headings that start with a fixed ASCII key
 * (`### current: what holds right now`). Code that reads the learned part
 * (`show_memory`, the next consolidation) goes by that key, never by the
 * wording of a heading, so the wording and the prompt language can change
 * without breaking it. An empty section is an empty list and is not written;
 * there is no "nothing" sentinel.
 *
 * Learned parts written before this format have German headings ("### Was
 * gerade gilt") and "- nichts" under empty ones. `parseLearned` still reads
 * them (read compatibility for stored data only); nothing writes that format
 * any more, and the next consolidation turns it into the keyed one.
 */
export const LEARNED_KEYS = ["who", "current", "when_to_act", "how_to_write"] as const;
export type LearnedKey = (typeof LEARNED_KEYS)[number];
export type LearnedSections = Record<LearnedKey, string[]>;

/** The readable part of each heading, for the model. Code never reads it back. */
export const LEARNED_TITLES: Record<LearnedKey, string> = {
  who: `who ${owner.name} is`,
  current: "what holds right now",
  when_to_act: "when to act, when to ask",
  how_to_write: "how to write",
};

const KEYED_HEADING = /^###\s+([a-z_]+):/;

/**
 * Headings of learned parts written before the keyed format, for reading
 * stored data only. The first one carried the owner's name, so it is matched
 * by its shape.
 */
const LEGACY_HEADINGS: ReadonlyArray<{ match: (line: string) => boolean; key: LearnedKey }> = [
  { match: (line) => /^###\s+Wer\s.+\sist$/.test(line), key: "who" },
  { match: (line) => line === "### Was gerade gilt", key: "current" },
  { match: (line) => line === "### Wann handeln, wann fragen", key: "when_to_act" },
  { match: (line) => line === "### Wie schreiben", key: "how_to_write" },
];
/** What the old format wrote under an empty heading. */
const LEGACY_EMPTY = /^nichts\.?$/i;

export function emptyLearned(): LearnedSections {
  return { who: [], current: [], when_to_act: [], how_to_write: [] };
}

function isLearnedKey(value: string): value is LearnedKey {
  return (LEARNED_KEYS as readonly string[]).includes(value);
}

/** One entry as one line: no line breaks, no bullet of its own. */
function cleanItem(item: string): string {
  return item.replace(/\s+/g, " ").trim().replace(/^-\s*/, "");
}

/** Writes the sections in the keyed format, in fixed order. Empty sections are left out; all empty is "". */
export function renderLearned(sections: LearnedSections): string {
  return LEARNED_KEYS.flatMap((key) => {
    const items = sections[key].map(cleanItem).filter(Boolean);
    return items.length > 0 ? [`### ${key}: ${LEARNED_TITLES[key]}`, ...items.map((item) => `- ${item}`)] : [];
  }).join("\n");
}

/**
 * Reads a stored learned part, keyed or legacy. Lenient, because it reads
 * what is stored: lines under a heading it does not know, and lines before
 * the first heading, belong to no section and are skipped.
 */
export function parseLearned(text: string): LearnedSections {
  const sections = emptyLearned();
  let current: LearnedKey | null = null;
  let legacy = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const keyed = KEYED_HEADING.exec(line)?.[1];
      const old = LEGACY_HEADINGS.find((heading) => heading.match(line));
      current = keyed && isLearnedKey(keyed) ? keyed : (old?.key ?? null);
      legacy = !keyed && Boolean(old);
      continue;
    }
    const item = cleanItem(line);
    if (!current || !item || (legacy && LEGACY_EMPTY.test(item))) continue;
    sections[current].push(item);
  }
  return sections;
}

/** The learned part in the keyed format, whatever format it is stored in. */
export function normalizeLearned(text: string): string {
  return renderLearned(parseLearned(text));
}

/** Lines of the base text that a machine may delete: not empty, no heading. */
export function deletableLines(base: string): number[] {
  return base.split("\n").flatMap((line, index) => (line.trim() && !line.trim().startsWith("#") ? [index] : []));
}

/** Deletes whole lines, nothing else. The base text is never rewritten. */
export function withoutLines(text: string, indices: Iterable<number>): string {
  const drop = new Set(indices);
  return text
    .split("\n")
    .filter((_, index) => !drop.has(index))
    .join("\n");
}

export type ConsolidationVerdict =
  | { ok: true; base: string; learned: string; removedBaseLines: number }
  | { ok: false; reason: "too_long" | "headings" | "base_lines" | "no_change" | "forgotten" };

/**
 * Checks the result of a run against the rules. The learned part must be in
 * the keyed format exactly as `renderLearned` writes it (`headings` if not).
 * `forgotten` is reported by the caller itself (markers need the key),
 * everything else is decided here.
 */
export function checkConsolidation(input: {
  base: string;
  learnedBefore: string;
  learned: string;
  outdatedBaseLines: readonly number[];
}): ConsolidationVerdict {
  const learned = input.learned.trim();
  if (learned.length > MEMORY.learnedMaxChars) return { ok: false, reason: "too_long" };
  if (normalizeLearned(learned) !== learned) return { ok: false, reason: "headings" };
  const allowed = new Set(deletableLines(input.base));
  const removed = [...new Set(input.outdatedBaseLines)];
  if (removed.length > MEMORY.consolidationMaxBaseDeletions || removed.some((index) => !allowed.has(index))) {
    return { ok: false, reason: "base_lines" };
  }
  // Compared in the keyed format: a legacy learned part with the same content is no change.
  if (removed.length === 0 && learned === normalizeLearned(input.learnedBefore)) return { ok: false, reason: "no_change" };
  return { ok: true, base: withoutLines(input.base, removed), learned, removedBaseLines: removed.length };
}
