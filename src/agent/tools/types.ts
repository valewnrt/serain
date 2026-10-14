import type { z, ZodRawShape } from "zod";
import type { OutboundFile } from "../../channel/types.js";
import {
  MAX_EFFECTS_PER_TURN,
  MAX_LINK_PREVIEWS_PER_TURN,
  MAX_MESSAGES_PER_TURN,
  MAX_REACTIONS_PER_TURN,
  MAX_TOOL_STEPS_PER_TURN,
  WRAP_UP_DENIALS,
} from "../../config/limits.js";
import { dropUnbackedLinks, findLinks, previewTarget, unbackedLinks } from "../../security/links.js";
import type { Screenshot } from "../../browser/screenshot.js";
import { CalendarRefs } from "../../calendar/refs.js";
import type { GrantScope } from "./grants.js";

/**
 * One tool world for two SDKs (D3, D4). A tool is defined exactly once: name,
 * description, Zod schema, safety level, handler. `src/agent/model.ts`
 * translates the same definition for the Claude Agent SDK (in-process MCP) and
 * for the Vercel AI SDK (OpenRouter fallback). The interaction layer sees
 * neither SDK.
 */

/** Levels per D8.3. The order is the ranking. */
export type ToolLevel = "read" | "write_reversible" | "irreversible" | "money";

/**
 * Levels that must not exist without the confirmation protocol (D8.3). As long
 * as the protocol does not exist, the registry refuses registration and
 * execution: fail closed, not "let it through for now and secure it later".
 */
export const CONFIRMATION_REQUIRED_LEVELS: readonly ToolLevel[] = ["irreversible", "money"];

export function needsConfirmation(level: ToolLevel): boolean {
  return CONFIRMATION_REQUIRED_LEVELS.includes(level);
}

const LEVEL_RANK: Record<ToolLevel, number> = {
  read: 0,
  write_reversible: 1,
  irreversible: 2,
  money: 3,
};

/** The stricter of two levels. */
export function stricterLevel(a: ToolLevel, b: ToolLevel): ToolLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/**
 * What a tool that needs confirmation must deliver for the preview (D8.3, W4).
 * The preview is built here, in the tool's code, from the checked arguments,
 * never from the model's text. Otherwise a model (or a page it has read) could
 * put a harmless preview in front of a different action.
 */
export interface ConfirmSpec {
  /**
   * What the owner reads before approving: a question, short, with every value
   * that matters, and names instead of addresses where the address decides
   * nothing (decision of 2026-10-13). `renderPreview` no longer adds a "shall
   * I?" head or instructions for approving: the question is here. May look
   * things up (D37: the preview counts the mails in the mailbox itself instead
   * of trusting a number from the model). If it throws, there is no preview and
   * nothing runs. Fixed wording comes from the catalog (`t()`), content
   * (recipients, text, titles) goes in verbatim as placeholder values.
   */
  preview(args: Record<string, unknown>): string | Promise<string>;
  /** The way back (W4). Required, even if it says "there is none". */
  undo(args: Record<string, unknown>): string;
  /**
   * Files the owner should look at before approving: they go into the thread
   * right under the preview (addendum D34 of 2026-10-08). Runs after `preview`,
   * with the same arguments.
   */
  files?(args: Record<string, unknown>): OutboundFile[];
  /**
   * The task type for a standing approval ("yes always"), e.g. the recipient.
   * Without this function the tool only gets single approvals. Structured
   * (kind plus parameters, `src/agent/tools/grants.ts`), never a sentence: the
   * confirmation protocol stores and matches it as canonical JSON
   * (`encodeGrant`) and puts it into words only when shown (`describeGrant`),
   * in the language of that moment. Null: no standing approval for this call.
   */
  grantKey?(args: Record<string, unknown>): GrantScope | null;
  /**
   * The owner asked for exactly this in this message, and the code can prove
   * it: then the tool runs without a preview (addendum D8 of 2026-10-03, case
   * "unsubscribe me from the kelvo newsletter"). Only gets the owner's own
   * words (`TurnState.ownerWords`), never model text. Returns the evidence
   * (what in their words matches), otherwise null. Only level `irreversible`,
   * never `money`, only in a turn the owner triggered.
   */
  namedByOwner?(args: Record<string, unknown>, ownerWords: string): string | null;
  /**
   * "yes, but tomorrow at 8" (addendum D14 of 2026-10-08). Without this entry
   * the tool only runs right away. Never for `money`.
   */
  later?: ConfirmLater;
  /**
   * How long the preview is valid, if not `APPROVAL_TTL_MS`. Only for previews
   * the owner did not ask for and therefore may not see right away
   * (`calendar_offer`, addendum D33 of 2026-10-10). Never for `money`.
   */
  ttlMs?: number;
  /**
   * Serain's own sentence above the preview instead of "shall I?" (addendum
   * D62 of 2026-10-10, only the offer from the mail). Built in the tool's code
   * from the checked arguments, never model text. Only level `irreversible`,
   * without `consequence` and without a standing approval (the registry checks
   * this at registration).
   */
  ask?(args: Record<string, unknown>): string;
  /**
   * Has the call become pointless in the meantime (the event is over)? Then a
   * 👍 on the expired preview does not reissue it; the owner only hears that it
   * expired (addendum D8 of 2026-10-10).
   */
  stale?(args: Record<string, unknown>): boolean;
}

/** How a tool may run later. The arguments are frozen since the preview anyway. */
export interface ConfirmLater {
  /**
   * Everything a default resolves at run time and the preview shows, e.g.
   * which mailbox a missing `account` means. Stored when scheduling,
   * recomputed before running; if it differs, nothing runs. If it throws,
   * nothing is scheduled.
   */
  pin(args: Record<string, unknown>): Record<string, unknown>;
  /** A reason why exactly this call only works right away (attachments), with the sentence for the owner. */
  refuse?(args: Record<string, unknown>): { reason: string; text: string } | null;
}

