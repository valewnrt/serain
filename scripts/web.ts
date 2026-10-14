import { createHash, randomBytes } from "node:crypto";
import { owner } from "../src/config/owner.js";
import { db } from "../src/db/client.js";
import { fromBase64Url, generateVaultKeyPair, keyId, loadVaultKey, toBase64Url } from "../src/vault/sealbox.js";
import { managementToken, projectRef, readVar, ROOT_VARS, WEB_VARS, writeVar } from "./dev-vars.js";
import { scramVerifier } from "./scram.js";
import { ensureWrangler, setWranglerVars } from "./wrangler-config.js";

/**
 * Setup of the web interface (D49). Runs on the owner's machine, never on
 * the server: needs the secret key from `.dev.vars` or the Supabase
 * management token (`SUPABASE_ACCESS_TOKEN` or keychain, scripts/dev-vars.ts).
 *
 *   pnpm web vault-key      create the vault key pair (private → .dev.vars, public → web/wrangler.toml;
 *                           creates web/wrangler.toml from web/wrangler.toml.example if it is missing)
 *   pnpm web db-password    reset the password of the role serain_web (→ web/.dev.vars)
 *   pnpm web enroll [url]   one-time link for a new passkey, valid for 15 minutes
 *   pnpm web passkeys       list passkeys
 *   pnpm web revoke <id>    remove a passkey, its sessions end immediately
 */

async function managementQuery(query: string): Promise<unknown> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef()}/database/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${managementToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase refuses (${response.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * SCRAM-SHA-256 verifier per RFC 5802/7677, as Postgres stores it. This way
 * the password never reaches Supabase in plain text, not even in a statement
 * log: only the verifier goes there.
 */
async function vaultKey(): Promise<void> {
  let privateKey = readVar(ROOT_VARS, "SERAIN_VAULT_KEY");
  if (!privateKey) {
    privateKey = (await generateVaultKeyPair()).privateKey;
    writeVar(ROOT_VARS, "SERAIN_VAULT_KEY", privateKey, "Vault (D49): private key. Also in /etc/serain/serain.env, otherwise the server cannot open the vault.");
    console.log("New key pair created, the private part is in .dev.vars.");
  } else {
    console.log("SERAIN_VAULT_KEY is already in .dev.vars, using it.");
  }
  const key = await loadVaultKey(privateKey);
  const publicKey = await publicFromPrivate(privateKey);
  if (ensureWrangler()) console.log("Created web/wrangler.toml from web/wrangler.toml.example.");
  setWranglerVars({ VAULT_PUBLIC_KEY: publicKey, OWNER_TIMEZONE: owner.timezone });
  console.log(`Public key (${key.keyId}) and time zone (${owner.timezone}) are in web/wrangler.toml.`);
  console.log("For the server: copy SERAIN_VAULT_KEY from .dev.vars to /etc/serain/serain.env.");
}

async function publicFromPrivate(privateKey: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey("pkcs8", fromBase64Url(privateKey), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = await subtle.exportKey("jwk", key);
  const publicKey = toBase64Url(new Uint8Array([4, ...fromBase64Url(jwk.x ?? ""), ...fromBase64Url(jwk.y ?? "")]));
  if ((await keyId(publicKey)) !== (await loadVaultKey(privateKey)).keyId) throw new Error("Keys do not match.");
  return publicKey;
}

async function dbPassword(): Promise<void> {
  const ref = projectRef();
  const password = toBase64Url(randomBytes(32));
  await managementQuery(`alter role serain_web with password '${scramVerifier(password)}'`);
  const pooler = (await (
    await fetch(`https://api.supabase.com/v1/projects/${ref}/config/database/pooler`, { headers: { authorization: `Bearer ${managementToken()}` } })
  ).json()) as Array<{ db_host: string; db_port: number; pool_mode: string; database_type: string }>;
  const tx = pooler.find((entry) => entry.database_type === "PRIMARY" && entry.pool_mode === "transaction");
  if (!tx) throw new Error("No transaction pooler found.");
  // Locally via the tunnel from web/dev.ts (TLS checked against the Supabase CA); the Worker itself cannot trust the CA.
  writeVar(WEB_VARS, "DATABASE_URL", `postgresql://serain_web.${ref}:${password}@127.0.0.1:54320/postgres`, "Web interface (D49): Postgres as serain_web, locally via the tunnel. Gitignored.");
  writeVar(WEB_VARS, "DATABASE_UPSTREAM", `${tx.db_host}:${tx.db_port}`, "Tunnel target: the Supabase pooler.");
  console.log("Password for serain_web set (only as a SCRAM verifier to Supabase), DATABASE_URL and DATABASE_UPSTREAM are in web/.dev.vars.");
  console.log("If the web interface already runs on Cloudflare, run pnpm web:setup afterwards: Hyperdrive needs the new password.");
}

async function enroll(origin: string): Promise<void> {
  const token = toBase64Url(randomBytes(32));
  const { error } = await db.from("web_enrollments").insert({
    token_hash: createHash("sha256").update(token).digest("hex"),
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  if (error) throw new Error(`One-time code not stored: ${error.message}`);
  console.log("One-time link, valid for 15 minutes, usable once. Do not share:");
  console.log(`${origin.replace(/\/$/, "")}/enroll#${token}`);
}

async function passkeys(): Promise<void> {
  const { data, error } = await db.from("web_passkeys").select("id, label, created_at, last_used_at").order("created_at");
  if (error) throw new Error(error.message);
  if (!data?.length) return console.log("No passkeys.");
  for (const row of data) console.log(`${String(row.id).slice(0, 12)}\t${row.label || "(no name)"}\tcreated ${row.created_at}\tlast used ${row.last_used_at ?? "never"}`);
}

async function revoke(prefix: string): Promise<void> {
  const { data, error } = await db.from("web_passkeys").select("id, label").like("id", `${prefix}%`);
  if (error) throw new Error(error.message);
  if (!data || data.length !== 1) throw new Error(data?.length ? "Ambiguous, give a longer prefix." : "No passkey with this prefix.");
  const row = data[0]!;
  const removed = await db.from("web_passkeys").delete().eq("id", row.id);
  if (removed.error) throw new Error(removed.error.message);
  await db.from("audit_log").insert({ event: "web_passkey_removed", actor: "web", detail: { passkey: String(row.id).slice(0, 12), label: row.label } });
  console.log(`Removed: ${row.label || String(row.id).slice(0, 12)}. Its sessions have ended.`);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command === "vault-key") return vaultKey();
  if (command === "db-password") return dbPassword();
  if (command === "enroll") return enroll(arg ?? "http://localhost:8787");
  if (command === "passkeys") return passkeys();
  if (command === "revoke" && arg) return revoke(arg);
  console.log("pnpm web vault-key | db-password | enroll [origin] | passkeys | revoke <id-prefix>");
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
