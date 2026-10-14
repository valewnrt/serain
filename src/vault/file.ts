import * as z from "zod/mini";
import { FILE_NAME_FORBIDDEN, MIME_TYPE } from "../files/name.js";
import { SITE_NAME } from "./entry.js";

/**
 * A file in the vault (ID, certificate, contract). Like the logins (D49):
 * sealed in the browser to the server's public key, only the server can open
 * it. Both sides read this file.
 *
 * Everything is sealed in one piece: a header with name, file name, type, size
 * and SHA-256, followed by the content. The server only uses what is inside
 * the seal; file name, type and size in `vault_files` are for display in the
 * web interface. Plain text (`[4 bytes header length][header as JSON][content]`).
 */

export const VAULT_FILE_NAME = SITE_NAME;
/** Fits into a mail (`MAIL_SEND_MAX_FILE_BYTES`) and does not take a minute to upload. */
export const VAULT_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** At most this much together, so the vault does not eat up Supabase's free quota (500 MB). */
export const VAULT_FILES_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const VAULT_FILES_MAX_COUNT = 25;
/** The header inside the seal; it holds no more than name, file name, type and checksum. */
export const VAULT_FILE_HEADER_MAX_BYTES = 1024;

export const vaultFileHeaderSchema = z.strictObject(
  {
    name: z.string("Name missing").check(z.regex(VAULT_FILE_NAME, "Name of lowercase letters, digits, - and _, 2 to 31 characters")),
    filename: z
      .string("File name missing")
      .check(
        z.minLength(1, "File name missing"),
        z.maxLength(120, "File name is too long"),
        z.refine((value) => !FILE_NAME_FORBIDDEN.test(value), "File name with forbidden characters"),
      ),
    mimeType: z.string("Type missing").check(z.regex(MIME_TYPE, "Unknown file type")),
    size: z.int("Size missing").check(z.gte(1, "The file is empty"), z.lte(VAULT_FILE_MAX_BYTES, "At most 10 MB per file")),
    sha256: z.string("Checksum missing").check(z.regex(/^[0-9a-f]{64}$/, "Checksum invalid")),
  },
  "Unknown field",
);
export type VaultFileHeader = z.infer<typeof vaultFileHeaderSchema>;

export class VaultFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultFileError";
  }
}

interface Digest {
  digest(algorithm: "SHA-256", data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
}
const subtle = (): Digest => (globalThis as unknown as { crypto: { subtle: Digest } }).crypto.subtle;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", new Uint8Array(bytes)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function packVaultFile(header: VaultFileHeader, body: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  if (head.length > VAULT_FILE_HEADER_MAX_BYTES) throw new VaultFileError("File header too large.");
  const out = new Uint8Array(4 + head.length + body.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(body, 4 + head.length);
  return out;
}

/** Splits the opened plain text and checks header, size and checksum against the content. */
export async function unpackVaultFile(plain: Uint8Array): Promise<{ header: VaultFileHeader; body: Uint8Array }> {
  if (plain.length < 4) throw new VaultFileError("File without header.");
  const length = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0);
  if (length < 2 || length > VAULT_FILE_HEADER_MAX_BYTES || 4 + length > plain.length) throw new VaultFileError("File header broken.");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain.subarray(4, 4 + length)));
  } catch {
    throw new VaultFileError("File header is not JSON.");
  }
  const parsed = vaultFileHeaderSchema.safeParse(raw);
  if (!parsed.success) throw new VaultFileError(`File header invalid: ${parsed.error.issues[0]?.message ?? "?"}`);
  const body = plain.subarray(4 + length);
  if (body.length !== parsed.data.size) throw new VaultFileError("Size does not match the content.");
  if ((await sha256Hex(body)) !== parsed.data.sha256) throw new VaultFileError("Checksum does not match the content.");
  return { header: parsed.data, body };
}

/** How much larger the sealed form is at most than the content: header, length field, seal. */
export function sealedSizeBounds(size: number, overhead: number): { min: number; max: number } {
  return { min: size + overhead + 4 + 2, max: size + overhead + 4 + VAULT_FILE_HEADER_MAX_BYTES };
}

/** base64url in chunks: at 10 MB one character after the other would be noticeably slow. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
