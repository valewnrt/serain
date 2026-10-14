import { z } from "zod";
import { MEMORY } from "../../config/memory.js";
import { audit } from "../../db/audit.js";
import { memoryLines, parseSection, renderMemoryLines, SECTION_LABELS, SECTION_ORDER, type MemoryLine } from "../../memory/areas.js";
import type { MemoryDeps } from "../../memory/deps.js";
import { forgetFacts, purgeUserModel, type FactForget } from "../../memory/forget.js";
import { notExpired } from "../../memory/kinds.js";
import type { ActiveFact, FactCandidate } from "../../memory/store.js";
import type { UserModelSource } from "../../memory/user-model.js";
import { defineTool, type ToolDefinition } from "./types.js";
import type { MessagePort } from "./messaging.js";
import { owner } from "../../config/owner.js";

/**
 * The two memory tools (W6, W7).
 *
 * **Level per D8.3 and D12:** both are `write_reversible`.
 *
 * For `show_memory` that is obvious: it sends the owner a message with their
 * own data, and the recipient is always the owner.
 *
 * For `forget_fact` it is a deliberate decision, reasoned in D13. D8.3 lists
 * "deleting" under `irreversible`, but what it means there is the effect on
 * the outside world and the destruction of evidence. Here only Serain's own,
 * derived knowledge about the owner is deleted, on the owner's direct
 * instruction in the same turn, while messages and the audit log stay
 * untouched. The confirmation is the instruction itself; that is why the tool
 * must never guess: if the target is not unambiguous, it asks back instead of
 * deleting.
 *
 * That is exactly why both carry `ownerOriginOnly` (D8.4): the reasoning
 * depends on the owner having triggered the turn. In a turn from untrusted
 * content (later a mail trigger or a heartbeat) it does not hold, and the
 * registry refuses to run, instead of relying on the description in the
 * prompt.
 */

export interface MemoryToolDeps {
  memory: MemoryDeps;
  port: MessagePort;
  subject?: string;
}

/** How close to the best match a second candidate must be to make the target ambiguous. */
const AMBIGUITY_RATIO = 0.8;
/** The best match must be this much closer than the second best, otherwise Serain asks back. */
const FORGET_CLEAR_GAP = 0.08;
/** From here on a fact is close enough to offer it in a follow-up question. */
const FORGET_NEAR_SIMILARITY = 0.3;

/** The areas with their number of entries: "Ich (12), Personen (5)". */
function counts(lines: readonly MemoryLine[]): string {
  return SECTION_ORDER.flatMap((section) => {
    const count = lines.filter((line) => line.section === section).length;
    return count > 0 ? [`${SECTION_LABELS[section]} (${count})`] : [];
  }).join(", ");
}

