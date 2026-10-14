import { Agent } from "undici";

/**
 * Connections to Supabase and OpenRouter stay open between two messages (D50).
 * Node closes an idle connection after four seconds; the first request after a
 * pause then pays for TCP and TLS again, measured at about 30 to 40 ms, on
 * every message from the owner. The other side may close earlier; then undici
 * reconnects as usual.
 *
 * Through the built-in `fetch` with a `dispatcher` of its own: that way it
 * stays the process's `fetch`, and tests that replace it replace this path too.
 */
const agent = new Agent({ keepAliveTimeout: 120_000, keepAliveMaxTimeout: 600_000 });

export const keepAliveFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, dispatcher: agent } as RequestInit);
