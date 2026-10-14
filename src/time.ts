import { owner } from "./config/owner.js";

/**
 * Wall time in the owner's time zone (`OWNER_TIMEZONE`, set in
 * `src/config/owner.ts`). The owner thinks in "tomorrow at 9", the database in
 * UTC, and a model that works out offsets itself is an hour off twice a year (a
 * wrong time zone is one of the most common complaints about assistants). So
 * the model only names wall time, and the conversion happens here.
 */

export const OWNER_TIMEZONE = owner.timezone;

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const WALL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: OWNER_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function parseWallTime(value: string): WallTime | null {
  const match = WALL_PATTERN.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  // In JS, Feb 31 silently rolls over into March. Then it is not a valid date.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day, hour, minute };
}

export function toWallTime(instant: Date): WallTime {
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts["year"]),
    month: Number(parts["month"]),
    day: Number(parts["day"]),
    hour: Number(parts["hour"]),
    minute: Number(parts["minute"]),
  };
}

function asUtcMillis(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/**
 * Wall time to UTC. In the night the clocks go forward, 02:30 does not exist;
 * then it is the moment the clock skipped that time (03:30 summer time). In the
 * night they go back, 02:30 exists twice; then the first one counts.
 */
export function wallTimeToUtc(wall: WallTime): Date {
  const target = asUtcMillis(wall);
  const offsetAt = (instant: number) => asUtcMillis(toWallTime(new Date(instant))) - instant;
  // Around a change there are two offsets. Compute both candidates instead of iterating:
  // in the night of the change an iteration swings between them.
  const offsets = new Set([offsetAt(target - 86_400_000), offsetAt(target + 86_400_000)]);
  const candidates = [...offsets].map((offset) => target - offset).sort((a, b) => a - b);
  const exact = candidates.filter((candidate) => asUtcMillis(toWallTime(new Date(candidate))) === target);
  // Exactly one hit is the normal case, two the repeated hour (the first one
  // counts), none the skipped hour (then the later candidate).
  const chosen = exact[0] ?? candidates[candidates.length - 1] ?? target;
  return new Date(chosen);
}

/** Calendar day of an instant for the owner as `YYYY-MM-DD`: "today" and "tomorrow" are wall time, not UTC. */
export function ownerDate(instant: Date): string {
  const wall = toWallTime(instant);
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` as a real calendar day, else null (Feb 31 is none). */
export function parseDay(value: string): { year: number; month: number; day: number } | null {
  if (!DAY_PATTERN.test(value.trim())) return null;
  const wall = parseWallTime(`${value.trim()} 00:00`);
  return wall ? { year: wall.year, month: wall.month, day: wall.day } : null;
}

/** Calendar day plus n days. Computed on the date, not in hours: a day has 23 or 25 at a clock change. */
export function addDays(day: string, days: number): string {
  const parsed = parseDay(day);
  if (!parsed) throw new Error(`Not a calendar day: ${day}`);
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return date.toISOString().slice(0, 10);
}

/** Distance between two calendar days in days (b minus a). */
export function daysBetween(a: string, b: string): number {
  const from = parseDay(a);
  const to = parseDay(b);
  if (!from || !to) throw new Error(`Not a calendar day: ${from ? b : a}`);
  return Math.round((Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / 86_400_000);
}

/** A calendar day of the owner at a wall time, as an instant. */
export function atWallTime(day: string, hour: number, minute: number): Date {
  const parsed = parseDay(day);
  if (!parsed) throw new Error(`Not a calendar day: ${day}`);
  return wallTimeToUtc({ ...parsed, hour, minute });
}

/**
 * Weekday, day and month of an instant for the owner, as `Intl` options.
 * Without a locale the form is for the model: British English with the month
 * as a word ("Thu 22 Oct, 14:05"), so no reader mixes up day and month. Texts
 * that go to the owner past the model pass `currentLocale()` and get the
 * owner's own short form ("Do., 22.10., 14:05", "Thu, 10/22, 14:05").
 */
function wallOptions(locale: string | undefined, clock: boolean): Intl.DateTimeFormatOptions {
  return {
    timeZone: OWNER_TIMEZONE,
    weekday: "short",
    day: locale ? "2-digit" : "numeric",
    month: locale ? "2-digit" : "short",
    ...(clock ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
  };
}

/** Locale of the model's form, see `wallOptions`. */
const MODEL_LOCALE = "en-GB";

/** Day and time of an instant for the owner. Without `locale` for the model, with it for the owner (`currentLocale()`). */
export function formatWallTime(instant: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale ?? MODEL_LOCALE, wallOptions(locale, true)).format(instant);
}

/** "Thu 22 Oct": only the day, when the time says nothing. `locale` as in `formatWallTime`. */
export function formatWallDay(instant: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale ?? MODEL_LOCALE, wallOptions(locale, false)).format(instant);
}

export type Repeat = "daily" | "weekdays" | "weekly" | "monthly" | "yearly";

/**
 * What the owner meant by a repetition: wall time including the milliseconds
 * within the minute, not the instant it first ran. If the first run fell into
 * the skipped hour (daily at 02:30 in the night before the last Sunday in
 * March), it ran at 03:30; what is meant stays 02:30.
 */
export interface WallAnchor extends WallTime {
  /** Seconds and milliseconds within the minute, 0 to 59.999. */
  millis: number;
}

/** The wall time of an instant as an anchor. Only for instants that existed: "in X minutes" or old entries. */
export function wallAnchor(instant: Date): WallAnchor {
  return { ...toWallTime(instant), millis: ((instant.getTime() % 60_000) + 60_000) % 60_000 };
}

const ANCHOR_PATTERN = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}):(\d{2})\.(\d{3})$/;

/** `YYYY-MM-DD HH:mm:ss.SSS` in `OWNER_TIMEZONE`, without offset: what is stored is what was meant. */
export function formatAnchor(anchor: WallAnchor): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return (
    `${anchor.year}-${pad(anchor.month)}-${pad(anchor.day)} ${pad(anchor.hour)}:${pad(anchor.minute)}:` +
    `${pad(Math.floor(anchor.millis / 1_000))}.${pad(anchor.millis % 1_000, 3)}`
  );
}

/** Inverse of `formatAnchor`, else null. */
export function parseAnchor(value: string): WallAnchor | null {
  const match = ANCHOR_PATTERN.exec(value);
  const wall = match ? parseWallTime(match[1]!) : null;
  const seconds = Number(match?.[2]);
  if (!wall || seconds > 59) return null;
  return { ...wall, millis: seconds * 1_000 + Number(match![3]) };
}

/**
 * Next run of a repetition: the next matching day after `previous`, strictly
 * after `after`. Computed in wall time, so "daily at 9" still comes at 9 after
 * a clock change, not at 8 or 10.
 *
 * Time of day, seconds and day of month come from `anchor`, the meant wall
 * time, never from the previous run: that one may have been shifted. Daily at
 * 02:30 runs at 03:30 in the night the clocks go forward (02:30 does not
 * exist), and the day after at 02:30 again, even if the very first run fell
 * into that night; monthly on the 31st runs on Apr 30 and then again on May 31.
 * Yearly takes month and day from the anchor: a birthday on Feb 29 comes on
 * Feb 28 in years without a leap day and on the 29th again in the next leap
 * year.
 *
 * The seconds belong to it: "in 10 minutes, then daily" at 9:41:30 means
 * 9:41:30 every day. Cut to the full minute it would come 30 s early from the
 * second day on.
 */
export function nextOccurrence(previous: Date, repeat: Repeat, after: Date, anchor: WallAnchor = wallAnchor(previous)): Date {
  const from = toWallTime(previous);
  for (let step = 1; step <= 3_700; step += 1) {
    const day = new Date(Date.UTC(from.year, from.month - 1, repeat === "monthly" ? 1 : from.day));
    if (repeat === "monthly" || repeat === "yearly") {
      if (repeat === "monthly") day.setUTCMonth(day.getUTCMonth() + step);
      else day.setUTCFullYear(from.year + step, anchor.month - 1, 1);
      // Not every month has a 31st, not every year a Feb 29. Then the last day of the month.
      const last = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
      day.setUTCDate(Math.min(anchor.day, last));
    } else {
      day.setUTCDate(day.getUTCDate() + (repeat === "weekly" ? 7 * step : step));
    }
    const weekday = day.getUTCDay();
    if (repeat === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    const next = new Date(
      wallTimeToUtc({
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour: anchor.hour,
        minute: anchor.minute,
      }).getTime() + anchor.millis,
    );
    if (next.getTime() > after.getTime()) return next;
  }
  throw new Error("No next repetition found");
}
