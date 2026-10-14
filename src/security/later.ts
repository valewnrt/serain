import { APPROVAL_LATER_MAX_MS, APPROVAL_LATER_MIN_MS } from "../config/limits.js";
import { t, textLanguage } from "../i18n/catalog.js";
import { currentLanguage, currentLocale } from "../i18n/language.js";
import { security } from "../i18n/messages/security.js";
import { words } from "../i18n/messages/words.js";
import { addDays, atWallTime, ownerDate, OWNER_TIMEZONE, parseDay, toWallTime } from "../time.js";

/**
 * "yes, but tomorrow at 8" (addendum D14 of 2026-10-08). The owner approves
 * now, the action runs at the time he names. Read like every decision: by
 * regex, before the model, and only as a whole message: a consent word and a
 * time, nothing else. "yes tomorrow morning" or "yes but after the call" is
 * conversation and goes to the model, which cannot approve anything.
 *
 * Two grammars, English and German, both always on. Other languages have no
 * "later": a time there is conversation, and the owner can still approve
 * right away (fail-safe: nothing is ever scheduled from a guess).
 *
 * German:
 * - `ja in 2 stunden`, `ja in 45 min`
 * - `ja um 8`, `ja 9:30`, `ja um 20 uhr` (next such time; "um 8" is 08:00, never 20:00)
 * - with a day before: `heute`, `morgen`, `übermorgen`, a weekday (the next
 *   one, today only if the time is still ahead), `am 12.10.` or `12.10.2026`
 * - allowed in between: `aber`, `erst`, `bitte` (`ja, aber erst morgen um 8`)
 *
 * English:
 * - `yes in 2 hours`, `yes in 45 min`, `ok in 3h`
 * - `yes at 8`, `yes 9:30`, `yes at 8pm`, `yes 7 am` ("at 8" is 08:00, never 20:00)
 * - a day before or after the time: `today`, `tomorrow`, `the day after
 *   tomorrow`, a weekday (`on friday`). No numeric dates: 10/12 means
 *   different days to different readers.
 * - allowed in between: `but`, `only`, `please`, `just`
 *
 * Computed in the owner's time zone through `src/time.ts` (D15).
 */

export type LaterRefusal = "past" | "too_soon" | "too_far";

export type LaterParse =
  | { ok: true; at: Date }
  | { ok: false; reason: LaterRefusal; at: Date };

/** Anything longer is never a decision, and the regex never sees a long foreign text. */
const MAX_CHARS = 80;

/** Consent words of one built-in language as a regex alternation (the lists in `messages/words.ts`). */
function consent(list: string): string {
  const alternatives = list
    .split("|")
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"))
    .sort((a, b) => b.length - a.length);
  return `(?:${alternatives.join("|")})`;
}

const END = String.raw`[\s.!]*$`;

// German.
const DE_CONSENT = consent(words.yes.de);
const DE_FILLER = String.raw`(?:[\s,]+(?:aber|erst|bitte))*`;
const DE_UNIT = String.raw`(min|minute|minuten|std|stunde|stunden|h)`;
const DE_WEEKDAY = String.raw`(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|mo|di|mi|do|fr|sa|so)`;
const DE_DAY = String.raw`(?:(heute|morgen|übermorgen|uebermorgen)|(?:am\s+)?${DE_WEEKDAY}|(?:am\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?)`;
// A clock time needs "um", "uhr" or minutes: a bare "ja 8" is none.
const DE_CLOCK = String.raw`(?:um\s+(\d{1,2})(?:[:.](\d{2}))?(?:\s*uhr)?|(\d{1,2})[:.](\d{2})(?:\s*uhr)?|(\d{1,2})\s*uhr)`;
const DE_RELATIVE = new RegExp(String.raw`^${DE_CONSENT}${DE_FILLER}[\s,]+in\s+(\d{1,3})\s*${DE_UNIT}${END}`, "i");
const DE_ABSOLUTE = new RegExp(String.raw`^${DE_CONSENT}${DE_FILLER}[\s,]+(?:${DE_DAY}[\s,]+)?${DE_CLOCK}${END}`, "i");

const DE_WEEKDAYS: Record<string, number> = {
  sonntag: 0, so: 0, montag: 1, mo: 1, dienstag: 2, di: 2, mittwoch: 3, mi: 3,
  donnerstag: 4, do: 4, freitag: 5, fr: 5, samstag: 6, sa: 6,
};

