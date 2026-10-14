import { mcpConnection } from "../mcp.js";
import { authorizeUrl, discover, exchangeCode, pkce, refresh, register, revoke, type OAuthClient } from "../oauth.js";
import { buildTools, compareTools, type RemoteToolSpec } from "../tools.js";
import { owner } from "../../config/owner.js";
import { ConnectorError, type ConnectorDriver, type CredentialSlot, type Json } from "../types.js";

/**
 * A remote MCP server with OAuth 2.1 (D51): COROS and whatever comes next. Per
 * issuer and redirect address, Serain registers once as a public client and
 * remembers the client ID; every connection runs with PKCE. Only what is needed
 * to renew and revoke is stored.
 */

export interface ClientRegistry {
  get(issuer: string, redirectUri: string): Promise<OAuthClient | null>;
  put(issuer: string, redirectUri: string, client: OAuthClient): Promise<void>;
}

export interface McpOAuthConfig {
  id: string;
  /** The MCP endpoint, also the resource (RFC 8707). */
  url: string;
  /** Who may issue tokens. If the metadata points elsewhere, there is no connection. */
  issuer: string;
  scope: string;
  tools: readonly RemoteToolSpec[];
  promptLine: string;
}

interface Credentials {
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

/** A token the issuer hands out as a JWT often names the account's mail address. For display only. */
export function accountFromToken(token: string): string {
  const payload = token.split(".")[1];
  if (!payload) return "";
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const email = claims["email"];
    return typeof email === "string" && email.length <= 200 ? email : "";
  } catch {
    return "";
  }
}

const clientOf = (c: { clientId: string; clientSecret?: string }): OAuthClient => ({ clientId: c.clientId, ...(c.clientSecret ? { clientSecret: c.clientSecret } : {}) });

export function mcpOAuthDriver(config: McpOAuthConfig, deps: { clients: ClientRegistry; fetch?: typeof fetch }): ConnectorDriver {
  const fetcher = deps.fetch ?? fetch;
  // If the catalog falls apart, that should show at startup, not on the first call.
  compareTools(config.id, config.tools, []);

  return {
    id: config.id,
    promptLine: config.promptLine,

    async begin({ redirectUri, state }) {
      const server = await discover(fetcher, config.url, config.issuer);
      let client = await deps.clients.get(config.issuer, redirectUri);
      if (!client) {
        client = await register(fetcher, server, redirectUri, config.scope);
        await deps.clients.put(config.issuer, redirectUri, client);
      }
      const { verifier, challenge } = pkce();
      return {
        authorizeUrl: authorizeUrl({ server, client, redirectUri, state, challenge, scope: config.scope, resource: config.url }),
        pending: { verifier, ...clientOf(client), tokenEndpoint: server.tokenEndpoint, revocationEndpoint: server.revocationEndpoint },
      };
    },

    async complete({ pending, code, redirectUri }) {
      const p = pending as unknown as Credentials & { verifier: string };
      const tokens = await exchangeCode(fetcher, { server: p, client: clientOf(p), code, verifier: p.verifier, redirectUri, resource: config.url });
      const credentials: Credentials = {
        ...clientOf(p),
        tokenEndpoint: p.tokenEndpoint,
        revocationEndpoint: p.revocationEndpoint,
        ...tokens,
      };
      return { credentials: credentials as unknown as Json, account: accountFromToken(tokens.accessToken), expiresAt: null };
    },

    open(slot: CredentialSlot) {
      let renewing: Promise<string> | null = null;
      const token = async ({ renew }: { renew: boolean }): Promise<string> => {
        const current = slot.get() as unknown as Credentials;
        const stale = current.expiresAt !== null && current.expiresAt - 60_000 < Date.now();
        if (!renew && !stale) return current.accessToken;
        if (!current.refreshToken) throw new ConnectorError(`The connection to ${config.id} has expired. ${owner.name} has to reconnect it in the web interface.`);
        // Two simultaneous calls renew once: a rotating refresh token is only valid for one renewal.
        renewing ??= (async () => {
          try {
            const next = await refresh(fetcher, { server: current, client: clientOf(current), refreshToken: current.refreshToken!, resource: config.url });
            await slot.save({ ...current, ...next } as unknown as Json);
            return next.accessToken;
          } finally {
            renewing = null;
          }
        })();
        return renewing;
      };
      const connection = mcpConnection({ url: config.url, token, fetch: fetcher });
      return {
        tools: buildTools(config.id, config.tools, async (spec, args, options) => connection.call(spec.remote ?? spec.name, args, options)),
        snapshot: async () => compareTools(config.id, config.tools, (await connection.listTools()).map((tool) => tool.name)),
        close: () => connection.close(),
      };
    },

    async revoke(raw) {
      const credentials = raw as unknown as Credentials;
      if (!credentials.revocationEndpoint || !credentials.refreshToken) return null;
      return revoke(fetcher, { endpoint: credentials.revocationEndpoint, client: clientOf(credentials), token: credentials.refreshToken });
    },
  };
}
