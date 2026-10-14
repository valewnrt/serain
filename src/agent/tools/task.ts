import { z } from "zod";
import { audit } from "../../db/audit.js";
import { SIGNALS } from "../../channel/signals.js";
import { coarsePlace, type TaskPlace } from "../../calendar/refs.js";
import { describeKinds, type ConfidentialGuard } from "../../security/confidential.js";
import type { MessagePort } from "./messaging.js";
import { defineTool, type ToolDefinition, type TurnState } from "./types.js";
import { owner } from "../../config/owner.js";
import { t } from "../../i18n/catalog.js";
import { tools as messages } from "../../i18n/messages/tools.js";

/**
 * `run_task` hands a research task to the executor (D4). It runs in the
 * background; its result comes back as a turn of its own and goes as a reply
 * into the thread of the question.
 *
 * **Ack only after the precondition check (W22).** An agent that says "on it"
 * first may only notice afterwards that no mail account is connected at all.
 * Here the tool first checks whether the task can run at all, and then sets
 * the 🔍 itself; the model promises nothing beforehand, because it needs no
 * means of its own for that. If the executor delivers a report, the 🔍 becomes
 * a ✅, otherwise a ❌ (the runtime sets it, it knows the result).
 *
 * **The acknowledgement always comes, and it never says "done".** If no tapback
 * works (channel cannot do them, limit, channel error) and the owner has not
 * received anything in this turn yet, the tool sends a fixed sentence
 * (`taskAckText`). A model left to word it might claim "done" before
 * anything ran; here the wording is in the code.
 *
 * **The task text is the boundary to the outside (D29).** The executor knows
 * only it, and what is in it can end up in a URL. If it carries a confidential
 * value from memory, nothing starts; the model is told the kind of finding and
 * phrases it more coarsely. If the protection list cannot be loaded, nothing
 * starts either.
 *
 * **The place of an event only goes to the executor** (addendum D54 of
 * 2026-10-10). With `event_id` the model names an event from the `<context>`
 * of this turn (`TurnState.calendarRefs`); the code inserts the place, and it
 * goes through the same filter as the task. It is not in the task text: that
 * lands in `tasks`, in the overview and in the result turn, the place in none of them.
 */

export interface TaskPort {
  /** Null when the task can run. Otherwise the reason, in words for the model. */
  precondition(): Promise<string | null>;
  /**
   * `guard` is the same state the task was checked against; the executor checks URLs and search queries with it.
   * `acked` means: the 🔍 sits on the owner's message and becomes ✅ or ❌.
   */
  start(request: {
    task: string;
    triggerExternalId: string;
    triggerMessageId: string;
    guard: ConfidentialGuard;
    acked: boolean;
    thorough?: boolean;
    /** Place and time of an event from the owner's calendar, only for the executor. */
    place?: TaskPlace;
  }): void;
}

/** A running task, as `cancel_task` sees it. */
export interface RunningTaskInfo {
  /** Short number in this process ("1", "2"). */
  id: string;
  task: string;
  /** Logged-in session instead of research (D49). */
  site?: string;
  startedAt: Date;
}

export interface TaskControl {
  running(): RunningTaskInfo[];
  /** False when the task does not exist (anymore). */
  cancel(id: string): boolean;
}

/** One line per task, for the model (`cancel_task`, `overview`). The text comes from a clean turn (`run_task` is `cleanTurnOnly`). */
export function describeRunning(info: RunningTaskInfo, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - info.startedAt.getTime()) / 60_000));
  const what = info.site ? `session at ${info.site}: ` : "";
  return `[${info.id}] for ${minutes} min: ${what}"${info.task.replace(/\s+/g, " ").slice(0, 120)}"`;
}

/**
 * `cancel_task` cancels a running task (audit 2026-10-05). Before, that only
 * worked through the kill switch, which stops and locks everything, or not at
 * all. Only on the owner's word (`ownerOriginOnly`): a mail trigger must not
 * be able to cancel their research. Cancelled means the same as with the kill
 * switch: no result turn, `tasks.status = cancelled` (D52).
 */
