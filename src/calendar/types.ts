import { wallTimeToUtc, parseDay } from "../time.js";

/**
 * One calendar, two providers (D32, D54): Google through our own OAuth app and
 * iCloud through CalDAV. The tools only know this interface; which calendar
 * it is stands in `label`, and what it cannot do, in `invites`.
 */

export interface CalendarEntry {
  id: string;
  title: string;
  /** ISO with offset, or YYYY-MM-DD when all-day. */
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  /** Mail addresses of the guests, without the owner themselves. */
  guests: string[];
  status: string;
  /**
   * Did the owner create the event? Only the organizer moves an event with
   * guests; if one changes that they do not organize, it was someone else
   * (V4, event change by others).
   */
  organizerSelf: boolean;
  /** The owner declined the invitation: the event is still there, but does not take place for them. */
  declined: boolean;
  /** Which of their calendars the event is in ("Work"), where the provider knows several. */
  calendar?: string;
}

export type Weekday = "mo" | "di" | "mi" | "do" | "fr" | "sa" | "so";
export const WEEKDAYS: readonly Weekday[] = ["mo", "di", "mi", "do", "fr", "sa", "so"];
const RRULE_DAYS: Record<Weekday, string> = { mo: "MO", di: "TU", mi: "WE", do: "TH", fr: "FR", sa: "SA", so: "SU" };

/** A series: on these weekdays, from the start day through `until`. */
export interface WeeklyRepeat {
  weekdays: readonly Weekday[];
  /** `YYYY-MM-DD`, calendar day of the owner, inclusive. */
  until: string;
}

export interface EntryDraft {
  title?: string;
  /** `YYYY-MM-DDTHH:mm:00` wall time of the owner, or `YYYY-MM-DD` when all-day. */
  start?: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  guests?: string[];
  repeat?: WeeklyRepeat;
  /** Name of the calendar from `Calendar.targets`; without it the default. Only when creating. */
  calendar?: string;
}

export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarError";
  }
}

export interface Calendar {
  /** What it is called for the model, e.g. "Alex's iCloud calendar" (English, it goes into tool descriptions and results). Also the taint source. */
  readonly label: string;
  /** Which provider it is; the owner reads it as `ownerCalendarName(provider)` from src/calendar/offer.ts, the model reads `label`. Optional only for fakes in tests. */
  readonly provider?: "icloud" | "google";
  /**
   * Can the calendar invite guests? iCloud over CalDAV cannot (D54): events
   * with guests are created and changed there by the owner themselves.
   */
  readonly invites: boolean;
  /** Where a deleted event can be brought back from: the last line of the delete preview, straight to the owner (`t()`). */
  readonly deleteUndo: string;
  /**
   * The calendars Serain can write into, and the default when none fits
   * better. Only for providers with several (iCloud: Work, Private, …);
   * Serain picks the fitting one per event (decision of 2026-10-05).
   */
  targets?(): Promise<{ names: string[]; fallback: string }>;
  list(range: { from: string; to: string; limit: number }): Promise<{ entries: CalendarEntry[]; truncated: boolean }>;
  get(id: string): Promise<CalendarEntry | null>;
  create(draft: EntryDraft): Promise<CalendarEntry>;
  update(id: string, draft: EntryDraft, notifyGuests: boolean): Promise<CalendarEntry>;
  remove(id: string, notifyGuests: boolean): Promise<void>;
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * RRULE of a series. `UNTIL` is the end of the last day at the owner's, as UTC:
 * with `TZID` on the start, RFC 5545 requires UTC there, and Google as well as
 * iCloud read it exactly that way.
 */
export function weeklyRule(repeat: WeeklyRepeat): string {
  const last = parseDay(repeat.until);
  if (!last) throw new CalendarError("until is not a valid day.");
  const until = wallTimeToUtc({ ...last, hour: 23, minute: 59 });
  const stamp =
    `${until.getUTCFullYear()}${pad(until.getUTCMonth() + 1)}${pad(until.getUTCDate())}` +
    `T${pad(until.getUTCHours())}${pad(until.getUTCMinutes())}59Z`;
  const days = WEEKDAYS.filter((day) => repeat.weekdays.includes(day)).map((day) => RRULE_DAYS[day]);
  return `FREQ=WEEKLY;BYDAY=${days.join(",")};UNTIL=${stamp}`;
}
