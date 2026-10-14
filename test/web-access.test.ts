import { beforeEach, describe, expect, it } from "vitest";
import { accessDenied, accessGate, resetAccessKeys } from "../web/src/access.js";
import { databaseUrl } from "../web/src/db.js";

const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-0123456789abcdef";
const NOW = Date.parse("2026-10-08T12:00:00Z");

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString("base64url");

async function keyPair(kid: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid }) => {
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input)));
    return `${input}.${b64url(signature)}`;
  };
  return { jwk, sign };
}

/** The team's keys, as Access serves them under /cdn-cgi/access/certs. */
function certs(...keys: JsonWebKey[]) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const request = (token?: string) => new Request("https://serain.example.com/api/audit", token ? { headers: { "cf-access-jwt-assertion": token } } : {});
const valid = { aud: [AUD], iss: `https://${TEAM}`, exp: NOW / 1000 + 3600, nbf: NOW / 1000 - 10, email: "alex@example.org" };
const config = { teamDomain: TEAM, aud: AUD };

describe("Cloudflare Access as the second door (D49)", () => {
  beforeEach(() => resetAccessKeys());

  it("lets a valid token of its own application through and loads the keys from the team", async () => {
    const key = await keyPair("k1");
    const { calls, fetcher } = certs(key.jwk);
    expect(await accessDenied(request(await key.sign(valid)), config, fetcher, NOW)).toBeNull();
    expect(calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it("rejects: no token, other application, other team, expired, foreign key, wrong algorithm", async () => {
    const key = await keyPair("k1");
    const stranger = await keyPair("k1");
    const { fetcher } = certs(key.jwk);
    const denied = async (token?: string) => accessDenied(request(token), config, fetcher, NOW);
    expect(await denied()).toBe("no Access token");
    expect(await denied(await key.sign({ ...valid, aud: ["andere-app"] }))).toBe("wrong audience");
    expect(await denied(await key.sign({ ...valid, iss: "https://boese.cloudflareaccess.com" }))).toBe("wrong issuer");
    expect(await denied(await key.sign({ ...valid, exp: NOW / 1000 - 120 }))).toBe("expired");
    expect(await denied(await stranger.sign(valid))).toBe("bad signature");
    expect(await denied(await key.sign(valid, { alg: "none", kid: "k1" }))).toBe("wrong algorithm");
    expect(await denied("a.b")).toBe("broken token");
  });

  it("reloads on an unknown key, but not on every request", async () => {
    const key = await keyPair("k1");
    const unknown = await keyPair("k2");
    const { calls, fetcher } = certs(key.jwk);
    expect(await accessDenied(request(await key.sign(valid)), config, fetcher, NOW)).toBeNull();
    for (let i = 0; i < 3; i += 1) expect(await accessDenied(request(await unknown.sign(valid)), config, fetcher, NOW)).toBe("unknown key");
    expect(calls).toHaveLength(1);
  });
});

describe("worker on https: nothing without Access (D49)", () => {
  const https = { WEB_ORIGIN: "https://serain.example.com" };

  it("blocks with 503 as long as Access is not set up", async () => {
    expect(await accessGate(new Request("https://serain.example.com/"), https)).toEqual({ status: 503, reason: "Access is not set up" });
  });

  it("blocks with 403 without a valid token and lets a valid one through", async () => {
    resetAccessKeys();
    const key = await keyPair("k1");
    const { fetcher } = certs(key.jwk);
    const env = { ...https, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
    expect(await accessGate(request(), env, fetcher)).toEqual({ status: 403, reason: "no Access token" });
    const fresh = { ...valid, exp: Date.now() / 1000 + 3600, nbf: Date.now() / 1000 - 10 };
    expect(await accessGate(request(await key.sign(fresh)), env, fetcher)).toBeNull();
  });

  it("checks nothing locally (http)", async () => {
    expect(await accessGate(new Request("http://localhost:8787/"), { WEB_ORIGIN: "http://localhost:8787" })).toBeNull();
  });

  it("takes a database only through Hyperdrive or on loopback, never an address on the network", () => {
    expect(databaseUrl({ HYPERDRIVE: { connectionString: "postgresql://hd" }, DATABASE_URL: "postgresql://u:p@127.0.0.1:1/x" })).toBe("postgresql://hd");
    expect(databaseUrl({ DATABASE_URL: "postgresql://u:p@127.0.0.1:54320/postgres" })).toBe("postgresql://u:p@127.0.0.1:54320/postgres");
    expect(databaseUrl({ DATABASE_URL: "postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres" })).toBeNull();
    expect(databaseUrl({})).toBeNull();
  });
});
