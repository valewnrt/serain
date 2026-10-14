import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OutboundFile } from "../../channel/types.js";
import { FILE_PDF_MAX_CHARS, FILE_PDF_MAX_PAGES, SOURCE_PDF_MAX_BYTES } from "../../config/limits.js";
import { buildIcs } from "../../files/ics.js";
import { buildPdf } from "../../files/pdf.js";
import { buildVcard } from "../../files/vcard.js";
import { defineTool, type ToolDefinition, type TurnOrigin } from "./types.js";
import { owner } from "../../config/owner.js";
import { t } from "../../i18n/catalog.js";
import { tools as messages } from "../../i18n/messages/tools.js";

/**
 * Files to the owner (audit 2026-10-05): an event as .ics, a contact as
 * vCard, text as PDF. Before, the channel could only receive attachments.
 *
 * **Built in code, from fields.** The model names title, time, name, text;
 * the code builds the file. So there is no way to pass a file from the web
 * through or to send bytes nobody has checked.
 *
 * **The recipient is always the owner** as with `send_message` (the port knows
 * no other target), hence `write_reversible`. What untrusted content the turn
 * read before travels as provenance to the row in `messages` (D8.4); the owner
 * forwards it themselves.
 */

export interface FilePort {
  /** `maxBytes` only for the owner's own files (vault); what Serain builds stays at `FILE_MAX_BYTES`. */
  sendFile(
    file: OutboundFile,
    caption: string,
    opts: { kind: string; origin: TurnOrigin; taintSources: readonly string[]; maxBytes?: number; replyTo?: string },
  ): Promise<boolean>;
}

const EXTENSION = { pdf: "pdf", ics: "ics", vcard: "vcf", screenshot: "jpg" } as const;
const MIME = { pdf: "application/pdf", ics: "text/calendar", vcard: "text/vcard", screenshot: "image/jpeg" } as const;

/** File name without path and control characters: letters, digits, space, dot, hyphen and underscore. */
export function fileName(stem: string, kind: keyof typeof EXTENSION): string {
  const clean = stem
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._-]+/gu, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 60)
    .trim();
  return `${clean || "serain"}.${EXTENSION[kind]}`;
}

const wall = z.string().trim().describe(`YYYY-MM-DD HH:mm local time (${owner.timezone}), or YYYY-MM-DD for all day.`);