export interface ToolResult {
  /** false reports an error to the model without aborting the turn. */
  ok: boolean;
  /** What the model sees as the tool result. Never a secret. */
  text: string;
  /**
   * Where the content comes from (URL, search query). Only for tools with
   * `returnsUntrusted`: it becomes the source in the marking and in the audit log.
   */
  source?: string;
  /**
   * Domain of the sender that the owner's provider confirmed via DMARC. Only
   * counts for tools with `vouchesSender`: then its home page may go to the
   * owner as a link (addendum D8.4 of 2026-10-12).
   */
  senderDomain?: string;
  /**
   * Identifier of what the tool created or changed (event id), because a later
   * turn needs it again ("delete that again"). Not part of the text: the
   * registry appends it to its first line (`withRef`), the audit log carries it
   * as its own field, and the history names it in full. Live finding
   * 2026-10-13: the note in the history was cut at 160 characters, the iCloud
   * id (over 150 characters) was at the end, and the model deleted with half
   * of it.
   */
  ref?: string;
}

/** What qualifies as `ToolResult.ref`: the same characters as the ids in the tool schemas. */
export const TOOL_REF = /^[A-Za-z0-9_-]{1,1024}$/;

/** The identifier as it appears after the first line of a result and in the history. */
export const refNote = (ref: string) => ` ID ${ref}.`;

/** Appends the identifier to the first line: that is where the fact is, and only that goes into the history. */
export function withRef(text: string, ref: string): string {
  const [first = "", ...rest] = text.split("\n");
  return [`${first}${refNote(ref)}`, ...rest].join("\n");
}

/**
 * What triggered this turn (D8.4). Required field: a new trigger should be a
 * compiler error and not a silent extension of rights.
 *
 * - `owner_message`: a message from the owner that passed the allowlist.
 * - `owner_reaction`: a 👎 or ❓ from the owner on a message from Serain
 *   (W24, D24). Comes from the owner but is not an instruction: a tapback has
 *   no text an owner-only tool could rely on.
 * - `schedule`: a due entry from `schedules`. The owner caused it at some
 *   point, but not now: the direct instruction owner-only tools rely on does
 *   not exist in this turn.
 * - `heartbeat`: Serain woke itself up.
 * - `approval`: the owner approved a preview; the turn executes or phrases the
 *   result. The approval was for exactly this one action, not for everything
 *   the model comes up with afterwards.
 * - `task`: a background task of the executor, or the turn that phrases its
 *   result. Almost always carries untrusted content.
 * - `untrusted`: untrusted content as the trigger (mail trigger, phase 4).
 */
export type TurnOrigin =
  | "owner_message"
  | "owner_reaction"
  | "schedule"
  | "heartbeat"
  | "approval"
  | "task"
  | "untrusted";

export interface ToolDefinition<Schema extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  level: ToolLevel;
  /** Zod raw shape (object of fields), because that is exactly what the Agent SDK expects. */
  schema: Schema;
  /** After this tool the turn is over. */
  endsTurn?: boolean;
  /**
   * A message to the owner (`send_message`, `reply_in_thread`). Still runs when
   * a turn is at the step limit and the owner has heard nothing
   * (`TurnState.wrappingUp`), and then costs no step.
   */
  answersOwner?: boolean;
  /**
   * Runs only in a turn the owner triggered (D8.4). For tools whose
   * justification is the direct instruction: `forget_fact` deletes hard and is
   * still `write_reversible`, because the instruction is the confirmation;
   * without that instruction the reasoning does not hold. Fail closed: with any
   * other origin the execution is refused and logged.
   */
  ownerOriginOnly?: boolean;
  /**
   * No longer runs once the turn has seen untrusted content, no matter who
   * triggered it. For tools that can carry data outside: a turn that read a
   * prepared page must not be able to start a new fetch with the owner's data
   * in the URL.
   */
  cleanTurnOnly?: boolean;
  /**
   * The tool only exists in turns of these origins: otherwise it is neither
   * offered nor executed. For tools that only make sense in a self-triggered
   * turn (`cancel_silently`, W5): in a conversation with the owner, "cancel
   * silently" would be a way to ignore them.
   */
  origins?: readonly TurnOrigin[];
  /**
   * The result contains content from an untrusted source (web page, search
   * hit, program output). The registry then wraps it with `wrapUntrusted` and
   * sets the turn's taint (D8.4, W1). Declared on the definition so no handler
   * can forget it.
   */
  returnsUntrusted?: boolean;
  /**
   * The result is not in the audit log, only its length. For content from the
   * owner's accounts (W13): the audit log is append-only, what is in there
   * could never be deleted when an integration is disconnected. And for
   * one-time codes (W17, D8.5). Call, arguments and success are still logged.
   */
  privateResult?: boolean;
  /**
   * The text of the arguments reaches the owner (message, reminder, file,
   * proposal). After untrusted content the registry checks every link in it
   * (addendum D8.4 of 2026-10-08, `src/security/links.ts`).
   */
  textToOwner?: boolean;
  /**
   * The tool itself opens a page on the web (fetch, browser, video), and
   * `source` is its address. Only such pages count as opened: links there may
   * go to the owner after untrusted content (addendum D8.4) and go out as a
   * preview (addendum D48 of 2026-10-08). Mail, calendar, connections and
   * logged-in sessions never carry it.
   */
  opensPages?: boolean;
  /**
   * The tool reads a mail, and `senderDomain` in the result comes from the
   * verdict of the owner's provider, never from the mail text
   * (`src/mail/sender-auth.ts`). Then, after this content, the home page of
   * that domain may go to the owner as a link, without path and without query
   * (addendum D8.4 of 2026-10-12).
   */
  vouchesSender?: boolean;
  /**
   * The argument `links` goes to the owner as a link preview. The registry
   * checks it before the run and before the audit (`TurnState.previewTargets`,
   * addendum D48 of 2026-10-08); the link evidence from D8.4 then only applies
   * to the remaining text.
   */
  linkPreviews?: boolean;
  /**
   * The tool may already have run in a preempted turn (D50): it changes
   * nothing and sends nothing, a second call in the follow-up turn is
   * harmless. Every other tool commits the turn before it runs; after that a
   * later message can no longer preempt it. Fail closed: without this flag a
   * tool commits, even one of level `read` (`run_task` only reads and still
   * starts a task).
   */
  repeatable?: boolean;
  /**
   * After this tool Serain comes back on its own: a task, a reminder, a
   * watcher, a mission, an expected mail. Holds a promise to the owner ("i'll
   * get back to you") (`TurnState.promiseOpen`, addendum D33 of 2026-10-13).
   * Only counts if the tool succeeded.
   */
  comesBack?: boolean;
  /**
   * Level by consequence of cost (W1). The level of a call is decided by what
   * it costs, not by what it looks like: a reservation with a cancellation fee
   * is `money`, even if it looks like a calendar entry. Can only raise the
   * level, never lower it.
   */
  consequence?(args: Record<string, unknown>): ToolLevel;
  /** Required as soon as `level` or `consequence` can require a confirmation. */
  confirm?: ConfirmSpec;
  /**
   * How long a call may take, preview included; without it `TOOL_TIMEOUT_MS`.
   * Only for tools that legitimately need longer.
   */
  timeoutMs?: number;
  run(args: Record<string, unknown>, turn: TurnState): Promise<ToolResult>;
}

