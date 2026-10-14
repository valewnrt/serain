import { z } from "zod";
import {
  AUDIT_TEXT_MAX_CHARS,
  MAX_LINK_PREVIEWS_PER_TURN,
  TOOL_ERROR_MAX_CHARS,
  TOOL_RESULT_MAX_CHARS,
  TOOL_TIMEOUT_MS,
} from "../../config/limits.js";
import { audit } from "../../db/audit.js";
import { log } from "../../log.js";
import { promisesFollowUp } from "../promises.js";
import { wrapUntrusted } from "../../security/untrusted.js";
import { clip } from "../../text/clip.js";
import {
  needsConfirmation,
  stricterLevel,
  TOOL_REF,
  withRef,
  type ConfirmLater,
  type ToolDefinition,
  type ToolLevel,
  type ToolResult,
  type TurnOrigin,
  type TurnState,
} from "./types.js";
import { owner } from "../../config/owner.js";
import { encodeGrant } from "./grants.js";

/**
 * Registry of all tools. Two jobs:
 *
 * 1. **Lock.** Tools of the levels `irreversible` and `money` need a
 *    confirmation via iMessage per D8.3. Without a `ConfirmationGate` the
 *    registry neither registers nor executes such tools; with it they never
 *    run from the model turn, only via `executeApproved` after the owner
 *    approved. Fail closed: a tool that can spend money only exists once the
 *    confirmation exists.
 * 2. **Execution with audit.** Arguments are checked against the Zod schema
 *    (two SDKs deliver raw JSON), every call lands in the audit log with
 *    arguments and result (D8.6).
 */

export class ToolBlockedError extends Error {
  constructor(public readonly tool: string, public readonly level: string, why?: string) {
    super(
      `Tool "${tool}" is level ${level} and needs the confirmation protocol (D8.3)` +
        (why ? `: ${why}` : ", which is not connected here."),
    );
    this.name = "ToolBlockedError";
  }
}

/**
 * The part of the confirmation protocol the registry sees
 * (`src/security/approvals.ts`). An interface, so the registry knows neither
 * channel nor database.
 */
export interface ConfirmationGate {
  covered(
    def: ToolDefinition,
    level: ToolLevel,
    args: Record<string, unknown>,
    turn: TurnState,
  ): Promise<boolean>;
  request(
    def: ToolDefinition,
    level: "irreversible" | "money",
    args: Record<string, unknown>,
    turn: TurnState,
  ): Promise<ToolResult>;
}

/** What `executeApproved` needs from a claimed confirmation. */
export interface ApprovedCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: string;
  /** Scheduled (addendum D14 of 2026-10-08): then `laterPin` applies too, and money never runs. */
  executeAt?: string | null;
  laterPin?: Record<string, unknown> | null;
}

/**
 * JSON with sorted keys. The database (jsonb) does not return objects in the
 * order they came in; what is compared is the content.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

/**
 * May this tool exist at all? Checked at registration *and* before every
 * execution. The second check is deliberate: it holds even if a tool got into
 * the list bypassing registration.
 *
 * A tool that *can* require a confirmation (through its level or through
 * `consequence`) needs the protocol and a preview.
 */
export function assertExecutable(def: ToolDefinition, gate?: ConfirmationGate): void {
  const mayNeedConfirmation = needsConfirmation(def.level) || def.consequence !== undefined;
  if (!mayNeedConfirmation) return;
  if (!gate) throw new ToolBlockedError(def.name, def.level);
  if (!def.confirm) throw new ToolBlockedError(def.name, def.level, "the tool has no preview.");
  // Its own sentence instead of "shall I?" only where the level is fixed and money is never involved (addendum D62 of 2026-10-10).
  if (def.confirm.ask && (def.level !== "irreversible" || def.consequence !== undefined || def.confirm.grantKey !== undefined)) {
    throw new ToolBlockedError(def.name, def.level, "its own sentence above the preview only works for level irreversible, without consequence and without a standing approval.");
  }
}

