import { setting } from "./dev-vars.js";

/**
 * The Cloudflare API for `pnpm web:*` (D49) and `pnpm site:*` (D65), with
 * `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from `.dev.vars`. Runs on
 * the owner's machine, never on the server.
 */

export interface Cloudflare {
  account: string;
  token: string;
  call<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export function cloudflare(): Cloudflare {
  const token = setting("CLOUDFLARE_API_TOKEN");
  const account = setting("CLOUDFLARE_ACCOUNT_ID");
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is missing in .dev.vars. API token for the Cloudflare account with the domain, permissions see web/README.md.");
  if (!account) throw new Error("CLOUDFLARE_ACCOUNT_ID is missing in .dev.vars. Account ID of the Cloudflare account with the domain.");
  return {
    account,
    token,
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await fetch(`https://api.cloudflare.com/client/v4${path.replace("{account}", account)}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = (await response.json()) as { success: boolean; result: T; errors?: Array<{ code: number; message: string }> };
      if (!data.success) {
        throw new Error(`Cloudflare ${method} ${path}: ${(data.errors ?? []).map((error) => `${error.code} ${error.message}`).join("; ") || response.status}`);
      }
      return data.result;
    },
  };
}

export interface Policy {
  id: string;
  name: string;
  decision: string;
  include: Array<Record<string, unknown>>;
  exclude?: unknown[];
  require?: unknown[];
}

export interface AccessApp {
  id: string;
  aud: string;
  name: string;
  domain: string;
  self_hosted_domains?: string[];
  destinations?: Array<{ type?: string; uri?: string }>;
  policies?: Policy[];
}

export const appDomains = (app: AccessApp) => [app.domain, ...(app.self_hosted_domains ?? []), ...(app.destinations ?? []).map((entry) => entry.uri ?? "")];

/** Does the application stand in front of exactly this host (the whole host, not only a path on it)? */
export const coversDomain = (app: AccessApp, domain: string) =>
  appDomains(app).some((entry) => entry === domain || entry === `${domain}/*` || entry === `${domain}/`);

export const accessApps = (cf: Cloudflare) => cf.call<AccessApp[]>("GET", "/accounts/{account}/access/apps");
