import type { TextStyle } from "../channel/types.js";
import { MAX_BUBBLE_CHARS, MAX_BUBBLES_PER_MESSAGE } from "../config/limits.js";

/**
 * Formatting for the outbound path. Three jobs, all pure functions:
 *
 * 1. **Translate Markdown.** iMessage renders no Markdown. `**bold**` arrives
 *    as `**bold**` and gives away at once that a model is typing. Headings,
 *    links, code and lists become text; bold, italic and strikethrough become
 *    real iMessage formatting (D48).
 * 2. **Split into bubbles.** A friend sends three short messages instead of a
 *    block of text. Paragraphs are the natural boundary; paragraphs that are
 *    too long are split at sentence boundaries, never mid-word as long as
 *    that works.
 * 3. **Emphasis as ranges.** Every bubble goes to the channel as text plus
 *    ranges, the way iMessage stores them itself.
 *
 * Between 1 and 3, characters from Unicode's private use area carry the
 * emphasis through the splitting. They are neither whitespace nor
 * punctuation, so splitting never happens at them; if a boundary does fall
 * inside an emphasis, it continues in both bubbles.
 *
 * Everything here works on characters and Unicode classes, not on words, so it
 * is the same in every language.
 */

/** Characters a sentence may end with. */
const SENTENCE_END = /(?<=[.!?…])\s+/;

const OPEN = { bold: "", italic: "", strikethrough: "" } as const;
const CLOSE = { bold: "", italic: "", strikethrough: "" } as const;
const MARKERS = /[-]/g;
const CLOSE_MARKERS = new Set<string>(Object.values(CLOSE));
const OPEN_MARKERS = new Set<string>(Object.values(OPEN));

/**
 * Emphasis kinds, in the order they are recognised. Bold first, so `**` does
 * not count as italic twice. The content of strikethrough and italic contains
 * no marker, so ranges never cross: they lie side by side or nested, never
 * half.
 */
const EMPHASIS: ReadonlyArray<{ type: TextStyle["type"]; pattern: RegExp; inWord: "strip" | "keep" }> = [
  { type: "bold", inWord: "strip", pattern: /\*\*(?=\S)((?:[^\n]|\n(?!\n))*?\S)\*\*/g },
  { type: "bold", inWord: "strip", pattern: /__(?=[^\s\uE000-\uE005])((?:[^\n\uE000-\uE005]|\n(?!\n))*?[^\s\uE000-\uE005])__/g },
  { type: "strikethrough", inWord: "keep", pattern: /~~(?=[^\s-])([^\n-]*?[^\s-])~~/g },
  { type: "italic", inWord: "keep", pattern: /\*(?=[^\s*-])([^*\n-]*?[^\s*-])\*/g },
  { type: "italic", inWord: "keep", pattern: /_(?=[^\s_-])([^_\n-]*?[^\s_-])_/g },
];

/** Whitespace or punctuation, but none that starts an emphasis itself. */
const BOUNDARY = /[\s\p{P}\p{S}]/u;
const MARKER_CHARS = new Set(["*", "_", "~"]);

/**
 * May an emphasis start or end here? Only at the edge of a word: then the
 * channel can show every recognised emphasis safely. Right next to another
 * emphasis it may touch it on the inside (nested), not on the outside.
 * `snake_case`, `3 * 4` and `price*` never reach this check: they lack the
 * counterpart without a space.
 */
function atBoundary(char: string | undefined, foreign: ReadonlySet<string>): boolean {
  if (char === undefined) return true;
  if (foreign.has(char)) return false;
  if (OPEN_MARKERS.has(char) || CLOSE_MARKERS.has(char)) return true;
  return BOUNDARY.test(char) && !MARKER_CHARS.has(char);
}

function markEmphasis(input: string): string {
  let text = input;
  for (const { type, pattern, inWord } of EMPHASIS) {
    text = text.replace(pattern, (match: string, inner: string, offset: number, whole: string) => {
      const before = whole[offset - 1];
      const after = whole[offset + match.length];
      // Mid-word: `**` is dropped as before, but without emphasis, otherwise the
      // owner would see raw asterisks as `**`. Single `*`, `_` and `~~` stay:
      // `user_model_v2` is a name, not an emphasis.
      if (!atBoundary(before, CLOSE_MARKERS) || !atBoundary(after, OPEN_MARKERS)) {
        return inWord === "strip" ? inner : match;
      }
      return `${OPEN[type]}${inner}${CLOSE[type]}`;
    });
  }
  return text;
}

/** Text without any interpretation, only without marker characters and surrounding whitespace. For values to copy. */
export function plainOutbound(input: string): string {
  return input.replace(/\r\n?/g, "\n").replace(MARKERS, "").trim();
}

/**
 * The style prompt forbids dashes (– and —), the model uses them anyway (live
 * 2026-10-13: "wusst ich nicht – dann passt das"). So the code enforces it: a
 * range between digits or a dash without spaces ("Mon–Fri") becomes a hyphen,
 * a dash as a list point becomes a bullet, after punctuation or at the end of
 * a line it is dropped, otherwise it becomes a comma.
 */
function withoutDashes(text: string): string {
  return text
    .replace(/(\d)[ \t]*[–—][ \t]*(?=\d)/g, "$1-")
    .replace(/(?<=\S)–(?=\S)/g, "-")
    .replace(/^([ \t]*)[–—][ \t]+/gm, "$1• ")
    .replace(/([,;:.!?…])[ \t]*[–—]+/g, "$1")
    .replace(/[ \t]*[–—]+[ \t]*$/gm, "")
    .replace(/[ \t]*[–—]+[ \t]*/g, ", ");
}