export function memoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  const subject = deps.subject ?? "owner";

  return [
    defineTool({
      name: "show_memory",
      description:
        `Shows ${owner.name}, unfiltered, what you have stored about them, by area (me, open, people, places, ` +
        "preferences, anniversaries, procedures), each line marked as said or inferred, with date. Use it when " +
        "they ask for it ('what do you know about me', 'which birthdays do you know'). The content goes straight to them, " +
        "you do not need to repeat it. If it is a lot, you get the areas instead and ask them which one they want to see.",
      level: "write_reversible",
      ownerOriginOnly: true,
      schema: {
        area: z
          .string()
          .trim()
          .optional()
          .describe(`Only show this area: ${SECTION_ORDER.join(", ")}. Without it, everything.`),
      },
      async run(args: { area?: string }, turn) {
        const now = deps.memory.now();
        const section = args.area ? parseSection(args.area) : null;
        if (args.area && !section) {
          return { ok: false, text: `There is no area "${args.area}". There are: ${SECTION_ORDER.join(", ")}.` };
        }
        const [version, all, procedures] = await Promise.all([
          deps.memory.store.activeUserModel(),
          deps.memory.store.activeFacts(subject),
          deps.memory.store.procedures(),
        ]);
        // Serain does not show expired facts as knowledge: they no longer hold (D39).
        const facts = all.filter((fact) => notExpired(fact, now));
        const lines = memoryLines({ facts, learned: version, procedures, now });
        const shown = section ? lines.filter((line) => line.section === section) : lines;

        if (shown.length === 0) {
          if (!section) return { ok: true, text: `Nothing is stored. Tell ${owner.name}.` };
          return {
            ok: false,
            text: `I have nothing under ${SECTION_LABELS[section]}. There are: ${counts(lines)}.`,
          };
        }

        const body = renderMemoryLines(shown);
        // A full dump would quickly be more bubbles than an answer is worth.
        // Better to offer the areas then.
        if (!section && body.length > MEMORY.showMemoryMaxChars) {
          await audit("memory_seed", { shown: "overview", facts: facts.length });
          const stand = version ? ` On top of that there is their base text (as of ${version.createdAt.slice(0, 10)}, ${SOURCE_LABELS[version.source]}), which is in the web interface under Memory.` : "";
          return {
            ok: true,
            text:
              `That is ${shown.length} entries, too many for one go. Areas: ${counts(lines)}.${stand} ` +
              `Ask ${owner.name} which one they want to see, then call show_memory with area.`,
          };
        }

        if (!turn.claimMessage()) {
          return { ok: false, text: "Message limit for this turn reached." };
        }
        const sent = await deps.port.send(body, { kind: "show_memory", taintSources: [...turn.taintSources] });
        await audit("memory_seed", {
          shown: section ?? "all",
          lines: shown.length,
          sent,
        });
        return sent
          ? { ok: true, text: "Sent, unchanged. You do not need to repeat any of it." }
          : { ok: false, text: "Not sent (limit, duplicate or channel error)." };
      },
    }),

    defineTool({
      name: "forget_fact",
      description:
        `Deletes what you have stored about ${owner.name}, permanently: the fact with its earlier versions, other facts ` +
        "that contain the same (one that only mentions it stays, without it), and the places in the user model where " +
        `it appears. Only on ${owner.name}'s explicit instruction ('forget that', 'forget ` +
        `that …'). Describe it the way ${owner.name} meant it. If it is unclear which fact is meant, or ` +
        "it would hit many places, you get them back and ask, instead of guessing.",
      level: "write_reversible",
      ownerOriginOnly: true,
      schema: {
        what: z
          .string()
          .trim()
          .min(3)
          .max(300)
          .describe(`What should be forgotten, in ${owner.name}'s words.`),
        fact_id: z
          .string()
          .trim()
          .optional()
          .describe("ID from a previous follow-up question. Then exactly that one is deleted."),
        all_lines: z
          .boolean()
          .default(false)
          .describe(`${owner.name} confirmed after the follow-up question that all listed facts and places in the user model should go.`),
      },
      async run(args: { what: string; fact_id?: string; all_lines: boolean }, turn) {
        // From here on this turn learns nothing: "forget that I X" contains X,
        // and the write path reads exactly this message.
        turn.factExtractionBlocked = true;

        let target: ActiveFact | FactCandidate | null = null;

        if (args.fact_id) {
          const facts = await deps.memory.store.activeFacts(subject);
          target = facts.find((fact) => fact.id === args.fact_id) ?? null;
          // A forget just before may have taken it along, if it carried the same detail.
          if (!target) return { ok: false, text: "This fact does not exist (anymore). If it went with a forget just now, there is nothing more to do." };
        } else {
          let embedding: number[] | null = null;
          try {
            const [vector] = await deps.memory.embed([args.what]);
            embedding = vector ?? null;
          } catch {
            // Full text is enough to find it. An embedding outage must not
            // block deletion.
          }
          const candidates = await deps.memory.store.searchFacts({
            subject,
            embedding,
            query: args.what,
            limit: MEMORY.candidateLimit,
            now: deps.memory.now().toISOString(),
            // The owner must be able to have expired facts deleted too.
            includeExpired: true,
          });
          const decision = resolveForgetTarget(candidates);
          if (decision.kind === "ambiguous") {
            return {
              ok: false,
              text: [
                `Ambiguous, I do not delete anything on suspicion. Ask ${owner.name} which one is meant:`,
                ...decision.candidates.map((fact) => `${fact.id}: [${fact.category}] ${fact.content}`),
                "Then call forget_fact again with fact_id.",
              ].join("\n"),
            };
          }
          if (decision.kind === "one") target = decision.fact;
        }

        const facts: FactForget = target
          ? await forgetFacts(deps.memory, { what: args.what, target, subject, allowMany: args.all_lines })
          : { deleted: 0, trimmed: 0, removedContents: [], tooMany: null };
        if (facts.tooMany) {
          return {
            ok: false,
            text: [
              `That would hit ${facts.tooMany.length} facts, I do not delete them on suspicion:`,
              ...facts.tooMany.map((content) => `- ${content}`),
              `Ask ${owner.name} briefly whether all of it should go. If yes: forget_fact again exactly the same, with all_lines: true.`,
            ].join("\n"),
          };
        }

        // Even without a fact: if it is in the user model, it goes from there (D40).
        // Trimmed facts are not passed in: their rest may stay in the model.
        const purge = await purgeUserModel(deps.memory, {
          what: args.what,
          facts: facts.removedContents,
          allowMany: args.all_lines,
        });
        const done = factSummary(facts);
        if (purge.tooMany) {
          return {
            ok: false,
            text: [
              done ? `Gone: ${done}.` : "",
              `In the user model it would hit ${purge.tooMany.length} places, I do not strike that on suspicion:`,
              ...purge.tooMany.map((line) => `- ${line}`),
              `Ask ${owner.name} briefly whether all of it should go. If yes: forget_fact again with all_lines: true.`,
            ]
              .filter(Boolean)
              .join("\n"),
          };
        }
        if (facts.deleted === 0 && purge.removedLines === 0) {
          return { ok: false, text: "I have nothing stored about that, neither as a fact nor in the user model." };
        }
        const parts = [done, purge.removedLines > 0 ? `${purge.removedLines} place(s) in the user model` : ""].filter(Boolean);
        return { ok: true, text: `Gone: ${parts.join(" and ")}. Let ${owner.name} know briefly.` };
      },
    }),
  ];
}