export function cancelTaskTools(control: TaskControl, now: () => Date = () => new Date()): ToolDefinition[] {
  return [
    defineTool({
      name: "cancel_task",
      description:
        `Cancels a running background task (run_task, run_site_task) when ${owner.name} no longer wants it. ` +
        "Without task_id when only one is running; if several are running, the result gives you their numbers. task_id \"all\" " +
        "cancels all of them. A cancelled task delivers no result anymore.",
      level: "write_reversible",
      ownerOriginOnly: true,
      schema: {
        task_id: z.string().trim().max(10).optional().describe('Number from the list, or "all".'),
      },
      async run(args) {
        const running = control.running();
        if (running.length === 0) return { ok: true, text: "Nothing cancelled: no task is running right now." };
        const all = args.task_id !== undefined && /^(alle|all)$/i.test(args.task_id);
        const targets = all
          ? running
          : args.task_id !== undefined
            ? running.filter((info) => info.id === args.task_id)
            : running.length === 1
              ? running
              : [];
        if (targets.length === 0) {
          return {
            ok: true,
            text:
              `Nothing cancelled: ${args.task_id === undefined ? "several tasks are running" : `task ${args.task_id} is not running`}.\n` +
              running.map((info) => describeRunning(info, now())).join("\n") +
              `\nCall cancel_task with the task_id of the right one. If it is unclear which one ${owner.name} means, ask them briefly.`,
          };
        }
        const stopped = targets.filter((info) => control.cancel(info.id));
        if (stopped.length === 0) return { ok: true, text: "Nothing cancelled: the task was already finished." };
        return {
          ok: true,
          text:
            `Cancelled: ${stopped.map((info) => describeRunning(info, now())).join("; ")}.\n` +
            `Tell ${owner.name} briefly that it is stopped.`,
        };
      },
    }),
  ];
}

/** What `screenshot: true` appends to the task (style round, addendum D23 of 2026-10-08). */
export const TASK_SCREENSHOT_LINE = "Take a screenshot of the page that shows the result.";

/**
 * Acknowledgement in words when no 🔍 works. Announces, claims nothing. Wording
 * from the style round (addendum D23 of 2026-10-08), a fixed text in the
 * owner's language (`src/i18n/messages/tools.ts`).
 */
export function taskAckText(): string {
  return t(messages.taskAck);
}

export interface TaskToolDeps {
  tasks: TaskPort;
  port: MessagePort;
  /** The confidential values from the user model and memory, fresh per task. Throws when they cannot be loaded. */
  confidential(): Promise<ConfidentialGuard>;
}