/**
 * Defines a tool type-safely and stores it in the schemaless form the registry
 * holds. The cast happens exactly here, once, instead of at every call site.
 */
export function defineTool<Schema extends ZodRawShape>(
  def: Omit<ToolDefinition<Schema>, "run" | "consequence" | "confirm"> & {
    run(args: z.infer<z.ZodObject<Schema>>, turn: TurnState): Promise<ToolResult>;
    consequence?(args: z.infer<z.ZodObject<Schema>>): ToolLevel;
    confirm?: {
      preview(args: z.infer<z.ZodObject<Schema>>): string | Promise<string>;
      undo(args: z.infer<z.ZodObject<Schema>>): string;
      grantKey?(args: z.infer<z.ZodObject<Schema>>): GrantScope | null;
      files?(args: z.infer<z.ZodObject<Schema>>): OutboundFile[];
      namedByOwner?(args: z.infer<z.ZodObject<Schema>>, ownerWords: string): string | null;
      later?: {
        pin(args: z.infer<z.ZodObject<Schema>>): Record<string, unknown>;
        refuse?(args: z.infer<z.ZodObject<Schema>>): { reason: string; text: string } | null;
      };
      ttlMs?: number;
      ask?(args: z.infer<z.ZodObject<Schema>>): string;
      stale?(args: z.infer<z.ZodObject<Schema>>): boolean;
    };
  },
): ToolDefinition {
  return def as unknown as ToolDefinition;
}

export interface TurnLimits {
  maxMessages: number;
  maxReactions: number;
  maxSteps: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  maxMessages: MAX_MESSAGES_PER_TURN,
  maxReactions: MAX_REACTIONS_PER_TURN,
  maxSteps: MAX_TOOL_STEPS_PER_TURN,
};

/**
 * A PDF the executor read from the web in this task, only in memory.
 * `send_file` sends it to the owner as a file instead of a preview.
 */
export interface SourcePdf {
  /** Identifier within the task, e.g. d1. */
  id: string;
  url: string;
  /** File name from the address, without extension. */
  name: string;
  pdf: Buffer;
  /** At most three pages as JPEG: then the PDF goes to the owner like this, one image per page. */
  pages?: Buffer[];
}

/**
 * What a turn did, for whoever starts it: if a tool commits the turn
 * (`TurnState.commit`), something happened that a second run would repeat.
 * Set by the turn, read afterwards, even if it threw.
 */
export interface TurnProgress {
  committed: boolean;
  /**
   * An answer of this turn did not (fully) reach the owner because the channel
   * also aborted on the second attempt (addendum D52 of 2026-10-13). Then their
   * message is not settled, even if the turn ended cleanly.
   */
  undelivered?: boolean;
}

/**
 * The list to pick from out of a task (addendum D61 of 2026-10-09), built by
 * the code (`renderPicks`). The turn's first message to the owner takes it
 * along; what the turn did not send, the runtime sends afterwards. Hence a
 * shared object instead of a value.
 */
export interface PendingPicks {
  readonly bubbles: readonly string[];
  /** Lines that no longer fit; the model tells the owner. */
  readonly dropped: number;
  sent: boolean;
}

