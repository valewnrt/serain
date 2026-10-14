import { audit } from "../db/audit.js";
import { log } from "../log.js";
import type { ModelRole } from "../config/models.js";
import { runModelTurn, type ChatTurn, type ModelPin, type ModelTurnResult, type WarmSlot } from "./model.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { MessagePort } from "./tools/messaging.js";
import { TurnState, type TurnSetup } from "./tools/types.js";

/**
 * One turn (D4). The model speaks through tools, not through its answer text;
 * this file holds the state for it, counts the limits along and knows
 * neither an SDK nor the channel.
 */

export interface TurnDeps {
  registry: ToolRegistry;
  /** Only for the emergency exit below. Normally the tools send. */
  port: MessagePort;
}

export interface TurnInput {
  role?: ModelRole;
  system: string;
  history: ChatTurn[];
  incoming: string;
  /** See `ModelTurnRequest.incomingSpeaker`. */
  incomingSpeaker?: string;
  /** See `ModelTurnRequest.context`: time and memory, not in the system prompt (V7). */
  context?: string;
  setup: TurnSetup;
  /**
   * Only the eval harness sets this: a specific candidate instead of the role
   * config, so that the comparison runs through exactly this turn code and not
   * through a copy of it. Always empty in production.
   */
  pin?: ModelPin;
  /** Slot in the warm pool (D50), see `ModelTurnRequest.warm`. */
  warm?: WarmSlot;
}

export interface TurnOutcome extends ModelTurnResult {
  messagesSent: number;
  /** Of these, accepted by the channel (`TurnState.messagesDelivered`). */
  messagesDelivered: number;
  reactionsSent: number;
  /** Previews of the confirmation protocol that went to the owner: that is an answer too (D63, building block C). */
  previewsSent?: number;
  steps: number;
  stopReason: string | null;
  /** True if Serain had to send its answer text as a message. */
  usedTextFallback: boolean;
  /**
   * True if this turn forgot something (W7). The memory write path then skips
   * the turn: the message "forget that I X" contains X.
   */
  factExtractionBlocked: boolean;
  /** What a clean turn catches up on right afterwards (`TurnState.defer`). Empty: nothing. */
  deferred: string[];
  /**
   * A late message superseded the turn before it did anything the owner sees
   * or that stays (D50). The turn then leaves nothing behind.
   */
  preempted: boolean;
  /** From the start of the turn to the first message, the first tapback or the first preview. */
  firstVisibleMs: number | null;
}

export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnOutcome> {
  const startedAt = performance.now();
  const state = new TurnState(input.setup);
  const tools = deps.registry.listFor(state);

  const result = await runModelTurn({
    role: input.role ?? "chat",
    system: input.system,
    history: input.history,
    incoming: input.incoming,
    ...(input.incomingSpeaker ? { incomingSpeaker: input.incomingSpeaker } : {}),
    ...(input.context ? { context: input.context } : {}),
    tools,
    maxSteps: state.limits.maxSteps,
    // One end for both SDK paths, from the same source: only the turn state
    // knows when the step with `end_turn` has really been worked through.
    stopSignal: state.untilStopped,
    execute: (name, args) => deps.registry.execute(name, args, state),
    allowFallback: () => state.messagesSent === 0 && state.reactionsSent === 0,
    // Messages the owner sent afterwards (D57): seen with the next answer,
    // in the fallback right in the input.
    onResponse: () => state.noteResponse(),
    restartNotes: () => state.restartSteers(),
    ...(input.pin ? { pin: input.pin } : {}),
    ...(input.warm ? { warm: input.warm } : {}),
  });

  let usedTextFallback = false;
  // If the model called `end_turn`, silence was its decision, and the text
  // after it is talking to itself. In the live test of 2026-09-20 that is how
  // "All good, no further step needed." went to the owner, after two previews.
  //
  // A heartbeat turn has no emergency exit: nobody asked, so silence is never
  // the mistake there. Text without a tool stays what it is (D9, W5). The same
  // goes for the mail trigger (`untrusted`, D33): there the emergency exit
  // would on top be a way to send text under the influence of an untrusted
  // mail past the message tools.
  //
  // If the model saw an addendum from the owner and afterwards only wrote text
  // (D57), the same applies: the owner is waiting for an answer to it.
  const silentByDefault = state.origin === "heartbeat" || state.origin === "untrusted";
  const unanswered = (state.messagesSent === 0 && state.reactionsSent === 0) || (state.steered && !state.ownerHeard);
  if (!silentByDefault && !state.preempted && unanswered && !state.endRequested && result.text) {
    // Emergency exit: the model only produced text and used no tool.
    // Silence would be the worse mistake, so the text goes out the same way
    // as everything else (chunking, dedupe, limits) and is logged.
    log.warn("Model used no message tool, sending its answer text");
    // Nobody asks back here any more: unbacked links after untrusted content are dropped (addendum to D8.4 of 2026-10-08).
    const text = state.dropUnbackedLinks(result.text);
    if (state.commit() && state.claimMessage()) {
      usedTextFallback = await deps.port.send(text, {
        kind: "text_fallback",
        origin: state.origin,
        taintSources: [...state.taintSources],
        onUndelivered: () => state.noteUndelivered(),
      });
      if (usedTextFallback) state.noteDelivered();
    }
    await audit(
      "turn_text_fallback",
      {
        provider: result.provider,
        model: result.model,
        sent: usedTextFallback,
        ...(state.undelivered ? { undelivered: true } : {}),
        ...(text !== result.text ? { links_dropped: true } : {}),
      },
      state.triggerMessageId,
    );
  }

  return {
    ...result,
    messagesSent: state.messagesSent,
    messagesDelivered: state.messagesDelivered,
    reactionsSent: state.reactionsSent,
    previewsSent: state.previewsSent,
    steps: state.steps,
    stopReason: state.stopReason,
    usedTextFallback,
    factExtractionBlocked: state.factExtractionBlocked,
    deferred: [...state.deferred],
    preempted: state.preempted,
    firstVisibleMs: state.firstVisibleAt === null ? null : Math.round(state.firstVisibleAt - startedAt),
  };
}
