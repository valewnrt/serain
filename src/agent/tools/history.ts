import { z } from "zod";
import { MEMORY } from "../../config/memory.js";
import type { MemoryDeps } from "../../memory/deps.js";
import { ownerDayEnd, ownerDayStart } from "../../memory/kinds.js";
import { wrapDerived } from "../../security/untrusted.js";
import { formatWallTime } from "../../time.js";
import { defineTool, type ToolDefinition } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * History search (V3, D41): "what did I tell you about X last week".
 *
 * Serain sees 20 messages and a few summaries per turn. Everything in between
 * used to be gone, although it is in `messages`. Hermes (`session_search`) and
 * OpenClaw (transcripts in the index) can do this; here hybrid as with the
 * facts, so that paraphrases and typos do not fail (a plain word search
 * misses them).
 *
 * **Level `read`, no `returnsUntrusted`:** the search only covers the owner's
 * own conversation with Serain. What Serain wrote in it after untrusted
 * content appears framed in the result as in the history (D8.4, addendum of
 * 2026-10-02): a marker, no taint, otherwise an old mail notice would block
 * every search.
 */
export interface HistoryToolDeps {
  memory: MemoryDeps;
  /** The owner's number: the search only covers their conversation. */
  ownerPhone: string;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(`Calendar day in ${owner.timezone}, YYYY-MM-DD.`);

export function historyTools(deps: HistoryToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: "search_history",
      description:
        "Searches your whole chat so far, including what is no longer in the history. For questions like " +
        `'what did I tell you about X last week' or when ${owner.name} refers to something earlier that you do not ` +
        "see. Searches by meaning and by words; from/to narrow the time range.",
      level: "read",
      repeatable: true,
      schema: {
        query: z.string().trim().min(2).max(200).describe("What it was about, in your own words or as keywords."),
        from: day.optional(),
        to: day.optional().describe("Last day that still counts."),
      },
      async run(args: { query: string; from?: string; to?: string }) {
        let embedding: number[] | null = null;
        try {
          const [vector] = await deps.memory.embed([args.query]);
          embedding = vector ?? null;
        } catch {
          // The full-text search finds names and numbers without a vector too.
        }
        // Calendar days in the owner's time zone, not with a fixed offset: otherwise it would be an hour off in winter.
        const from = args.from ? ownerDayStart(args.from) : null;
        const to = args.to ? ownerDayEnd(args.to) : null;
        const hits = await deps.memory.store.searchMessages({
          peer: deps.ownerPhone,
          embedding,
          query: args.query,
          limit: MEMORY.historySearchLimit,
          ...(from ? { from: from.toISOString() } : {}),
          ...(to ? { to: to.toISOString() } : {}),
        });
        if (hits.length === 0) return { ok: true, text: "Nothing about that in your chat." };
        const lines = hits
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((hit) => {
            const body = hit.body.length > MEMORY.historyHitMaxChars ? `${hit.body.slice(0, MEMORY.historyHitMaxChars)} …` : hit.body;
            const text = hit.direction === "outbound" && hit.taintSources.length > 0 ? wrapDerived(body, hit.taintSources) : body;
            return `${formatWallTime(new Date(hit.createdAt))} ${hit.direction === "inbound" ? `${owner.name}` : "You"}: ${text}`;
          });
        return { ok: true, text: lines.join("\n") };
      },
    }),
  ];
}