/**
 * Prepares model text for sending: block Markdown becomes text, emphasis is
 * marked. The result goes into `splitIntoBubbles` and then bubble by bubble
 * into `styledBubble`.
 */
export function prepareOutbound(input: string): string {
  // Characters from the private use area already in the text would be read as
  // markers. They have no business in a chat message.
  let text = input.replace(/\r\n?/g, "\n").replace(MARKERS, "");

  // Code fences: keep the content, drop the fences.
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, body: string) => body.trim());
  // Inline code and backticks.
  text = text.replace(/`([^`\n]+)`/g, "$1");
  // Links: text plus URL in parentheses, so the URL is not lost.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
  // Headings, quotes, rules.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s{0,3}(?:[-*_]\s?){3,}$/gm, "");
  // List points become bullets, otherwise a bare hyphen would stand there.
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, "• ");
  text = withoutDashes(text);
  // Nobody sees whitespace at the end of a line; for the channel it would be a line break.
  text = text.replace(/[ \t]+$/gm, "");
  // Bold, italic, strikethrough. Only paired and without spaces inside.
  text = markEmphasis(text);

  // More than one blank line does nothing in iMessage.
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/**
 * A bubble from `prepareOutbound`/`splitIntoBubbles` as text plus ranges. An
 * emphasis that began before the bubble or ends after it reaches up to the
 * edge; empty ranges are dropped.
 */
export function styledBubble(bubble: string): { text: string; styles: TextStyle[] } {
  const styles: TextStyle[] = [];
  const open = new Map<TextStyle["type"], number>();
  const types = Object.keys(OPEN) as Array<TextStyle["type"]>;
  let text = "";
  const close = (type: TextStyle["type"], start: number): void => {
    if (text.length > start) styles.push({ type, start, length: text.length - start });
  };
  for (const char of bubble) {
    const opened = types.find((type) => OPEN[type] === char);
    if (opened) {
      if (!open.has(opened)) open.set(opened, text.length);
      continue;
    }
    const closed = types.find((type) => CLOSE[type] === char);
    if (closed) {
      close(closed, open.get(closed) ?? 0);
      open.delete(closed);
      continue;
    }
    text += char;
  }
  for (const [type, start] of open) close(type, start);

  // Whitespace at the edges is dropped, the ranges move along.
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const fitted = styles
    .map((style) => {
      const start = Math.max(0, style.start - lead);
      const end = Math.min(trimmed.length, style.start + style.length - lead);
      return { ...style, start, length: end - start };
    })
    .filter((style) => style.length > 0)
    .sort((a, b) => a.start - b.start || b.length - a.length);
  return { text: trimmed, styles: fitted };
}

/** The text as the owner reads it, without markers. For storage, dedupe and comparisons. */
export function stripMarkdown(input: string): string {
  return prepareOutbound(input).replace(MARKERS, "");
}

export interface BubbleOptions {
  maxChars?: number;
  maxBubbles?: number;
}

/** Splits a paragraph that is too long at sentence boundaries, if need be at word boundaries. */
function splitParagraph(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];

  const pieces: string[] = [];
  let buffer = "";
  const push = (): void => {
    if (buffer.trim()) pieces.push(buffer.trim());
    buffer = "";
  };

  for (const sentence of paragraph.split(SENTENCE_END)) {
    if (sentence.length > maxChars) {
      push();
      // A single sentence too long: cut at word boundaries, hard in the extreme case.
      let rest = sentence;
      while (rest.length > maxChars) {
        const window = rest.slice(0, maxChars);
        const cut = window.lastIndexOf(" ");
        const at = cut > maxChars * 0.5 ? cut : maxChars;
        pieces.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      buffer = rest;
      continue;
    }
    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    if (candidate.length > maxChars) {
      push();
      buffer = sentence;
    } else {
      buffer = candidate;
    }
  }
  push();
  return pieces;
}

/**
 * Merges neighbouring bubbles until the limit holds. The shortest pair of
 * neighbours is always merged: that way the long parts stay on their own and
 * only the snippets move together.
 */
function mergeToLimit(bubbles: string[], maxChars: number, maxBubbles: number): string[] {
  const out = [...bubbles];
  while (out.length > maxBubbles) {
    let bestIndex = -1;
    let bestLength = Number.POSITIVE_INFINITY;
    for (let i = 0; i < out.length - 1; i += 1) {
      const combined = (out[i] as string).length + 1 + (out[i + 1] as string).length;
      if (combined <= maxChars && combined < bestLength) {
        bestLength = combined;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    out.splice(bestIndex, 2, `${out[bestIndex] as string}\n${out[bestIndex + 1] as string}`);
  }

  if (out.length > maxBubbles) {
    // Does not fit with the best will: the rest into the last allowed bubble, shortened.
    const tail = out.splice(maxBubbles - 1).join("\n");
    out.push(tail.length > maxChars ? `${tail.slice(0, maxChars - 1).trimEnd()}…` : tail);
  }
  return out;
}

/**
 * Split text into message bubbles. Empty text yields an empty list; the caller
 * then sends nothing.
 */
export function splitIntoBubbles(input: string, options: BubbleOptions = {}): string[] {
  const maxChars = options.maxChars ?? MAX_BUBBLE_CHARS;
  const maxBubbles = options.maxBubbles ?? MAX_BUBBLES_PER_MESSAGE;
  const text = input.trim();
  if (!text) return [];

  const bubbles: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    bubbles.push(...splitParagraph(trimmed, maxChars));
  }
  if (bubbles.length === 0) return [];
  return mergeToLimit(bubbles, maxChars, maxBubbles);
}

/** Comparison form for the outbound dedupe: case and whitespace do not matter. */
export function dedupeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}