export interface TurnSetup {
  /**
   * What triggered this turn (D8.4). Required field, today always
   * `owner_message`.
   */
  origin: TurnOrigin;
  /** Channel id of the triggering message: target for reply thread and tapback. */
  triggerExternalId: string;
  /** DB id of the same message, so the audit keeps the reference. */
  triggerMessageId: string;
  /** Channel ids this turn may react to: only messages of this turn. */
  reactableIds: string[];
  limits?: TurnLimits;
  /**
   * Narrow toolbox: if the list exists, only these tools exist in this turn.
   * For turns nobody triggered (heartbeat, D9): what Serain does on its own
   * should be countable on one hand. Enforced in the registry, not only when
   * offering.
   */
  toolNames?: readonly string[];
  /**
   * Untrusted content the turn already carries at the start, e.g. the result of
   * a confirmed tool that the turn only has to phrase.
   */
  taintSources?: string[];
  /**
   * What the owner wrote or said in the messages of this turn, without images
   * and without system notes. Only for `owner_message`.
   */
  ownerWords?: string;
  /**
   * May a later message from the owner still preempt this turn (D50)? Only
   * message turns carry this. Without it: never.
   */
  preemption?: Preemption;
  /**
   * Messages from the owner that arrive while this turn is already committed
   * (D57). Only message turns carry this. Without it: none.
   */
  steering?: Steering;
  /**
   * May a tool that is blocked here after untrusted content be caught up right
   * after in a clean turn on the same message (D8.4, addendum 2026-10-08)? Only
   * message turns, and never the catch-up turn itself.
   */
  followUp?: boolean;
  /**
   * Pages a tool already opened for this turn, e.g. the executor for its
   * result. Links there may go to the owner even after untrusted content
   * (addendum D8.4 of 2026-10-08).
   */
  openedPages?: readonly string[];
  /** Screenshots the executor took for this turn (addendum D48 of 2026-10-08). */
  screenshots?: readonly Screenshot[];
  /** The list to pick from out of the task (addendum D61 of 2026-10-09). */
  picks?: PendingPicks;
  /** PDFs the executor read, only in memory. */
  documents?: readonly SourcePdf[];
  /** Remembers whether the turn did something with an effect (`TurnProgress`). */
  progress?: TurnProgress;
  /**
   * The events with a location that this turn sees as identifiers in the
   * `<context>` (addendum D54 of 2026-10-10). Only these does `run_task`
   * resolve with `event_id`.
   */
  calendarRefs?: CalendarRefs;
  /**
   * The owner is waiting for this turn although they did not trigger it: the
   * result of their task, even an empty or failed one. The turn then does not
   * end silently (`TurnState.owesAnswer`).
   */
  reportOwed?: boolean;
}

/** A message sent in afterwards, read and ready for the model (D57). */
export interface SteerContent {
  /** What the owner typed or said. Becomes part of `TurnState.ownerWords` once the model has seen it. */
  ownerWords: string;
  /** What the model reads: their words, framed images, notes on attachments. Empty: nothing to say. */
  text: string;
  /** Untrusted content in it, e.g. an image. Sets the taint as soon as the text goes to the model. */
  taintSources: readonly string[];
}

/** A message sent in afterwards, as the turn reports it at the end. */
export interface SteerReport {
  /** DB id of the message. */
  id: string;
  arrivedAt: number;
  /** When the model saw it (ms since epoch); only for seen ones. */
  seenAt: number | null;
  content: SteerContent | null;
  /** Was already in a tool result, but the model did not get another turn after that. */
  delivered: boolean;
}

interface SteerEntry {
  id: string;
  externalId: string;
  arrivedAt: number;
  status: "reading" | "ready" | "delivered" | "seen" | "failed";
  content: SteerContent | null;
  seenAt: number | null;
}

/**
 * Steering a running turn (D57). If the owner writes while Serain has already
 * done something (the turn is committed, D50, and can no longer be preempted),
 * the message goes into this turn instead of waiting behind it.
 *
 * The way into the model is the same for both SDK paths: the registry appends
 * the message to the next tool result (`TurnState.deliverSteers`). The model
 * has only seen it with its next response (`TurnState.noteResponse`); only
 * then do its words count as the owner's words in the turn. What the turn did
 * not see anymore, the runtime puts back into the queue at the end: it runs as
 * its own turn right after, it is never lost.
 *
 * States of a message: `reading` (attachments are being read), `ready`,
 * `delivered` (in a tool result), `seen`, `failed` (reading failed, goes back
 * into the queue).
 */
export class Steering {
  private readonly entries: SteerEntry[] = [];
  private sealed = false;

  /** Accepts a message. False once the turn can no longer read any. */
  offer(id: string, externalId: string, arrivedAt: number): boolean {
    if (this.sealed) return false;
    this.entries.push({ id, externalId, arrivedAt, status: "reading", content: null, seenAt: null });
    return true;
  }

