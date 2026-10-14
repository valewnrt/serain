/**
 * Cloudflare Access as the second door (D49): Access stands in front of the
 * domain, only the owner's mail address gets through. The worker does not rely
 * on that blindly but checks the token Access adds to every request
 * (`Cf-Access-Jwt-Assertion`): signature against the team's keys, audience (the
 * application's AUD), issuer, expiry. If Access goes away because someone
 * deletes the application or routes around it, the worker answers 403 instead
 * of standing open.
 *
 * Locally (http://localhost) there is no Access; there the worker checks nothing.
 * On https without an Access configuration it refuses everything (fail closed).
 */

export interface AccessConfig {
  /** `<team>.cloudflareaccess.com` */
  teamDomain: string;
  /** AUD tag of the Access application in front of the domain. */
  aud: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

const KEYS_TTL_MS = 10 * 60_000;
/** An unknown `kid` reloads the keys, but at most this often: otherwise anyone could force fetches with an invented token. */
const REFRESH_MIN_MS = 60_000;
/** Clocks are never exactly in sync. */
const LEEWAY_S = 60;

let cache: { team: string; at: number; keys: Jwk[] } | null = null;

function decode(part: string): Uint8Array<ArrayBuffer> {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function keys(team: string, fetcher: typeof fetch, refresh: boolean): Promise<Jwk[]> {
  const now = Date.now();
  const fresh = cache && cache.team === team && now - cache.at < (refresh ? REFRESH_MIN_MS : KEYS_TTL_MS);
  if (fresh && cache) return cache.keys;
  const response = await fetcher(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access keys not retrievable (${response.status}).`);
  const body = (await response.json()) as { keys?: Jwk[] };
  cache = { team, at: now, keys: body.keys ?? [] };
  return cache.keys;
}

/** Null when the token is valid; otherwise the reason, only for the log. */
export async function accessDenied(request: Request, config: AccessConfig, fetcher: typeof fetch = fetch, nowMs = Date.now()): Promise<string | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return "no Access token";
  const parts = token.split(".");
  if (parts.length !== 3) return "broken token";
  const [head = "", body = "", signature = ""] = parts;
  let header: { alg?: string; kid?: string };
  let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number };
  try {
    header = JSON.parse(new TextDecoder().decode(decode(head))) as typeof header;
    claims = JSON.parse(new TextDecoder().decode(decode(body))) as typeof claims;
  } catch {
    return "broken token";
  }
  if (header.alg !== "RS256" || !header.kid) return "wrong algorithm";
  let jwk = (await keys(config.teamDomain, fetcher, false)).find((key) => key.kid === header.kid);
  jwk ??= (await keys(config.teamDomain, fetcher, true)).find((key) => key.kid === header.kid);
  if (!jwk) return "unknown key";
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(signature), new TextEncoder().encode(`${head}.${body}`));
  if (!valid) return "bad signature";
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.aud)) return "wrong audience";
  if (claims.iss !== `https://${config.teamDomain}`) return "wrong issuer";
  const now = nowMs / 1000;
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < now) return "expired";
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_S > now) return "not valid yet";
  return null;
}

/**
 * The door in front of everything else: null means through. On https without
 * Access values 503 (fail closed), without a valid token 403. Locally (http)
 * without a check.
 */
export async function accessGate(
  request: Request,
  env: { WEB_ORIGIN: string; ACCESS_TEAM_DOMAIN?: string | undefined; ACCESS_AUD?: string | undefined },
  fetcher: typeof fetch = fetch,
): Promise<{ status: 403 | 503; reason: string } | null> {
  if (!env.WEB_ORIGIN.startsWith("https://")) return null;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { status: 503, reason: "Access is not set up" };
  const denied = await accessDenied(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }, fetcher).catch((error: unknown) => (error as Error).message);
  return denied ? { status: 403, reason: denied } : null;
}

/** Only for tests: otherwise the key cache lives as long as the worker instance. */
export function resetAccessKeys(): void {
  cache = null;
}
