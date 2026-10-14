import { addDays, atWallTime, daysBetween, formatWallDay, formatWallTime, toWallTime } from "../time.js";
import type { CalendarEntry } from "./types.js";

/**
 * Free times for scheduling. The code
 * computes them, not the model: reading a gap out of events is exactly the
 * kind of calculation in which a model overlooks an event.
 *
 * **At most three suggestions, spread out.** Three slots on the same morning
 * are a selection, not help; first one per day, only then a second on the
 * same day with a gap.
 *
 * What is busy comes from start and end, plus the buffer, for events with a
 * location the travel time; title and location themselves never appear in
 * the result. The result therefore carries no foreign text (D8.4). All-day
 * entries do not block (birthdays, holidays), but are named as a day, so that
 * Serain checks for a vacation.
 */

export interface FreeSlotQuery {
  /** Calendar days of the owner `YYYY-MM-DD`, inclusive. */
  from: string;
  to: string;
  minutes: number;
  /** Window per day as minutes after midnight (wall time). */
  earliest: number;
  latest: number;
  weekends: boolean;
  /** Gap to existing events, before and after. */
  bufferMinutes: number;
  /**
   * Travel time to and from events with a location, before and after, instead
   * of the buffer when it is larger: after an event until 17:00 in another
   * city, a call at 17:30 is no suggestion, the owner is still on the way home.
   */
  travelMinutes: number;
  /** Not before this, e.g. now plus lead time. */
  notBefore: Date;
  maxSlots: number;
}

export interface FreeSlot {
  start: Date;
  end: Date;
  /** Calendar day of the owner. */
  day: string;
}

export interface FreeSlotResult {
  slots: FreeSlot[];
  /** Days in the period with an all-day entry, without title. */
  allDayDays: string[];
}

const MINUTE = 60_000;
/** Suggestions start on the full or half hour. */
const ALIGN_MINUTES = 30;
/** A second suggestion on the same day lies this far from the first. */
const SAME_DAY_GAP_MS = 2 * 3_600_000;

/** Does the owner's time count as busy? Not for declined, cancelled and all-day entries. */
export function isBusy(entry: CalendarEntry): boolean {
  return !entry.allDay && !entry.declined && entry.status !== "cancelled";
}

function weekdayIndex(day: string): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

/**
 * Round up to the next half hour in wall time. Not in UTC: in zones offset by
 * three quarters of an hour (Nepal), a suggestion would otherwise land on :15
 * or :45.
 */
function alignUp(instant: number): number {
  const step = ALIGN_MINUTES * MINUTE;
  const minute = Math.floor(instant / MINUTE) * MINUTE;
  const wall = toWallTime(new Date(minute));
  const offset = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - minute;
  return Math.ceil((instant + offset) / step) * step - offset;
}

export function findFreeSlots(entries: readonly CalendarEntry[], query: FreeSlotQuery): FreeSlotResult {
  const length = query.minutes * MINUTE;
  const buffer = query.bufferMinutes * MINUTE;
  const travel = Math.max(buffer, query.travelMinutes * MINUTE);
  const busy = entries
    .filter(isBusy)
    .map((entry) => {
      const margin = entry.location.trim() ? travel : buffer;
      return { start: new Date(entry.start).getTime() - margin, end: new Date(entry.end).getTime() + margin };
    })
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
    .sort((a, b) => a.start - b.start);

  const span = daysBetween(query.from, query.to);
  const allDayDays = new Set<string>();
  for (const entry of entries) {
    if (!entry.allDay || entry.declined || entry.status === "cancelled") continue;
    // All-day: start inclusive, end exclusive (the same in iCalendar and Google).
    const last = entry.end > entry.start ? addDays(entry.end.slice(0, 10), -1) : entry.start.slice(0, 10);
    for (let day = entry.start.slice(0, 10); day <= last; day = addDays(day, 1)) {
      if (day >= query.from && day <= query.to) allDayDays.add(day);
    }
  }

  // Per day all fitting starts, in order.
  const perDay: FreeSlot[][] = [];
  for (let offset = 0; offset <= span; offset++) {
    const day = addDays(query.from, offset);
    const weekday = weekdayIndex(day);
    if (!query.weekends && (weekday === 0 || weekday === 6)) continue;
    const windowStart = atWallTime(day, Math.floor(query.earliest / 60), query.earliest % 60).getTime();
    const windowEnd = atWallTime(day, Math.floor(query.latest / 60), query.latest % 60).getTime();
    let cursor = alignUp(Math.max(windowStart, query.notBefore.getTime()));
    const found: FreeSlot[] = [];
    while (cursor + length <= windowEnd) {
      const end = cursor + length;
      const clash = busy.find((range) => range.start < end && range.end > cursor);
      if (!clash) {
        found.push({ start: new Date(cursor), end: new Date(end), day });
        cursor = end;
      } else {
        cursor = alignUp(clash.end);
      }
    }
    if (found.length > 0) perDay.push(found);
  }

  // First the earliest slot of each day, then more with a gap, until there are enough.
  const picked: FreeSlot[] = [];
  for (const slots of perDay) {
    if (picked.length >= query.maxSlots) break;
    picked.push(slots[0]!);
  }
  for (const slots of perDay) {
    for (const slot of slots.slice(1)) {
      if (picked.length >= query.maxSlots) break;
      const near = picked.some((other) => other.day === slot.day && Math.abs(other.start.getTime() - slot.start.getTime()) < SAME_DAY_GAP_MS);
      if (!near) picked.push(slot);
    }
  }
  picked.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { slots: picked, allDayDays: [...allDayDays].sort() };
}

/** "Tue 14 Oct, 10:00 to 11:00": how a slot stands in the result, in the model's form. */
export function slotLabel(slot: FreeSlot): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const to = toWallTime(slot.end);
  return `${formatWallTime(slot.start)} to ${pad(to.hour)}:${pad(to.minute)}`;
}

/** "Tue 13 Oct": an all-day day in the result, in the model's form. */
export function dayLabel(day: string): string {
  return formatWallDay(atWallTime(day, 12, 0));
}
