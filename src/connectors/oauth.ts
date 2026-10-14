import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth 2.1 for remote MCP servers (D51): find metadata (RFC 9728, RFC 8414),
 * register Serain as a public client (RFC 7591), PKCE with S256, exchange the
 * code, renew tokens, revoke. Runs only on the server; the web interface sees
 * neither code verifier nor token.
 *
 * **The issuer is fixed.** Every driver names who may issue tokens for it
 * (`issuer`). If the MCP server's metadata points elsewhere, the setup aborts:
 * a code or refresh token only goes to the one issuer we know, and no request
 * that carries one follows redirects.
 */

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface AuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
}

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** Milliseconds since 1970; null when the issuer says nothing. */
  expiresAt: number | null;
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 15_000;
const MAX_BODY = 200_000;

function httpsUrl(value: unknown, what: string): string {
  if (typeof value !== "string") throw new OAuthError(`${what} is missing in the metadata.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError(`${what} is not a URL.`);
  }
  if (url.protocol !== "https:") throw new OAuthError(`${what} is not https.`);
  return url.toString();
}

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length > MAX_BODY) throw new OAuthError(`${what}: response too large.`);
  try {
    const data = JSON.parse(text) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // below
  }
  throw new OAuthError(`${what}: no JSON response (HTTP ${response.status}).`);
}

async function getJson(fetcher: Fetch, url: string): Promise<Record<string, unknown> | null> {
  const response = await fetcher(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 404) return null;
  if (!response.ok) return null;
  return readJson(response, url);
}

/** RFC 8414 puts the path after `.well-known`, some issuers (Supabase) have it before. Both are asked. */
function metadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  const urls = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/oauth-authorization-server`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
  return [...new Set(urls)];
}

/**
 * From the MCP server to the issuer. `expectedIssuer` is in the driver; if the
 * chain deviates from it, there is no connection.
 */
export async function discover(fetcher: Fetch, resource: string, expectedIssuer: string): Promise<AuthServer> {
  const mcp = new URL(resource);
  const path = mcp.pathname.replace(/\/$/, "");
  const protectedResource =
    (await getJson(fetcher, `${mcp.origin}/.well-known/oauth-protected-resource${path}`)) ??
    (await getJson(fetcher, `${mcp.origin}/.well-known/oauth-protected-resource`));
  const servers = protectedResource?.["authorization_servers"];
  const named = Array.isArray(servers) ? servers.map(String) : [];
  const norm = (value: string) => value.replace(/\/$/, "");
  if (!named.some((server) => norm(server) === norm(expectedIssuer))) {
    throw new OAuthError(`The MCP server names a different issuer than expected (${named.join(", ") || "none"}).`);
  }

  for (const url of metadataUrls(expectedIssuer)) {
    const meta = await getJson(fetcher, url).catch(() => null);
    if (!meta) continue;
    if (norm(String(meta["issuer"] ?? "")) !== norm(expectedIssuer)) throw new OAuthError("The metadata belongs to a different issuer.");
    const methods = meta["code_challenge_methods_supported"];
    if (Array.isArray(methods) && !methods.includes("S256")) throw new OAuthError("The issuer does not support PKCE with S256.");
    const server: AuthServer = {
      issuer: expectedIssuer,
      authorizationEndpoint: httpsUrl(meta["authorization_endpoint"], "authorization_endpoint"),
      tokenEndpoint: httpsUrl(meta["token_endpoint"], "token_endpoint"),
      registrationEndpoint: meta["registration_endpoint"] ? httpsUrl(meta["registration_endpoint"], "registration_endpoint") : null,
      revocationEndpoint: meta["revocation_endpoint"] ? httpsUrl(meta["revocation_endpoint"], "revocation_endpoint") : null,
    };
    // Tokens and codes go only to the issuer's host.
    const host = new URL(expectedIssuer).host;
    for (const endpoint of [server.tokenEndpoint, server.revocationEndpoint, server.registrationEndpoint]) {
      if (endpoint && new URL(endpoint).host !== host) throw new OAuthError("An endpoint is not at the issuer.");
    }
    return server;
  }
  throw new OAuthError("No metadata found at the issuer.");
}

/** Dynamic registration as a public client, without a secret. */
export async function register(fetcher: Fetch, server: AuthServer, redirectUri: string, scope: string): Promise<OAuthClient> {
  if (!server.registrationEndpoint) throw new OAuthError("The issuer does not allow registration.");
  const response = await fetcher(server.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      client_name: "Serain",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope ? { scope } : {}),
    }),
  });
  const data = await readJson(response, "Registration");
  if (!response.ok || typeof data["client_id"] !== "string") throw new OAuthError(`Registration refused (HTTP ${response.status}).`);
  return { clientId: data["client_id"], ...(typeof data["client_secret"] === "string" ? { clientSecret: data["client_secret"] } : {}) };
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(input: {
  server: AuthServer;
  client: OAuthClient;
  redirectUri: string;
  state: string;
  challenge: string;
  scope: string;
  resource: string;
}): string {
  const url = new URL(input.server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resource);
  if (input.scope) url.searchParams.set("scope", input.scope);
  return url.toString();
}

async function tokenRequest(fetcher: Fetch, server: Pick<AuthServer, "tokenEndpoint">, client: OAuthClient, params: Record<string, string>): Promise<Tokens & { raw: Record<string, unknown> }> {
  const body = new URLSearchParams({ ...params, client_id: client.clientId });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const response = await fetcher(server.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await readJson(response, "Token");
  if (!response.ok || typeof data["access_token"] !== "string") {
    // Only the standard's error code, never the rest of the response: it could repeat a token.
    const code = typeof data["error"] === "string" && /^[a-z_]{1,40}$/.test(data["error"]) ? data["error"] : `HTTP ${response.status}`;
    throw new OAuthError(`Token refused (${code}).`);
  }
  const expiresIn = Number(data["expires_in"]);
  return {
    accessToken: data["access_token"],
    refreshToken: typeof data["refresh_token"] === "string" ? data["refresh_token"] : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    raw: data,
  };
}

export async function exchangeCode(
  fetcher: Fetch,
  input: { server: Pick<AuthServer, "tokenEndpoint">; client: OAuthClient; code: string; verifier: string; redirectUri: string; resource: string },
): Promise<Tokens> {
  const { raw: _raw, ...tokens } = await tokenRequest(fetcher, input.server, input.client, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    resource: input.resource,
  });
  return tokens;
}

/** A new access token. If the issuer sends a new refresh token, that one applies from now on (rotation). */
export async function refresh(
  fetcher: Fetch,
  input: { server: Pick<AuthServer, "tokenEndpoint">; client: OAuthClient; refreshToken: string; resource: string },
): Promise<Tokens> {
  const { raw: _raw, ...tokens } = await tokenRequest(fetcher, input.server, input.client, {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    resource: input.resource,
  });
  return { ...tokens, refreshToken: tokens.refreshToken ?? input.refreshToken };
}

/** RFC 7009. True when the issuer accepted the revocation. */
export async function revoke(fetcher: Fetch, input: { endpoint: string; client: OAuthClient; token: string }): Promise<boolean> {
  const body = new URLSearchParams({ token: input.token, token_type_hint: "refresh_token", client_id: input.client.clientId });
  if (input.client.clientSecret) body.set("client_secret", input.client.clientSecret);
  const response = await fetcher(input.endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return response.ok;
}
