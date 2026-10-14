import { z } from "zod";
import { t } from "../../i18n/catalog.js";
import { tools } from "../../i18n/messages/tools.js";
import { defineTool, type ToolDefinition } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * Dry run of the confirmation protocol (D8.3, D14). The tool is level
 * `irreversible` but does nothing: in phase 2 there was no real tool of this
 * level yet, and the protocol should be proven in the running system *before*
 * the first one depends on it (mail in phase 4). Preview, 👍, expiry, standing
 * approval and revocation can be played through over iMessage without
 * anything being able to happen.
 */
export function selftestTools(): ToolDefinition[] {
  return [
    defineTool({
      name: "confirm_selftest",
      description:
        `Dry run of the confirmation protocol, without any effect. Only when ${owner.name} explicitly ` +
        "wants to test the confirmation.",
      level: "irreversible",
      ownerOriginOnly: true,
      schema: {
        note: z.string().trim().max(80).optional().describe("Optional: keyword for the test run."),
      },
      confirm: {
        preview: (args) => (args.note ? t(tools.selftestAskNote, { note: args.note }) : t(tools.selftestAsk)),
        undo: () => t(tools.selftestUndo),
        grantKey: () => ({ kind: "confirm_selftest" }),
        // "yes, but later" can also be played through without effect (addendum D14 of 2026-10-08).
        later: { pin: () => ({}) },
      },
      async run() {
        return { ok: true, text: "Test run done: the confirmation arrived and the tool ran exactly once." };
      },
    }),
  ];
}
