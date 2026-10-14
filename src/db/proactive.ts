import { createHash } from "node:crypto";
import type { Calendar, CalendarEntry } from "../calendar/types.js";
import type { Companion } from "../companion/client.js";
import { env } from "../config/env.js";
import { CALENDAR_LIST_MAX_EVENTS } from "../config/limits.js";
import {
  EMPTY_HEARTBEAT_STATE,
  type HeartbeatSignals,
  type HeartbeatState,
  type HeartbeatStateStore,
} from "../proactive/heartbeat.js";
import type { DeadlineSeen, SnapshotEntry } from "../proactive/occasions.js";
import { ownerDay } from "../memory/kinds.js";
import { log } from "../log.js";
import { db } from "./client.js";
import { commitment } from "./mail-items.js";

/** State and signals of the heartbeat (D9) against Supabase. */
const STATE_KEY = "proactive_heartbeat";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only entries of the expected shape: a hand-edited state or one from an older version does not break the heartbeat. */
function entries<T>(value: unknown, valid: (entry: unknown) => entry is T): Record<string, T> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, T] => valid(pair[1])));
}

const isDeadlineSeen = (value: unknown): value is DeadlineSeen =>
  isRecord(value) &&
  typeof value["due"] === "string" &&
  (value["level"] === "today" || value["level"] === "tomorrow") &&
  typeof value["told"] === "boolean";

const isSnapshotEntry = (value: unknown): value is SnapshotEntry =>
  isRecord(value) && typeof value["start"] === "string" && typeof value["place"] === "string" && typeof value["at"] === "string";

/**
 * The state is only written from this process (via `save`): after the first
 * read, memory is enough. The heartbeat looks every 30 s and until 2026-10-11
 * read the database every time, almost always without doing anything.
 */
let known: HeartbeatState | null = null;

