import { createHash } from "node:crypto";
import { WATCH_ANCHOR_WINDOW_CHARS, WATCH_SECTION_CHARS } from "../config/limits.js";
import type { MailArrivesSpec } from "./types.js";

/**
 * What a watcher sees on a page, purely functional and without a model (D43).
 * Input is the page text from `htmlToText` (`src/executor/fetch.ts`), the same
 * the executor reads.
 *
 * Everything that comes out of here and later reaches a model is built by the
 * code: a number, formatted anew, and a currency sign from a fixed list. No
 * character of the page passes through unchanged. That is why the result of
 * `watch_create` does not need to taint the turn (see there).
 */

/** Collapse whitespace: line breaks of the text extraction must not split an anchor. */
function collapse(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export type Currency = "€" | "$" | "£" | "CHF" | null;

export interface ExtractedValue {
  value: number;
  /** The value as the model reads it, formatted by the code: "1,299.00 €". */
  display: string;
}

export type ExtractResult = { ok: true; value: ExtractedValue } | { ok: false; reason: "anchor_missing" | "no_number" };

/**
 * A number as shops and Wikipedia write it, German and English style:
 * "1.299,00", "1,299.00", "129,99", "129.99", "12.345", optionally with a
 * currency before or after. Not glued to a letter on either side: "S24" and
 * "8GB" in a product name are no price. Spaces as thousands separators are not
 * supported, otherwise "2 100" would be two numbers or one, depending on the
 * page.
 */
const NUMBER =
  /(?<![\p{L}\p{N}.,])(?:(€|\$|£|EUR|USD|GBP|CHF)\s?)?(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\p{N}])(?:\s?(€|\$|£|EUR|USD|GBP|CHF|Euro)(?![\p{L}]))?(?![\p{L}\p{N}])/gu;

function currencyOf(raw: string | undefined): Currency {
  if (!raw) return null;
  if (raw === "$" || raw === "USD") return "$";
  if (raw === "£" || raw === "GBP") return "£";
  if (raw === "CHF") return "CHF";
  return "€";
}

/**
 * The value in the window after the anchor: the first number with a currency,
 * else the first number. Product names almost always carry numbers
 * ("Raspberry Pi 5, 8GB RAM", "iPhone 15"), and the price comes after them;
 * without this precedence an anchor on the product name would find the model
 * number. Where no currency is given (population, water level), the first
 * number it is.
 */
function pickNumber(window: string): { value: number; decimals: number; currency: Currency } | null {
  let first: { value: number; decimals: number; currency: Currency } | null = null;
  for (const match of window.matchAll(NUMBER)) {
    const parsed = match[2] ? parseNumber(match[2]) : null;
    if (!parsed) continue;
    const currency = currencyOf(match[1] ?? match[3]);
    if (currency) return { ...parsed, currency };
    first ??= { ...parsed, currency };
  }
  return first;
}

/**
 * Number string to number. With two different separators, the last one is the
 * decimal separator. With only one kind, the group after it decides: exactly
 * three digits are thousands ("1.299", "1,299"), one or two are decimals
 * ("129,9", "4.5"). A number with three decimals is read as thousands; prices
 * and key figures practically never have them.
 */
export function parseNumber(raw: string): { value: number; decimals: number } | null {
  const last = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
  if (last < 0) {
    const value = Number(raw);
    return Number.isFinite(value) ? { value, decimals: 0 } : null;
  }
  const tail = raw.slice(last + 1);
  const mixed = raw.includes(".") && raw.includes(",");
  const decimalSep = tail.length !== 3 || mixed ? raw[last] : null;
  const digits = decimalSep
    ? `${raw.slice(0, last).replace(/[.,]/g, "")}.${tail}`
    : raw.replace(/[.,]/g, "");
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return { value, decimals: decimalSep ? tail.length : 0 };
}

/** Number format of every value a watcher hands to the model (`formatValue`, `formatQuote`): "1,299.00". */
export const VALUE_LOCALE = "en-US";

/**
 * Formatted for the model (English digits, the model writes it in the owner's
 * language), with as many decimals as the page showed. Only the model reads it:
 * the owner gets every value through a turn, never verbatim from here.
 */