/**
 * Frames the result of a tool that delivers untrusted content, and sets the
 * taint. Also for `ok: false`: an error message can carry the other side's text.
 */
function markUntrusted(def: ToolDefinition, result: ToolResult, turn: TurnState): ToolResult {
  const source = result.source ?? def.name;
  turn.taint(source);
  // A page a tool really loaded may reach the owner as a link (addendum D8.4 of 2026-10-08)
  // and as a preview (addendum D48). The definition decides that, never the source's text.
  if (result.ok && def.opensPages === true) turn.noteOpened(source);
  // Likewise the home page of a sender the owner's provider confirmed (addendum D8.4 of 2026-10-12).
  if (result.ok && def.vouchesSender === true && result.senderDomain) turn.noteSender(result.senderDomain);
  return { ...result, text: wrapUntrusted(result.text, source) };
}

/** The stored form of the standing approval a call falls under, for the audit; empty without one. */
function grantKeyOf(def: ToolDefinition, args: Record<string, unknown>): string {
  const scope = def.confirm?.grantKey?.(args);
  return scope ? encodeGrant(scope) : "";
}

/** All texts in the arguments, nested ones too (event, contact). */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

/** Text of an exception, even if someone throws something other than an Error. */
function errorText(error: unknown): string {
  let text: string;
  try {
    text = error instanceof Error ? error.message : String(error);
  } catch {
    text = "unknown error";
  }
  return clip(text, TOOL_ERROR_MAX_CHARS);
}

/**
 * What a tool returns, as the registry passes it on. The shape is a contract,
 * not a promise: a tool without a text result has failed, and text that is too
 * long is shortened before it is framed (the framing stays whole).
 */
function checkedResult(raw: unknown): ToolResult {
  const result = raw as Partial<ToolResult> | null | undefined;
  if (!result || typeof result !== "object" || typeof result.text !== "string") {
    throw new Error("The tool did not return a valid result.");
  }
  // An id that does not fit is a bug in the tool. Failing because of it would mean reporting an
  // effect that already happened as failed; then the model creates it twice.
  const ref = typeof result.ref === "string" && TOOL_REF.test(result.ref) ? result.ref : undefined;
  if (result.ref !== undefined && !ref) log.error("Tool result with an invalid id, dropped");
  return {
    ok: result.ok === true,
    text: clip(ref ? withRef(result.text, ref) : result.text, TOOL_RESULT_MAX_CHARS),
    ...(ref ? { ref } : {}),
    ...(typeof result.source === "string" && result.source ? { source: result.source } : {}),
    ...(typeof result.senderDomain === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(result.senderDomain) ? { senderDomain: result.senderDomain } : {}),
  };
}

/** Does this tool exist in a turn of this origin and with this toolbox? */
function offeredIn(
  def: ToolDefinition,
  origin: TurnOrigin,
  toolNames: readonly string[] | null,
): boolean {
  if (def.origins && !def.origins.includes(origin)) return false;
  if (toolNames && !toolNames.includes(def.name)) return false;
  return true;
}

export interface ToolExecution extends ToolResult {
  /** Signals the model layer that the turn ends here. */
  endsTurn: boolean;
}

/**
 * Appended to every tool result as long as nothing has reached the owner yet
 * in a turn they started. Live and reproduced (2026-10-02): after a tool whose
 * result asks "tell the owner …", the model wrote the answer as text in about
 * every sixth run and called `end_turn`; text never reaches the owner, the
 * lock (`owner_unanswered`) caught it and cost a step. The hint is where the
 * model decides, not only in the system prompt.
 */
function unansweredHint(turn: TurnState): string {
  return (
    (turn.steered
      ? `\n\n(You have not answered ${owner.name}'s addendum yet. `
      : `\n\n(${owner.name} has not received anything from you in this turn yet. `) +
    "What they should read only goes out via send_message, reply_in_thread or react, never as text.)"
  );
}