export const heartbeatState: HeartbeatStateStore = {
  async load() {
    if (known) return structuredClone(known);
    const { data, error } = await db.from("agent_state").select("value").eq("key", STATE_KEY).maybeSingle();
    if (error) throw new Error(`Heartbeat state not readable: ${error.message}`);
    const value = (data?.value ?? {}) as Partial<Record<keyof HeartbeatState, unknown>>;
    known = {
      lastCheckedAt: typeof value.lastCheckedAt === "string" ? value.lastCheckedAt : null,
      lastLookedAt: typeof value.lastLookedAt === "string" ? value.lastLookedAt : null,
      sentDay: typeof value.sentDay === "string" ? value.sentDay : null,
      sentCount: typeof value.sentCount === "number" ? value.sentCount : EMPTY_HEARTBEAT_STATE.sentCount,
      behaviorVersion: typeof value.behaviorVersion === "number" ? value.behaviorVersion : null,
      probationSince: typeof value.probationSince === "string" ? value.probationSince : null,
      travelSeen: entries(value.travelSeen, (entry): entry is string => typeof entry === "string"),
      deadlinesSeen: entries(value.deadlinesSeen, isDeadlineSeen),
      calendarSnapshot: entries(value.calendarSnapshot, isSnapshotEntry),
      morningDay: typeof value.morningDay === "string" ? value.morningDay : null,
    };
    return structuredClone(known);
  },

  async save(state) {
    const { error } = await db
      .from("agent_state")
      .upsert({ key: STATE_KEY, value: state, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Heartbeat state not saved: ${error.message}`);
    known = structuredClone(state);
  },
};

/** At most this many deadlines at once; more on two days would be a bug, not a busy week. */
const DUE_LIMIT = 20;
/** At most this many own edits are read. Serain does not change 100 events in ten minutes. */
const OWN_EDIT_LIMIT = 100;

export const heartbeatSignals: Omit<HeartbeatSignals, "upcomingEvents"> = {
  async lastMessageAt() {
    const { data, error } = await db
      .from("messages")
      .select("created_at")
      .eq("peer", env.ownerPhone)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`History not readable: ${error.message}`);
    return data ? new Date(data.created_at as string) : null;
  },

  async inboundSince(since) {
    const { count, error } = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("peer", env.ownerPhone)
      .eq("direction", "inbound")
      .gt("created_at", since.toISOString());
    if (error) throw new Error(`History not readable: ${error.message}`);
    return count ?? 0;
  },

  /**
   * Deadlines from `mail_items.commitment.due` (V4). A commitment that a later
   * mail points to as a change (`changes_item`) no longer applies: postponed or
   * cancelled, and the mail trigger has already reported the change.
   */
  async dueCommitments(today, tomorrow) {
    const { data, error } = await db
      .from("mail_items")
      .select("id, sender, commitment, category")
      .in("commitment->>due", [today, tomorrow])
      .order("received_at", { ascending: true })
      .limit(DUE_LIMIT);
    if (error) throw new Error(`Deadlines not readable: ${error.message}`);
    const rows = data ?? [];
    if (rows.length === 0) return [];
    const ids = rows.map((row) => String(row.id));
    const { data: later, error: laterError } = await db.from("mail_items").select("changes_item").in("changes_item", ids);
    if (laterError) throw new Error(`Changes to deadlines not readable: ${laterError.message}`);
    const changed = new Set((later ?? []).map((row) => String(row.changes_item)));
    return rows.flatMap((row) => {
      const value = commitment(row.commitment);
      if (!value?.due || changed.has(String(row.id))) return [];
      return [
        {
          id: String(row.id),
          what: value.what,
          when: value.when,
          due: value.due,
          sender: String(row.sender ?? ""),
          ...(row.category === "lapse" ? { lapse: true } : {}),
        },
      ];
    });
  },

  /**
   * Serain's own calendar changes, from the audit log (D8.6): every executed
   * `calendar_update` (until 2026-10-05 `gcal_update`) is recorded there as a
   * `tool_call` with its arguments.
   * The preview (`awaiting_approval`) does not count, only the execution after
   * the owner's 👍, and only what succeeded.
   */
  async ownCalendarEdits(since) {
    const { data, error } = await db
      .from("audit_log")
      .select("at, detail")
      .eq("event", "tool_call")
      .eq("actor", "serain")
      .in("detail->>tool", ["calendar_update", "gcal_update"])
      .gt("at", since.toISOString())
      .order("id", { ascending: true })
      .limit(OWN_EDIT_LIMIT);
    if (error) throw new Error(`Own calendar changes not readable: ${error.message}`);
    return (data ?? []).flatMap((row) => {
      const detail = row.detail as Record<string, unknown>;
      const args = detail["args"] as Record<string, unknown> | undefined;
      const eventId = args?.["event_id"];
      if (detail["ok"] !== true || detail["awaiting_approval"] === true || typeof eventId !== "string") return [];
      return [{ eventId, at: String(row.at) }];
    });
  },
};

/**
 * Events for the proactive occasions, from both sources Serain knows: the
 * connected calendar (iCloud or Google, D54) and the Apple calendar on the Mac
 * (D28). The calendar only arrives after startup (`connectServices`), hence a
 * function.
 *
 * The Mac is only a source while it is awake; if both are gone, there are no
 * calendar occasions (`null`). When iCloud is connected, the Mac shows the same
 * events once more: whatever already came from the calendar with the same
 * title and start is dropped from the Mac, otherwise Serain would report every
 * journey twice. The Mac remains for calendars that only live there
 * (subscriptions, other accounts).
 *
 * Apple events carry no guests and no organizer. They therefore count as the
 * owner's own: journey and conflict yes, "event changed by others" never. As
 * for title and location, they are untrusted content like all others;
 * `occasions.ts` frames that.
 */
export function calendarEvents(
  calendar: () => Calendar | null,
  companion: () => Companion | null = () => null,
): NonNullable<HeartbeatSignals["upcomingEvents"]> {
  return async (from, to) => {
    const connected = calendar();
    const mac = companion();
    if (!connected && !mac) return null;
    const [fromCalendar, fromMac] = await Promise.all([
      connected ? connected.list({ from: from.toISOString(), to: to.toISOString(), limit: CALENDAR_LIST_MAX_EVENTS }).then((result) => result.entries) : null,
      mac ? macEntries(mac, from, to) : null,
    ]);
    if (!fromCalendar && !fromMac) return null;
    const key = (entry: CalendarEntry) => `${entry.title.trim()}|${entry.allDay ? entry.start : new Date(entry.start).getTime()}`;
    const known = new Set((fromCalendar ?? []).map(key));
    return [...(fromCalendar ?? []), ...(fromMac ?? []).filter((entry) => !known.has(key(entry)))];
  };
}

async function macEntries(companion: Companion, from: Date, to: Date): Promise<CalendarEntry[] | null> {
  try {
    const { events } = await companion.call("calendar_events", { from: ownerDay(from), to: ownerDay(to) }, 15_000);
    return events.map((event) => ({
      // Apple exposes no stable ID; title and start are enough for "once per event".
      id: `mac:${createHash("sha256").update(`${event.calendar}|${event.title}|${event.start}`).digest("hex").slice(0, 24)}`,
      title: event.title,
      start: event.allDay ? ownerDay(new Date(event.start)) : event.start,
      end: event.allDay ? ownerDay(new Date(event.end)) : event.end,
      allDay: event.allDay,
      location: event.location,
      guests: [],
      status: "confirmed",
      organizerSelf: true,
      declined: false,
    }));
  } catch (error) {
    // Lid closed or offline is the normal case, not an error.
    log.debug("Mac calendar not reachable for the heartbeat:", (error as Error).message);
    return null;
  }
}