// English.
const EN_CONSENT = consent(words.yes.en);
const EN_FILLER = String.raw`(?:[\s,]+(?:but|only|please|just))*`;
const EN_UNIT = String.raw`(min|mins|minute|minutes|h|hr|hrs|hour|hours)`;
const EN_WEEKDAY = String.raw`(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)`;
const EN_DAY = String.raw`(?:(today|tomorrow|(?:the\s+)?day\s+after\s+tomorrow)|(?:on\s+)?${EN_WEEKDAY})`;
// A clock time needs "at", am/pm, "o'clock" or minutes: a bare "yes 8" is none.
const EN_CLOCK = String.raw`(?:at\s+(\d{1,2})(?:[:.](\d{2}))?|(\d{1,2})[:.](\d{2})|(\d{1,2})(?=\s*(?:am|pm|a\.m\.|p\.m\.|o'?clock)))(?:\s*(am|pm|a\.m\.|p\.m\.|o'?clock))?`;
const EN_RELATIVE = new RegExp(String.raw`^${EN_CONSENT}${EN_FILLER}[\s,]+in\s+(\d{1,3})\s*${EN_UNIT}${END}`, "i");
const EN_DAY_FIRST = new RegExp(String.raw`^${EN_CONSENT}${EN_FILLER}[\s,]+(?:${EN_DAY}[\s,]+)?${EN_CLOCK}${END}`, "i");
const EN_DAY_LAST = new RegExp(String.raw`^${EN_CONSENT}${EN_FILLER}[\s,]+${EN_CLOCK}[\s,]+${EN_DAY}${END}`, "i");

const EN_WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

/** Which day, before the clock is applied. */
type DaySpec =
  | { kind: "offset"; days: number }
  | { kind: "weekday"; weekday: number }
  | { kind: "date"; day: number; month: number; year: number | null }
  | { kind: "next" };

/** Weekday of a calendar day in the owner's zone (0 = Sunday). */
function weekdayOf(day: string): number {
  const parsed = parseDay(day);
  if (!parsed) throw new Error(`Not a calendar day: ${day}`);
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
}

function bounded(at: Date, now: Date): LaterParse {
  const ahead = at.getTime() - now.getTime();
  if (ahead <= 0) return { ok: false, reason: "past", at };
  if (ahead < APPROVAL_LATER_MIN_MS) return { ok: false, reason: "too_soon", at };
  if (ahead > APPROVAL_LATER_MAX_MS) return { ok: false, reason: "too_far", at };
  return { ok: true, at };
}

function relative(amount: number, unit: string, now: Date): LaterParse | null {
  if (amount <= 0) return null;
  const minutes = unit.toLowerCase().startsWith("m") ? amount : amount * 60;
  return bounded(new Date(now.getTime() + minutes * 60_000), now);
}

function resolve(spec: DaySpec, hour: number, minute: number, now: Date): LaterParse | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  const today = ownerDate(now);
  let day: string;
  switch (spec.kind) {
    case "offset":
      day = addDays(today, spec.days);
      break;
    case "weekday": {
      let ahead = (spec.weekday - weekdayOf(today) + 7) % 7;
      if (ahead === 0 && atWallTime(today, hour, minute).getTime() <= now.getTime()) ahead = 7;
      day = addDays(today, ahead);
      break;
    }
    case "date": {
      const year = spec.year ?? toWallTime(now).year;
      const candidate = `${year}-${String(spec.month).padStart(2, "0")}-${String(spec.day).padStart(2, "0")}`;
      if (!parseDay(candidate)) return null;
      day = candidate;
      break;
    }
    case "next":
      // Without a day the next such time: today if it is still ahead, else tomorrow.
      day = atWallTime(today, hour, minute).getTime() > now.getTime() ? today : addDays(today, 1);
      break;
  }
  return bounded(atWallTime(day, hour, minute), now);
}

