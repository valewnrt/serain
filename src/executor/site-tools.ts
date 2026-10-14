import { z } from "zod";
import { FETCH_MAX_CHARS } from "../config/limits.js";
import type { PageSnapshot } from "../browser/pilot.js";
import { SiteFailure, siteActionSchema, type SiteSession } from "../sites/session.js";
import { defineTool, type ToolDefinition, type ToolResult } from "../agent/tools/types.js";
import { screenshotLine } from "./tools.js";
import { owner } from "../config/owner.js";

/**
 * The executor's tools in a logged-in session (D36). In this mode there are
 * **only** these two and `finish_task`: no `web_fetch`, no search, no second
 * browser. What the executor reads in the owner's account can thus only leave
 * the server in the report, and that goes to the owner.
 *
 * Logging in, pinning hosts and the block list for buttons live in the
 * session (`src/sites/session.ts`), not in the prompt.
 * Results are foreign content and do not stand in the audit log (`privateResult`).
 */

export function renderSitePage(page: Pick<PageSnapshot, "url" | "title" | "text" | "elements">): string {
  const elements = page.elements.map((element) =>
    [
      `[${element.id}] ${element.kind} ${element.label || "(no label)"}`,
      element.value ? `· ${element.value}` : "",
      element.options ? `· options: ${element.options.map((option, index) => `${index}=${option}`).join(", ")}` : "",
      element.host ? `→ ${element.host}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  return [
    `Page: ${page.title} | ${page.url}`,
    elements.length > 0 ? `Elements:\n${elements.join("\n")}` : "No operable elements in the visible part.",
    `Text:\n${page.text.slice(0, FETCH_MAX_CHARS) || "(no readable text)"}`,
  ].join("\n\n");
}

function failure(error: unknown): ToolResult {
  if (error instanceof SiteFailure) return { ok: false, text: error.message };
  throw error;
}

export function siteTools(
  session: Pick<SiteSession, "site" | "look" | "act" | "screenshot">,
  onFinish: (report: string) => void,
  /** Like `ExecutorToolDeps.onScreenshot` (addendum D48 of 2026-10-08). */
  onScreenshot?: (shot: { jpeg: Buffer; label: string }) => string | null,
): ToolDefinition[] {
  const source = `Logged-in session at ${session.site}`;
  return [
    defineTool({
      name: "site_look",
      description:
        "Looks at the current page of the logged-in session again: visible elements with number, and the text. With " +
        "screenshot: true it also takes a screenshot, only if the task asks for one and the page shows " +
        "what is asked for. If credentials or codes are on it, there is none.",
      level: "read",
      returnsUntrusted: true,
      privateResult: true,
      schema: {
        screenshot: z.boolean().default(false),
        focus: z
          .string()
          .trim()
          .min(2)
          .max(120)
          .optional()
          .describe(
            "Only with screenshot: a text that stands exactly like this on the page and is to be in the image (a heading, an " +
              "order number). The image then shows the part of the page around it instead of the whole window.",
          ),
      },
      async run(args) {
        try {
          const page = renderSitePage(await session.look());
          if (!args.screenshot) return { ok: true, source, text: page };
          let line: string;
          try {
            const jpeg = await session.screenshot(args.focus);
            const id = onScreenshot?.({ jpeg, label: session.site }) ?? null;
            line = screenshotLine(id ? { id } : { failed: onScreenshot ? "there are already enough for this task" : "not possible in this task" });
          } catch (error) {
            if (!(error instanceof SiteFailure)) throw error;
            line = error.message;
          }
          return { ok: true, source, text: `${line}\n\n${page}` };
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "site_act",
      description:
        "Operates the page: click an element, type text into a field (submit sends it with Enter), choose an entry " +
        "of a select list, scroll or go back. The numbers come from the last result. What comes back is the " +
        `page afterwards. Buttons that buy, book, pay, delete or submit are blocked: ${owner.name} does that themselves.`,
      level: "read",
      returnsUntrusted: true,
      privateResult: true,
      schema: { action: siteActionSchema },
      async run(args) {
        try {
          return { ok: true, source, text: renderSitePage(await session.act(args.action)) };
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "finish_task",
      description: "Ends the task and returns the result to Serain. Always call it last, even if you found nothing.",
      level: "read",
      endsTurn: true,
      schema: { report: z.string().trim().min(1).max(3_000).describe(`What you found in ${owner.name}'s account, in bullet points, and what stayed open.`) },
      async run(args) {
        onFinish(args.report);
        return { ok: true, text: "Task finished." };
      },
    }),
  ];
}
