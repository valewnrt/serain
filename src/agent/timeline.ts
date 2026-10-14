import { ownerDate, OWNER_TIMEZONE } from "../time.js";
import type { ChatTurn } from "./model.js";

/**
 * Time markers in the history (finding 2026-10-09). The history went to the
 * model as a bare sequence of "Alex:"/"You:", only the `<context>` before the
 * last message carried a date. If the same question from the evening before
 * stood in it ("what's the weather tomorrow"), the model took it for seconds
 * old and copied the answer for the wrong day (eval `verlauf-gestern-01`: 4 out
 * of 4).
 *
 * So a marker with day and time stands before a message as soon as a new
 * calendar day (in the owner's time zone) begins or a pause of `MARKER_GAP_MS`
 * lies since the last message. Within one conversation the history stays
 * unchanged, the marker costs tokens only where time has passed.
 *
 * English like the rest of the prompt: the model reads it, the owner never does.
 */
export const MARKER_GAP_MS = 30 * 60_000;

const FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: OWNER_TIMEZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

/** For each turn the marker before it, or null. Turns without `at` belong to the turn before and never get one. */
export function timeMarkers(history: readonly ChatTurn[]): Array<string | null> {
  let last: Date | null = null;
  return history.map((turn) => {
    if (!turn.at) return null;
    const at = new Date(turn.at);
    if (Number.isNaN(at.getTime())) return null;
    const fresh = last === null || ownerDate(at) !== ownerDate(last) || at.getTime() - last.getTime() >= MARKER_GAP_MS;
    last = at;
    return fresh ? `[${FORMAT.format(at)}]` : null;
  });
}
