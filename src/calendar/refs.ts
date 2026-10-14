import { CALENDAR_LOOKAHEAD_DAYS, CALENDAR_REF_LOCATION_MAX_CHARS, CALENDAR_REFS_MAX } from "../config/limits.js";
import { addDays, formatWallDay, formatWallTime, parseDay, atWallTime } from "../time.js";
import type { CalendarEntry } from "./types.js";

/**
 * The location of an event for research, without the chat seeing it
 * (addendum D54 of 2026-10-10, decision 6 of the hairpin round).
 *
 * "what will the weather be on sunday?" depends on the event in Hamburg.
 * Title and location of an event are foreign content (someone else writes an
 * invitation), and after `calendar_events` no `run_task` starts any more
 * (D8.4). So the chat only sees, in the `<context>`, the times of the events
 * with a location, each with a short handle ("t1"). If it passes the handle to
 * `run_task`, the code resolves it here, and only the executor gets the
 * location, framed and through the filter for confidential values (D29).
 *
 * The handles are valid for exactly one turn: what was not in its `<context>`
 * does not exist. A guessed or invented handle finds nothing. Only the
 * heartbeat's latest snapshot is read, without a query before the turn (D50).
 */

export interface CalendarRef {
  /** "t1", "t2", … in order of time. */
  id: string;
  /** When, in words, without title and location ("Sun 11 Oct, 14:00 to 18:00"), in the model's form. */
  when: string;
  /** The location, one line, shortened. Never goes into a prompt of the chat. */
  location: string;
}

/** A location in one line, without control characters, shortened. Empty means: no location. */
function cleanLocation(raw: string): string {
  const line = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > CALENDAR_REF_LOCATION_MAX_CHARS ? `${line.slice(0, CALENDAR_REF_LOCATION_MAX_CHARS).trimEnd()}…` : line;
}

/** All-day: the end is the day after (exclusive), for Google as for iCloud. */
function allDayLabel(entry: CalendarEntry): string {
  const first = entry.start.slice(0, 10);
  const end = entry.end.slice(0, 10);
  const last = parseDay(end) && end > first ? addDays(end, -1) : first;
  const day = (value: string) => formatWallDay(atWallTime(value, 12, 0));
  return last === first ? `${day(first)}, all day` : `${day(first)} to ${day(last)}, all day`;
}

function timedLabel(start: Date, end: Date): string {
  const from = formatWallTime(start);
  const to = formatWallTime(end);
  // Same day: only the time of the end.
  return from.slice(0, -5) === to.slice(0, -5) ? `${from} to ${to.slice(-5)}` : `${from} to ${to}`;
}

/** When the event starts and ends, as instants; null when it is not readable. */
function span(entry: CalendarEntry): { start: number; end: number } | null {
  if (entry.allDay) {
    const first = entry.start.slice(0, 10);
    const end = entry.end.slice(0, 10);
    if (!parseDay(first)) return null;
    const last = parseDay(end) && end > first ? end : addDays(first, 1);
    return { start: atWallTime(first, 0, 0).getTime(), end: atWallTime(last, 0, 0).getTime() };
  }
  const start = Date.parse(entry.start);
  const end = Date.parse(entry.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end: Math.max(start, end) };
}

/** What of the event goes to the executor: when and where, without title and without handle. */
export type TaskPlace = Pick<CalendarRef, "when" | "location">;

export class CalendarRefs {
  private constructor(private readonly refs: readonly CalendarRef[]) {}

  static readonly empty = new CalendarRefs([]);

  /**
   * The next events with a location that are not over yet, at most
   * `CALENDAR_REFS_MAX` and at most `CALENDAR_LOOKAHEAD_DAYS` ahead.
   * Declined and cancelled ones do not count: the owner is not there.
   */
  static from(entries: readonly CalendarEntry[], now: Date): CalendarRefs {
    const horizon = now.getTime() + CALENDAR_LOOKAHEAD_DAYS * 86_400_000;
    const picked = entries
      .filter((entry) => !entry.declined && entry.status !== "cancelled")
      .map((entry) => ({ entry, location: cleanLocation(entry.location ?? ""), at: span(entry) }))
      .filter((item): item is { entry: CalendarEntry; location: string; at: { start: number; end: number } } =>
        item.location.length > 0 && item.at !== null && item.at.end > now.getTime() && item.at.start < horizon,
      )
      .sort((a, b) => a.at.start - b.at.start)
      .slice(0, CALENDAR_REFS_MAX);
    return new CalendarRefs(
      picked.map((item, index) => ({
        id: `t${index + 1}`,
        when: item.entry.allDay ? allDayLabel(item.entry) : timedLabel(new Date(item.at.start), new Date(item.at.end)),
        location: item.location,
      })),
    );
  }

  get size(): number {
    return this.refs.length;
  }

  /** Only handle and time, for the `<context>` of the chat. Never title, never location. */
  contextLines(): string[] {
    return this.refs.map((ref) => `${ref.id}: ${ref.when}`);
  }

  /** The event for a handle from this turn, else null. Case and whitespace do not matter. */
  resolve(id: string): CalendarRef | null {
    const wanted = id.trim().toLowerCase();
    return this.refs.find((ref) => ref.id === wanted) ?? null;
  }

  /** The handles that exist, for a rejection. */
  ids(): string[] {
    return this.refs.map((ref) => ref.id);
  }
}

/**
 * Postal code and town from an address ("Musterweg 7, 12345 Musterstadt" →
 * "12345 Musterstadt"), for the case that the full address is a confidential
 * value (D29: town and postal code may go outside). Null when there is no
 * postal code in it.
 */
export function coarsePlace(location: string): string | null {
  const match = /(?<!\d)(\d{5})\s+([^\d,;]+)/.exec(location);
  if (!match) return null;
  const city = (match[2] as string).trim().replace(/[\s.]+$/, "");
  return city ? `${match[1]} ${city}` : null;
}