/** Which facts are gone, in half a sentence for the model. Empty if none. */
function factSummary(facts: FactForget): string {
  const removed = facts.removedContents.length;
  const earlier = facts.deleted - removed - facts.trimmed;
  return [
    removed === 0 ? "" : `${removed === 1 ? "the fact" : `${removed} facts`}${earlier > 0 ? ` with ${earlier} earlier versions` : ""}`,
    facts.trimmed > 0 ? `the detail struck from ${facts.trimmed} more, the rest stays` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

const SOURCE_LABELS: Record<UserModelSource, string> = {
  seed: "your base text",
  push: "your base text, freshly uploaded",
  consolidation: "condensed overnight",
  forget: "after a forget",
};

export type ForgetDecision =
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: FactCandidate[] }
  | { kind: "one"; fact: FactCandidate };

/**
 * Which fact is meant? Deliberately deterministic and not by judge: for a
 * deletion, a probability of 0.7 is not a reason, but a reason to ask back.
 */
export function resolveForgetTarget(candidates: readonly FactCandidate[]): ForgetDecision {
  // Without a vector (budget, outage) only full text remains, and then its rank decides.
  if (candidates.every((candidate) => candidate.similarity === 0)) {
    const [first, second] = candidates;
    if (!first) return { kind: "none" };
    if (second && second.score >= first.score * AMBIGUITY_RATIO) {
      return { kind: "ambiguous", candidates: candidates.slice(0, MEMORY.candidateLimit) };
    }
    return { kind: "one", fact: first };
  }
  // Full-text hits count even with a weak vector: "forget the thing with Mirella" hits the name,
  // while the vector of the whole sentence is at 0.52. But the meaning picks the target, not the
  // rank from the fusion: "apartment on Lindenallee" hit the parking-space fact by full text (which
  // contained the word "apartment") and deleted it instead of the apartment (memory eval, D45).
  const usable = candidates
    .filter((candidate) => candidate.similarity >= MEMORY.candidateMinSimilarity || candidate.textHit)
    .sort((a, b) => b.similarity - a.similarity);
  const first = usable[0];
  if (!first) {
    // Nothing clearly matching, but something close ("pills" for a medication by name):
    // ask instead of claiming "nothing stored". Deletion only happens with the owner's choice.
    const near = candidates.filter((candidate) => candidate.similarity >= FORGET_NEAR_SIMILARITY);
    return near.length > 0 ? { kind: "ambiguous", candidates: near.slice(0, MEMORY.candidateLimit) } : { kind: "none" };
  }
  const second = usable[1];
  if (second && first.similarity - second.similarity < FORGET_CLEAR_GAP) {
    return { kind: "ambiguous", candidates: usable.slice(0, MEMORY.candidateLimit) };
  }
  return { kind: "one", fact: first };
}
