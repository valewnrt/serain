import { z } from "zod";
import {
  MISSION_DEFAULT_CHECK_MS,
  MISSION_GOAL_MAX_CHARS,
  MISSION_MAX_ACTIVE,
  MISSION_MAX_CHECK_DAYS,
  MISSION_MIN_CHECK_MINUTES,
  MISSION_NOTE_MAX_CHARS,
  MISSION_TAINTED_MAX_CHECK_DAYS,
} from "../../config/limits.js";
import { audit } from "../../db/audit.js";
import { MissionError, type MissionBook } from "../../missions/book.js";
import { wrapUntrusted } from "../../security/untrusted.js";
import { formatWallDay, formatWallTime } from "../../time.js";
import { resolveWhen, when } from "./schedule.js";
import { defineTool, type ToolDefinition, type ToolResult, type TurnOrigin } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * Missions (D63, building block B): what runs over days, with goal, history and
 * next check. All level `write_reversible`: a mission grants no rights, it only
 * remembers the state; what a woken turn does is checked by the registry as
 * everywhere.
 *
 * - `mission_start` sets a goal that Serain later reads as an instruction:
 *   like `schedule_task` only on a message from the owner in a clean turn
 *   (`ownerOriginOnly`, D8.4), otherwise it would be a prompt injection with a
 *   time fuse. After foreign content the follow-up turn catches up on it.
 * - `mission_note` is allowed in every turn except the heartbeat, including the
 *   mail trigger reporting an answer: the note carries its origin and is framed
 *   at the next wake-up, the turn inherits the taint. The code bounds the next
 *   check (at the earliest in one hour, at most four times a day); the mail
 *   trigger never moves it, and after foreign content it goes at most 60 days
 *   ahead. Otherwise a crafted answer would silently put the mission to sleep
 *   (security review of 2026-10-13).
 * - `mission_close` only in turns from the owner or a confirmation. A woken
 *   turn reads notes that come from answer mails; "all done" in them must not
 *   end a mission. It tells the owner that the goal seems reached, and the
 *   owner closes (security review of 2026-10-13).
 * - `mission_forget` deletes hard (W7), only on the owner's instruction.
 */

export interface MissionToolDeps {
  book: MissionBook;
  now?: () => Date;
}

const missionId = z.string().uuid().describe("ID of the mission from <missions> in the <context>.");

/** Who may write a note: every turn that can have to do with the mission. Not the heartbeat. */
const NOTE_ORIGINS: readonly TurnOrigin[] = ["owner_message", "owner_reaction", "approval", "schedule", "task", "untrusted"];
const CLOSE_ORIGINS: readonly TurnOrigin[] = ["owner_message", "approval"];

function failure(error: unknown): ToolResult {
  if (error instanceof MissionError) return { ok: false, text: error.message };
  throw error;
}

