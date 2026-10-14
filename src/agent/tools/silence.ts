import { z } from "zod";
import { defineTool, type ToolDefinition } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * `cancel_silently` (W5). A turn Serain triggered itself may end in nothing:
 * the heartbeat found nothing, the scheduled price alert did not fire. The
 * mistake it prevents is the explaining message: "I checked, there is nothing
 * new" costs one of 250 messages and teaches the owner to mute Serain.
 *
 * The tool stops the turn immediately, not only at the end of the step: what
 * the model still wanted to send afterwards runs into `turn_stopped`. In a
 * turn the owner triggered, the tool does not exist: there, silently
 * cancelling would be a way to ignore them.
 */
export function silenceTools(): ToolDefinition[] {
  return [
    defineTool({
      name: "cancel_silently",
      description:
        `Ends this turn without writing ${owner.name} anything. The normal case when you woke yourself ` +
        "up and there is nothing that concerns them now. No message before, no " +
        "explanation after.",
      level: "read",
      endsTurn: true,
      // `untrusted`: the mail trigger (D33). Nobody asked, silence is the normal case there.
      origins: ["heartbeat", "schedule", "untrusted"],
      schema: {
        reason: z
          .string()
          .trim()
          .min(3)
          .max(200)
          .describe(`One sentence for the audit log on why silence is right. ${owner.name} does not read it.`),
      },
      async run(_args, turn) {
        turn.requestEnd("cancel_silently");
        turn.stop("cancel_silently");
        return { ok: true, text: "Ended silently." };
      },
    }),
  ];
}
