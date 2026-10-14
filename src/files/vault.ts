import { log } from "../log.js";
import { loadVaultKey, type VaultKey } from "../vault/sealbox.js";
import { unpackVaultFile } from "../vault/file.js";
import { owner } from "../config/owner.js";

/**
 * Files in the vault on the server (D49 addendum of 2026-10-08): the owner
 * stores them in the web interface, sealed to the server's public key. They
 * are opened here and only here, with `SERAIN_VAULT_KEY`, and only when the
 * owner wants a file or wants to pass it on (`vault_file`).
 *
 * Only what is inside the seal is used: file name, type and content with its
 * checksum. The columns next to it are for display; the list (`list`) comes
 * from there, because it is not supposed to open anything.
 */

export interface VaultFileMeta {
  name: string;
  filename: string;
  mimeType: string;
  size: number;
  updatedAt: Date;
}

export interface VaultFileRowSource {
  list(): Promise<VaultFileMeta[]>;
  sealed(name: string): Promise<Uint8Array | null>;
}

export interface OpenedVaultFile {
  filename: string;
  mimeType: string;
  body: Buffer;
}

export interface VaultFiles {
  list(): Promise<VaultFileMeta[]>;
  /** Null when the file does not exist. Throws `VaultFileUnavailable` when it cannot be opened. */
  open(name: string): Promise<OpenedVaultFile | null>;
}

export class VaultFileUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultFileUnavailable";
  }
}

export function serverVaultFiles(rows: VaultFileRowSource, privateKey: string): VaultFiles {
  let key: Promise<VaultKey> | null = null;
  const loadKey = () => (key ??= loadVaultKey(privateKey));
  return {
    list: () => rows.list(),
    async open(name) {
      const sealed = await rows.sealed(name);
      if (!sealed) return null;
      try {
        const { header, body } = await unpackVaultFile(await (await loadKey()).openBytes(name, sealed));
        // The name is already bound through the AAD; twice holds better in case the format ever changes.
        if (header.name !== name) throw new Error("header names a different name");
        return { filename: header.filename, mimeType: header.mimeType, body: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
      } catch (error) {
        log.warn(`Vault file ${name} not readable: ${(error as Error).message}`);
        throw new VaultFileUnavailable(`The file "${name}" in the vault cannot be opened. ${owner.name} has to store it again in the web interface.`);
      }
    },
  };
}
