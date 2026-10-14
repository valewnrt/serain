import type { GoogleSecret } from "../integrations/types.js";
import { redactValue } from "../log.js";

/**
 * The only place where a Google token exists (W16, D32). Adapters call
 * `request` with path and body; the access token is fetched, held and put
 * into the header here, at the network edge. It stands in no return value,
 * no error message and, because it is registered with the logger, in no log.
 *
 * Only Google hosts: an adapter with a typo in the URL must not be able to
 * carry the token anywhere.
 */

/**
 * `gmail.modify` instead of `gmail.readonly` (addendum D37 of 2026-10-13): read and set labels, so
 * trash and spam folder; it cannot delete permanently. An earlier connection only has
 * `gmail.readonly` and does not clean up until the owner reconnects (`src/integrations/setup.ts`).
 */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export const GOOGLE_SCOPES = [
  GMAIL_MODIFY_SCOPE,
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const ALLOWED_HOSTS = new Set(["gmail.googleapis.com", "www.googleapis.com"]);
const TIMEOUT_MS = 20_000;

export class GoogleError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

export interface GoogleClient {
  /** JSON in, JSON out. `null` without content. Throws `GoogleError` for everything from 400 on. */
  request<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T>;
}

type FetchLike = typeof fetch;

async function errorText(response: Response): Promise<string> {
  return messageOf(await response.text().catch(() => ""), response.statusText);
}

function messageOf(text: string, fallback: string): string {
  const body = text.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; error_description?: string };
    const message = typeof parsed.error === "string" ? (parsed.error_description ?? parsed.error) : parsed.error?.message;
    if (message) return message;
  } catch {
    // Not JSON: the raw beginning is enough.
  }
  return body || fallback;
}

/**
 * Gmail throttles per user and minute; measured on 2026-10-13: 6,000 units
 * (`totalQueryCostPerMinutePerUser`), around 300 fetches of a mail. Whoever hits
 * the limit gets 429 or 403 with `rateLimitExceeded`. Then it waits and
 * retries, as Google requires, until a new minute has started.
 * A 403 for another reason (missing permission, daily limit) is an error.
 */
const RATE_LIMIT_WAITS_MS = [2_000, 4_000, 8_000, 16_000, 32_000];

function rateLimited(status: number, text: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  try {
    const parsed = JSON.parse(text) as { error?: { errors?: Array<{ reason?: string }> } };
    return (parsed.error?.errors ?? []).some((entry) => entry.reason === "rateLimitExceeded" || entry.reason === "userRateLimitExceeded");
  } catch {
    return false;
  }
}

export function googleClient(
  secret: GoogleSecret,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): GoogleClient {
  let access: { token: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (access && access.expiresAt - 60_000 > now()) return access.token;
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: secret.clientId,
        client_secret: secret.clientSecret,
        refresh_token: secret.refreshToken,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      // `invalid_grant`: the owner revoked the access at Google, or the token has expired. That is the
      // login being rejected (400/401), which `failureKind` recognises by the word "login".
      const refused = response.status === 400 || response.status === 401;
      throw new GoogleError(`${refused ? "Google rejects the login, no token" : "Google issues no token"}: ${await errorText(response)}`, response.status);
    }
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new GoogleError("Google answered without a token.", 502);
    redactValue(data.access_token);
    access = { token: data.access_token, expiresAt: now() + (data.expires_in ?? 3_000) * 1_000 };
    return access.token;
  }

  return {
    async request<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
      const target = new URL(url);
      if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
        throw new GoogleError(`Not a Google host: ${target.hostname}`, 400);
      }
      const send = async () =>
        fetchImpl(target, {
          method: init.method ?? "GET",
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      let response = await send();
      if (response.status === 401) {
        // The token can become invalid before its time. Fetch a new one once, then it is an error.
        access = null;
        response = await send();
      }
      for (const pause of RATE_LIMIT_WAITS_MS) {
        if (response.ok || (response.status !== 429 && response.status !== 403)) break;
        const text = await response.text().catch(() => "");
        if (!rateLimited(response.status, text)) throw new GoogleError(messageOf(text, response.statusText), response.status);
        await wait(pause);
        response = await send();
      }
      if (!response.ok) throw new GoogleError(await errorText(response), response.status);
      // Some calls (`batchModify`) answer without content, not every one with 204.
      const text = response.status === 204 ? "" : await response.text();
      return (text ? JSON.parse(text) : null) as T;
    },
  };
}

/** Revocation on disconnect (W13): afterwards the refresh token is worthless at Google too. */
export async function revokeGoogle(secret: GoogleSecret, fetchImpl: FetchLike = fetch): Promise<void> {
  const response = await fetchImpl(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: secret.refreshToken }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new GoogleError(`Revocation failed: ${await errorText(response)}`, response.status);
}
