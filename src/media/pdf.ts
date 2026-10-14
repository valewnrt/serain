import { PDF_TO_TEXT_TIMEOUT_MS } from "../config/limits.js";
import type { Sandbox } from "../sandbox/client.js";

/**
 * The text of a PDF, read in the sandbox (`pdf_to_text`, at most 40 pages,
 * without network), never in the service (D20 addendum of 2026-10-09). For PDFs
 * from the web (`web_fetch`) and from mails (`mail_attachment`).
 */
export async function pdfToText(
  sandbox: Sandbox,
  pdf: Buffer,
  cancelled?: Promise<void>,
): Promise<{ ok: true; text: string } | { ok: false; reason: "timeout" | "failed" | "empty" }> {
  const result = await sandbox.run({ job: "pdf_to_text", input: pdf, timeoutMs: PDF_TO_TEXT_TIMEOUT_MS, ...(cancelled ? { cancelled } : {}) });
  if (result.timedOut) return { ok: false, reason: "timeout" };
  if (result.exitCode !== 0) return { ok: false, reason: "failed" };
  // pdftotext reads pages with several columns (menus) line by line; the gap between the columns becomes a
  // "|", so the model does not attribute the price on the left to the dish on the right.
  const text = result.stdout
    .toString("utf8")
    .replace(/\f/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]{3,}/g, " | "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? { ok: true, text } : { ok: false, reason: "empty" };
}

/** A PDF is recognised by `%PDF-` at the start; the standard allows up to 1024 bytes of junk before it. */
export function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).includes("%PDF-", 0, "latin1");
}
