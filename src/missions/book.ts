import { MISSION_DEFAULT_CHECK_MS, MISSION_NOTES_IN_TURN, MISSION_WAKES_PER_DAY } from "../config/limits.js";
import { owner } from "../config/owner.js";
import { audit } from "../db/audit.js";
import { log } from "../log.js";
import type { ScheduleRow, ScheduleStore } from "../scheduler/store.js";
import { wrapUntrusted } from "../security/untrusted.js";
import { addDays, atWallTime, ownerDate, formatWallDay, formatWallTime, wallAnchor } from "../time.js";
import type { Mission, MissionNote, MissionStore } from "./types.js";

/**
 * The open missions of this process (D63, building block B). Keeps them in
 * memory so the `<context>` shows them without a query before the turn (D50);
 * they change only through this class, so memory is correct as long as the
 * process runs.
 *
 * Wakes go through `schedules` (kind `mission`): every open mission has exactly
 * one next check. A woken turn has the origin `schedule` and thus the rights of
 * a scheduled task (D15): no owner-only tools, everything with an effect goes
 * through a preview. It inherits its taint from the notes, like a reminder from
 * its entry (D8.4): what was noted after a reply mail is untrusted content.
 */

export interface ActiveMission {
  id: string;
  title: string;
  createdAt: string;
  /** Next check (ISO), null if none is due. */
  nextCheck: string | null;
}

export interface MissionWake {
  incoming: string;
  recallQuery: string;
  taintSources: string[];
}

export interface MissionBookDeps {
  store: MissionStore;
  schedules: ScheduleStore;
  now?: () => Date;
}

export class MissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionError";
  }
}

export class MissionBook {
  private readonly missions = new Map<string, ActiveMission>();
  /** Wakes per mission and local day; in memory only, a restart starts over. */
  private readonly wakes = new Map<string, { day: string; count: number }>();
  private readonly now: () => Date;

  constructor(private readonly deps: MissionBookDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * At startup: the open missions and their next check. If one has none (a
   * wake that was running during a crash is never repeated, D52), it gets one
   * in three days: a mission never silently falls asleep.
   */
  async load(): Promise<void> {
    const [missions, schedules] = await Promise.all([this.deps.store.active(), this.deps.schedules.active()]);
    this.missions.clear();
    for (const mission of missions) {
      const next = schedules.filter((row) => row.mode === "mission" && row.text === mission.id).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0];
      this.missions.set(mission.id, { id: mission.id, title: mission.title, createdAt: mission.createdAt, nextCheck: next?.nextRunAt ?? null });
      if (!next) {
        await this.schedule(mission.id, new Date(this.now().getTime() + MISSION_DEFAULT_CHECK_MS), []);
        await audit("mission_rescheduled", { mission: mission.id, reason: "no_wake" });
      }
    }
  }

  list(): ActiveMission[] {
    return [...this.missions.values()];
  }

  get size(): number {
    return this.missions.size;
  }

  find(id: string): ActiveMission | undefined {
    return this.missions.get(id);
  }

  async start(input: { title: string; goal: string; firstCheck: Date; taintSources: readonly string[] }): Promise<ActiveMission> {
    const mission = await this.deps.store.create({ title: input.title, goal: input.goal });
    const entry: ActiveMission = { id: mission.id, title: mission.title, createdAt: mission.createdAt, nextCheck: null };
    this.missions.set(mission.id, entry);
    await this.schedule(mission.id, input.firstCheck, input.taintSources);
    return entry;
  }

  /** A note and, if given, a new next check replacing the old one. */
  async note(id: string, input: { text: string; taintSources: readonly string[]; origin: string; nextCheck: Date | null }): Promise<ActiveMission> {
    const entry = this.require(id);
    await this.deps.store.addNote(id, { text: input.text, taintSources: input.taintSources, origin: input.origin });
    if (input.nextCheck) await this.schedule(id, input.nextCheck, input.taintSources);
    return entry;
  }

  async notes(id: string): Promise<{ mission: Mission; notes: MissionNote[] }> {
    const mission = await this.deps.store.get(id);
    if (!mission) throw new MissionError("This mission does not exist (anymore).");
    return { mission, notes: await this.deps.store.notes(id, MISSION_NOTES_IN_TURN) };
  }

  async close(id: string, status: "done" | "cancelled", outcome: string): Promise<void> {
    this.require(id);
    await this.cancelWakes(id);
    const closed = await this.deps.store.close(id, status, outcome);
    this.missions.delete(id);
    if (!closed) throw new MissionError("The mission was already closed.");
  }

  /** Hard delete, open or closed (W7). */
  async forget(id: string): Promise<boolean> {
    await this.cancelWakes(id);
    this.missions.delete(id);
    return this.deps.store.remove(id);
  }

