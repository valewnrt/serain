import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Sealing credentials (W16, D30). AES-256-GCM, the key lives only in the
 * server env (`SERAIN_INTEGRATION_KEY`), the sealed value only in the
 * database: whoever has one of the two has no access. GCM, because a modified
 * entry should fail on opening instead of delivering nonsense.
 *
 * Format: `v1.<iv>.<tag>.<data>`, all base64url.
 */

const VERSION = "v1";

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

/** 32 bytes, base64 or base64url. Throws with a message that does not name the value. */
export function parseSealKey(raw: string): Buffer {
  const key = Buffer.from(raw.trim().replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) {
    throw new SealError("SERAIN_INTEGRATION_KEY must be 32 bytes in base64 (openssl rand -base64 32).");
  }
  return key;
}

export function seal(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function open(key: Buffer, sealed: string): unknown {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !data) throw new SealError("Sealed credential has an unknown format.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    // Deliberately without a cause: node's error message names no details about the key, and it never should.
    throw new SealError("Sealed credential cannot be opened (wrong key or modified entry).");
  }
}
