import { z } from "zod";
import { FEEDBACK_MAX_PER_DAY } from "../../config/limits.js";
import { audit } from "../../db/audit.js";
import { defineTool, type ToolDefinition } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * Feedback tickets from the conversation (package 2 of 2026-10-08): when
 * Serain notices that it lacks a tool or something is broken, it writes that
 * into the audit log (event `feedback`), and the owner reads it in the web
 * interface under Audit → Feedback. An agent with such a tool tends to call it
 * on almost every error and then tell the owner "passed it on to the team"
 * instead of helping. Hence: the list is for development, not for the
 * conversation, and the result tells the model exactly that.
 *
 * **Level `write_reversible`:** it only writes into Serain's own audit log,
 * nothing goes outside. It also runs after untrusted content, because that is
 * often where something is missing (a mail with a form Serain cannot fill
 * in). In return the taint is on the entry, the web interface shows it, the
 * registry checks links as for every message to the owner (`textToOwner`), and
 * the code accepts no more than {@link FEEDBACK_MAX_PER_DAY} a day: a crafted
 * page must not flood the list.
 */

export interface FeedbackToolDeps {
  /** How many feedback entries already exist today (owner's time zone). */
  countToday(): Promise<number>;
}

export function feedbackTools(deps: FeedbackToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: "give_feedback",
      description:
        `Notes on ${owner.name}'s development list that you lack something (feature: a tool, an access, a capability) ` +
        `or that something did not work (bug). ${owner.name} reads the list later in the web interface, not in the chat. Only ` +
        "when you really lack something to fulfil a request, or a tool behaves wrongly. It replaces no " +
        `answer: ${owner.name} still gets what you can do instead, and it is not mentioned to them. The ` +
        "description holds only the capability and the occasion, no content from mails, calendar or pages, no " +
        "names of third parties, no credentials.",
      level: "write_reversible",
      textToOwner: true,
      schema: {
        kind: z.enum(["feature", "bug"]).describe("feature: something is missing. bug: something did not work although it should."),
        description: z
          .string()
          .trim()
          .min(10)
          .max(500)
          .describe("In one or two sentences: what is missing or did not work, and what you would have needed it for."),
      },
      async run(args, turn) {
        if ((await deps.countToday()) >= FEEDBACK_MAX_PER_DAY) {
          return { ok: false, text: `There are already ${FEEDBACK_MAX_PER_DAY} entries on the list for today. Leave it at that.` };
        }
        await audit(
          "feedback",
          {
            kind: args.kind,
            description: args.description,
            origin: turn.origin,
            tainted: turn.tainted,
            ...(turn.tainted ? { taint_sources: [...turn.taintSources].slice(0, 3) } : {}),
          },
          turn.triggerMessageId || undefined,
        );
        return {
          ok: true,
          text: `It is on the list. Do not mention it to ${owner.name}, it replaces no answer.`,
        };
      },
    }),
  ];
}
