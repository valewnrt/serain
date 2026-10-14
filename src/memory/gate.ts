import { JUDGE_NONE_KEY, type JudgeBooleanQuestion } from "../agent/judge/types.js";
import { renderContextBlock, type MemoryContextTurn } from "./context.js";
import type { ExtractedFact } from "./deps.js";
import { validityLabel, type FactKind } from "./kinds.js";
import type { FactCandidate } from "./store.js";
import { owner } from "../config/owner.js";

/** `[category, situation, until 2026-08-31]`: what the judge needs to know about kind and validity (D39). */
function factLabel(fact: { category: string; kind?: FactKind; validFrom?: string | null; validUntil?: string | null }): string {
  const validity = validityLabel(
    { kind: fact.kind ?? "identity", validFrom: fact.validFrom ?? null, validUntil: fact.validUntil ?? null },
    new Date(0),
  );
  return [fact.category, fact.kind ?? "", validity].filter(Boolean).join(", ");
}

/**
 * What the `judge` role gets to see in the memory path, and the one question
 * the whole write path hangs on (D12, D13).
 *
 * Deliberately a separate, leaf-like module without database, without SDK,
 * without keys: the eval measures exactly this question in exactly this
 * frame, and for that it must be able to import it without loading half of
 * the runtime. A rebuilt question in the eval would rank a wording that runs
 * nowhere.
 */

/**
 * Key of the option "the new fact replaces none of the existing ones": the
 * judge's shared "none of these" key (`JUDGE_NONE_KEY`), a fixed ASCII key
 * independent of the prompt language; the other options are fact ids (UUIDs),
 * so it cannot collide.
 */
export const NO_RIVAL_KEY = JUDGE_NONE_KEY;

/**
 * The case for the judge questions of the write path. The order is
 * intentional: first the history, then the message it is about, then what
 * Serain already knows.
 */
export function renderState(
  text: string,
  candidates: readonly FactCandidate[] = [],
  fact?: ExtractedFact,
  context: readonly MemoryContextTurn[] = [],
): string {
  const history = renderContextBlock(context);
  const lines = history ? [history, "", "<message>", text, "</message>"] : ["<message>", text, "</message>"];
  if (fact) {
    lines.push("", "<new_fact>", `[${factLabel(fact)}] ${fact.content}`, "</new_fact>");
  }
  if (candidates.length > 0) {
    lines.push("", "<existing_facts>");
    for (const candidate of candidates) {
      lines.push(`${candidate.id}: [${factLabel(candidate)}] ${candidate.content}`);
    }
    lines.push("</existing_facts>");
  }
  return lines.join("\n");
}

/** The case the gate sees: the owner's message, the history before it. */
export function renderGateState(
  text: string,
  context: readonly MemoryContextTurn[] = [],
): string {
  return renderState(text, [], undefined, context);
}

/**
 * The gate question, defined once.
 *
 * The version of 2026-09-18 names habits and corrections explicitly. The
 * previous one ("Does this message contain a fact about the user worth
 * remembering permanently … appointments, mood and small talk do not count")
 * pushed a habit change mentioned in passing down to 0.58 in the live test,
 * just below the threshold: against a list of exclusions that says "mood",
 * "I do it differently now" reads like a passing state. A partial retraction
 * got 0.35, but that was down to the missing history, not the question; both
 * are fixed, and the judge suite measures both now.
 *
 * Birthdays and anniversaries (2026-10-10): the appointment rule swept them
 * along, "my sister's birthday is on 3 March" got 0.05. A date that comes
 * back every year is knowledge about a person, though, not an appointment;
 * the question says so explicitly now, and the party on one day remains an
 * appointment.
 *
 * Who someone is (2026-10-13): Serain warned about a mail from the tax
 * advisor's office, the owner answered "that's our tax advisor <name>". The
 * warning stands in the history only as a placeholder (D8.4), and "that's …"
 * read like an answer for the moment: 0.45, and between 0.4 and 0.92 when
 * replayed with the same history. Name, role or company of a person is
 * knowledge about them, also as an answer to a notice; the question says so
 * now.
 */
export const GATE_QUESTION = {
  key: "memorable",
  type: "boolean",
  instructions:
    `Does ${owner.name} say something in <message> about themself or about the people, animals and things in their ` +
    "life that should be remembered beyond this conversation? This includes habits, likes, dislikes, circumstances and decisions, even " +
    `when said in passing, even in a few words, and explicitly also when ${owner.name} uses it to ` +
    "correct, retract or limit something that was said before in the <history>. Likewise a situation that " +
    "holds for days or weeks (exam phase, trip, illness, project), and a change that only holds " +
    `from a later day on. Likewise who someone is for ${owner.name} (name, role, company, relationship), even ` +
    `if they only say it as an answer to a notice from Serain ("that's my tax advisor …"). And always whatever ${owner.name} explicitly asks to be remembered ` +
    "(\"remember\", \"don't forget\", \"make a note\"), even if it seems trivial on its own: the request " +
    "makes it worth remembering, unless it is a single appointment. A birthday, anniversary or date of death " +
    `(of ${owner.name} or of someone in their life) is not a single appointment but a date that comes back every ` +
    "year: that always counts. Not included are single appointments (not even with " +
    "\"remember\", not even the party for a birthday; those belong in reminders), passing moods, " +
    `small talk, questions to Serain, a request that only holds for the current task, and what others say about ${owner.name}.`,
} as const satisfies JudgeBooleanQuestion;