  /**
   * A due check. Null means nothing to do (closed, deleted, or the daily cap is
   * reached and the check is moved to tomorrow). Before the turn, the fallback
   * check in three days is already set; if the turn sets its own with
   * `mission_note`, that one replaces it.
   */
  async wake(row: ScheduleRow): Promise<MissionWake | null> {
    const id = row.text;
    // Not in memory does not mean closed: if loading failed at startup, the wake asks the store itself.
    let entry = this.missions.get(id);
    if (!entry) {
      const stored = await this.deps.store.get(id);
      if (stored?.status !== "active") return null;
      entry = { id, title: stored.title, createdAt: stored.createdAt, nextCheck: null };
      this.missions.set(id, entry);
    }
    if (entry.nextCheck === row.nextRunAt) entry.nextCheck = null;
    const now = this.now();
    const day = ownerDate(now);
    const count = this.wakes.get(id);
    const used = count?.day === day ? count.count : 0;
    if (used >= MISSION_WAKES_PER_DAY) {
      await this.schedule(id, atWallTime(addDays(day, 1), 9, 0), row.taintSources, row.id);
      await audit("mission_wake_capped", { mission: id, wakes: used });
      return null;
    }
    this.wakes.set(id, { day, count: used + 1 });
    const { mission, notes } = await this.notes(id);
    if (mission.status !== "active") {
      this.missions.delete(id);
      return null;
    }
    await this.schedule(id, new Date(now.getTime() + MISSION_DEFAULT_CHECK_MS), [], row.id);
    const taint = [...new Set(notes.flatMap((note) => note.taintSources))];
    return {
      incoming: renderWake(mission, notes, now),
      recallQuery: `${mission.title} ${mission.goal}`,
      taintSources: taint,
    };
  }

  /** For the `<context>`: one line per open mission. Titles come from turns on the owner's messages. */
  contextLines(): string[] {
    return this.list().map((entry) => {
      const next = entry.nextCheck ? `next check ${formatWallTime(new Date(entry.nextCheck))}` : "no check planned";
      return `- ${entry.id}: ${entry.title} (since ${formatWallDay(new Date(entry.createdAt))}, ${next})`;
    });
  }

  private require(id: string): ActiveMission {
    const entry = this.missions.get(id);
    if (!entry) throw new MissionError("This mission is not open. The open ones are listed under <missions> in the <context>.");
    return entry;
  }

  /** Exactly one next check: all others of this mission are dropped, except the one running right now. */
  private async schedule(id: string, at: Date, taintSources: readonly string[], keep?: string): Promise<void> {
    await this.cancelWakes(id, keep);
    const row = await this.deps.schedules.insert({
      mode: "mission",
      text: id,
      repeat: null,
      nextRunAt: at.toISOString(),
      anchor: wallAnchor(at),
      sourceMessageId: "",
      taintSources,
    });
    const entry = this.missions.get(id);
    if (entry) entry.nextCheck = row.nextRunAt;
  }

  private async cancelWakes(id: string, keep?: string): Promise<void> {
    const rows = (await this.deps.schedules.active()).filter((row) => row.mode === "mission" && row.text === id && row.id !== keep);
    for (const row of rows) {
      try {
        await this.deps.schedules.cancel(row.id);
      } catch (error) {
        log.warn(`Wake ${row.id} for mission ${id} not cancelled:`, (error as Error).message);
      }
    }
  }
}

/** What the woken turn reads. Built by code; notes written after untrusted content are framed. */
export function renderWake(mission: Mission, notes: readonly MissionNote[], now: Date): string {
  const lines = notes.map((note) => {
    const when = formatWallTime(new Date(note.at));
    if (note.taintSources.length === 0) return `- ${when}: ${note.text}`;
    return `- ${when}: ${wrapUntrusted(note.text, `your note, derived from: ${note.taintSources.join(", ")}`)}`;
  });
  return [
    `Mission "${mission.title}" (${mission.id}), created on ${formatWallDay(new Date(mission.createdAt))}. It is time for the next check (${formatWallTime(now)}).`,
    `Goal, as ${owner.name} wanted it:`,
    mission.goal,
    notes.length > 0 ? `History, oldest note first${notes.length >= MISSION_NOTES_IN_TURN ? " (older ones omitted)" : ""}:` : "No notes yet.",
    ...lines,
    `What now: check the state (replies, deadlines), take the next step (everything with an effect goes through a preview to ${owner.name}) and record with mission_note what you did and when you will check again. If the goal seems reached or no longer reachable, tell ${owner.name} in one sentence; closing it is up to them. Without a new check, you look again in three days. If there is nothing new, you write ${owner.name} nothing.`,
  ].join("\n");
}
