import { messagingTools, type MessagePort } from "../src/agent/tools/messaging.js";
import { memoryTools } from "../src/agent/tools/memory.js";
import { ToolRegistry, type ToolExecution } from "../src/agent/tools/registry.js";
import type { TurnState } from "../src/agent/tools/types.js";
import type { MemoryDeps } from "../src/memory/deps.js";
import type { TurnRecord } from "./types.js";

/**
 * The channel in the eval is a dummy. Nothing goes to Photon, nothing goes to
 * iMessage, nothing costs one of the 250 messages: the port only records
 * what Serain *would have* sent.
 *
 * Everything before it stays real. The tools come from `src/agent/tools/`, the registry
 * is the production registry (including the tier lock and audit), the turn
 * runs through `src/agent/turn.ts`. What gets measured is what later runs too,
 * not a replica of it.
 */

export interface RecordingPort extends MessagePort {
  readonly record: TurnRecord;
}

export interface RecordingPortOptions {
  /** Capabilities of the simulated channel. Default: tapbacks yes, threads no. */
  canReact?: boolean;
  canReplyInThread?: boolean;
}

export function createRecordingPort(options: RecordingPortOptions = {}): RecordingPort {
  const record: TurnRecord = {
    messages: [],
    reactions: [],
    toolCalls: [],
    unknownTools: [],
    usedTextFallback: false,
    stopReason: null,
    steps: 0,
  };

  return {
    // Default: both on, so that all four messaging tools are available
    // in the comparison at all. A tool the channel cannot do is not even
    // registered, and then the tools suite does not measure it either.
    canReact: options.canReact ?? true,
    canReplyInThread: options.canReplyInThread ?? true,
    record,
    async send(text, opts) {
      record.messages.push({
        text,
        kind: opts.kind,
        ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }),
      });
      return true;
    },
    async react(messageId, emoji) {
      record.reactions.push({ messageId, emoji });
      return true;
    },
  };
}

/**
 * All tool names that exist in production, including those not registered
 * in the eval at all. This is needed for the check "no internal
 * names in a message": the rule applies to `forget_fact` just as much as to
 * `send_message`, whether or not the tool was available in this run.
 *
 * Derived rather than copied: the names come from the same factories that
 * `src/runtime.ts` uses too. The handlers never run here: the
 * memory dependency is a proxy that throws on every access, and exactly
 * that is the proof here, not the problem.
 */
export function productionToolNames(): string[] {
  const port = createRecordingPort();
  const memory = new Proxy(
    {},
    {
      get(): never {
        throw new Error("productionToolNames only reads names, it executes nothing");
      },
    },
  ) as MemoryDeps;
  return [...messagingTools(port), ...memoryTools({ memory, port })].map((tool) => tool.name);
}

/**
 * Registry that records every call. Inherits the production logic; only the
 * logging is overridden.
 *
 * What it does **not** see: tools the model invents and that the model layer
 * rejects beforehand. On the subscription path `canUseTool` catches them, on the OpenRouter path
 * the Vercel AI SDK only offers registered names. What stays visible is the case where an
 * unknown name does get through to here, and exactly that is what
 * `unknownTools` counts.
 */
export class RecordingRegistry extends ToolRegistry {
  constructor(private readonly record: TurnRecord) {
    super();
  }

  override async execute(
    name: string,
    rawArgs: Record<string, unknown>,
    turn: TurnState,
  ): Promise<ToolExecution> {
    const known = this.get(name) !== undefined;
    const result = await super.execute(name, rawArgs, turn);
    if (known) {
      this.record.toolCalls.push({ name, args: rawArgs, ok: result.ok });
    } else {
      this.record.unknownTools.push(name);
    }
    return result;
  }
}
