import { isBusy } from "./free.js";
import type { CalendarEntry } from "./types.js";

/**
 * Busy time around an instant (memory package of 2026-10-10): if a reminder
 * whose time Serain picked itself falls in the middle of an event, the model
 * should name a better one. Counted as in `calendar_free` (declined, cancelled
 * and all-day entries block nothing), and as there only times come out, never
 * title or location: the result carries no foreign text (D8.4).
 */

export interface BusySpan {
  start: Date;
  end: Date;
}

/**
 * The contiguous busy span `at` lies in: all events that contain `at`, plus
 * every one that overlaps or follows without a gap. Two events back to back
 * are one span for a reminder; the time before or after is the better choice,
 * not the minute in between. Null when `at` is free.
 */
export function busySpanAt(entries: readonly CalendarEntry[], at: Date): BusySpan | null {
  const ranges = entries
    .filter(isBusy)
    .map((entry) => ({ start: Date.parse(entry.start), end: Date.parse(entry.end) }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start);
  const instant = at.getTime();
  const containing = ranges.filter((range) => range.start <= instant && instant < range.end);
  if (containing.length === 0) return null;
  let start = Math.min(...containing.map((range) => range.start));
  let end = Math.max(...containing.map((range) => range.end));
  for (let grown = true; grown; ) {
    grown = false;
    for (const range of ranges) {
      if (range.start <= end && range.end >= start && (range.start < start || range.end > end)) {
        start = Math.min(start, range.start);
        end = Math.max(end, range.end);
        grown = true;
      }
    }
  }
  return { start: new Date(start), end: new Date(end) };
}
