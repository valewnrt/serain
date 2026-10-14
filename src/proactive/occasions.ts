import { createHash } from "node:crypto";
import type { CalendarEntry } from "../calendar/types.js";
import {
  OCCASION_TEXT_MAX_CHARS,
  OWN_EDIT_MARGIN_MS,
  PROACTIVE_HIGH_EXTRA_PER_DAY,
  PROACTIVE_MAX_PER_DAY,
} from "../config/limits.js";
import { owner } from "../config/owner.js";
import { wrapUntrusted } from "../security/untrusted.js";
import { addDays, atWallTime, ownerDate, formatWallDay, formatWallTime, toWallTime } from "../time.js";

/**
 * Occasions for a proactive look (V4), detected in code, without I/O and
 * without a model. The heartbeat and the morning look fetch calendar,
 * commitments and own changes; these functions decide which of them is an
 * occasion. A model only runs if something is left here (D19).
 *
 * **Event titles, places and commitments are untrusted content.** An
 * invitation from strangers can carry any title, and a model read a
 * commitment out of a mail. Whatever of it goes into the prompt is therefore
 * in `wrapUntrusted`, and the occasion names its source so the turn gets the
 * taint (D8.4).
 *
 * **No travel occasion** (addendum D46 of 2026-10-14). "An event with a place
 * starts soon" is in the owner's own calendar; without real data on the way
 * there (traffic, cancellations) the code has nothing the owner does not know,
 * and the model filled the gap with guesses from memory.
 */

export type Priority = "high" | "normal";

export type OccasionKind = "inbound" | "deadline" | "calendar_change" | "collision";

export interface Occasion {
  /**
   * Stable key: `since:…` for occasions at the "since the last look" pointer,
   * `deadline:<id>`, `change:<id>` for remembered ones,
   * `collision:…` in the morning look.
   */
  key: string;
  kind: OccasionKind;
  priority: Priority;
  /** Plain text for the prompt; untrusted content in it is framed. */
  text: string;
  /** Source of untrusted content in the text, for the turn's taint. Null for our own. */
  source: string | null;
}

export const CALENDAR_SOURCE = `${owner.possessive} calendar`;
export const MAIL_SOURCE = `${owner.possessive} inbox`;

/** Commitment from `mail_items.commitment` with a checked due date that no later mail has changed. */
export interface DueCommitment {
  id: string;
  what: string;
  when: string;
  /** `YYYY-MM-DD`, day in the owner's time zone. */
  due: string;
  sender: string;
  /**
   * A deadline from machine mail after which something lapses (`lapse`,
   * addendum D33 of 2026-10-10), not a commitment someone is waiting for.
   * Missing: commitment.
   */
  lapse?: boolean;
}

/** A successful change Serain made itself via `calendar_update`. */
export interface OwnCalendarEdit {
  eventId: string;
  at: string;
}

/** How a deadline was seen: on which day relative to the due date, and whether the model saw it. */
export interface DeadlineSeen {
  due: string;
  level: "today" | "tomorrow";
  told: boolean;
}

/** Last confirmed state of an event. The place only as a hash: the state holds no event content. */
export interface SnapshotEntry {
  /** ISO instant, `YYYY-MM-DD` for all-day events. */
  start: string;
  place: string;
  /** When this state was last seen like this. */
  at: string;
}

export function clip(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, OCCASION_TEXT_MAX_CHARS);
}