  /** The message has been read. Without text there is nothing to say: it counts as seen. */
  ready(id: string, content: SteerContent): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry || entry.status !== "reading") return;
    entry.content = content;
    if (content.text) entry.status = "ready";
    else {
      entry.status = "seen";
      entry.seenAt = Date.now();
    }
  }

  /** Reading failed: the message gets its own turn. */
  fail(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry?.status === "reading") entry.status = "failed";
  }

  /** From now on the turn accepts nothing more. */
  seal(): void {
    this.sealed = true;
  }

  /** Read and not yet sent to the model. */
  get hasReady(): boolean {
    return this.entries.some((entry) => entry.status === "ready");
  }

  /** Sent to the model, but not yet seen by it. */
  get hasDelivered(): boolean {
    return this.entries.some((entry) => entry.status === "delivered");
  }

  /** Has the model already seen a message sent in afterwards in this turn? */
  get anySeen(): boolean {
    return this.entries.some((entry) => entry.status === "seen" && entry.content?.text);
  }

  /** What can go to the model now; afterwards `delivered`. */
  take(): Array<{ externalId: string; content: SteerContent }> {
    return this.move("ready", "delivered");
  }

  /** The model starts a new response: what reached it before, it has seen. */
  markSeen(): Array<{ externalId: string; content: SteerContent }> {
    return this.move("delivered", "seen");
  }

  /**
   * The fallback restarts the turn (D3): everything read belongs into its
   * input. What was already seen stays seen; the rest goes out now.
   */
  restart(takeReady: boolean): { all: SteerContent[]; fresh: SteerContent[] } {
    const fresh = takeReady ? this.move("ready", "delivered").map((entry) => entry.content) : [];
    const all = this.entries.flatMap((entry) =>
      entry.content?.text && (entry.status === "delivered" || entry.status === "seen") ? [entry.content] : [],
    );
    return { all, fresh };
  }

  /** Turn over: what the model has seen belongs to it, the rest does not. */
  close(): { seen: SteerReport[]; unseen: SteerReport[] } {
    this.sealed = true;
    const report = (entry: SteerEntry): SteerReport => ({
      id: entry.id,
      arrivedAt: entry.arrivedAt,
      seenAt: entry.seenAt,
      content: entry.content,
      delivered: entry.status === "delivered",
    });
    return {
      seen: this.entries.filter((entry) => entry.status === "seen").map(report),
      unseen: this.entries.filter((entry) => entry.status !== "seen").map(report),
    };
  }

  private move(from: SteerEntry["status"], to: SteerEntry["status"]): Array<{ externalId: string; content: SteerContent }> {
    const moved: Array<{ externalId: string; content: SteerContent }> = [];
    for (const entry of this.entries) {
      if (entry.status !== from || !entry.content) continue;
      entry.status = to;
      if (to === "seen") entry.seenAt = Date.now();
      moved.push({ externalId: entry.externalId, content: entry.content });
    }
    return moved;
  }
}

/** How a message sent in afterwards appears in the tool result (D57). */
export function renderSteers(steers: readonly { externalId: string; content: SteerContent }[]): string {
  return steers
    .map((steer) => `<addendum message_id="${steer.externalId.replace(/["<>\s]/g, "")}">\n${steer.content.text}\n</addendum>`)
    .join("\n");
}

/**
 * Preemption of a message turn by a straggler message (D50).
 *
 * The owner often writes two thoughts in two messages. Instead of waiting
 * three seconds for a possible second one, the turn starts after a short
 * window; if the second arrives while it has not yet done anything the owner
 * sees or that stays, it aborts and a new turn starts with both messages.
 *
 * Both transitions are final and exclude each other: a committed turn can no
 * longer be preempted, a preempted one can no longer be committed. The
 * registry commits before it starts a tool, in the same synchronous section
 * as the check; between check and effect there is no `await` in which a
 * preemption could slip in.
 */
export class Preemption {
  private state: "open" | "committed" | "cancelled" = "open";
  /** Resolves as soon as the turn is preempted. */
  readonly cancelled: Promise<void>;
  private markCancelled: () => void = () => undefined;

  constructor() {
    this.cancelled = new Promise<void>((resolve) => {
      this.markCancelled = resolve;
    });
  }

  get isCancelled(): boolean {
    return this.state === "cancelled";
  }

  /** Preempt. False if the turn is already committed. */
  cancel(): boolean {
    if (this.state === "committed") return false;
    if (this.state === "open") {
      this.state = "cancelled";
      this.markCancelled();
    }
    return true;
  }

  /** Commit. False if the turn is already preempted. */
  commit(): boolean {
    if (this.state === "cancelled") return false;
    this.state = "committed";
    return true;
  }
}

/**
 * State of a turn. Counts what already went out, and is the place where a
 * derailed loop ends hard. The SDKs' own step limits are the second belt, not
 * the first.
 */
export class TurnState {
  readonly origin: TurnOrigin;
  readonly triggerExternalId: string;
  readonly triggerMessageId: string;
  /** Channel ids this turn may react to; a message sent in afterwards is added once the model has seen it (D57). */
  get reactableIds(): readonly string[] {
    return this.reactable;
  }
  private readonly reactable: string[];
  readonly limits: TurnLimits;
  readonly toolNames: readonly string[] | null;
  /**
   * The owner's own words in this turn (`TurnSetup.ownerWords`); empty if the owner did not trigger it.
   * A message sent in afterwards (D57) is only added once the model has seen it: a
   * tool it planned before must not rely on it (`namedByOwner`).
   */
  get ownerWords(): string {
    return this.ownerText;
  }
  private ownerText: string;
  private readonly preemption: Preemption | null;
  private readonly steering: Steering | null;
  /** How much the owner had seen when the model last saw a message they sent in afterwards (D57). */
  private heardMark = 0;

