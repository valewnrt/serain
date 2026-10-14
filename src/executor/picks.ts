import { z } from "zod";
import { MAX_BUBBLE_CHARS, PICK_BUBBLES_MAX, PICK_GROUPS_MAX, PICK_ITEMS_MAX } from "../config/limits.js";
import { dropUnbackedLinks } from "../security/links.js";
import { owner } from "../config/owner.js";

/**
 * Things to choose from in a task (addendum D61 of 2026-10-09): dishes,
 * products, offers, grouped by person or source. The executor hands them to
 * `finish_task` as fixed data, the code builds the list in the owner's form
 * from them, and that list goes to the owner verbatim.
 *
 * Before this, a ranking of 23 dishes stood complete in a video description,
 * only in excerpts in the report, and Serain turned it into paragraphs. Two
 * models condensing one after the other lose on the way what no prompt holds
 * reliably.
 *
 * The content is foreign (it comes from videos and pages). It only goes to the
 * owner, without links (`dropUnbackedLinks` without evidence: every one goes)
 * and without formatting (verbatim), so a page can slip in neither a link nor
 * emphasis. The executor never sees the chat: the owner's language for `note`,
 * `detail` and `why` comes with its task (`ownerLanguageLine` in `language.ts`).
 */

const line = (max: number) => z.string().trim().min(1).max(max);

export const picksSchema = z
  .array(
    z.object({
      who: line(40).describe("Person or source as one word or name (Eli, Max), without channel and without brackets."),
      note: line(60)
        .optional()
        .describe(
          `Their verdict on the whole, a few words in ${owner.name}'s language ("best restaurant in the world"). Never how you searched. Otherwise leave it out.`,
        ),
      own_list: z
        .boolean()
        .describe(
          "true if the person in the video keeps a list of their own (best-of list, ranking, \"goes on the list\"). Then " +
            "items holds every entry of that list, in its order, no selection from it, and why only where it says " +
            "more than \"on the list\" (favourite, a quote).",
        ),
      items: z
        .array(
          z.object({
            name: line(80).describe("The real name, exactly as on the menu or in the video, never translated."),
            detail: line(40).optional().describe(`What it is, only if the name does not say it (aubergines), in ${owner.name}'s language.`),
            price: line(20).optional().describe("Final price from the provider, as the provider writes it (\"49,99 €\"). Leave it out if you have no evidence for one."),
            why: line(80).optional().describe(`A half sentence in ${owner.name}'s language, why: their favourite, number 1, a quote.`),
          }),
        )
        .min(1)
        .max(PICK_ITEMS_MAX),
    }),
  )
  .max(PICK_GROUPS_MAX)
  .optional()
  .describe(
    "Only if the task delivers things to choose from (dishes, products, offers): one group per person or source " +
      "with all things in their order. Never files, pages, screenshots or sources, and never the whole menu copied out: if the task only wants the " +
      `menu or the PDF itself, ${owner.name} gets it as an image, and picks stays empty. Serain sends this to ${owner.name} verbatim.`,
  );

export type PickGroup = NonNullable<z.infer<typeof picksSchema>>;

/** One line, without line break, link or control characters. */
function clean(text: string | undefined): string {
  if (!text) return "";
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return dropUnbackedLinks(flat, []);
}

function itemLine(item: PickGroup[number]["items"][number]): string {
  const name = clean(item.name);
  const detail = clean(item.detail);
  return ["• " + (detail ? `${name} (${detail})` : name), clean(item.price), clean(item.why)].filter(Boolean).join(", ");
}

export interface RenderedPicks {
  /** One bubble per entry: a group, a long group also in several. */
  bubbles: string[];
  /** Lines that did not fit any more beyond `PICK_BUBBLES_MAX`. */
  dropped: number;
}

/**
 * The list in the owner's form: one line per person or source, below it one line
 * per thing, "• name (what), price, why". Every group starts a new bubble; one
 * that does not fit into one continues at line boundaries.
 */
export function renderPicks(groups: PickGroup): RenderedPicks {
  const bubbles: string[] = [];
  let dropped = 0;
  for (const group of groups) {
    const who = clean(group.who);
    const note = clean(group.note);
    let current = note ? `${who} (${note})` : who;
    for (const item of group.items) {
      const next = itemLine(item).slice(0, MAX_BUBBLE_CHARS);
      if (current.length + 1 + next.length <= MAX_BUBBLE_CHARS) {
        current = `${current}\n${next}`;
        continue;
      }
      bubbles.push(current);
      current = next;
    }
    bubbles.push(current);
  }
  if (bubbles.length > PICK_BUBBLES_MAX) {
    dropped = bubbles.splice(PICK_BUBBLES_MAX).reduce((sum, bubble) => sum + bubble.split("\n").filter((row) => row.startsWith("• ")).length, 0);
  }
  return { bubbles, dropped };
}