export function taskTools(deps: TaskToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: "run_task",
      comesBack: true,
      description:
        "Gives a research task to your executor: search the web, read public pages, " +
        "compile. For everything current and everything you do not know for sure. It knows neither " +
        `${owner.name} nor the history, so the task must stand on its own, and it carries only the ` +
        "personal details without which it cannot be solved: the town instead of the address, never numbers, " +
        "accounts or mail addresses. Matching preferences from your memory belong in it (home town as start, " +
        `ticket or rail card, diet, sizes), without address and without numbers. This tool sets the 🔍 on ${owner.name}'s message ` +
        "itself; you write them nothing before.",
      level: "read",
      // A turn that has read untrusted content starts no new fetch: the task
      // text would be the way to carry the owner's data into a URL.
      cleanTurnOnly: true,
      schema: {
        task: z
          .string()
          .trim()
          .min(10)
          .max(1_500)
          .describe("The task, complete: what is wanted, for when and where, and what the result should contain."),
        screenshot: z
          .boolean()
          .default(false)
          .describe(
            `true for every weather forecast (even for one day), every timetable, every table and when ${owner.name} wants a ` +
              `screenshot: the executor then captures the page with the result, and you send it to ${owner.name} along. Never for ` +
              `menus, price lists and other PDFs: the executor reads them, and ${owner.name} gets them as they are, short ones as an image per ` +
              `page. If ${owner.name} wants something like that as an image, the task only says which menu or which PDF to read.`,
          ),
        thorough: z
          .boolean()
          .default(false)
          .describe(
            "true when it is about money, health or law (insurance, taxes, contracts, loans, medication, " +
              "symptoms, rights and deadlines): then the executor opens at least five primary sources and takes longer. " +
              `Otherwise always false, even when ${owner.name} says "thoroughly" or "start over" or an earlier attempt was not ` +
              "enough: then the task says what was missing.",
          ),
        event_id: z
          .string()
          .trim()
          .max(10)
          .optional()
          .describe(
            "ID of an event from <events> in the <context> (t1, t2 …) when the research depends on its place (weather, " +
              "getting there, what is there). The system inserts the place for the executor; in the task you write \"at the place " +
              "of the event\". You do not know the place and do not guess it. Only IDs listed there.",
          ),
      },
      async run(args, turn) {
        const blocker = await deps.tasks.precondition();
        if (blocker) {
          await audit("tool_denied", { tool: "run_task", reason: "precondition", detail: blocker }, turn.triggerMessageId);
          return { ok: false, text: `Not possible right now: ${blocker} Tell ${owner.name} directly.` };
        }
        let guard: ConfidentialGuard;
        try {
          guard = await deps.confidential();
        } catch (error) {
          await audit(
            "tool_denied",
            { tool: "run_task", reason: "confidential_unavailable", detail: (error as Error).message },
            turn.triggerMessageId,
          );
          return {
            ok: false,
            text: `Not possible right now: your memory is not readable, and without it the task cannot be checked. Tell ${owner.name} directly.`,
          };
        }
        const leaks = guard.check(args.task);
        if (leaks.length > 0) {
          await audit("tool_denied", { tool: "run_task", reason: "confidential", kinds: leaks }, turn.triggerMessageId);
          return {
            ok: false,
            text:
              `Not started: the task contains ${describeKinds(leaks)} from your memory. That does not leave the ` +
              "server, because the executor carries the task into URLs and search queries. Call run_task again, " +
              "only as precise as necessary: the town or district instead of the address, and entirely without numbers, " +
              `accounts and mail addresses. If that is not enough for the question, tell ${owner.name} what you would need for it.`,
          };
        }
        let place: TaskPlace | undefined;
        if (args.event_id !== undefined && args.event_id !== "") {
          const ref = turn.calendarRefs.resolve(args.event_id);
          if (!ref) {
            // Only what was in the <context> of this turn: a guessed ID finds nothing.
            await audit("tool_denied", { tool: "run_task", reason: "unknown_event" }, turn.triggerMessageId);
            const known = turn.calendarRefs.ids();
            return {
              ok: false,
              text:
                `Not started: there is no event ${args.event_id.slice(0, 10)} in this turn. ` +
                (known.length > 0
                  ? `There are only ${known.join(", ")} from <events>. Take the matching ID, or call run_task without event_id.`
                  : `The <context> lists no events with a place. Call run_task without event_id, or ask ${owner.name} where it is.`),
            };
          }
          // The place goes through the same filter (D29). If the full address is confidential, postcode and town are enough.
          const placeLeaks = guard.check(ref.location);
          const coarse = coarsePlace(ref.location);
          const location = placeLeaks.length === 0 ? ref.location : coarse && guard.check(coarse).length === 0 ? coarse : null;
          if (!location) {
            await audit("tool_denied", { tool: "run_task", reason: "confidential_place", kinds: placeLeaks }, turn.triggerMessageId);
            return {
              ok: false,
              text:
                `Not started: the place of ${ref.id} contains ${describeKinds(placeLeaks)} from your memory ` +
                "and does not go to the executor. Call run_task without event_id and name the place as coarsely as you know it from your " +
                `memory (the town), or ask ${owner.name}.`,
            };
          }
          place = { when: ref.when, location };
        }
        // What the owner already had before the 🔍 was tried: a failed tapback counts in the turn.
        const heardBefore = turn.ownerHeard;
        let acked = false;
        if (deps.port.canReact && turn.triggerExternalId && turn.reactableIds.includes(turn.triggerExternalId)) {
          if (turn.claimReaction()) acked = await deps.port.react(turn.triggerExternalId, SIGNALS.working);
        }
        // Only when the owner is waiting for this answer right now: a scheduled task needs no acknowledgement.
        const ackedInText =
          !acked && !heardBefore && turn.origin === "owner_message" ? await acknowledgeInText(deps.port, turn) : false;
        deps.tasks.start({
          // Fixed sentence from the code: the executor only takes screenshots when the task asks for it.
          task: args.screenshot ? `${args.task}\n${TASK_SCREENSHOT_LINE}` : args.task,
          triggerExternalId: turn.triggerExternalId,
          triggerMessageId: turn.triggerMessageId,
          guard,
          acked,
          thorough: args.thorough,
          ...(place ? { place } : {}),
        });
        return {
          ok: true,
          text:
            // First line is the fact (it shows up in the history later), then the instruction.
            "Research is running in the background.\n" +
            (ackedInText ? `${owner.name} already got "${taskAckText()}". ` : "") +
            (place ? `The executor has the place of ${args.event_id?.trim().toLowerCase()}. ` : "") +
            `The result comes back to you as a turn of its own. End the turn now without writing ${owner.name} anything; ` +
            "nothing is done yet.",
        };
      },
    }),
  ];
}

/**
 * The acknowledgement as a message, in the thread of the question when the
 * channel can do that. Counts against the turn's messages like any other.
 */
async function acknowledgeInText(port: MessagePort, turn: TurnState): Promise<boolean> {
  if (!turn.claimMessage()) return false;
  const threaded = port.canReplyInThread && turn.triggerExternalId.length > 0;
  const sent = await port.send(taskAckText(), {
    kind: "task_ack",
    origin: turn.origin,
    taintSources: [...turn.taintSources],
    ...(threaded ? { replyTo: turn.triggerExternalId } : {}),
  });
  if (sent) turn.noteDelivered();
  return sent;
}