  messagesSent = 0;
  /**
   * Messages the channel really accepted. `messagesSent` counts attempts (the
   * limit per turn); only this says whether the owner got something.
   */
  messagesDelivered = 0;
  /** An answer to the owner did not (fully) arrive (`noteUndelivered`). */
  undelivered = false;
  reactionsSent = 0;
  /** Previews of the confirmation protocol that went to the owner in this turn. */
  previewsSent = 0;
  /**
   * When the owner was first supposed to get something in this turn: message,
   * tapback or preview (`performance.now()`). For the latency in the audit (D50).
   */
  firstVisibleAt: number | null = null;
  /** Messages with an iMessage effect (D48). */
  effectsUsed = 0;
  steps = 0;
  /**
   * The step limit is reached, but the owner has not received anything yet.
   * The turn keeps running, only for one message to them (`answersOwner`);
   * every other tool is refused, at most `WRAP_UP_DENIALS` times.
   */
  wrappingUp = false;
  private wrapUpDenials = 0;
  /**
   * Set by `forget_fact`: this turn may not learn any facts afterwards.
   * Otherwise the deleted fact would be right back: "forget that i X" is a
   * message that contains X, and the write path runs over exactly this
   * message.
   */
  factExtractionBlocked = false;
  /**
   * Sources of untrusted content this turn has already seen (D8.4, W1). From
   * the first entry on, the registry refuses owner-only tools: the instruction
   * could come from the web page instead of the owner, and from the outside
   * the two cannot be told apart.
   */
  readonly taintSources: string[] = [];
  /**
   * The taint came with the owner's own message (an image, at the start or
   * sent in afterwards). A catch-up turn would read the same image and be just
   * as unclean.
   */
  private ownerTainted = false;
  /**
   * Promises (addendum D33 of 2026-10-13): Serain wrote to the owner that it
   * will get back later (`promisesFollowUp`), and nothing ran in this turn yet
   * that makes it come back on its own (`comesBack`). Then the turn does not
   * end, once.
   */
  private promised = false;
  private promiseHeld = false;
  private promiseReminded = false;
  private readonly followUpAllowed: boolean;
  /** `TurnSetup.reportOwed`. */
  readonly reportOwed: boolean;
  /**
   * Tools this turn was no longer allowed after untrusted content and that a
   * clean turn right after catches up (addendum D8.4 of 2026-10-08). Only the
   * names: the arguments were chosen by a model that had read untrusted
   * content.
   */
  readonly deferred: string[] = [];
  /**
   * Pages a tool successfully opened in this turn, plus those from
   * `TurnSetup.openedPages`. Only there may a link go after untrusted content.
   */
  readonly openedPages: string[] = [];
  /** Sender domains a tool with `vouchesSender` got confirmed in this turn. Only their home pages. */
  private readonly senderDomains: string[] = [];
  /** Screenshots from the task, only in memory; `send_file` sends them to the owner. */
  readonly screenshots: readonly Screenshot[];
  /** The list to pick from out of the task; the first message to the owner takes it along. */
  readonly picks: PendingPicks | null;
  /** PDFs from the task; `send_file` sends them as a file. */
  readonly documents: readonly SourcePdf[];
  /** `TurnSetup.progress`. */
  private readonly progress: TurnProgress | null;
  /** `TurnSetup.calendarRefs`; empty if the `<context>` showed no events. */
  readonly calendarRefs: CalendarRefs;
  /** Link previews this turn has already sent. */
  previewsUsed = 0;
  /** Set when a limit is reached or after the step with `end_turn`. */
  stopped = false;
  stopReason: string | null = null;
  /**
   * `end_turn` was called, but the running step is finished first. See
   * `runSerial`.
   */
  endRequested = false;
  private endReason: string | null = null;

  /**
   * Tool runs of this turn run one after another, in call order. Two counters
   * for that: the chain serializes, `pending` detects the end of a step.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;

  /**
   * Resolves as soon as the turn is really over: after the last tool of the
   * step, not at the first `end_turn`.
   *
   * The model layer hangs the abort of the SDK request on it. Without this
   * signal the Agent SDK path kept running after `end_turn` and started more
   * model steps, which the registry then refused one by one (live test
   * 2026-09-18): three `tool_denied` in ten seconds, among them a
   * `send_message` the owner never saw.
   */
  readonly untilStopped: Promise<void>;
  private markStopped: () => void = () => undefined;

  constructor(setup: TurnSetup) {
    this.untilStopped = new Promise<void>((resolve) => {
      this.markStopped = resolve;
    });
    this.origin = setup.origin;
    this.triggerExternalId = setup.triggerExternalId;
    this.triggerMessageId = setup.triggerMessageId;
    this.reactable = [...setup.reactableIds];
    this.limits = setup.limits ?? DEFAULT_TURN_LIMITS;
    this.toolNames = setup.toolNames ? [...setup.toolNames] : null;
    this.ownerText = setup.origin === "owner_message" ? (setup.ownerWords ?? "") : "";
    this.taintSources.push(...(setup.taintSources ?? []));
    this.ownerTainted = this.taintSources.length > 0;
    this.openedPages.push(...(setup.openedPages ?? []));
    this.screenshots = [...(setup.screenshots ?? [])];
    this.picks = setup.picks ?? null;
    this.documents = [...(setup.documents ?? [])];
    this.progress = setup.progress ?? null;
    this.calendarRefs = setup.calendarRefs ?? CalendarRefs.empty;
    this.followUpAllowed = setup.origin === "owner_message" && setup.followUp === true;
    this.reportOwed = setup.reportOwed === true;
    this.preemption = setup.preemption ?? null;
    this.steering = setup.origin === "owner_message" ? (setup.steering ?? null) : null;
    if (this.taintSources.length > 0) this.steering?.seal();
    // Preempted means over: the model layer aborts via `untilStopped`.
    void this.preemption?.cancelled.then(() => this.stop("preempted"));
  }

  /** Preempted by a straggler message (D50). */
  get preempted(): boolean {
    return this.preemption?.isCancelled === true;
  }

  /**
   * Commits the turn before a tool with an effect starts (D50). False means:
   * the turn is already preempted, the tool does not run.
   */
  commit(): boolean {
    const committed = this.preemption ? this.preemption.commit() : true;
    if (committed && this.progress) this.progress.committed = true;
    return committed;
  }

  /**
   * One tool step. False means: no more tools. If the owner is still waiting
   * for an answer, the turn does not end right away but goes into
   * `wrappingUp`; otherwise it is over.
   */
  claimStep(): boolean {
    if (this.steps < this.limits.maxSteps) {
      this.steps += 1;
      return true;
    }
    if (this.owesAnswer && this.wrapUpDenials < WRAP_UP_DENIALS) {
      this.wrappingUp = true;
      this.wrapUpDenials += 1;
      return false;
    }
    this.stop("step_limit");
    return false;
  }

