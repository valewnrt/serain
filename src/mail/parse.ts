import type { AddressObject, ParsedMail } from "mailparser";
import { htmlToText } from "../executor/fetch.js";
import { mailSnippet } from "./codes.js";
import { verifiedSenderDomain, type HeaderField, type ProviderTrust } from "./sender-auth.js";
import type { MailMessage } from "./types.js";

/** From a parsed mail, what Serain needs of it. Without I/O, so that it stays testable. */

function addresses(value: AddressObject | AddressObject[] | undefined): string {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .flatMap((entry) => entry.value)
    .map((entry) => (entry.name ? `${entry.name} <${entry.address ?? ""}>` : (entry.address ?? "")))
    .filter(Boolean)
    .join(", ");
}

type Headers = Pick<Map<string, unknown>, "has" | "get">;

/**
 * Bulk mail recognised by its header (RFC 2369, RFC 2076), not by its content:
 * newsletters, advertising, lists. Only that may be touched by the cleanup (D37).
 */
export function isBulk(headers: Headers): boolean {
  const precedence = String(headers.get("precedence") ?? "").toLowerCase();
  return headers.has("list-unsubscribe") || headers.has("list-id") || ["bulk", "list", "junk"].includes(precedence);
}

/**
 * Sent by a machine (RFC 3834 `Auto-Submitted`), but not a list: booking
 * confirmation, pickup slip, ticket (addendum D33 of 2026-10-10). Until then
 * this counted as bulk mail, and the cleanup moved a sender's tickets to the
 * trash along with its newsletters.
 */
export function isAutomated(headers: Headers): boolean {
  const auto = String(headers.get("auto-submitted") ?? "").toLowerCase();
  return auto !== "" && auto !== "no";
}

/**
 * What an attachment is called in the list. Embedded images (logos,
 * signatures, referenced by Content-ID in the HTML) are not attachments. An
 * invitation from Outlook comes as `text/calendar` without a file name: it is
 * then called what it is, instead of "(unnamed)", otherwise a mail with an
 * empty text and a proposed appointment is empty for every reader (addendum
 * D33 of 2026-10-08). `null`: do not list.
 */
export function attachmentLabel(part: { filename?: string | undefined; contentType?: string | undefined; inline: boolean }): string | null {
  const type = (part.contentType ?? "").toLowerCase();
  if (part.inline && type.startsWith("image/")) return null;
  if (part.filename) return part.filename;
  if (type === "text/calendar") return "calendar-invitation.ics";
  return "(unnamed)";
}

/**
 * The attachments the list names, with their content, in the same order:
 * number n in `MailMessage.attachments` is the n-th entry here.
 */
export function listedAttachments(parsed: Pick<ParsedMail, "attachments">): Array<{ label: string; mimeType: string; content: Buffer }> {
  return parsed.attachments.flatMap((file) => {
    const label = attachmentLabel({
      filename: file.filename,
      contentType: file.contentType,
      inline: file.related || (file.contentDisposition === "inline" && Boolean(file.cid)),
    });
    return label === null ? [] : [{ label, mimeType: file.contentType ?? "", content: file.content }];
  });
}

export function bodyText(parsed: Pick<ParsedMail, "text" | "html">): string {
  const plain = (parsed.text ?? "").trim();
  if (plain) return plain.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return typeof parsed.html === "string" ? htmlToText(parsed.html).text : "";
}

/** All header lines in their order, top first, with their raw value. */
function headerFields(parsed: Pick<ParsedMail, "headerLines">): HeaderField[] {
  return parsed.headerLines.map((header) => ({ name: header.key, value: header.line.slice(header.line.indexOf(":") + 1) }));
}

export function toMailMessage(
  accountId: string,
  providerId: string,
  parsed: ParsedMail,
  fallbackDate: Date,
  folder: string,
  /** How to recognise the verdict of the own incoming server (`imapTrust`); without it, no sender counts as verified. */
  trust: ProviderTrust | null = null,
): MailMessage {
  const text = bodyText(parsed);
  const from = addresses(parsed.from);
  const senderDomain = verifiedSenderDomain(headerFields(parsed), trust);
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const messageId = parsed.messageId ?? "";
  return {
    id: `${accountId}:${providerId}`,
    // The first entry in References is the root of the thread; without it the mail itself is the root.
    threadKey: references[0] ?? parsed.inReplyTo ?? messageId,
    from,
    to: addresses(parsed.to),
    subject: (parsed.subject ?? "").trim(),
    date: (parsed.date ?? fallbackDate).toISOString(),
    snippet: mailSnippet(text, undefined, { subject: parsed.subject ?? "", from }),
    bulk: isBulk(parsed.headers),
    automated: isAutomated(parsed.headers),
    folder,
    text,
    attachments: listedAttachments(parsed).map((file) => file.label),
    messageId,
    references,
    ...(senderDomain ? { senderDomain } : {}),
  };
}
