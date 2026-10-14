import { z } from "zod";
import { PROPOSALS } from "../../config/memory.js";
import { audit } from "../../db/audit.js";
import type { MemoryDeps } from "../../memory/deps.js";
import { distinctiveTokens } from "../../memory/markers.js";
import { comparableText } from "../../memory/procedures.js";
import type { StoredProcedure } from "../../memory/proposal-store.js";
import type { ProcedureOffer } from "../../memory/proposals.js";
import { defineTool, type ToolDefinition, type TurnState } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * Approved procedures (H5, D42): propose and forget. `show_memory` can show
 * them, and recall brings them in.
 *
 * **`propose_procedure` is `write_reversible` and only in turns the owner
 * triggered (`origins`), but deliberately not `ownerOriginOnly`.** In this
 * registry `ownerOriginOnly` also means "only in a clean turn", and the
 * typical case (cleaning up the mailbox) reads mails first and is therefore
 * tainted. The justification here also differs from `forget_fact`: not the
 * owner's instruction in the turn, but their later 👍 on exactly the text
 * they read. Until then only a proposal is stored; the question goes out
 * with the turn's taint (D8.4) and stands framed in the history. Allowed are
 * `owner_message` and `approval`: a task with a preview has only "succeeded"
 * in the result turn after the owner's 👍.
 *
 * **`forget_procedure` is `ownerOriginOnly`** like `forget_fact`: it deletes
 * hard, and the confirmation is the owner's instruction in a clean turn (D13).
 */

export interface ProcedureToolDeps {
  memory: Pick<MemoryDeps, "store">;
  proposals: { offerProcedure(input: ProcedureOffer): Promise<{ ok: boolean; text: string }> };
}

/** Which procedure is meant? Deterministic, and with more than one candidate it asks instead of guessing. */
export function resolveProcedure(
  procedures: readonly StoredProcedure[],
  what: string,
): { kind: "none" } | { kind: "one"; procedure: StoredProcedure } | { kind: "ambiguous"; candidates: StoredProcedure[] } {
  const key = comparableText(what);
  const exact = procedures.filter((procedure) => comparableText(procedure.title) === key);
  if (exact.length === 1 && exact[0]) return { kind: "one", procedure: exact[0] };
  const tokens = distinctiveTokens(what);
  const candidates = procedures.filter((procedure) => {
    const title = comparableText(procedure.title);
    if (key && (title.includes(key) || key.includes(title))) return true;
    const own = distinctiveTokens(`${procedure.title} ${procedure.trigger}`);
    return [...tokens].some((token) => own.has(token));
  });
  if (candidates.length === 1 && candidates[0]) return { kind: "one", procedure: candidates[0] };
  return candidates.length > 1 ? { kind: "ambiguous", candidates } : { kind: "none" };
}

export function procedureTools(deps: ProcedureToolDeps): ToolDefinition[] {
  // At most one proposal per turn. Remembered on the turn itself, without extending `TurnState` for it.
  const proposedIn = new WeakSet<TurnState>();

  return [
    defineTool({
      name: "propose_procedure",
      description:
        `Proposes to ${owner.name} a procedure you would remember for next time. Only after a ` +
        "multi-step task that succeeded and that they will probably want the same way again, never after a " +
        "single step. The tool builds the question to them, you write nothing about it. Only with their 👍 do you " +
        "remember the procedure; after that it is a hint for you, not a permission: previews still apply.",
      level: "write_reversible",
      textToOwner: true,
      origins: ["owner_message", "approval"],
      schema: {
        title: z.string().trim().min(3).max(PROPOSALS.procedureTitleMaxChars).describe("Short title, e.g. \"Clean up mailbox\"."),
        steps: z
          .string()
          .trim()
          .min(10)
          .max(PROPOSALS.procedureStepsMaxChars)
          .describe(`The steps as a numbered list, one line per step, the way ${owner.name} wants it.`),
        when: z
          .string()
          .trim()
          .min(5)
          .max(PROPOSALS.procedureWhenMaxChars)
          .describe(`How to recognise a matching request, e.g. "${owner.name} wants to clean up their mailbox".`),
      },
      async run(args: { title: string; steps: string; when: string }, turn) {
        if (proposedIn.has(turn)) return { ok: false, text: "One proposal per turn is enough." };
        if (!turn.claimMessage()) return { ok: false, text: "Message limit for this turn reached." };
        proposedIn.add(turn);
        return deps.proposals.offerProcedure({
          title: args.title,
          steps: args.steps,
          when: args.when,
          taintSources: [...turn.taintSources],
          sourceMessageId: turn.triggerMessageId,
        });
      },
    }),

    defineTool({
      name: "forget_procedure",
      description:
        `Deletes a remembered procedure permanently. Only on ${owner.name}'s explicit instruction. If it is unclear ` +
        "which one is meant, you get the candidates back and ask, instead of guessing.",
      level: "write_reversible",
      ownerOriginOnly: true,
      schema: {
        what: z.string().trim().min(3).max(200).describe(`Title or description in ${owner.name}'s words.`),
        procedure_id: z.string().trim().optional().describe("ID from a previous follow-up question. Then exactly that one is deleted."),
      },
      async run(args: { what: string; procedure_id?: string }) {
        const all = await deps.memory.store.procedures();
        let target: StoredProcedure | null = null;
        if (args.procedure_id) {
          target = all.find((procedure) => procedure.id === args.procedure_id) ?? null;
          if (!target) return { ok: false, text: "This procedure does not exist (anymore)." };
        } else {
          const decision = resolveProcedure(all, args.what);
          if (decision.kind === "ambiguous") {
            return {
              ok: false,
              text: [
                `Ambiguous, I do not delete anything on suspicion. Ask ${owner.name} which one is meant:`,
                ...decision.candidates.map((procedure) => `${procedure.id}: ${procedure.title}`),
                "Then call forget_procedure again with procedure_id.",
              ].join("\n"),
            };
          }
          if (decision.kind === "none") {
            return {
              ok: false,
              text:
                all.length > 0
                  ? `I have no procedure for that. There are: ${all.map((procedure) => procedure.title).join(", ")}.`
                  : "There are no remembered procedures.",
            };
          }
          target = decision.procedure;
        }
        const deleted = await deps.memory.store.deleteProcedure(target.id);
        // As with facts: the audit log records THAT something was deleted, never what.
        await audit("memory_forget", { kind: "procedure", procedure_id: target.id, deleted });
        return deleted
          ? { ok: true, text: `The procedure is gone. Let ${owner.name} know briefly.` }
          : { ok: false, text: "This procedure does not exist (anymore)." };
      },
    }),
  ];
}
