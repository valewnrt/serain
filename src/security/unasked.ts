import { addDays, ownerDate, daysBetween, parseDay } from "../time.js";

/**
 * Creating things unasked (addendum D62 of 2026-10-10, decision 7 of the
 * hairpin round). If the owner mentions a birthday, Serain creates a yearly
 * reminder; if they say "the insurance will get back to me by friday", a mail
 * watcher with `report_if_none`. Both only from their own message, never from
 * foreign content (mail, page, video).
 *
 * **Enforced here, not in the prompt.** A call with `unasked` only runs if (1)
 * the owner triggered the turn, (2) the turn has not read foreign content yet
 * and (3) the day is in their own words (`TurnState.ownerWords`, never model
 * text), for a birthday the word as well. The third is the evidence, as with
 * `namedByOwner` (addendum D8 of 2026-10-03): a clean follow-up turn (addendum
 * D8.4 of 2026-10-08) also sees framed in the history what a mail wrote, and
 * only the day in their text shows that it comes from them. The day is
 * recognised as a date ("14.3.", "14 March", "March 14th", ISO, an unambiguous
 * "14/3"), as "today", "tomorrow", "the day after tomorrow" or as a weekday in
 * the next two weeks. "by the end of the week" proves nothing: then Serain
 * creates nothing by itself.
 *
 * Languages: digits, ISO dates and 🎂 work in every language. Month and
 * weekday names, relative days and the birthday word are built in for English
 * and German, always both. In any other language only the digits count, and a
 * birthday needs 🎂: otherwise nothing is created unasked (fail closed); the
 * owner can still ask for it, and then a preview or an ack follows as usual.
 *
 * `judge` does not decide here (D12): whether something comes into being
 * without the owner asking is a boundary, not a verdict.
 */

/** As in `src/security/confidential.ts`: "März", "Maerz" and "MÄRZ" are the same month. */
function fold(text: string): string {
  return text.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
}

/** Month names, English and German, January first. */
const MONTHS: readonly string[] = [
  "januar|jan|jaenner|january",
  "februar|feb|february",
  "maerz|maer|mrz|march|mar",
  "april|apr",
  "mai|may",
  "juni|jun|june",
  "juli|jul|july",
  "august|aug",
  "september|sept|sep",
  "oktober|okt|october|oct",
  "november|nov",
  "dezember|dez|december|dec",
];

/**
 * Weekday names, English and German, Sunday first. Full names only: a weekday
 * stands on its own, and "sun", "sat" or "wed" are ordinary words.
 */
const WEEKDAYS: readonly string[] = [
  "sonntag|sunday",
  "montag|monday",
  "dienstag|tuesday",
  "mittwoch|wednesday",
  "donnerstag|thursday",
  "freitag|friday",
  "samstag|sonnabend|saturday",
];

/** Relative days, English and German. "morgens" and "mornings" are not "tomorrow": whole words only. */
const RELATIVE: ReadonlyArray<[RegExp, number]> = [
  [/(?<![a-z])(?:heute|today|tonight)(?![a-z])/, 0],
  [/(?<![a-z])(?:morgen|tomorrow)(?![a-z])/, 1],
  [/(?<![a-z])(?:uebermorgen|day after tomorrow)(?![a-z])/, 2],
];

/** How far ahead a weekday ("by friday", "next saturday") means a particular day. */
const WEEKDAY_REACH_DAYS = 13;

/** The birthday word in English and German, and 🎂 in every language. */
const BIRTHDAY = /geburtstag|(?<![a-z])geb\.|(?<![a-z])b-?day(?![a-z])|birthday|geburi|wiegenfest|🎂/u;

/** Is the owner talking about a birthday? */
export function mentionsBirthday(words: string): boolean {
  return BIRTHDAY.test(fold(words));
}

function weekdayOf(day: string): number {
  const parsed = parseDay(day);
  if (!parsed) return -1;
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
}

/**
 * "14/3" or "3/14": only when one reading is possible. "3/4" could be March 4
 * or April 3, so it proves neither (fail closed).
 */
function namesSlashDate(text: string, d: number, m: number): boolean {
  for (const match of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?(?![\d/])/g)) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (!(a === d && b === m) && !(a === m && b === d)) continue;
    const ambiguous = a !== b && a <= 12 && b <= 12;
    if (!ambiguous) return true;
  }
  return false;
}

/**
 * Does the owner name this day? `yearly`: only day and month count (a birthday
 * is on the same day every year, the first reminder may be next year).
 * Otherwise it has to be exactly this day.
 */
export function namesDay(words: string, day: string, now: Date, yearly: boolean): boolean {
  const target = parseDay(day);
  if (!target) return false;
  const text = fold(words);
  const d = target.day;
  const m = target.month;
  const ordinal = "(?:\\.|st|nd|rd|th|te[nmrs]?|ster)?";
  const numeric = new RegExp(`(?<!\\d)0?${d}\\.\\s?0?${m}(?:\\.|(?![\\d]))`);
  // "14. März", "14 march", "14th of march", "march 14", "march 14th".
  const named = new RegExp(
    `(?<!\\d)0?${d}${ordinal}\\s*(?:of\\s+)?(?:${MONTHS[m - 1]})(?![a-z])|(?<![a-z])(?:${MONTHS[m - 1]})\\.?\\s+0?${d}${ordinal}(?![\\d.:])`,
  );
  const iso = new RegExp(`(?<!\\d)\\d{4}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}(?!\\d)`);
  if (numeric.test(text) || named.test(text) || iso.test(text) || namesSlashDate(text, d, m)) return true;

  const today = ownerDate(now);
  const same = (candidate: string) => (yearly ? candidate.slice(5) === day.slice(5) : candidate === day);
  if (RELATIVE.some(([pattern, offset]) => pattern.test(text) && same(addDays(today, offset)))) return true;

  // A weekday means the next one of that name, "next friday" the one after too.
  const ahead = yearly ? null : daysBetween(today, day);
  for (let offset = 0; offset <= WEEKDAY_REACH_DAYS; offset += 1) {
    const candidate = addDays(today, offset);
    if (!same(candidate) || (ahead !== null && ahead !== offset)) continue;
    const name = WEEKDAYS[weekdayOf(candidate)];
    if (name && new RegExp(`(?<![a-z])(?:${name})(?![a-z])`).test(text)) return true;
  }
  return false;
}

/**
 * May this turn create anything by itself at all? Null means yes, otherwise
 * the reason for audit and model. The caller checks the words, because only it
 * knows which day is meant.
 */
export function unaskedTurnBlocker(turn: { origin: string; tainted: boolean }): "origin_not_owner" | "turn_tainted" | null {
  if (turn.origin !== "owner_message") return "origin_not_owner";
  if (turn.tainted) return "turn_tainted";
  return null;
}

/** For the model's example sentences, which it puts into the owner's language. */
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });

function utcDate(day: string): Date | null {
  const parsed = parseDay(day);
  return parsed ? new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12)) : null;
}

/** "14 Mar": day and month, for an example sentence to the model. */
export function dayMonthLabel(day: string): string {
  const date = utcDate(day);
  return date ? DAY_MONTH.format(date) : day;
}

/** "friday" within the next seven days, otherwise "16 Oct": how one says "by …", for an example sentence to the model. */
export function untilLabel(day: string, now: Date): string {
  const ahead = daysBetween(ownerDate(now), day);
  if (ahead === 0) return "today";
  if (ahead === 1) return "tomorrow";
  const date = utcDate(day);
  return ahead > 1 && ahead < 7 && date ? WEEKDAY.format(date).toLowerCase() : dayMonthLabel(day);
}
