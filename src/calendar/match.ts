import { FINDING_CALENDAR_MATCH_MS } from "../config/limits.js";
import { ownerDate, formatWallTime, OWNER_TIMEZONE } from "../time.js";
import type { Calendar, CalendarEntry } from "./types.js";

/**
 * Is an event already in the calendar (addendum D33 of 2026-10-10)? Serain only
 * offers a booking from the mail if not; and before writing it, it looks once
 * more, because the owner may have entered it themselves in the meantime.
 *
 * Only the time is compared, never the title: the title from the mail is
 * foreign content, and no comparison matches "ICE 597" against "Train Berlin".
 * An event with a time counts if one lies within `FINDING_CALENDAR_MATCH_MS`
 * around the start; an all-day one if there is an all-day one on its first day.
 */
export interface Span {
  from: Date;
  to: Date;
  allDay: boolean;
}

export function covers(entries: readonly CalendarEntry[], span: Span): boolean {
  const day = ownerDate(span.from);
  return entries.some((entry) => {
    if (entry.declined || entry.status === "cancelled") return false;
    if (span.allDay) return entry.allDay && entry.start.slice(0, 10) === day;
    if (entry.allDay) return false;
    const start = new Date(entry.start).getTime();
    return Number.isFinite(start) && Math.abs(start - span.from.getTime()) <= FINDING_CALENDAR_MATCH_MS;
  });
}

/** Reads exactly the window around the event. */
export async function calendarCovers(calendar: Calendar, span: Span): Promise<boolean> {
  const from = new Date(span.from.getTime() - FINDING_CALENDAR_MATCH_MS);
  const to = span.allDay ? span.to : new Date(span.from.getTime() + FINDING_CALENDAR_MATCH_MS);
  const { entries } = await calendar.list({ from: from.toISOString(), to: to.toISOString(), limit: 50 });
  return covers(entries, span);
}

/** A busy period without title and location: only this may go from a foreign calendar entry into a prompt without a frame. */
export interface Busy {
  from: Date;
  to: Date;
}

/** What overlaps the period, without all-day, declined and cancelled ones, without `except` (the event itself). */
export function busyDuring(entries: readonly CalendarEntry[], span: Pick<Span, "from" | "to">, except?: (entry: CalendarEntry) => boolean): Busy[] {
  return entries
    .filter((entry) => !entry.allDay && !entry.declined && entry.status !== "cancelled" && !except?.(entry))
    .map((entry) => ({ from: new Date(entry.start), to: new Date(entry.end) }))
    .filter((busy) => Number.isFinite(busy.from.getTime()) && Number.isFinite(busy.to.getTime()) && busy.from < span.to && busy.to > span.from)
    .sort((a, b) => a.from.getTime() - b.from.getTime());
}

export async function calendarBusy(calendar: Calendar, span: Pick<Span, "from" | "to">, except?: (entry: CalendarEntry) => boolean): Promise<Busy[]> {
  const { entries } = await calendar.list({ from: span.from.toISOString(), to: span.to.toISOString(), limit: 50 });
  return busyDuring(entries, span, except);
}

const clockFormat = new Intl.DateTimeFormat("en-GB", { timeZone: OWNER_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "09:30–11:00", past midnight with the day ("22:00 to Fri 23 Oct, 01:00"). For the model. */
export function busyLabel(busy: Busy): string {
  const clock = (instant: Date) => clockFormat.format(instant);
  return ownerDate(busy.from) === ownerDate(busy.to) ? `${clock(busy.from)}–${clock(busy.to)}` : `${clock(busy.from)} to ${formatWallTime(busy.to)}`;
}