function parseGerman(value: string, now: Date): LaterParse | null {
  const rel = DE_RELATIVE.exec(value);
  if (rel) return relative(Number(rel[1]), rel[2] ?? "", now);
  const abs = DE_ABSOLUTE.exec(value);
  if (!abs) return null;
  const [, word, weekday, dayOfMonth, month, year, umHour, umMinute, bareHour, bareMinute, uhrHour] = abs;
  const hour = Number(umHour ?? bareHour ?? uhrHour);
  const minute = Number(umMinute ?? bareMinute ?? 0);
  let spec: DaySpec;
  if (word) spec = { kind: "offset", days: word === "heute" ? 0 : word === "morgen" ? 1 : 2 };
  else if (weekday) {
    const target = DE_WEEKDAYS[weekday];
    if (target === undefined) return null;
    spec = { kind: "weekday", weekday: target };
  } else if (dayOfMonth && month) {
    spec = { kind: "date", day: Number(dayOfMonth), month: Number(month), year: year ? (year.length === 2 ? 2000 + Number(year) : Number(year)) : null };
  } else spec = { kind: "next" };
  return resolve(spec, hour, minute, now);
}

/** 1 to 12 with am/pm; "o'clock" and no suffix keep the 24-hour reading. */
function englishHour(hour: number, suffix: string | undefined): number {
  const marker = suffix?.replace(/\./g, "");
  if (marker !== "am" && marker !== "pm") return hour;
  if (hour < 1 || hour > 12) return Number.NaN;
  return (hour % 12) + (marker === "pm" ? 12 : 0);
}

function englishDay(word: string | undefined, weekday: string | undefined): DaySpec | null {
  if (word) return { kind: "offset", days: word === "today" ? 0 : word === "tomorrow" ? 1 : 2 };
  if (weekday) {
    const target = EN_WEEKDAYS[weekday];
    return target === undefined ? null : { kind: "weekday", weekday: target };
  }
  return { kind: "next" };
}

function parseEnglish(value: string, now: Date): LaterParse | null {
  const rel = EN_RELATIVE.exec(value);
  if (rel) return relative(Number(rel[1]), rel[2] ?? "", now);
  const first = EN_DAY_FIRST.exec(value);
  const last = first ? null : EN_DAY_LAST.exec(value);
  let clock: Array<string | undefined>;
  let spec: DaySpec | null;
  if (first) {
    const [, word, weekday, ...rest] = first;
    spec = englishDay(word?.replace(/\s+/g, " ").replace(/^the /, ""), weekday);
    clock = rest;
  } else if (last) {
    const [, ...groups] = last;
    clock = groups.slice(0, 6);
    spec = englishDay(groups[6]?.replace(/\s+/g, " ").replace(/^the /, ""), groups[7]);
  } else return null;
  if (!spec) return null;
  const [atHour, atMinute, bareHour, bareMinute, suffixedHour, suffix] = clock;
  const hour = englishHour(Number(atHour ?? bareHour ?? suffixedHour), suffix?.toLowerCase());
  const minute = Number(atMinute ?? bareMinute ?? 0);
  return resolve(spec, hour, minute, now);
}

/**
 * Reads a thread reply as "yes, but later". Null means no such decision (then
 * it is conversation or a plain "yes"). A recognised but unusable time (past,
 * under 2 min, over 7 days) comes back with its reason, so the code can tell
 * the owner why nothing was scheduled.
 */
export function parseLater(text: string, now: Date): LaterParse | null {
  const value = text.trim().toLowerCase();
  if (value.length === 0 || value.length > MAX_CHARS) return null;
  return parseGerman(value, now) ?? parseEnglish(value, now);
}

/** An example the owner can type in this language (only English and German have "later"). */
export function laterExample(lang: string = currentLanguage()): string {
  return lang === "de" ? "ja morgen um 8" : "yes tomorrow at 8";
}

/**
 * The resolved time the way the owner reads it: "Fr., 09.10. um 08:00",
 * "Fri, Oct 9 at 8:00 AM". German keeps its numeric day and month (style
 * round); every other language gets the month's name, which no reader can
 * misread as month/day.
 */
export function formatLater(at: Date, lang: string = currentLanguage()): string {
  // The language the frame really renders in (English until a translation is there), so date and words agree.
  const used = textLanguage(security.laterWhen, lang);
  const locale = currentLocale(used);
  const numeric = used === "de";
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: numeric ? "2-digit" : "numeric",
    month: numeric ? "2-digit" : "short",
    timeZone: OWNER_TIMEZONE,
  }).format(at);
  const time = new Intl.DateTimeFormat(locale, { hour: numeric ? "2-digit" : "numeric", minute: "2-digit", timeZone: OWNER_TIMEZONE }).format(at);
  return t(security.laterWhen, { day, time }, used);
}
