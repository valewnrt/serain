import { MEMORY } from "../config/memory.js";
import { owner } from "../config/owner.js";

/**
 * The conversation history for the write path (D6, D13).
 *
 * Until 2026-09-18 the gate and the extraction saw only the owner's current
 * message. For a habit change mentioned in passing that is barely enough, for
 * a partial retraction not at all: "nah actually, an espresso now and then"
 * says nothing about anything on its own, and in the live test the gate
 * consistently gave it 0.35. A human reads two lines up to see what it is
 * about; the model now gets the same two lines.
 *
 * Two limits this history does not move:
 *
 * 1. **It is context, not a source.** Facts still come only from the owner's
 *    current message (D8.4). Both prompts say so explicitly, so that half of
 *    Serain's answer does not end up as knowledge about the owner.
 * 2. **It is capped.** The history goes to an external provider, and the
 *    smaller the prompt, the cheaper the call (D3).
 */

/** One turn from the running chat. Only for understanding, never a source of facts. */
export interface MemoryContextTurn {
  role: "user" | "assistant";
  content: string;
  /** Derived from untrusted content (D8.4). Appears in the block only as a placeholder. */
  fromUntrusted?: boolean;
}

/**
 * What stands in the block instead of a message from untrusted content (D8.4,
 * addendum 2026-10-02). Not framed but left out: gate and extraction must not
 * be able to learn anything from the owner's answer to it that only makes
 * sense through this text. A "yes" to "your new address is X, right?" from a
 * crafted mail would otherwise be a fact. The placeholder stays so that their
 * answer visibly answers something instead of standing in a void.
 */
export const UNTRUSTED_TURN_PLACEHOLDER = "[message from untrusted content, left out here]";

/**
 * The last turns as a block, oldest first. Empty string when there are none;
 * then the prompt has no empty frame either.
 *
 * Cut from the front: the most recent turn is closest to the current message
 * and explains it best.
 */
export function renderContextBlock(
  turns: readonly MemoryContextTurn[],
  limits: { turns: number; maxChars: number } = {
    turns: MEMORY.writeContextTurns,
    maxChars: MEMORY.writeContextMaxChars,
  },
): string {
  const lines: string[] = [];
  let chars = 0;
  for (const turn of turns.slice(-limits.turns).reverse()) {
    const content = turn.fromUntrusted ? UNTRUSTED_TURN_PLACEHOLDER : turn.content.trim();
    if (!content) continue;
    const line = `${turn.role === "user" ? owner.name : "Serain"}: ${content}`;
    if (chars + line.length > limits.maxChars) break;
    chars += line.length;
    lines.unshift(line);
  }
  if (lines.length === 0) return "";
  return ["<history>", ...lines, "</history>"].join("\n");
}