export function missionTools(deps: MissionToolDeps): ToolDefinition[] {
  const book = deps.book;
  const now = deps.now ?? (() => new Date());

  /** The next check within the bounds of the code, or a sentence why not. Narrower after foreign content. */
  const nextCheck = (args: { at?: string | undefined; in_minutes?: number | undefined }, tainted: boolean): Date | { error: string } => {
    const resolved = resolveWhen(args, now());
    if ("error" in resolved) return resolved;
    const delta = resolved.at.getTime() - now().getTime();
    const maxDays = tainted ? MISSION_TAINTED_MAX_CHECK_DAYS : MISSION_MAX_CHECK_DAYS;
    if (delta < MISSION_MIN_CHECK_MINUTES * 60_000) return { error: `The next check at the earliest in ${MISSION_MIN_CHECK_MINUTES} minutes.` };
    if (delta > maxDays * 86_400_000) return { error: `The next check at most in ${maxDays} days.` };
    return resolved.at;
  };

  return [
    defineTool({
      name: "mission_start",
      comesBack: true,
      description:
        "Creates a mission: something that runs over days and that you stay on (requests with a reply deadline, complaint, " +
        `cancellation, following up, dealings with authorities). Goal the way ${owner.name} wants it, with everything you need to know later. At the next ` +
        "check (at or in_minutes, without either in three days) the code wakes you with goal and history; then you check the state, " +
        `take the next step and note it with mission_note. Only when ${owner.name} gives you something that will not be finished in ` +
        "this turn.",
      level: "write_reversible",
      ownerOriginOnly: true,
      schema: {
        title: z.string().trim().min(3).max(80).describe(`Short, the way ${owner.name} would call it, e.g. "GDPR requests advertising".`),
        goal: z.string().trim().min(10).max(MISSION_GOAL_MAX_CHARS),
        at: when.at,
        in_minutes: when.in_minutes,
      },
      async run(args, turn) {
        if (book.size >= MISSION_MAX_ACTIVE) {
          return { ok: false, text: `${MISSION_MAX_ACTIVE} missions are already open. Close one first; tell ${owner.name} that.` };
        }
        const first =
          args.at === undefined && args.in_minutes === undefined ? new Date(now().getTime() + MISSION_DEFAULT_CHECK_MS) : nextCheck(args, turn.tainted);
        if (!(first instanceof Date)) return { ok: false, text: first.error };
        const entry = await book.start({ title: args.title, goal: args.goal, firstCheck: first, taintSources: turn.taintSources });
        await audit("mission_started", { mission: entry.id, next_check: first.toISOString() }, turn.triggerMessageId || undefined);
        return { ok: true, text: `Mission created (${entry.id}). Next check: ${formatWallTime(first)}.` };
      },
    }),

    defineTool({
      name: "mission_note",
      comesBack: true,
      description:
        "Records in the history of a mission what happened (sent, answer in, deadline, next step), brief and with " +
        "everything you need at the next check. With at or in_minutes you set the next check (at the earliest in " +
        `${MISSION_MIN_CHECK_MINUTES} minutes), e.g. for the end of a deadline; without, the previous one stays.`,
      level: "write_reversible",
      origins: NOTE_ORIGINS,
      schema: {
        id: missionId,
        text: z.string().trim().min(1).max(MISSION_NOTE_MAX_CHARS),
        at: when.at,
        in_minutes: when.in_minutes,
      },
      async run(args, turn) {
        const wantsCheck = args.at !== undefined || args.in_minutes !== undefined;
        if (wantsCheck && turn.origin === "untrusted") {
          return { ok: false, text: "From a mail the next check stays as it is. Note without at and in_minutes." };
        }
        const next = wantsCheck ? nextCheck(args, turn.tainted) : null;
        if (next !== null && !(next instanceof Date)) return { ok: false, text: next.error };
        try {
          await book.note(args.id, { text: args.text, taintSources: turn.taintSources, origin: turn.origin, nextCheck: next });
        } catch (error) {
          return failure(error);
        }
        await audit("mission_noted", { mission: args.id, ...(next ? { next_check: next.toISOString() } : {}) }, turn.triggerMessageId || undefined);
        const entry = book.find(args.id);
        const planned = entry?.nextCheck ? ` Next check: ${formatWallTime(new Date(entry.nextCheck))}.` : "";
        return { ok: true, text: `Noted.${planned}` };
      },
    }),

    defineTool({
      name: "mission_show",
      description: "Goal and history of a mission, for \"how is … going?\" or before you continue working on it.",
      level: "read",
      repeatable: true,
      // Notes after answer mails are derived from foreign content; which ones is stated with them.
      returnsUntrusted: true,
      privateResult: true,
      schema: { id: missionId },
      async run(args) {
        try {
          const { mission, notes } = await book.notes(args.id);
          const lines = notes.map((note) => `- ${formatWallTime(new Date(note.at))}: ${note.taintSources.length > 0 ? wrapUntrusted(note.text, `note, derived from: ${note.taintSources.join(", ")}`) : note.text}`);
          const entry = book.find(args.id);
          return {
            ok: true,
            text: [
              `${mission.title} (${mission.status === "active" ? "open" : mission.status === "done" ? "done" : "cancelled"}, since ${formatWallDay(new Date(mission.createdAt))})`,
              `Goal: ${mission.goal}`,
              ...(mission.outcome ? [`Outcome: ${mission.outcome}`] : []),
              ...(entry?.nextCheck ? [`Next check: ${formatWallTime(new Date(entry.nextCheck))}`] : []),
              notes.length > 0 ? "History:" : "No notes yet.",
              ...lines,
            ].join("\n"),
            source: `mission ${mission.id}`,
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    defineTool({
      name: "mission_close",
      description:
        `Closes a mission: done when the goal is reached, cancelled when ${owner.name} no longer wants it or it is no longer ` +
        `possible. outcome says in one sentence what came of it. Only in a conversation with ${owner.name}; at a wake-up you tell them that the ` +
        "goal seems reached, and they decide.",
      level: "write_reversible",
      origins: CLOSE_ORIGINS,
      schema: {
        id: missionId,
        status: z.enum(["done", "cancelled"]),
        outcome: z.string().trim().min(3).max(400),
      },
      async run(args, turn) {
        try {
          await book.close(args.id, args.status, args.outcome);
        } catch (error) {
          return failure(error);
        }
        await audit("mission_closed", { mission: args.id, status: args.status }, turn.triggerMessageId || undefined);
        return { ok: true, text: "Closed. It will not wake you any more." };
      },
    }),

    defineTool({
      name: "mission_forget",
      description: `Deletes a mission with its whole history for good. Only if ${owner.name} explicitly wants it.`,
      level: "write_reversible",
      ownerOriginOnly: true,
      schema: { id: missionId },
      async run(args, turn) {
        const removed = await book.forget(args.id);
        await audit("mission_forgotten", { mission: args.id, removed }, turn.triggerMessageId || undefined);
        return removed ? { ok: true, text: "Deleted, with its history." } : { ok: false, text: "This mission does not exist." };
      },
    }),
  ];
}
