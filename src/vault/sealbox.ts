/**
 * Sealing to the server (D49). The vault is encrypted in the browser, with the
 * server's public key; only whoever has the private key can open it, and that
 * is only in the server's env (`SERAIN_VAULT_KEY`). Web interface, worker and
 * database see only sealed data.
 *
 * Design: ECIES over P-256, all WebCrypto, so the same file runs in the
 * browser, in the worker and in node. A fresh ephemeral key per entry, ECDH
 * with the server key, HKDF-SHA256 (salt: ephemeral key, info: server key),
 * AES-256-GCM. The entry's name is additional authenticated data: putting a
 * sealed value under another name fails on opening. P-256 instead of X25519,
 * because Safari has supported it longer.
 *
 * Format: `sv1.<kid>.<ephemeral-key>.<iv>.<data>`, all base64url. `kid` is the
 * first 8 bytes of the SHA-256 over the public key.
 *
 * Files (`sealBytesTo`) use the same design, only binary and with a context of
 * their own in the AAD: `0x01 | kid (8) | ephemeral-key (65) | iv (12) | data`.
 * A sealed login cannot be opened as a file that way, and vice versa.
 */

const VERSION = "sv1";
const INFO = "serain-vault-v1";
const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * The part of WebCrypto this file needs. Types of its own, because the browser,
 * node and worker types describe the same API differently and this file is
 * type-checked in all three.
 */
type Bytes = Uint8Array<ArrayBuffer>;
interface Key {
  readonly type: string;
}
interface Subtle {
  importKey(format: "raw" | "pkcs8", data: Bytes, algorithm: object | string, extractable: boolean, usages: string[]): Promise<Key>;
  exportKey(format: "raw" | "pkcs8", key: Key): Promise<ArrayBuffer>;
  exportKey(format: "jwk", key: Key): Promise<{ x?: string; y?: string }>;
  generateKey(algorithm: object, extractable: boolean, usages: string[]): Promise<{ publicKey: Key; privateKey: Key }>;
  deriveBits(algorithm: object, key: Key, length: number): Promise<ArrayBuffer>;
  deriveKey(algorithm: object, key: Key, derived: object, extractable: boolean, usages: string[]): Promise<Key>;
  encrypt(algorithm: object, key: Key, data: Bytes): Promise<ArrayBuffer>;
  decrypt(algorithm: object, key: Key, data: Bytes): Promise<ArrayBuffer>;
  digest(algorithm: string, data: Bytes): Promise<ArrayBuffer>;
}
interface WebCrypto {
  subtle: Subtle;
  getRandomValues(array: Bytes): Bytes;
}
const webcrypto = (): WebCrypto => (globalThis as unknown as { crypto: WebCrypto }).crypto;
const subtle = (): Subtle => webcrypto().subtle;
const utf8 = (text: string): Bytes => new Uint8Array(enc.encode(text));

export class SealboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealboxError";
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new SealboxError("Not base64url.");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

const EC = { name: "ECDH", namedCurve: "P-256" } as const;

async function importPublic(publicKey: string): Promise<{ key: Key; raw: Bytes }> {
  const raw = fromBase64Url(publicKey);
  if (raw.length !== 65 || raw[0] !== 4) throw new SealboxError("Public vault key has the wrong format.");
  return { key: await subtle().importKey("raw", raw, EC, true, []), raw };
}

async function deriveKey(privateKey: Key, peer: Key, salt: Bytes, recipient: Bytes): Promise<Key> {
  const shared = await subtle().deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const ikm = await subtle().importKey("raw", new Uint8Array(shared), "HKDF", false, ["deriveKey"]);
  const info = new Uint8Array([...utf8(INFO), ...recipient]);
  return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function aad(site: string): Bytes {
  return utf8(`${INFO}\u0000${site}`);
}

/** Login names contain no null byte, so "file" in front safely separates both spaces. */
function fileAad(name: string): Bytes {
  return utf8(`${INFO}\u0000file\u0000${name}`);
}

const FILE_VERSION = 1;
/** Version, key id, ephemeral key, IV, GCM tag: this much larger is the sealed form than the content. */
export const SEALED_BYTES_OVERHEAD = 1 + 8 + 65 + 12 + 16;

export async function keyId(publicKey: string): Promise<string> {
  const { raw } = await importPublic(publicKey);
  return toBase64Url(new Uint8Array(await subtle().digest("SHA-256", raw)).slice(0, 8));
}

/** New key pair: public as raw curve points, private as PKCS#8, both base64url. */
export async function generateVaultKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await subtle().generateKey(EC, true, ["deriveBits"]);
  return {
    publicKey: toBase64Url(new Uint8Array(await subtle().exportKey("raw", pair.publicKey))),
    privateKey: toBase64Url(new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey))),
  };
}

