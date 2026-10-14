import { db } from "./client.js";
import type { VaultFileRowSource } from "../files/vault.js";
import type { VaultRowSource } from "../sites/vault.js";

/** `vault_entries` with the secret key (D49). Reads the sealed data, writes nothing: entries are created in the web interface. */
export const vaultRows: VaultRowSource = {
  async sites() {
    const { data, error } = await db.from("vault_entries").select("site").order("site");
    if (error) throw new Error(`Vault not readable: ${error.message}`);
    return (data ?? []).map((row) => String(row.site));
  },
  async row(site) {
    const { data, error } = await db.from("vault_entries").select("site, sealed").eq("site", site).maybeSingle();
    if (error) throw new Error(`Vault not readable: ${error.message}`);
    return data ? { site: String(data.site), sealed: String(data.sealed) } : null;
  },
};

/** `vault_files` with the secret key (addendum D49 of 2026-10-08). Reads, writes nothing: files are stored in the web interface. */
export const vaultFileRows: VaultFileRowSource = {
  async list() {
    const { data, error } = await db.from("vault_files").select("name, filename, mime_type, size, updated_at").order("name");
    if (error) throw new Error(`Vault not readable: ${error.message}`);
    return (data ?? []).map((row) => ({
      name: String(row.name),
      filename: String(row.filename),
      mimeType: String(row.mime_type),
      size: Number(row.size),
      updatedAt: new Date(String(row.updated_at)),
    }));
  },
  async sealed(name) {
    const { data, error } = await db.from("vault_files").select("sealed").eq("name", name).maybeSingle();
    if (error) throw new Error(`Vault not readable: ${error.message}`);
    if (!data) return null;
    // PostgREST returns bytea as "\x" plus hex.
    const hex = String(data.sealed);
    if (!/^\\x(?:[0-9a-f]{2})+$/.test(hex)) throw new Error("Vault file has an unknown format.");
    return new Uint8Array(Buffer.from(hex.slice(2), "hex"));
  },
};
