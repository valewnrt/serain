import { createHash } from "node:crypto";
import { FILE_SHELF_MAX_BYTES, FILE_SHELF_MAX_FILES, FILE_SHELF_TTL_MS } from "../config/limits.js";
import { t } from "../i18n/catalog.js";
import { media } from "../i18n/messages/media.js";
import { cleanFileName, MIME_TYPE } from "./name.js";

/**
 * Files the owner sent over iMessage, for attaching to a mail (D34 addendum of
 * 2026-10-08). None of them is opened: Serain knows name, type and size, never
 * the content.
 *
 * **Only in memory.** A certificate of enrolment, a contract, an ID do not
 * belong in a database just because Serain is to pass them on once. After a
 * restart or a day the file is gone, and `mail_send` says so instead of
 * sending without it.
 *
 * **The ID is the checksum.** It is in the arguments of the confirmation
 * (`approvals`), so after the owner's 👍 exactly the file that was in the
 * preview goes out, and no other that happens to have the same name.
 */

export interface ShelvedFile {
  /** The first 16 hex characters of SHA-256 over the content. */
  id: string;
  name: string;
  mimeType: string;
  size: number;
  body: Buffer;
}

export const FILE_ID = /^[0-9a-f]{16}$/;

export function fileId(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** The type for the mail: PDF recognised by its bytes, otherwise the channel's statement if it looks like a type. */
export function fileMimeType(body: Buffer, declared: string): string {
  if (body.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  const mime = declared.trim().toLowerCase();
  return MIME_TYPE.test(mime) ? mime : "application/octet-stream";
}

export class FileShelf {
  private readonly files = new Map<string, { file: ShelvedFile; at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits = { ttlMs: FILE_SHELF_TTL_MS, maxFiles: FILE_SHELF_MAX_FILES, maxBytes: FILE_SHELF_MAX_BYTES },
  ) {}

  put(input: { name: string; mimeType: string; body: Buffer }): ShelvedFile {
    const mimeType = fileMimeType(input.body, input.mimeType);
    const file: ShelvedFile = {
      id: fileId(input.body),
      name: cleanFileName(input.name, mimeType, t(mimeType === "application/pdf" ? media.unnamedPdf : media.unnamedFile)),
      mimeType,
      size: input.body.length,
      body: input.body,
    };
    this.files.delete(file.id);
    this.files.set(file.id, { file, at: this.now() });
    this.prune();
    return file;
  }

  /** Null when the file never existed, is too old or is missing since a restart. */
  get(id: string): ShelvedFile | null {
    this.prune();
    return this.files.get(id)?.file ?? null;
  }

  private prune(): void {
    const cutoff = this.now() - this.limits.ttlMs;
    for (const [id, entry] of this.files) if (entry.at < cutoff) this.files.delete(id);
    let total = [...this.files.values()].reduce((sum, entry) => sum + entry.file.size, 0);
    // Oldest first: Map keeps the insertion order, `put` moves a file to the end.
    for (const [id, entry] of this.files) {
      if (this.files.size <= this.limits.maxFiles && total <= this.limits.maxBytes) break;
      this.files.delete(id);
      total -= entry.file.size;
    }
  }
}
