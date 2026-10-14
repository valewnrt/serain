import { db } from "./client.js";
import { log } from "../log.js";

/**
 * Bookkeeping for the budget guard (D3). Every model call and every search
 * lands here in `usage_log`. The caps themselves are in
 * `src/config/limits.ts`, the decisions based on them in `src/budget.ts`.
 */

export interface ModelUsage {
  provider: string;
  model: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /**
   * Extra data for `usage_log.detail`, e.g. `{ eval: "chat", run: "…" }`.
   * `kind` stays "model" so eval requests count against the same monthly cap
   * as everything else; the label only says where they came from.
   */
  detail?: Record<string, unknown>;
}

export async function recordModelUsage(usage: ModelUsage): Promise<void> {
  const { error } = await db.from("usage_log").insert({
    kind: "model",
    provider: usage.provider,
    model: usage.model,
    role: usage.role,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_usd: usage.costUsd,
    detail: usage.detail ?? {},
  });
  if (error) log.error("usage_log (model) failed:", error.message);
}

function monthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export interface MonthUsage {
  apiCostUsd: number;
}

/**
 * Sum in the database (`usage_since`, 0025): PostgREST returns at most 1,000
 * rows, and a month has more. Until 2026-10-08 the client summed up and from
 * about the fourth day on saw only part of the costs.
 */
async function usageSince(kind: "model" | "search"): Promise<{ costUsd: number; units: number }> {
  const { data, error } = await db.rpc("usage_since", { p_kind: kind, p_since: monthStart() });
  if (error) throw new Error(`usage_log not readable: ${error.message}`);
  const row = ((data ?? []) as Array<{ cost_usd: number | string; units: number | string }>)[0];
  return { costUsd: Number(row?.cost_usd ?? 0), units: Number(row?.units ?? 0) };
}

export async function monthUsage(): Promise<MonthUsage> {
  return { apiCostUsd: (await usageSince("model")).costUsd };
}

/**
 * What the voice via OpenRouter cost today and this month (addendum D59). It is
 * booked as a model call with role `speech`, so it also counts against the
 * overall API cap.
 */
export async function speechUsage(now = new Date()): Promise<{ today: number; monthUsd: number }> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  const { data, error } = await db
    .from("usage_log")
    .select("at, cost_usd")
    .eq("kind", "model")
    .eq("role", "speech")
    .gte("at", monthStart());
  if (error) throw new Error(`usage_log not readable: ${error.message}`);
  const rows = data ?? [];
  return {
    today: rows.filter((row) => Date.parse(String(row.at)) >= dayStart).length,
    monthUsd: rows.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0),
  };
}

/** A web search (D16). Counts against the search provider's monthly quota. */
export async function recordSearch(provider: string): Promise<void> {
  const { error } = await db.from("usage_log").insert({ kind: "search", provider, units: 1 });
  if (error) log.error("usage_log (search) failed:", error.message);
}

export async function monthSearches(): Promise<number> {
  return (await usageSince("search")).units;
}
