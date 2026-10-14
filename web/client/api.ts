import { startAuthentication } from "@simplewebauthn/browser";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reauth = false,
  ) {
    super(message);
  }
}

/** The session expired or is missing: main.ts then shows the sign-in and comes back to the same place afterwards. */
export const isSignedOut = (error: unknown) => error instanceof ApiError && error.status === 401 && !error.reauth;

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const write = init.method !== undefined && init.method !== "GET";
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: write ? { "content-type": "application/json" } : {},
      ...(write ? { body: JSON.stringify(init.body ?? {}) } : {}),
    });
  } catch {
    throw new ApiError(0, "No connection. Are you online?");
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(response.status, String(data["error"] ?? "Error"), data["reauth"] === true);
  return data as T;
}

export async function passkeyLogin(): Promise<void> {
  const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/api/login/options", { method: "POST" });
  const response = await startAuthentication({ optionsJSON: options });
  await api("/api/login/verify", { method: "POST", body: { challengeId, response } });
}

/** Writes something that needs a fresh confirmation; asks for the passkey once if needed. */
export async function withReauth<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ApiError) || !error.reauth) throw error;
    await passkeyLogin();
    return run();
  }
}

export function message(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  const name = (error as { name?: string }).name;
  if (name === "NotAllowedError" || name === "AbortError") return "Cancelled.";
  return (error as Error).message || "Error";
}

/*
 * Reading with memory: whatever was loaded once shows at once on the next
 * visit and is refreshed in the background. Identical requests running at the
 * same time share one.
 */

const cache = new Map<string, { data: unknown; at: number }>();
const inflight = new Map<string, Promise<unknown>>();

export function cached<T>(path: string): T | undefined {
  return cache.get(path)?.data as T | undefined;
}

/** Loaded just now (say by prefetching on hovering the link): then do not ask again right away. */
export function isFresh(path: string, ms = 10_000): boolean {
  const entry = cache.get(path);
  return entry !== undefined && Date.now() - entry.at < ms;
}

export function load<T>(path: string): Promise<T> {
  const running = inflight.get(path);
  if (running) return running as Promise<T>;
  const request = api<T>(path)
    .then((data) => {
      cache.set(path, { data, at: Date.now() });
      return data;
    })
    .finally(() => inflight.delete(path));
  inflight.set(path, request);
  return request;
}

/** Load ahead when the pointer is on a link. Errors do not count here; the real visit reports them. */
export function prefetch(path: string): void {
  if (!cache.has(path)) load(path).catch(() => undefined);
}

export function forget(path?: string): void {
  if (path) cache.delete(path);
  else cache.clear();
}
