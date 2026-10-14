/**
 * Responses, headers, cookies. Every response of the web interface goes
 * through `harden`, static files too (`run_worker_first`).
 */

export interface Env {
  ASSETS: Fetcher;
  /**
   * Postgres as role `serain_web` (0016_web.sql), never the secret key. On
   * Cloudflare through Hyperdrive, which talks to Supabase with TLS verified
   * against the Supabase CA; locally through the tunnel from web/dev.ts
   * (`DATABASE_URL`, loopback only). There is no connection to the network
   * without one of the two.
   */
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  /** Cloudflare Access (web/src/access.ts). Required on https, empty locally. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** The server's public vault key (src/vault/sealbox.ts). */
  VAULT_PUBLIC_KEY: string;
  /** The owner's IANA time zone for dates in the audit (`pnpm web vault-key` fills it in). */
  OWNER_TIMEZONE: string;
  /** Exactly this origin, e.g. https://serain.example.com. Passkeys and cookies depend on it. */
  WEB_ORIGIN: string;
  RP_ID: string;
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  // The client builds its DOM only with createElement and textContent. Where the browser supports it, every other way is blocked.
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join("; ");

export function harden(response: Response, env: Pick<Env, "WEB_ORIGIN">): Response {
  const out = new Response(response.body, response);
  const h = out.headers;
  h.set("content-security-policy", CSP);
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "no-referrer");
  h.set("cross-origin-opener-policy", "same-origin");
  h.set("cross-origin-resource-policy", "same-origin");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)");
  h.set("x-robots-tag", "noindex, nofollow");
  if (env.WEB_ORIGIN.startsWith("https://")) h.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  return out;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** On `https://` with `__Host-`, which binds the cookie to exactly this origin. Locally (http://localhost) that does not work. */
export function cookieName(env: Pick<Env, "WEB_ORIGIN">): string {
  return env.WEB_ORIGIN.startsWith("https://") ? "__Host-serain" : "serain_session";
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

export function sessionCookie(env: Pick<Env, "WEB_ORIGIN">, value: string, maxAgeSeconds: number): string {
  const secure = env.WEB_ORIGIN.startsWith("https://") ? "; Secure" : "";
  return `${cookieName(env)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

/**
 * Writing requests only from the own origin and only as JSON. Together with
 * `SameSite=Strict` this is the CSRF protection; a foreign form can neither set
 * the header nor send JSON without the browser asking first.
 */
export function requireSameOrigin(request: Request, env: Pick<Env, "WEB_ORIGIN">): void {
  if (request.headers.get("origin") !== env.WEB_ORIGIN) throw new HttpError(403, "Wrong origin.");
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) throw new HttpError(415, "JSON only.");
}

export async function readJson(request: Request, maxBytes = 32_000): Promise<unknown> {
  // Do not even read what is too large; the length afterwards counts anyway, the header can be missing.
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) throw new HttpError(413, "Too large.");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Not valid JSON.");
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