export async function sealTo(publicKey: string, site: string, value: unknown): Promise<string> {
  const recipient = await importPublic(publicKey);
  const ephemeral = await subtle().generateKey(EC, true, ["deriveBits"]);
  const epk = new Uint8Array(await subtle().exportKey("raw", ephemeral.publicKey));
  const key = await deriveKey(ephemeral.privateKey, recipient.key, epk, recipient.raw);
  const iv = webcrypto().getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad(site) }, key, utf8(JSON.stringify(value))),
  );
  return [VERSION, await keyId(publicKey), toBase64Url(epk), toBase64Url(iv), toBase64Url(data)].join(".");
}

/** Seals bytes (a file from the vault) to the server, bound to its name. */
export async function sealBytesTo(publicKey: string, name: string, bytes: Uint8Array): Promise<Bytes> {
  const recipient = await importPublic(publicKey);
  const ephemeral = await subtle().generateKey(EC, true, ["deriveBits"]);
  const epk = new Uint8Array(await subtle().exportKey("raw", ephemeral.publicKey));
  const key = await deriveKey(ephemeral.privateKey, recipient.key, epk, recipient.raw);
  const iv = webcrypto().getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: fileAad(name) }, key, new Uint8Array(bytes)));
  const kid = fromBase64Url(await keyId(publicKey));
  const out = new Uint8Array(1 + kid.length + epk.length + iv.length + data.length);
  out.set([FILE_VERSION], 0);
  out.set(kid, 1);
  out.set(epk, 1 + kid.length);
  out.set(iv, 1 + kid.length + epk.length);
  out.set(data, 1 + kid.length + epk.length + iv.length);
  return out;
}

/** Whether bytes look as if sealed with `sealBytesTo` for this key. Opens nothing. */
export function sealedBytesFor(sealed: Uint8Array, kid: string): boolean {
  const expected = fromBase64Url(kid);
  return sealed.length > SEALED_BYTES_OVERHEAD && sealed[0] === FILE_VERSION && expected.every((byte, i) => sealed[1 + i] === byte);
}

/** The server's private key, loaded once. Throws with a message that does not name the value. */
export interface VaultKey {
  readonly keyId: string;
  open(site: string, sealed: string): Promise<unknown>;
  openBytes(name: string, sealed: Uint8Array): Promise<Bytes>;
}

export async function loadVaultKey(privateKey: string): Promise<VaultKey> {
  let key: Key;
  let publicRaw: Bytes;
  try {
    key = await subtle().importKey("pkcs8", fromBase64Url(privateKey.trim()), EC, true, ["deriveBits"]);
    const jwk = await subtle().exportKey("jwk", key);
    publicRaw = new Uint8Array([4, ...fromBase64Url(jwk.x ?? ""), ...fromBase64Url(jwk.y ?? "")]);
  } catch {
    throw new SealboxError("SERAIN_VAULT_KEY is not a private P-256 key (pnpm web vault-key creates one).");
  }
  const publicKey = toBase64Url(publicRaw);
  const id = await keyId(publicKey);
  return {
    keyId: id,
    async open(site, sealed) {
      const [version, kid, epk, iv, data, ...rest] = sealed.split(".");
      if (version !== VERSION || !kid || !epk || !iv || !data || rest.length > 0) throw new SealboxError("Sealed vault entry has an unknown format.");
      if (kid !== id) throw new SealboxError("The vault entry is sealed for another key.");
      try {
        const peer = await subtle().importKey("raw", fromBase64Url(epk), EC, false, []);
        const aes = await deriveKey(key, peer, fromBase64Url(epk), publicRaw);
        const plain = await subtle().decrypt({ name: "AES-GCM", iv: fromBase64Url(iv), additionalData: aad(site) }, aes, fromBase64Url(data));
        return JSON.parse(dec.decode(plain));
      } catch {
        throw new SealboxError("Vault entry cannot be opened (wrong key, wrong name or altered).");
      }
    },
    async openBytes(name, sealed) {
      if (sealed.length <= SEALED_BYTES_OVERHEAD || sealed[0] !== FILE_VERSION) throw new SealboxError("Sealed file has an unknown format.");
      if (!sealedBytesFor(sealed, id)) throw new SealboxError("The file is sealed for another key.");
      const epk = new Uint8Array(sealed.slice(9, 74));
      const iv = new Uint8Array(sealed.slice(74, 86));
      try {
        const peer = await subtle().importKey("raw", epk, EC, false, []);
        const aes = await deriveKey(key, peer, epk, publicRaw);
        return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv, additionalData: fileAad(name) }, aes, new Uint8Array(sealed.slice(86))));
      } catch {
        throw new SealboxError("File cannot be opened (wrong key, wrong name or altered).");
      }
    },
  };
}
