import { MAIL_ATTACHMENT_MAX_CHARS, MAIL_ATTACHMENT_PAGE_MAX_CHARS, PDF_PAGES_MAX } from "../config/limits.js";
import type { PerceptionRequest, PerceptionResult } from "../agent/model.js";
import { renderPages } from "../executor/pdf-pages.js";
import { log } from "../log.js";
import { detectKind, IMAGE_INSTRUCTION, lookAtImage } from "../media/attachments.js";
import { isPdf, pdfToText } from "../media/pdf.js";
import type { Sandbox } from "../sandbox/client.js";
import type { MailAttachmentFile } from "./types.js";

/**
 * Open an attachment from a mail (addendum D31 of 2026-10-12). Reason: a
 * payment reminder stated the amount only in the PDF, and Serain could only
 * tell the owner to look it up themselves.
 *
 * The same path as for attachments from the owner (D21) and PDFs from the web
 * (addendum D20 of 2026-10-09): every parser for the foreign format runs in the
 * sandbox, without network. A PDF becomes text (`pdf_to_text`); if it has none,
 * it is a scan, and up to `PDF_PAGES_MAX` pages are rendered as images
 * (`pdf_to_pages`) and transcribed. An image becomes a JPEG without metadata
 * and is then described. Everything else stays closed. The text is untrusted
 * content; framing it and hiding codes is the tool's job.
 */

export interface AttachmentOpener {
  /** Without a sandbox nothing is opened: the service has no fallback path. */
  sandbox: Sandbox;
  describeImage(req: PerceptionRequest): Promise<PerceptionResult>;
}

export type OpenedAttachment =
  | { ok: true; kind: "pdf" | "scan" | "image"; text: string; truncated: boolean }
  | { ok: false; reason: string };

const PAGE_INSTRUCTION =
  "This is one page of a document, as an image. Transcribe its text, as literally as possible, with all amounts, " +
  "dates, numbers and names. Tables as rows with \"|\" between the columns. Mark what you cannot read " +
  "with [illegible]. Add nothing, no summary before or after.";

function cut(text: string, max: number): { text: string; truncated: boolean } {
  const clean = text.trim();
  return clean.length > max ? { text: `${clean.slice(0, max)}…`, truncated: true } : { text: clean, truncated: false };
}

async function readPdf(file: MailAttachmentFile, opener: AttachmentOpener, cancelled?: Promise<void>): Promise<OpenedAttachment> {
  const read = await pdfToText(opener.sandbox, file.body, cancelled);
  if (read.ok) return { ok: true, kind: "pdf", ...cut(read.text, MAIL_ATTACHMENT_MAX_CHARS) };
  if (read.reason === "timeout") return { ok: false, reason: "The PDF could not be read in time." };
  if (read.reason === "failed") return { ok: false, reason: "The PDF could not be read, it is probably broken or encrypted." };
  // No text: a scan. Short ones are transcribed page by page, long ones stay closed.
  const pages = await renderPages(opener.sandbox, file.body, cancelled);
  if (!pages) return { ok: false, reason: `The PDF is a scan without text with more than ${PDF_PAGES_MAX} pages, I cannot transcribe that.` };
  const parts: string[] = [];
  let truncated = false;
  for (const [index, page] of pages.entries()) {
    const seen = await lookAtImage(opener.sandbox, page, opener.describeImage, PAGE_INSTRUCTION, cancelled);
    const text = seen.ok ? cut(seen.text, MAIL_ATTACHMENT_PAGE_MAX_CHARS) : { text: "[page could not be opened]", truncated: false };
    truncated ||= text.truncated;
    parts.push(pages.length > 1 ? `Page ${index + 1}:\n${text.text}` : text.text);
  }
  return { ok: true, kind: "scan", text: parts.join("\n\n"), truncated };
}

export async function openMailAttachment(file: MailAttachmentFile, opener: AttachmentOpener, cancelled?: Promise<void>): Promise<OpenedAttachment> {
  try {
    if (isPdf(file.body)) return await readPdf(file, opener, cancelled);
    if (detectKind(file.body, file.mimeType, file.name) === "image") {
      const seen = await lookAtImage(opener.sandbox, file.body, opener.describeImage, IMAGE_INSTRUCTION, cancelled);
      if (!seen.ok) return { ok: false, reason: "The image could not be opened." };
      const text = cut(seen.text, MAIL_ATTACHMENT_PAGE_MAX_CHARS);
      return text.text ? { ok: true, kind: "image", ...text } : { ok: false, reason: "No description came back for the image." };
    }
    return { ok: false, reason: `I can only open PDFs and images, this one is ${file.mimeType.replace(/[^\w.+/-]/g, "").slice(0, 60) || "an unknown type"}.` };
  } catch (error) {
    log.warn("Mail attachment not opened:", (error as Error).message);
    return { ok: false, reason: "The attachment could not be opened right now." };
  }
}