export function formatValue(value: number, decimals: number, currency: Currency): string {
  const number = new Intl.NumberFormat(VALUE_LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
  return currency ? `${number} ${currency}` : number;
}

/** The currency of a value that `formatValue` built, so the threshold carries the same one. */
export function displayCurrency(display: string | null | undefined): Currency {
  const match = /(€|\$|£|CHF)$/.exec(display ?? "");
  return (match?.[1] as Currency | undefined) ?? null;
}

/** For the threshold the owner named: decimals only if there are any. */
export function formatThreshold(value: number, currency: Currency): string {
  return formatValue(value, Number.isInteger(value) ? 0 : 2, currency);
}

interface Token {
  word: string;
  start: number;
}

/**
 * Words and numbers, lowercase, with their position in the text. Digits and
 * letters are separate tokens: "8GB" and "8 GB" give the same.
 */
function tokens(text: string): Token[] {
  return [...text.matchAll(/\p{L}+|\p{N}+/gu)].map((match) => ({ word: match[0].toLowerCase(), start: match.index }));
}

/** The words and numbers of a text, as the anchor comparison sees them. */
export function wordTokens(text: string): string[] {
  return tokens(collapse(text)).map((token) => token.word);
}

/**
 * Every occurrence of the anchor, as the position right after it. Words and
 * numbers are compared, not punctuation and whitespace: Serain usually does not
 * know the page, and "Raspberry Pi 5 8GB" must find "Raspberry Pi 5, 8GB RAM"
 * (failed live on 2026-10-02). As before with the substring, the first word may
 * sit at the end of a longer one and the last at the start of a longer one
 * ("Preis" in "Gesamtpreis:", "Einwohner" in "Einwohnerzahl").
 */
function anchorEnds(text: string, anchor: string): number[] {
  const needle = tokens(collapse(anchor)).map((token) => token.word);
  const first = needle[0];
  const last = needle[needle.length - 1];
  if (first === undefined || last === undefined) return [];
  const page = tokens(text);
  const ends: number[] = [];
  if (needle.length === 1) {
    for (const token of page) {
      for (let at = token.word.indexOf(first); at >= 0; at = token.word.indexOf(first, at + 1)) {
        ends.push(token.start + at + first.length);
      }
    }
    return ends;
  }
  for (let i = 0; i + needle.length <= page.length; i += 1) {
    const head = page[i] as Token;
    const tail = page[i + needle.length - 1] as Token;
    if (!head.word.endsWith(first) || !tail.word.startsWith(last)) continue;
    if (needle.slice(1, -1).every((word, offset) => page[i + 1 + offset]?.word === word)) {
      ends.push(tail.start + last.length);
    }
  }
  return ends;
}

/**
 * The value of a `url_value` watcher: the first number (preferring one with a
 * currency, see `pickNumber`) in the 120 characters after the anchor. If the
 * anchor appears several times on the page (product name in title, breadcrumbs
 * and heading), the first occurrence followed by any number counts.
 * Deterministic: the same page always gives the same value.
 */
export function extractValue(pageText: string, anchor: string): ExtractResult {
  const text = collapse(pageText);
  const ends = anchorEnds(text, anchor);
  if (ends.length === 0) return { ok: false, reason: "anchor_missing" };
  for (const end of ends) {
    const picked = pickNumber(text.slice(end, end + WATCH_ANCHOR_WINDOW_CHARS));
    if (!picked) continue;
    return { ok: true, value: { value: picked.value, display: formatValue(picked.value, picked.decimals, picked.currency) } };
  }
  return { ok: false, reason: "no_number" };
}

export type Comparison = "below" | "above" | "changes";

/**
 * Does the watcher fire? `below`/`above` compare with the threshold, `changes`
 * with the last seen value. Without an earlier value there is no change.
 */
export function compareValue(
  compare: Comparison,
  current: number,
  previous: number | null,
  threshold: number | undefined,
): boolean {
  if (compare === "below") return threshold !== undefined && current < threshold;
  if (compare === "above") return threshold !== undefined && current > threshold;
  return previous !== null && current !== previous;
}

export type SectionResult = { ok: true; section: string } | { ok: false; reason: "anchor_missing" | "empty" };

/**
 * The watched section of a `status_changes` watcher: 300 characters after the
 * first occurrence of the anchor, without an anchor the whole page (that is
 * already the main content, `htmlToText` takes `<main>`/`<article>` if present).
 */
export function extractSection(pageText: string, anchor: string | undefined): SectionResult {
  const text = collapse(pageText);
  if (!anchor) return text ? { ok: true, section: text } : { ok: false, reason: "empty" };
  const end = anchorEnds(text, anchor)[0];
  if (end === undefined) return { ok: false, reason: "anchor_missing" };
  const section = text.slice(end, end + WATCH_SECTION_CHARS).trim();
  return section ? { ok: true, section } : { ok: false, reason: "empty" };
}

/**
 * Relative times in the languages a watched page is most likely written in.
 * They change on every fetch without anything happening ("vor 5 Minuten",
 * "3 hours ago", "il y a 2 heures"), so they are replaced by a fixed token.
 * Only seconds, minutes and hours: "vor 2 Tagen" against "vor 3 Tagen" can be
 * news. A missing language only means one unconfirmed candidate more per
 * fetch, which the confirmation in the poller catches; this is comfort, not
 * a safety check. Applied to lowercased text.
 */
const RELATIVE_TIMES: ReadonlyArray<readonly [RegExp, string]> = [
  // German and English keep the tokens they always had, so stored fingerprints stay valid.
  [/(?<![\p{L}])vor\s+\d+\s*(?:sekunden?|sek\.?|minuten?|min\.?|stunden?|std\.?)(?![\p{L}])/gu, "vor #"],
  [/(?<![\p{L}])\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\s+ago(?![\p{L}])/gu, "# ago"],
  // French
  [/(?<![\p{L}])il\s+y\s+a\s+\d+\s*(?:secondes?|minutes?|min\.?|heures?|h)(?![\p{L}])/gu, "# ago"],
  // Spanish, Portuguese
  [/(?<![\p{L}])(?:hace|há)\s+\d+\s*(?:segundos?|minutos?|min\.?|horas?)(?![\p{L}])/gu, "# ago"],
  // Italian
  [/(?<![\p{L}])\d+\s*(?:secondi|minuti|min\.?|ore|ora)\s+fa(?![\p{L}])/gu, "# ago"],
  // Dutch
  [/(?<![\p{L}])\d+\s*(?:seconden|minuten|min\.?|uur)\s+geleden(?![\p{L}])/gu, "# ago"],
  // Turkish
  [/(?<![\p{L}])\d+\s*(?:saniye|dakika|dk\.?|saat)\s+önce(?![\p{L}])/gu, "# ago"],
];

/**
 * Fingerprint of a section. Only what changes on every fetch without anything
 * happening is normalized: case, whitespace, clock times ("Stand 14:32") and
 * relative times (`RELATIVE_TIMES`). Dates and other numbers stay: "Zustellung
 * am 05.10." against "am 06.10." is exactly the change the owner is waiting for,
 * and a counter that goes up is rarely the noise it is taken for. What still
 * flickers (rotating notices, A/B variants) is caught by the confirmation in the
 * poller: a new fingerprint only counts when the next fetch sees it again.
 */
export function sectionHash(section: string): string {
  const normalized = RELATIVE_TIMES.reduce(
    (text, [pattern, token]) => text.replace(pattern, token),
    collapse(section).toLowerCase().replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "#:#"),
  );
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/** Case and umlauts alike: "Müller" finds "MUELLER" and vice versa. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/**
 * Does a new mail match a `mail_arrives` watcher? Substring on the sender (name
 * and address, as the adapter delivers `from`) and on the subject; if both are
 * given, both must match. This check never sees the mail body.
 *
 * For a promise (`awaited`) one of the two is enough: Serain only roughly knows
 * what the mail will look like when promising, and a missed mail breaks the
 * promise, while one too many only costs a report with a summary.
 */
export function mailMatches(spec: MailArrivesSpec, mail: { from: string; subject: string }): boolean {
  if (spec.awaited) {
    return (
      (spec.from !== undefined && fold(mail.from).includes(fold(spec.from))) ||
      (spec.subject !== undefined && fold(mail.subject).includes(fold(spec.subject)))
    );
  }
  if (spec.from !== undefined && !fold(mail.from).includes(fold(spec.from))) return false;
  if (spec.subject !== undefined && !fold(mail.subject).includes(fold(spec.subject))) return false;
  return true;
}