export function fileTools(port: FilePort | null): ToolDefinition[] {
  if (!port) return [];
  return [
    defineTool({
      name: "send_file",
      description:
        `Sends ${owner.name} a file via iMessage that you build from fields: ics (an event to tap or forward, ` +
        "adds nothing to their calendar), vcard (a contact), pdf (text with a heading, to forward or " +
        `print). Only when ${owner.name} wants a file or it obviously saves them work; for everything else ` +
        "send_message. A PDF is plain text: paragraphs with blank lines, lists with \"•\", no Markdown. screenshot " +
        "sends a screenshot the executor took in this task (ID from the result), in the thread. " +
        "document sends a PDF the executor read in this task (ID d1 from the result), as it " +
        "is on the page, in the thread; one call per PDF.",
      level: "write_reversible",
      textToOwner: true,
      schema: {
        kind: z.enum(["ics", "vcard", "pdf", "screenshot", "document"]),
        name: z.string().trim().min(1).max(60).optional().describe("File name without extension; unset: the title."),
        event: z
          .object({
            title: z.string().trim().min(1).max(200),
            start: wall,
            end: wall.optional().describe("Unset: one hour, all day: one day."),
            location: z.string().trim().max(200).optional(),
            description: z.string().trim().max(1_000).optional(),
          })
          .strict()
          .optional()
          .describe("Only for ics."),
        contact: z
          .object({
            name: z.string().trim().min(1).max(120),
            phones: z.array(z.string().trim().min(3).max(40)).max(5).optional(),
            emails: z.array(z.string().trim().min(3).max(120)).max(5).optional(),
            org: z.string().trim().max(120).optional(),
            address: z.string().trim().max(300).optional(),
            note: z.string().trim().max(500).optional(),
          })
          .strict()
          .optional()
          .describe("Only for vcard."),
        title: z.string().trim().min(1).max(200).optional().describe("Only for pdf: the heading."),
        text: z.string().trim().min(1).max(FILE_PDF_MAX_CHARS).optional().describe("Only for pdf: the text."),
        screenshot: z.string().trim().max(8).optional().describe("Only for screenshot: the ID from the task result, e.g. s1."),
        document: z.string().trim().max(8).optional().describe("Only for document: the ID from the task result, e.g. d1."),
      },
      async run(args, turn) {
        let file: OutboundFile;
        let caption: string;
        let note = "";
        let replyTo: string | undefined;
        let maxBytes: number | undefined;
        /** Further pages of the same document, each as its own file right after. */
        let more: OutboundFile[] = [];
        if (args.kind === "screenshot") {
          // Only images the browser of this task captured (addendum D48 of 2026-10-08). The code sets the
          // caption, not the model. For public pages it says what the image shows (`Screenshot.shows`): the
          // owner sees it, and without it Serain checked other days than the ones in the image twice in live use.
          // The history frames the line as derived (the message carries the provenance of the task).
          if (args.event || args.contact || args.text) return { ok: false, text: "For screenshot give only the ID." };
          const shot = turn.screenshots.find((entry) => entry.id === args.screenshot);
          if (!shot) {
            return {
              ok: false,
              text:
                turn.screenshots.length > 0
                  ? `This screenshot does not exist. There are: ${turn.screenshots.map((entry) => entry.id).join(", ")}.`
                  : "There is no screenshot in this turn. Only the executor takes one, when the task asks for it.",
            };
          }
          // Name and caption are fixed texts in the owner's language; label and what it shows are content.
          file = { name: fileName(t(messages.screenshotName, { label: shot.label }), "screenshot"), mimeType: MIME.screenshot, body: shot.jpeg };
          caption =
            shot.origin === "site"
              ? t(messages.screenshotAtSite, { label: shot.label })
              : shot.shows
                ? t(messages.screenshotOfShows, { label: shot.label, shows: shot.shows })
                : t(messages.screenshotOf, { label: shot.label });
          if (turn.triggerExternalId) replyTo = turn.triggerExternalId;
        } else if (args.kind === "document") {
          // Only PDFs the executor of this task read, unchanged. The code sets name and caption.
          if (args.event || args.contact || args.text || args.screenshot) return { ok: false, text: "For document give only the ID." };
          const doc = turn.documents.find((entry) => entry.id === args.document);
          if (!doc) {
            return {
              ok: false,
              text:
                turn.documents.length > 0
                  ? `This PDF does not exist. There are: ${turn.documents.map((entry) => entry.id).join(", ")}.`
                  : "There is no PDF in this turn. Only the executor keeps one, when it has read it.",
            };
          }
          // Short enough, then an image per page: the owner sees that in the chat, a PDF is only an icon there (decision of 2026-10-09).
          const pages = (doc.pages ?? []).map((body, index, all) => ({
            name: fileName(all.length > 1 ? t(messages.documentPage, { name: doc.name, page: index + 1 }) : doc.name, "screenshot"),
            mimeType: MIME.screenshot,
            body,
          }));
          file = pages[0] ?? { name: fileName(doc.name, "pdf"), mimeType: MIME.pdf, body: doc.pdf };
          more = pages.slice(1);
          caption = "";
          maxBytes = SOURCE_PDF_MAX_BYTES;
          if (turn.triggerExternalId) replyTo = turn.triggerExternalId;
        } else if (args.kind === "ics") {
          if (!args.event || args.contact || args.text) return { ok: false, text: "For ics give only event." };
          const built = buildIcs(args.event, { uid: `${randomUUID()}@serain`, now: new Date() });
          if (!built.ok) return { ok: false, text: `No file: ${built.reason}` };
          file = { name: fileName(args.name ?? args.event.title, "ics"), mimeType: MIME.ics, body: built.body };
          caption = `${args.event.title}, ${built.summary}`;
        } else if (args.kind === "vcard") {
          if (!args.contact || args.event || args.text) return { ok: false, text: "For vcard give only contact." };
          file = { name: fileName(args.name ?? args.contact.name, "vcard"), mimeType: MIME.vcard, body: buildVcard(args.contact) };
          caption = args.contact.name;
        } else {
          if (!args.text || args.event || args.contact) return { ok: false, text: "For pdf give text, ideally with title." };
          const built = buildPdf({ title: args.title, text: args.text, maxPages: FILE_PDF_MAX_PAGES });
          file = { name: fileName(args.name ?? args.title ?? t(messages.noteName), "pdf"), mimeType: MIME.pdf, body: built.body };
          caption = args.title ?? "";
          if (built.truncated) note = ` Cut off after ${FILE_PDF_MAX_PAGES} pages.`;
        }
        if (!turn.claimMessage()) return { ok: false, text: "Message limit for this turn reached." };
        const opts = {
          kind: args.kind === "screenshot" || args.kind === "document" ? args.kind : "file",
          origin: turn.origin,
          taintSources: [...turn.taintSources],
          ...(replyTo ? { replyTo } : {}),
          ...(maxBytes ? { maxBytes } : {}),
        };
        const sent = await port.sendFile(file, caption, opts);
        if (!sent) {
          return { ok: false, text: `Not sent (channel does not accept the file, limit or duplicate). Tell ${owner.name} and send the essentials as text.` };
        }
        let rest = 0;
        for (const page of more) if (await port.sendFile(page, "", opts)) rest += 1;
        const shown = file.mimeType === MIME.screenshot && args.kind === "document" ? ` As an image${more.length > 0 ? ` per page (${1 + rest} of ${1 + more.length})` : ""}, not as a PDF.` : "";
        return { ok: true, text: `${file.name} is out.${shown}${note}` };
      },
    }),
  ];
}
