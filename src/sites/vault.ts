import { log, redactValue } from "../log.js";
import { loadVaultKey, type VaultKey } from "../vault/sealbox.js";
import { vaultEntrySchema, type VaultEntry } from "../vault/entry.js";
import { owner } from "../config/owner.js";

/**
 * The vault on the server (D49): entries live in `vault_entries`, sealed to the
 * server's public key. They are opened here and only here, with
 * `SERAIN_VAULT_KEY`, and only for a session that is starting.
 *
 * Only what stands in the sealed part is used. The plain-text columns next to
 * it are display for the web interface; whoever can change the database could
 * bend them, but not steer a password to a foreign host.
 */

export interface VaultRow {
  site: string;
  sealed: string;
}

export interface VaultRowSource {
  sites(): Promise<string[]>;
  row(site: string): Promise<VaultRow | null>;
}

export interface VaultReader {
  /** Names of the entries, without opening anything. */
  list(): Promise<string[]>;
  get(site: string): Promise<VaultEntry | null>;
}

export class VaultUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultUnavailable";
  }
}

export function serverVault(rows: VaultRowSource, privateKey: string): VaultReader {
  let key: Promise<VaultKey> | null = null;
  const loadKey = () => (key ??= loadVaultKey(privateKey));
  return {
    list: () => rows.sites(),
    async get(site) {
      const row = await rows.row(site);
      if (!row) return null;
      let parsed: VaultEntry;
      try {
        const opened = vaultEntrySchema.safeParse(await (await loadKey()).open(site, row.sealed));
        if (!opened.success) throw new Error("content does not match the schema");
        parsed = opened.data;
      } catch (error) {
        log.warn(`Vault entry ${site} not readable: ${(error as Error).message}`);
        throw new VaultUnavailable(`The vault entry "${site}" cannot be opened. ${owner.name} has to create it again in the web interface.`);
      }
      // The name is already bound through the AAD; belt and braces, in case the format ever changes.
      if (parsed.site !== site) throw new VaultUnavailable(`The vault entry "${site}" belongs to another name.`);
      redactValue(parsed.password);
      redactValue(parsed.totpSecret);
      return parsed;
    },
  };
}
