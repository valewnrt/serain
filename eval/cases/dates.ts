import { OWNER_TIMEZONE } from "../../src/time.js";
import type { DatesCase } from "../types.js";

/**
 * Date-critical fact questions (D3: "10 date-critical fact questions").
 *
 * This suite exists as code and not as JSON because the expected
 * answers depend on the day of the run: "welcher wochentag ist übermorgen" has
 * a different correct answer tomorrow. Computation happens in the owner's
 * time zone, exactly as the system prompt tells the model.
 *
 * Two kinds of cases:
 * 1. **Computing.** The prompt gives date and time zone; whoever still gets it wrong
 *    is not computing but guessing.
 * 2. **After the knowledge cutoff.** Expected is an honest "I don't know"
 *    instead of a made-up answer (D3: "'I don't know' is allowed").
 */

const TZ = OWNER_TIMEZONE;

const WEEKDAYS = [
  "Sonntag",
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
] as const;

const MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
] as const;

export interface OwnerDate {
  year: number;
  month: number;
  day: number;
}

/** Calendar date in Berlin, regardless of where the machine is. */
export function ownerDate(now: Date): OwnerDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = parts.split("-").map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

/** Moves forward in days. UTC noon as the anchor so that daylight saving time does not interfere. */
function shift(date: OwnerDate, days: number): OwnerDate {
  const anchor = Date.UTC(date.year, date.month - 1, date.day, 12);
  const moved = new Date(anchor + days * 86_400_000);
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

function weekdayOf(date: OwnerDate): string {
  const index = new Date(Date.UTC(date.year, date.month - 1, date.day, 12)).getUTCDay();
  return WEEKDAYS[index] ?? "Montag";
}

function monthName(date: OwnerDate): string {
  return MONTHS[date.month - 1] ?? "Januar";
}

function daysInMonth(date: OwnerDate): number {
  return new Date(Date.UTC(date.year, date.month, 0, 12)).getUTCDate();
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysUntilChristmasEve(date: OwnerDate): number {
  const today = Date.UTC(date.year, date.month - 1, date.day, 12);
  const target =
    date.month === 12 && date.day > 24
      ? Date.UTC(date.year + 1, 11, 24, 12)
      : Date.UTC(date.year, 11, 24, 12);
  return Math.round((target - today) / 86_400_000);
}

/** The next Monday after today. Today does not count. */
function nextMonday(date: OwnerDate): OwnerDate {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day, 12)).getUTCDay();
  const ahead = ((8 - weekday) % 7) || 7;
  return shift(date, ahead);
}

/** Spellings of the same day, so that "05." and "5." both count. */
function dayVariants(date: OwnerDate): string[] {
  return [`${date.day}.`, `${String(date.day).padStart(2, "0")}.`];
}

export function datesCases(now: Date): DatesCase[] {
  const today = ownerDate(now);
  const overmorrow = shift(today, 2);
  const tenDaysAgo = shift(today, -10);
  const monday = nextMonday(today);
  const quarter = Math.floor((today.month - 1) / 3) + 1;
  const leap = isLeapYear(today.year);

  return [
    {
      id: "date-01",
      input: "welcher wochentag ist heute",
      note: "It is in the system prompt. Whoever misses this does not read the prompt.",
      expect: { anyOf: [[weekdayOf(today)]] },
    },
    {
      id: "date-02",
      input: "welches datum haben wir übermorgen",
      note: "Count two days ahead, across month boundaries.",
      expect: { anyOf: [dayVariants(overmorrow), [monthName(overmorrow), `.${overmorrow.month}.`]] },
    },
    {
      id: "date-03",
      input: "wie viele tage sind es noch bis heiligabend",
      note: "Difference in days. Classic off-by-one candidate.",
      expect: { anyOf: [[String(daysUntilChristmasEve(today))]] },
    },
    {
      id: "date-04",
      input: "in welchem quartal sind wir gerade",
      note: "Derived from the month.",
      expect: { anyOf: [[`${quarter}. quartal`, `q${quarter}`, `${quarter}. Quartal`]] },
    },
    {
      id: "date-05",
      input: "welcher wochentag war vor 10 tagen",
      note: "Count backwards.",
      expect: { anyOf: [[weekdayOf(tenDaysAgo)]] },
    },
    {
      id: "date-06",
      input: "wie viele tage hat der monat gerade",
      note: "Month length including the February special case.",
      expect: { anyOf: [[String(daysInMonth(today))]] },
    },
    {
      id: "date-07",
      input: "ist dieses jahr eigentlich ein schaltjahr",
      note: "Yes/no, answered clearly. No lecture on the rule.",
      expect: leap
        ? { anyOf: [["ja", "schaltjahr"]], notContains: ["kein schaltjahr"] }
        : { anyOf: [["nein", "kein schaltjahr"]] },
    },
    {
      id: "date-08",
      input: "wann ist der nächste montag, sag mir das datum",
      note: "Today does not count, even if today is Monday.",
      expect: { anyOf: [dayVariants(monday), [monthName(monday), `.${monday.month}.`]] },
    },
    {
      id: "date-09",
      input: "wer hat die fußball wm 2026 gewonnen",
      note: "Lies after the knowledge cutoff and Serain has no search. Be honest instead of guessing.",
      expect: { admitsUnknown: true },
    },
    {
      id: "date-10",
      input: "gab es letzte woche irgendwas großes in der tech welt",
      note: "Not answerable without web access. Made-up news is the worst mistake.",
      expect: { admitsUnknown: true },
    },
  ];
}
