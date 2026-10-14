import { PDF_PAGES_MAX, PDF_TO_PAGES_TIMEOUT_MS } from "../config/limits.js";
import type { Sandbox } from "../sandbox/client.js";

/**
 * A short PDF as an image per page (decision of 2026-10-09). A PDF in
 * iMessage is an icon with a file name; a menu as an image the owner sees right
 * away in the chat and can zoom into without leaving iMessage. Rendering
 * happens in the sandbox (`pdf_to_pages`), without network. More than
 * `PDF_PAGES_MAX` pages stay a PDF.
 */

/** The output of `pdf_to_pages`: per page ten digits of length, then the JPEG. Null if it does not look exactly like that. */
export function parsePages(out: Buffer): Buffer[] | null {
  const pages: Buffer[] = [];
  let offset = 0;
  while (offset < out.length) {
    const digits = out.subarray(offset, offset + 10).toString("latin1");
    if (!/^\d{10}$/.test(digits)) return null;
    const size = Number(digits);
    const start = offset + 10;
    if (size === 0 || start + size > out.length) return null;
    const page = out.subarray(start, start + size);
    if (page[0] !== 0xff || page[1] !== 0xd8) return null;
    pages.push(page);
    offset = start + size;
  }
  return pages.length > 0 && pages.length <= PDF_PAGES_MAX ? pages : null;
}

/** The pages as JPEG, or null: too many pages, broken PDF, sandbox failed. Then the PDF itself goes. */
export async function renderPages(sandbox: Sandbox, pdf: Buffer, cancelled?: Promise<void>): Promise<Buffer[] | null> {
  try {
    const result = await sandbox.run({ job: "pdf_to_pages", input: pdf, timeoutMs: PDF_TO_PAGES_TIMEOUT_MS, ...(cancelled ? { cancelled } : {}) });
    if (result.timedOut || result.truncated || result.exitCode !== 0) return null;
    return parsePages(result.stdout);
  } catch {
    return null;
  }
}
