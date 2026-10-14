import { AsyncLocalStorage } from "node:async_hooks";

/**
 * So that the memory eval never reaches the production database.
 *
 * The write path calls `audit()` (`src/db/audit.ts`) and books model calls
 * via `recordModelUsage()` (`src/db/usage.ts`); `embed()` and the model layer
 * read the monthly total from `usage_log` beforehand. All of that goes through the one
 * Supabase client from `src/db/client.ts`. `setAuditActor("eval")` does not help
 * here: the eval would still write into the production audit log, just under a different
 * name. The existing eval (`eval/run.ts`) does exactly that and books its
 * requests into `usage_log` on purpose, so that they count against the monthly cap.
 * This eval goes further: it writes **nothing** to Supabase and reads
 * nothing from there either.
 *
 * This is how it works without touching `src/`:
 *
 * 1. **Before any module from `src/` loads**, `SUPABASE_URL` points to an
 *    address under `.invalid` (RFC 2606: never resolves) and the key is
 *    a dummy. `src/config/env.ts` only takes from `.dev.vars` what is not
 *    set yet, so this value wins. That is why this module must be the
 *    first import of `eval/memory/cli.ts`.
 * 2. `fetch` answers exactly this address itself: audit and usage rows
 *    land in the run's memory, the monthly total is empty, everything else is
 *    answered with an error and recorded as an "unexpected access".
 *    Other hosts (OpenRouter) go out unchanged.
 *
 * If the interception ever falls away, a request lands at an address that does not
 * exist, and not at real data. The run additionally checks at start that
 * `env.supabaseUrl` really is this address (`eval/memory/run.ts`).
 *
 * Intended side effect: the intercepted `usage_log` rows are the
 * run's cost bookkeeping, with the cost OpenRouter itself reports. In return the
 * monthly cap from `src/config/limits.ts` does not see these runs; `--cap`
 * takes its place.
 */

export const SINK_URL = "http://memory-eval.invalid";

process.env["SUPABASE_URL"] = SINK_URL;
process.env["SUPABASE_SECRET_KEY"] = "sb_secret_memory_eval_sink";

export interface UsageEntry {
  provider: string;
  model: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AuditEntry {
  event: string;
  messageId: string | null;
  detail: Record<string, unknown>;
}

/** The database traffic a case (or the whole run) would have caused. */
export interface Ledger {
  usage: UsageEntry[];
  audits: AuditEntry[];
  unexpected: string[];
}

export function newLedger(): Ledger {
  return { usage: [], audits: [], unexpected: [] };
}

/** Everything from the whole run, across all parallel cases. Basis for `--cap`. */
export const runLedger: Ledger = newLedger();

const scope = new AsyncLocalStorage<Ledger>();

/**
 * Runs `work` with its own ledger. AsyncLocalStorage carries the reference through
 * all `await`s, even when three cases run at once: every audit row
 * lands with the case that triggered it.
 */
export function withLedger<T>(ledger: Ledger, work: () => Promise<T>): Promise<T> {
  return scope.run(ledger, work);
}

function record(apply: (ledger: Ledger) => void): void {
  apply(runLedger);
  const local = scope.getStore();
  if (local) apply(local);
}

function rows(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  return body && typeof body === "object" ? [body as Record<string, unknown>] : [];
}

function parseBody(raw: unknown): unknown {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function answer(url: URL, method: string, body: unknown): Response {
  const path = url.pathname;
  if (method === "POST" && path === "/rest/v1/audit_log") {
    for (const row of rows(body)) {
      record((ledger) =>
        ledger.audits.push({
          event: String(row["event"] ?? ""),
          messageId: typeof row["message_id"] === "string" ? row["message_id"] : null,
          detail: (row["detail"] as Record<string, unknown> | undefined) ?? {},
        }),
      );
    }
    return json(201, null);
  }
  if (method === "POST" && path === "/rest/v1/usage_log") {
    for (const row of rows(body)) {
      if (row["kind"] !== "model") continue;
      record((ledger) =>
        ledger.usage.push({
          provider: String(row["provider"] ?? ""),
          model: String(row["model"] ?? ""),
          role: String(row["role"] ?? ""),
          inputTokens: Number(row["input_tokens"] ?? 0),
          outputTokens: Number(row["output_tokens"] ?? 0),
          costUsd: Number(row["cost_usd"] ?? 0),
        }),
      );
    }
    return json(201, null);
  }
  if (method === "POST" && path === "/rest/v1/rpc/usage_since") {
    // Monthly total for the budget guard (`usage_since`, 0025): zero in the eval. The run has `--cap`.
    // Until 2026-10-10 the row query from before 0025 stood here; since then every case failed on it.
    return json(200, [{ cost_usd: 0, units: 0 }]);
  }
  const what = `${method} ${path}`;
  record((ledger) => ledger.unexpected.push(what));
  return json(500, { message: `Memory eval: no database access (${what})`, code: "EVAL_SINK" });
}

const realFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!href.startsWith(SINK_URL)) return realFetch(input, init);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const raw = init?.body ?? (input instanceof Request ? await input.text() : null);
  return answer(new URL(href), method, parseBody(raw));
};