export function clock(instant: Date): string {
  const wall = toWallTime(instant);
  return `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
}

/** Start of an event with a time, otherwise null (all-day or broken). */
export function entryStart(entry: CalendarEntry): Date | null {
  if (entry.allDay) return null;
  const start = new Date(entry.start);
  return Number.isNaN(start.getTime()) ? null : start;
}

export function entryEnd(entry: CalendarEntry): Date | null {
  if (entry.allDay) return null;
  const end = new Date(entry.end);
  return Number.isNaN(end.getTime()) ? null : end;
}

/** Day (owner's time zone) on which an event starts. */
export function entryDay(entry: CalendarEntry): string {
  const start = entryStart(entry);
  return start ? ownerDate(start) : entry.start.slice(0, 10);
}

/** Does the event take place for the owner? Declined ones are in the calendar but do not count. */
export function attending(entry: CalendarEntry): boolean {
  return !entry.declined && entry.status !== "cancelled";
}

/**
 * Deadlines today and tomorrow. Once per commitment: whoever saw it yesterday
 * as "due tomorrow" does not get it again today. Exception: yesterday it was
 * only dropped in probation, never shown; then it may knock again today as
 * "due today" (high).
 */
export function deadlineOccasions(
  dues: readonly DueCommitment[],
  today: string,
  seen: Readonly<Record<string, DeadlineSeen>>,
): Occasion[] {
  const tomorrow = addDays(today, 1);
  return dues.flatMap((item) => {
    if (item.due !== today && item.due !== tomorrow) return [];
    const level = item.due === today ? ("today" as const) : ("tomorrow" as const);
    const before = seen[item.id];
    if (before && before.due === item.due && (before.told || before.level === level || level === "tomorrow")) return [];
    return [
      {
        key: `deadline:${item.id}`,
        kind: "deadline" as const,
        priority: level === "today" ? ("high" as const) : ("normal" as const),
        text:
          (item.lapse
            ? `From ${owner.possessive} mail: ${level === "today" ? "today" : "tomorrow"} (${item.due}) something lapses if ${owner.name} does nothing:\n`
            : `A commitment from ${owner.possessive} mails is due ${level === "today" ? "today" : "tomorrow"} (${item.due}):\n`) +
          wrapUntrusted(
            `What: ${clip(item.what)}\nWhen according to the mail: ${clip(item.when) || "not stated"}\nFrom: ${clip(item.sender)}`,
            MAIL_SOURCE,
          ),
        source: MAIL_SOURCE,
      },
    ];
  });
}

function placeHash(location: string): string {
  return createHash("sha256").update(location.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex").slice(0, 16);
}

/** The comparable state of an event: start as an instant (format changes do not count), place as a hash. */
export function snapshotValue(entry: CalendarEntry): { start: string; place: string } {
  const start = entryStart(entry);
  return { start: start ? start.toISOString() : entry.start.slice(0, 10), place: placeHash(entry.location) };
}

function differs(before: SnapshotEntry | undefined, entry: CalendarEntry): boolean {
  if (!before) return false;
  const now = snapshotValue(entry);
  return before.start !== now.start || before.place !== now.place;
}

/**
 * Can a change to this event come from someone else? Only if it has guests
 * and the owner does not organize it. What the owner organizes, they change
 * themselves, also on the phone past Serain; otherwise that would be a false
 * alarm about their own hand.
 */
function changeableByOthers(entry: CalendarEntry): boolean {
  return entry.guests.length > 0 && !entry.organizerSelf && attending(entry);
}

function startsAfter(start: string, now: Date): boolean {
  return start.length === 10 ? start >= ownerDate(now) : new Date(start).getTime() > now.getTime();
}

export interface CalendarChange {
  entry: CalendarEntry;
  previousStart: string;
  startChanged: boolean;
  placeChanged: boolean;
}

/**
 * Since when must own changes be looked up? The oldest confirmed state among
 * the events that changed and could come from others. Null means no query to
 * the audit log is needed.
 */
export function pendingSince(entries: readonly CalendarEntry[], snapshot: Readonly<Record<string, SnapshotEntry>>): Date | null {
  const times = entries
    .filter((entry) => changeableByOthers(entry) && differs(snapshot[entry.id], entry))
    .map((entry) => new Date(snapshot[entry.id]?.at ?? 0).getTime());
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

/**
 * Compares the calendar list with the last confirmed state. New events go
 * silently into the snapshot (so the first run reports nothing), unchanged
 * ones are confirmed again, vanished ones drop out. A change stays open (the
 * old state stays) if it can come from someone else, was not Serain's own and
 * the event is still ahead; everything else is taken over silently. Vanished
 * is no signal: the list does not return cancelled events, and the owner may
 * also have deleted an event themselves.
 */
export function diffCalendar(input: {
  now: Date;
  entries: readonly CalendarEntry[];
  snapshot: Readonly<Record<string, SnapshotEntry>>;
  ownEdits: readonly OwnCalendarEdit[];
}): { snapshot: Record<string, SnapshotEntry>; changes: CalendarChange[] } {
  const at = input.now.toISOString();
  const snapshot: Record<string, SnapshotEntry> = {};
  const changes: CalendarChange[] = [];
  for (const entry of input.entries) {
    if (!entry.id) continue;
    const before = input.snapshot[entry.id];
    const value = snapshotValue(entry);
    if (!before || !differs(before, entry)) {
      snapshot[entry.id] = { ...value, at };
      continue;
    }
    // Own change: Serain itself changed this event since the last confirmed state.
    const confirmed = new Date(before.at).getTime() - OWN_EDIT_MARGIN_MS;
    const own = input.ownEdits.some((edit) => edit.eventId === entry.id && new Date(edit.at).getTime() >= confirmed);
    const upcoming = startsAfter(value.start, input.now) || startsAfter(before.start, input.now);
    if (own || !upcoming || !changeableByOthers(entry)) {
      snapshot[entry.id] = { ...value, at };
      continue;
    }
    snapshot[entry.id] = before;
    changes.push({
      entry,
      previousStart: before.start,
      startChanged: before.start !== value.start,
      placeChanged: before.place !== value.place,
    });
  }
  return { snapshot, changes };
}

/** A change counts as seen: the new state becomes the confirmed one. */
export function acknowledge(
  snapshot: Readonly<Record<string, SnapshotEntry>>,
  entries: readonly CalendarEntry[],
  ids: ReadonlySet<string>,
  now: Date,
): Record<string, SnapshotEntry> {
  const next = { ...snapshot };
  for (const entry of entries) {
    if (ids.has(entry.id) && next[entry.id]) next[entry.id] = { ...snapshotValue(entry), at: now.toISOString() };
  }
  return next;
}

function describeStart(start: string): string {
  // Noon wall time of that day: the weekday and date come out right in every time zone.
  return start.length === 10 ? `all day on ${formatWallDay(atWallTime(start, 12, 0))}` : formatWallTime(new Date(start));
}

/**
 * Event change by others. High if the event is today or tomorrow (before or
 * after): then the owner is already planning with it, and an hour earlier
 * means missed. What gets moved later in the week is normal.
 */
export function changeOccasions(
  changes: readonly CalendarChange[],
  snapshot: Readonly<Record<string, SnapshotEntry>>,
  today: string,
): Occasion[] {
  const soon = new Set([today, addDays(today, 1)]);
  const dayOf = (start: string) => (start.length === 10 ? start : ownerDate(new Date(start)));
  return changes
    .filter((change) => differs(snapshot[change.entry.id], change.entry))
    .map((change) => {
      const now = snapshotValue(change.entry).start;
      const what = [
        change.startChanged ? `start was ${describeStart(change.previousStart)}, now ${describeStart(now)}` : "",
        change.placeChanged ? "the place is a different one" : "",
      ]
        .filter(Boolean)
        .join("; ");
      return {
        key: `change:${change.entry.id}`,
        kind: "calendar_change" as const,
        priority: soon.has(dayOf(now)) || soon.has(dayOf(change.previousStart)) ? ("high" as const) : ("normal" as const),
        text:
          `Someone else changed an event ${owner.name} is invited to: ${what}.\n` +
          wrapUntrusted(`Title: ${clip(change.entry.title) || "(no title)"}\nPlace now: ${clip(change.entry.location) || "none"}`, CALENDAR_SOURCE),
        source: CALENDAR_SOURCE,
      };
    });
}

export interface GateResult {
  /** Goes along into the turn. */
  included: Occasion[];
  /** Dropped in probation: counts as seen, does not come back (D26). */
  dropped: Occasion[];
  /** Failed at the daily cap: stays until there is room again or the occasion is over. */
  blocked: Occasion[];
}

/**
 * Priority against probation and daily cap. High is what harms the owner if
 * they do not learn of it: an appointment that never arrived, a deadline
 * today, an event today or tomorrow that someone else moved, and in the
 * morning look a collision. Normal is what could be useful but usually turns
 * out fine without Serain too: a deadline tomorrow (a day remains), "the
 * owner has written". In probation
 * only high gets through; at the cap, high may exceed it once.
 */
export function gate(occasions: readonly Occasion[], context: { probation: boolean; sentToday: number }): GateResult {
  if (context.sentToday >= PROACTIVE_MAX_PER_DAY + PROACTIVE_HIGH_EXTRA_PER_DAY) {
    return { included: [], dropped: [], blocked: [...occasions] };
  }
  const dropped = context.probation ? occasions.filter((occasion) => occasion.priority !== "high") : [];
  const rest = occasions.filter((occasion) => !dropped.includes(occasion));
  const blocked = context.sentToday >= PROACTIVE_MAX_PER_DAY ? rest.filter((occasion) => occasion.priority !== "high") : [];
  const included = rest
    .filter((occasion) => !blocked.includes(occasion))
    .sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high"));
  return { included, dropped, blocked };
}

/** A turn's taint from its occasions: each source once. */
export function taintOf(occasions: readonly Occasion[]): string[] {
  return [...new Set(occasions.flatMap((occasion) => (occasion.source ? [occasion.source] : [])))];
}