/** Why the turn may not end here yet (`TurnState.mayEnd`). */
function endRefusal(turn: TurnState): string {
  if (turn.owesAnswer) {
    return (
      (turn.origin === "approval"
        ? `${owner.name} approved and is waiting for the result, nothing has come from you yet. `
        : turn.reportOwed
          ? `${owner.name} is waiting for the result of their task, even if nothing came of it. `
          : turn.steered
          ? `${owner.name} wrote to you again and has not received anything from you on it yet. `
          : `${owner.name} wrote to you and has not received anything from you yet. `) +
      "Send them a message or a tapback first, then end the turn."
    );
  }
  // D57: the model sees the addendum with this result or has just received it.
  if (turn.steersAwaiting) return `Not ended: ${owner.name} has written to you again in the meantime (<addendum>). Respond to it, then end the turn.`;
  // Addendum D33 of 2026-10-13: a promise that only exists in the chat, Serain forgets.
  turn.remindPromise();
  return (
    `Not ended: you promised ${owner.name} to get back to them, and nothing holds that. If you are waiting for a mail, call ` +
    `expect_mail; for a fixed time set_reminder. You write nothing to ${owner.name} about it. If you meant nothing that ` +
    "has to come on its own, end the turn again."
  );
}

/** What a refused preview is called in the audit. */
const PREVIEW_DENIED = {
  unbacked: "unbacked_preview",
  limit: "preview_limit",
  screenshot: "preview_with_screenshot",
  document: "preview_of_pdf",
} as const;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /**
   * `halted` is the kill switch (D8.2) as the registry sees it: if it returns
   * true, no tool runs anymore, not even in a turn that was already underway.
   */
  constructor(
    private readonly gate?: ConfirmationGate,
    private readonly halted: () => boolean = () => false,
  ) {}

  register(def: ToolDefinition): this {
    assertExecutable(def, this.gate);
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(def.name)) {
      throw new Error(`Tool name "${def.name}" does not match [a-z][a-z0-9_]{2,40}`);
    }
    if (this.tools.has(def.name)) throw new Error(`Tool "${def.name}" is already registered`);
    this.tools.set(def.name, def);
    return this;
  }

  registerAll(defs: readonly ToolDefinition[]): this {
    for (const def of defs) this.register(def);
    return this;
  }

  /**
   * Takes tools out again when the owner disconnects a service (D51). A turn
   * that is already running no longer finds them afterwards: `runOne` looks up
   * every tool anew on every call.
   */
  unregister(names: readonly string[]): void {
    for (const name of names) this.tools.delete(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * What the model gets to see at all in a turn of this origin. Offering is
   * comfort, not security: `runOne` checks the same rules again before every
   * execution, fail closed.
   */
  listFor(turn: { origin: TurnOrigin; toolNames?: readonly string[] | null }): ToolDefinition[] {
    return this.list().filter((def) => offeredIn(def, turn.origin, turn.toolNames ?? null));
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Executes a tool. Never throws: an error goes back to the model as the tool
   * result, so the turn continues in a controlled way instead of aborting.
   *
   * Runs via `turn.runSerial`, so a step's tools are processed in call order
   * (even if the SDK starts them in parallel) and `end_turn` only takes effect
   * after the step.
   */
  async execute(
    name: string,
    rawArgs: Record<string, unknown>,
    turn: TurnState,
  ): Promise<ToolExecution> {
    const timeoutMs = this.tools.get(name)?.timeoutMs ?? TOOL_TIMEOUT_MS;
    let result = await turn.runSerial(() => this.withDeadline(name, timeoutMs, () => this.runOne(name, rawArgs, turn), turn));
    // An `end_turn` that did not take effect at the end of the step (`runSerial`):
    // the model should not believe it is done.
    if (this.tools.get(name)?.endsTurn === true && result.ok && !turn.stopped && !turn.endRequested) {
      result = { ok: false, text: endRefusal(turn), endsTurn: false };
    }
    // If the owner wrote again in the meantime, the model reads it here (D57).
    const steers = turn.deliverSteers();
    return steers ? { ...result, text: `${result.text}\n\n${steers}` } : result;
  }

  /**
   * Every tool call ends in bounded time. Without this a hanging tool held the
   * turn, the chain in `runSerial` and with it the conversation queue forever
   * (fuzzing 2026-10-04). A promise cannot be cancelled: the tool keeps running
   * in the background, the turn continues without its result, and the model
   * learns that it is open whether it had an effect.
   */
  private async withDeadline(
    name: string,
    timeoutMs: number,
    work: () => Promise<ToolExecution>,
    turn: TurnState,
    extra: Record<string, unknown> = {},
  ): Promise<ToolExecution> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ToolExecution>((resolve) => {
      timer = setTimeout(() => {
        log.error(`Tool ${name} did not answer after ${timeoutMs} ms`);
        // Do not wait: if the database itself hangs, this entry would hang too.
        void audit("tool_call", { tool: name, ok: false, error: "timeout", timeout_ms: timeoutMs, ...extra }, turn.triggerMessageId).catch(
          () => undefined,
        );
        resolve({
          ok: false,
          text:
            `${name} did not answer after ${Math.round(timeoutMs / 1000)} s. Whether it had an effect is open: ` +
            `do not just call it again, check or tell ${owner.name} that it is stuck right now.`,
          endsTurn: false,
        });
      }, timeoutMs);
    });
    try {
      return await Promise.race([work(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async runOne(
    name: string,
    rawArgs: Record<string, unknown>,
    turn: TurnState,
  ): Promise<ToolExecution> {
    if (this.halted()) {
      turn.stop("kill_switch");
      await audit("tool_denied", { tool: name, reason: "kill_switch" }, turn.triggerMessageId);
      return { ok: false, text: `Stopped. ${owner.name} pulled the kill switch.`, endsTurn: true };
    }

    const def = this.tools.get(name);
    if (!def) {
      await audit("tool_denied", { tool: name, reason: "unknown_tool" }, turn.triggerMessageId);
      return { ok: false, text: `Tool "${name}" does not exist.`, endsTurn: false };
    }

    // Origin and toolbox of the turn (D9, W5). A tool that does not exist in
    // this turn does not run even if the model knows its name.
    if (!offeredIn(def, turn.origin, turn.toolNames)) {
      await audit(
        "tool_denied",
        { tool: name, level: def.level, reason: "not_in_this_turn", origin: turn.origin },
        turn.triggerMessageId,
      );
      return { ok: false, text: `Tool "${name}" does not exist in this turn.`, endsTurn: false };
    }

    try {
      assertExecutable(def, this.gate);
    } catch (error) {
      await audit(
        "tool_denied",
        { tool: name, level: def.level, reason: "confirmation_protocol_missing" },
        turn.triggerMessageId,
      );
      return { ok: false, text: errorText(error), endsTurn: true };
    }

    // Origin (D8.4). Tools whose justification is the owner's direct instruction
    // only run in a turn the owner triggered themselves. Fail closed: a turn from
    // untrusted content does not get through here, even if the model is
    // convinced it is meant.
    if (def.ownerOriginOnly === true && turn.origin !== "owner_message") {
      await audit(
        "tool_denied",
        { tool: name, level: def.level, reason: "origin_not_owner", origin: turn.origin },
        turn.triggerMessageId,
      );
      log.error(`Tool ${name} refused in a turn of origin ${turn.origin}`);
      return {
        ok: false,
        text: `This only works if ${owner.name} writes it themselves. They did not trigger this turn.`,
        endsTurn: false,
      };
    }

    // Taint (D8.4, W1). If the turn has seen untrusted content, the "instruction"
    // to an owner-only tool may come from that content. The justification of
    // these tools is the owner's direct instruction; after the taint it can no
    // longer be proven. It can be proven again in a clean turn on their message:
    // the runtime starts one right after this (addendum D8.4 of 2026-10-08),
    // otherwise the owner writes it again.
    if ((def.ownerOriginOnly === true || def.cleanTurnOnly === true) && turn.tainted) {
      const followUp = turn.defer(name);
      await audit(
        "tool_denied",
        { tool: name, level: def.level, reason: "turn_tainted", sources: turn.taintSources, follow_up: followUp },
        turn.triggerMessageId,
      );
      log.error(`Tool ${name} refused after untrusted content${followUp ? ", runs in the catch-up turn" : ""}`);
      return {
        ok: false,
        text: followUp
          ? "This no longer works in this turn: you have read untrusted content. Right after this turn you get " +
            `${owner.name}'s message again in a clean turn, it works there. Here you only answer the rest; ` +
            `${owner.name} does not have to write anything again.`
          : "This no longer works in this turn: you have read untrusted content. " +
            `Tell ${owner.name} to write it to you again in a new message.`,
        endsTurn: false,
      };
    }

    if (turn.stopped) {
      await audit(
        "tool_denied",
        { tool: name, reason: "turn_stopped", stop_reason: turn.stopReason },
        turn.triggerMessageId,
      );
      return { ok: false, text: "The turn is over.", endsTurn: true };
    }

    // At the step limit, before the owner has heard anything, exactly one way
    // stays open: writing to them. That costs no step (`TurnState.wrappingUp`).
    const answering = turn.wrappingUp && def.answersOwner === true && !turn.ownerHeard;
    if (!answering && !turn.claimStep()) {
      await audit(
        "turn_limit",
        { tool: name, reason: "step_limit", steps: turn.steps, wrap_up: !turn.stopped },
        turn.triggerMessageId,
      );
      if (!turn.stopped) {
        return {
          ok: false,
          text:
            "Not done: the step limit for this turn is reached, there are no more tools. " +
            `${owner.name} has not heard anything from you yet. Send them now with send_message what is done and what is still missing.`,
          endsTurn: false,
        };
      }
      return { ok: false, text: "That is it for this turn: too many steps.", endsTurn: true };
    }

    // A turn the owner triggered does not end silently (`TurnState.mayEnd`).
    // The refusal costs a step, so even a stubborn model ends at the step
    // limit. If siblings are still queued, the message can come after them:
    // then `runSerial` decides at the end of the step.
    if (def.endsTurn === true && !turn.mayEnd && !turn.hasQueuedSiblings) {
      await audit(
        "tool_denied",
        { tool: name, level: def.level, reason: turn.owesAnswer ? "owner_unanswered" : turn.steersAwaiting ? "steer_unseen" : "promise_unheld" },
        turn.triggerMessageId,
      );
      return { ok: false, text: endRefusal(turn), endsTurn: false };
    }

    const parsed = z.object(def.schema).strict().safeParse(rawArgs);
    if (!parsed.success) {
      const reason = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      await audit(
        "tool_denied",
        { tool: name, level: def.level, reason: "invalid_args", detail: reason },
        turn.triggerMessageId,
      );
      return { ok: false, text: `Arguments do not fit: ${reason}`, endsTurn: false };
    }

    const args = parsed.data as Record<string, unknown>;
    // Links after untrusted content (addendum D8.4 of 2026-10-08): what the owner gets only points
    // to pages a tool opened itself, or to their own.
    // The previews in `links` are checked by their own, narrower evidence below (addendum D48): only opened
    // pages, tracking parameters removed on both sides. Here the remaining text counts.
    const previewLinks = def.linkPreviews === true ? args["links"] : undefined;
    const textArgs = def.linkPreviews === true ? { ...args, links: undefined } : args;
    if (def.textToOwner === true && turn.tainted) {
      const unbacked = stringsIn(textArgs).flatMap((text) => turn.unbackedLinks(text));
      if (unbacked.length > 0) {
        // The link itself stays out: it may come from a mail (W13).
        await audit("tool_denied", { tool: name, level: def.level, reason: "unbacked_link", links: unbacked.length }, turn.triggerMessageId);
        return {
          ok: false,
          text:
            `Not sent: ${unbacked.join(", ")} comes from untrusted content, and no tool opened the page ` +
            "itself. Send it without this link; you may name the site. For a mail with " +
            "\"sender verified\" the home page of that domain works, without a path.",
          endsTurn: false,
        };
      }
    }
    // Link previews (addendum D48 of 2026-10-08): Photon's Mac fetches each one itself, so only a page that
    // a tool with `opensPages` opened in this task, at most two per turn. Checked before the call's audit,
    // so a refused address is nowhere on record; if one does not work, nothing goes out.
    if (def.linkPreviews === true && Array.isArray(previewLinks) && previewLinks.length > 0) {
      const verdict = turn.previewTargets(previewLinks as string[]);
      if (!verdict.ok) {
        await audit(
          "tool_denied",
          { tool: name, level: def.level, reason: PREVIEW_DENIED[verdict.reason], links: previewLinks.length },
          turn.triggerMessageId,
        );
        return {
          ok: false,
          text:
            verdict.reason === "unbacked"
              ? "Not sent: a preview only works for pages the executor opened itself in this task. " +
                "Send the message without this preview; you may name the site."
              : verdict.reason === "screenshot"
                ? `Not sent: with a screenshot there is no preview, ${owner.name} wants one or the other. Send the message without links ` +
                  "and then the screenshot."
                : verdict.reason === "document"
                  ? "Not sent: the executor read this PDF, so it goes as a file (send_file with kind document), " +
                    `not as a preview that throws ${owner.name} out of iMessage. Send the message without this link.`
                  : `Not sent: there are no more than ${MAX_LINK_PREVIEWS_PER_TURN} previews in a turn. Send without or with fewer.`,
          endsTurn: false,
        };
      }
    }

    // Preemption (D50). Synchronous with the start of the tool: there is no
    // `await` between this check and the effect, so a straggler message can no
    // longer preempt the turn after it was committed here.
    if (turn.preempted || (!def.repeatable && !turn.commit())) {
      return { ok: false, text: `The turn is preempted, there is a new message from ${owner.name}.`, endsTurn: true };
    }
    // Level by consequence of cost (W1): `consequence` can only raise it.
    const level = def.consequence ? stricterLevel(def.level, def.consequence(args)) : def.level;
    if (level === "irreversible" || level === "money") {
      const confirmed = await this.confirmFirst(def, level, args, turn);
      if (confirmed.ok && def.comesBack === true) turn.notePromiseHeld();
      return confirmed;
    }
    const execution = await this.runAudited(def, level, args, turn);
    if (execution.ok && def.comesBack === true) turn.notePromiseHeld();
    if (execution.ok && def.answersOwner === true && promisesFollowUp(stringsIn(textArgs).join("\n"))) turn.notePromise();
    if (answering && turn.ownerHeard) {
      // The answer at the step limit is out; there is nothing more in this turn.
      turn.stop("step_limit");
      return { ...execution, endsTurn: true };
    }
    return execution;
  }

  /**
   * Levels 3 and 4 do not run from the model turn. Either a standing approval
   * covers the call, or the owner gets a preview and the turn only learns that
   * it is waiting.
   */
  private async confirmFirst(
    def: ToolDefinition,
    level: "irreversible" | "money",
    args: Record<string, unknown>,
    turn: TurnState,
  ): Promise<ToolExecution> {
    const gate = this.gate;
    if (!gate) {
      // Unreachable as long as `assertExecutable` comes first. Fail closed.
      return { ok: false, text: "This does not run without the confirmation protocol.", endsTurn: true };
    }
    // The owner asked for it themselves, and the tool proves it from their words (addendum D8 of 2026-10-03).
    // Never for money, never in a turn the owner did not trigger. Even after untrusted content: the evidence
    // rests on the owner's text, not on what the model made of it.
    const named =
      level === "irreversible" && turn.origin === "owner_message" && turn.ownerWords ? (def.confirm?.namedByOwner?.(args, turn.ownerWords) ?? null) : null;
    if (named) {
      await audit("approval_waived", { tool: def.name, level, named_by_owner: named, tainted: turn.tainted }, turn.triggerMessageId);
      return this.runAudited(def, level, args, turn);
    }
    try {
      if (await gate.covered(def, level, args, turn)) {
        await audit(
          "approval_grant_used",
          { tool: def.name, level, grant_key: grantKeyOf(def, args) },
          turn.triggerMessageId,
        );
        return this.runAudited(def, level, args, turn);
      }
      const result = checkedResult(await gate.request(def, level, args, turn));
      // If the owner approves, the result comes as its own turn: a promise about it is held.
      if (result.ok) turn.notePromiseHeld();
      await audit(
        "tool_call",
        { tool: def.name, level, args, ok: result.ok, result: clip(result.text, AUDIT_TEXT_MAX_CHARS), awaiting_approval: result.ok },
        turn.triggerMessageId,
      );
      return { ...result, endsTurn: turn.stopped || turn.endRequested };
    } catch (error) {
      const reason = errorText(error);
      log.error(`Confirmation for ${def.name} failed:`, error);
      await audit(
        "tool_denied",
        { tool: def.name, level, reason: "approval_error", detail: reason },
        turn.triggerMessageId,
      );
      return { ok: false, text: `Not done: ${reason}`, endsTurn: false };
    }
  }

  /**
   * Executes exactly what the owner confirmed. The caller claimed the entry
   * atomically via `ApprovalService.decide`; still, status, tool and arguments
   * are checked here once more. The arguments come from `approvals`, never
   * from a model.
   */
  async executeApproved(approval: ApprovedCall, turn: TurnState): Promise<ToolResult> {
    if (this.halted()) {
      await audit(
        "tool_denied",
        { tool: approval.tool, approval_id: approval.id, reason: "kill_switch" },
        turn.triggerMessageId,
      );
      return { ok: false, text: `Stopped. ${owner.name} pulled the kill switch.` };
    }
    const def = this.tools.get(approval.tool);
    if (approval.status !== "approved" || !def) {
      await audit(
        "tool_denied",
        { tool: approval.tool, approval_id: approval.id, reason: "approval_not_executable" },
        turn.triggerMessageId,
      );
      return { ok: false, text: "The confirmation matches no executable tool." };
    }
    const parsed = z.object(def.schema).strict().safeParse(approval.args);
    if (!parsed.success) {
      await audit(
        "tool_denied",
        { tool: def.name, approval_id: approval.id, reason: "invalid_args" },
        turn.triggerMessageId,
      );
      return { ok: false, text: "The stored arguments no longer fit the tool." };
    }
    const args = parsed.data as Record<string, unknown>;
    const level = def.consequence ? stricterLevel(def.level, def.consequence(args)) : def.level;
    if (approval.executeAt) {
      const denied = await this.laterDenied(def, level, args, approval, turn);
      if (denied) return denied;
    }
    const result = await turn.runSerial(() =>
      this.withDeadline(def.name, def.timeoutMs ?? TOOL_TIMEOUT_MS, () => this.runAudited(def, level, args, turn, approval.id), turn, {
        approval_id: approval.id,
      }),
    );
    return { ok: result.ok, text: result.text };
  }

  /** May this scheduled confirmation still run now? Null means yes, otherwise the result of the refusal. */
  private async laterDenied(
    def: ToolDefinition,
    level: ToolLevel,
    args: Record<string, unknown>,
    approval: ApprovedCall,
    turn: TurnState,
  ): Promise<ToolResult | null> {
    const deny = async (reason: string, text: string): Promise<ToolResult> => {
      await audit("tool_denied", { tool: def.name, approval_id: approval.id, reason }, turn.triggerMessageId);
      return { ok: false, text };
    };
    // Byte-exact what the preview showed: the parsed arguments are stored. If the schema reads them
    // differently today (a deploy in between), nothing runs, instead of doing something slightly different.
    if (canonicalJson(args) !== canonicalJson(approval.args)) {
      return deny("args_changed", "The stored arguments no longer give exactly the same today. Nothing done.");
    }
    // The level may have risen since scheduling (W1); money is never scheduled.
    if (level === "money") return deny("money_later", "This costs money by now and therefore does not run scheduled. Nothing done.");
    const later = def.confirm?.later;
    if (!later) return deny("later_not_supported", "The tool only runs right away by now. Nothing done.");
    let pin: Record<string, unknown>;
    try {
      pin = later.pin(args);
    } catch {
      return deny("pin_changed", "What the preview showed cannot be checked right now. Nothing done.");
    }
    if (canonicalJson(pin) !== canonicalJson(approval.laterPin ?? {})) {
      return deny("pin_changed", "What the preview showed has changed since the approval (for example the mailbox). Nothing done.");
    }
    return null;
  }

  /** What the tool's `ConfirmSpec.later` says, for scheduling. Null: only right away. */
  laterSpec(name: string): ConfirmLater | null {
    return this.tools.get(name)?.confirm?.later ?? null;
  }

  /** A tool's definition, for an expired preview that is reissued (addendum D8 of 2026-10-10). */
  definition(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  private async runAudited(
    def: ToolDefinition,
    level: ToolLevel,
    args: Record<string, unknown>,
    turn: TurnState,
    approvalId?: string,
  ): Promise<ToolExecution> {
    const name = def.name;
    const extra = approvalId ? { approval_id: approvalId } : {};
    try {
      const raw = checkedResult(await def.run(args, turn));
      const result = def.returnsUntrusted ? markUntrusted(def, raw, turn) : raw;
      await audit(
        "tool_call",
        {
          tool: name,
          level,
          args,
          ok: result.ok,
          result: def.privateResult ? `[not logged, ${raw.text.length} chars]` : clip(result.text, AUDIT_TEXT_MAX_CHARS),
          ...(raw.ref ? { ref: raw.ref } : {}),
          ...extra,
        },
        turn.triggerMessageId,
      );
      // Take note instead of stopping right away: the other message tools of the
      // same step should still run (see TurnState.runSerial).
      if (def.endsTurn) turn.requestEnd(name);
      return {
        ...result,
        text: turn.owesAnswer && !def.endsTurn ? `${result.text}${unansweredHint(turn)}` : result.text,
        endsTurn: def.endsTurn === true || turn.stopped || turn.endRequested,
      };
    } catch (error) {
      const reason = errorText(error);
      log.error(`Tool ${name} failed:`, error);
      // An exception from a tool with untrusted content can carry that content's text (a Playwright message
      // quotes the page, an IMAP error the server): it counts like its result, framed and with taint,
      // and with a private result it is not in the audit log, only its length. The journal has it in full.
      // Before, it went unframed to the model and into the undeletable audit (fuzzing 2026-10-04).
      await audit(
        "tool_call",
        { tool: name, level, args, ok: false, error: def.privateResult ? `[not logged, ${reason.length} chars]` : reason, ...extra },
        turn.triggerMessageId,
      );
      const failed: ToolResult = { ok: false, text: `The tool failed: ${reason}` };
      return { ...(def.returnsUntrusted ? markUntrusted(def, failed, turn) : failed), endsTurn: false };
    }
  }
}