  claimMessage(): boolean {
    if (this.messagesSent >= this.limits.maxMessages) {
      this.stop("message_limit");
      return false;
    }
    this.messagesSent += 1;
    this.noteVisible();
    return true;
  }

  /** The channel accepted a message of this turn. */
  noteDelivered(): void {
    this.messagesDelivered += 1;
  }

  /**
   * An answer to the owner failed at the channel (addendum D52 of 2026-10-13).
   * Stays set even if something goes through later: whether that replaces the
   * lost answer the code does not know, the second run sees it in the history.
   */
  noteUndelivered(): void {
    this.undelivered = true;
    if (this.progress) this.progress.undelivered = true;
  }

  /** The owner is about to see something (D50). */
  noteVisible(): void {
    this.firstVisibleAt ??= performance.now();
  }

  /**
   * An effect. Unlike messages, the turn does not end here: without the effect
   * the message still goes out.
   */
  claimEffect(): boolean {
    if (this.effectsUsed >= MAX_EFFECTS_PER_TURN) return false;
    this.effectsUsed += 1;
    return true;
  }

  claimReaction(): boolean {
    if (this.reactionsSent >= this.limits.maxReactions) {
      this.stop("reaction_limit");
      return false;
    }
    this.reactionsSent += 1;
    this.noteVisible();
    return true;
  }

  /**
   * Has the owner already received anything from Serain in this turn? Whether
   * a turn they triggered may end depends on it (see registry). After a message
   * sent in afterwards that the model has seen (D57), only what came after
   * counts: the owner is waiting for an answer to that too.
   */
  get ownerHeard(): boolean {
    return this.messagesSent + this.reactionsSent + this.previewsSent > this.heardMark;
  }

  /** Is the owner still waiting for a sign from Serain in this turn? */
  get owesAnswer(): boolean {
    return (this.origin === "owner_message" || this.origin === "approval" || this.reportOwed) && !this.ownerHeard;
  }

  /** Has the model seen a message sent in afterwards in this turn (D57)? */
  get steered(): boolean {
    return this.steering?.anySeen === true;
  }

  /**
   * Is a message sent in afterwards waiting that the model has not seen yet
   * (D57)? After untrusted content none goes in anymore (see `taint`); what is
   * still waiting then does not hold up the turn.
   */
  get steersAwaiting(): boolean {
    return this.steering?.hasDelivered === true || (!this.tainted && this.steering?.hasReady === true);
  }

  /**
   * Appends messages sent in afterwards to the tool result that is about to go
   * to the model (D57). Not anymore once the turn ends: then the model sees no
   * more results, and the runtime returns them as their own turn. An image in
   * them sets the taint now, not only when reading: from here on it is part of
   * the conversation.
   */
  deliverSteers(): string | null {
    if (!this.steering || this.stopped || this.endRequested || this.tainted) return null;
    const steers = this.steering.take();
    if (steers.length === 0) return null;
    for (const steer of steers) for (const source of steer.content.taintSources) this.taintFromOwner(source);
    return renderSteers(steers);
  }

  /**
   * The model starts a new response (D57). What reached it before, it has now
   * seen: from here on these are the owner's words in this turn, they wait for
   * an answer to them, and a tapback on them is allowed.
   */
  noteResponse(): void {
    const seen = this.steering?.markSeen() ?? [];
    for (const steer of seen) {
      if (steer.content.ownerWords) this.ownerText = [this.ownerText, steer.content.ownerWords].filter(Boolean).join("\n");
      if (steer.externalId) this.reactable.push(steer.externalId);
    }
    if (seen.length > 0) this.heardMark = this.messagesSent + this.reactionsSent + this.previewsSent;
  }

  /**
   * The fallback restarts the turn (D3): what the owner sent in meanwhile is
   * then right in its input, instead of hanging on a tool result that does not
   * exist in the new attempt (D57).
   */
  restartSteers(): string {
    if (!this.steering) return "";
    const { all, fresh } = this.steering.restart(!this.tainted);
    for (const content of fresh) for (const source of content.taintSources) this.taintFromOwner(source);
    return all.map((content) => content.text).join("\n");
  }

  /**
   * A turn the owner triggered does not end silently. Live finding 2026-09-21:
   * the owner gave a task, the model only called `end_turn` in the first step,
   * and nothing arrived, not even a tapback. Turns nobody triggered may keep
   * silent.
   *
   * The same applies to the turn after an approval: the owner set 👍 and waits
   * for the result. Live finding 2026-09-21: 23 senders cleaned up, two
   * unsubscribes failed, and the turn ended with nothing but `end_turn`.
   */
  get mayEnd(): boolean {
    // If the owner wrote in the meantime (D57), the model sees it before the turn ends.
    return !this.owesAnswer && !this.steersAwaiting && !this.promiseOpen;
  }

  /** Serain promised the owner in this turn to get back to them. */
  notePromise(): void {
    this.promised = true;
  }

  /** A tool with `comesBack` succeeded: Serain comes back on its own. */
  notePromiseHeld(): void {
    this.promiseHeld = true;
  }

  /**
   * Is there a promise without anything that holds it? Only in owner turns,
   * where `expect_mail` exists, and only once: if the model was reminded and
   * still created nothing, it meant nothing that has to come on its own.
   */
  get promiseOpen(): boolean {
    return this.origin === "owner_message" && this.promised && !this.promiseHeld && !this.promiseReminded;
  }

  /** The model got the reminder about the promise. */
  remindPromise(): void {
    this.promiseReminded = true;
  }

  /** Are siblings of the same step still queued behind the running tool? */
  get hasQueuedSiblings(): boolean {
    return this.pending > 1;
  }

  get tainted(): boolean {
    return this.taintSources.length > 0;
  }

  /**
   * From untrusted content on, the turn accepts no more messages from the
   * owner (D57): in a clean turn afterwards they may do everything that needs
   * the owner's direct instruction (`ownerOriginOnly`, `cleanTurnOnly`), here
   * not anymore. Live finding 2026-10-06: "make the reminder 10 instead"
   * arrived after the calendar had been read, the new reminder was created, the
   * old one could not be deleted.
   */
  taint(source: string): void {
    this.taintSources.push(source);
    this.steering?.seal();
  }

  /** A tool opened this page and got content. */
  noteOpened(url: string): void {
    if (/^https?:\/\//i.test(url) && !this.openedPages.includes(url)) this.openedPages.push(url);
  }

  /** The owner's provider confirmed that a mail that was read comes from this domain. */
  noteSender(domain: string): void {
    if (!this.senderDomains.includes(domain)) this.senderDomains.push(domain);
  }

  /**
   * Links in the text that may not go to the owner after untrusted content
   * (addendum D8.4 of 2026-10-08). Backed are opened pages, links from the
   * owner's own words and the home page of a confirmed sender (addendum of
   * 2026-10-12). In a clean turn: none.
   */
  unbackedLinks(text: string): string[] {
    return this.tainted ? unbackedLinks(text, this.linkBacking(), this.senderDomains) : [];
  }

  /**
   * Where the previews may point (addendum D48 of 2026-10-08): per link the
   * opened page without tracking parameters. If one does not work (not backed
   * or the turn's quota is full), none goes out. If the turn has a screenshot,
   * there is no preview: the owner wants one or the other (addendum D23 of
   * 2026-10-08), and the image shows the current state, the page's preview
   * image often does not.
   */
  previewTargets(links: readonly string[]): { ok: true; urls: string[] } | { ok: false; reason: "unbacked" | "limit" | "screenshot" | "document" } {
    if (this.screenshots.length > 0) return { ok: false, reason: "screenshot" };
    const urls: string[] = [];
    const documents = this.documents.map((doc) => previewTarget(doc.url, [doc.url]));
    for (const link of links) {
      const url = previewTarget(link, this.openedPages);
      if (url === null) return { ok: false, reason: "unbacked" };
      // A PDF that is there as a file goes as a file (decision of 2026-10-09): a preview throws the owner out of iMessage.
      if (documents.includes(url)) return { ok: false, reason: "document" };
      if (!urls.includes(url)) urls.push(url);
    }
    if (this.previewsUsed + urls.length > MAX_LINK_PREVIEWS_PER_TURN) return { ok: false, reason: "limit" };
    return { ok: true, urls };
  }

  /** Books the previews that are about to go out. */
  claimPreviews(count: number): void {
    this.previewsUsed += count;
  }

  /** For the emergency exit: unbacked links are dropped. */
  dropUnbackedLinks(text: string): string {
    return this.tainted ? dropUnbackedLinks(text, this.linkBacking(), this.senderDomains) : text;
  }

  private linkBacking(): string[] {
    return [...this.openedPages, ...findLinks(this.ownerText)];
  }

  private taintFromOwner(source: string): void {
    this.ownerTainted = true;
    this.taint(source);
  }

  /**
   * Mark a tool that is blocked after untrusted content for the clean turn
   * right after (addendum D8.4 of 2026-10-08). That turn reads the owner's
   * message again, as if they had just sent it. False if that changes nothing:
   * a trigger other than the owner, an image from them, or this turn already
   * is the catch-up turn.
   */
  defer(tool: string): boolean {
    if (!this.followUpAllowed || this.ownerTainted) return false;
    if (!this.deferred.includes(tool)) this.deferred.push(tool);
    return true;
  }

  stop(reason: string): void {
    this.stopped = true;
    this.stopReason ??= reason;
    // A turn that is over reads nothing more (D57).
    this.steering?.seal();
    this.markStopped();
  }

  /**
   * `end_turn` ends the turn, but not its siblings. A model may call
   * `send_message` and `end_turn` in the same step (on the OpenRouter path
   * exactly that happened), and then the message should go out, regardless of
   * the order the two had in the call. That is why this only takes note; it
   * becomes effective in `runSerial`.
   */
  requestEnd(reason: string): void {
    this.endRequested = true;
    this.endReason ??= reason;
  }

  /**
   * Runs tool calls one after another, in the order they were requested. Two
   * things depend on it:
   *
   * 1. **Order.** The Vercel AI SDK starts parallel tool calls of a step at the
   *    same time. Without this chain, chance would decide which bubble reaches
   *    the owner first.
   * 2. **Step boundary.** When the chain is empty, the step is done: another
   *    call can only come after the model has seen the results. Exactly there a
   *    pending `end_turn` becomes effective, and every call of a later step
   *    runs into `stopped`.
   *
   * The limits apply unchanged: they are drawn in the tools themselves and
   * stop the turn immediately, not only at the end of the step.
   */
  async runSerial<T>(work: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.chain.then(work);
    // The chain must not get stuck on an error: the next call should run, even
    // if the previous one threw.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } finally {
      this.pending -= 1;
      if (this.pending === 0 && this.endRequested && !this.stopped) {
        if (this.mayEnd) {
          this.stop(this.endReason ?? "end_turn");
        } else {
          // `end_turn` came before siblings none of which reached the owner,
          // or the owner wrote in the meantime (D57). The end does not count;
          // the registry tells the model why.
          this.endRequested = false;
          this.endReason = null;
        }
      }
    }
  }
}
