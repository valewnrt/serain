import {
  BUDGET_CONTEXT_RATIO,
  BUDGET_REFRESH_MS,
  BUDGET_THROTTLE_RATIO,
  FIXED_MONTHLY_COST_USD,
  MONTHLY_API_BUDGET_USD,
  MONTHLY_BUDGET_USD,
} from "./config/limits.js";
import { env, type ClaudeAuth } from "./config/env.js";
import { db } from "./db/client.js";
import { monthUsage, type MonthUsage } from "./db/usage.js";
import { log } from "./log.js";
import { t, textLanguage } from "./i18n/catalog.js";
import { currentLanguage, currentLocale } from "./i18n/language.js";
import { core } from "./i18n/messages/core.js";

/**
 * Budget guard (D3, D10). `usage_log` books every paid model call, Claude with
 * an API key too (`src/agent/model.ts`); here that becomes a decision.
 *
 * **API (`MONTHLY_API_BUDGET_USD`), in three stages** (addendum D3 of
 * 2026-10-08: throttle rather than block):
 * - from 50 % the state is a line in the `<context>` (`BudgetMonitor`), so
 *   Serain can say honestly where it stands; below that only when the owner asks.
 * - from 80 % Serain is **throttled**: the paid fallback takes the role's
 *   saving model, heartbeat and morning look are off, the owner is told once.
 *   The chat keeps running unchanged.
 * - at 100 % there is no paid call any more; tasks (executor, search) are off,
 *   the owner is told once. With the subscription token the chat keeps running
 *   (0 $), with an API key or only OpenRouter it stops too (`chatStops`).
 *
 * There is no message quota since Photon (D38): the free plan has none, and
 * Photon's daily limit of 5,000 messages is far above what the outbound rate
 * limit lets through at all (D8.8).
 */
const NOTICE_KEY = "budget_notice";

export interface BudgetStatus {
  apiCostUsd: number;
  apiRatio: number;
  /** Everything together against the total cap: API plus fixed costs. */
  totalCostUsd: number;
  totalRatio: number;
  /** From {@link BUDGET_THROTTLE_RATIO}: saving model, no heartbeat. */
  throttled: boolean;
  apiExhausted: boolean;
  /**
   * Asked by every tool that can cost money (executor, search, fallback model).
   * Messages to the owner stay allowed, or Serain could not even say any more
   * that its budget is used up.
   */
  tasksAllowed: boolean;
  /**
   * Does the chat itself cost API money (Claude with a key or only OpenRouter)?
   * Then it stops at the cap too; only with the subscription token does it keep running.
   */
  chatStops: boolean;
}

export function evaluateBudget(usage: MonthUsage, claude: ClaudeAuth | null = env.claudeAuth): BudgetStatus {
  const apiRatio = usage.apiCostUsd / MONTHLY_API_BUDGET_USD;
  const apiExhausted = usage.apiCostUsd >= MONTHLY_API_BUDGET_USD;
  const totalCostUsd = usage.apiCostUsd + FIXED_MONTHLY_COST_USD;
  return {
    apiCostUsd: usage.apiCostUsd,
    apiRatio,
    totalCostUsd,
    totalRatio: totalCostUsd / MONTHLY_BUDGET_USD,
    throttled: apiRatio >= BUDGET_THROTTLE_RATIO,
    apiExhausted,
    tasksAllowed: !apiExhausted,
    chatStops: claude !== "oauth",
  };
}

/** Current state from `usage_log`. Throws if the table is not readable. */
export async function budgetStatus(): Promise<BudgetStatus> {
  return evaluateBudget(await monthUsage());
}

/**
 * What can still be spent at OpenRouter: the smaller of what is left of the key
 * limit and the account's credit. Null when there is no key or OpenRouter does
 * not answer; then the figure is missing instead of being guessed.
 */
export async function openRouterRemaining(): Promise<number | null> {
  if (!env.openrouterApiKey) return null;
  const get = async (path: string) => {
    const response = await fetch(`https://openrouter.ai/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${env.openrouterApiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`OpenRouter ${path}: HTTP ${response.status}`);
    return ((await response.json()) as { data?: Record<string, unknown> }).data ?? {};
  };
  try {
    const [key, credits] = await Promise.all([get("key"), get("credits")]);
    const left: number[] = [];
    if (typeof key["limit_remaining"] === "number") left.push(key["limit_remaining"]);
    if (typeof credits["total_credits"] === "number" && typeof credits["total_usage"] === "number") {
      left.push(credits["total_credits"] - credits["total_usage"]);
    }
    return left.length > 0 ? Math.max(0, Math.min(...left)) : null;
  } catch (error) {
    log.warn("OpenRouter credit not readable:", (error as Error).message);
    return null;
  }
}

/**
 * Does the owner ask about costs or budget? Then the state is in the context,
 * below 50 % too. Word lists for English and German (a comfort heuristic, not
 * a safety one): in any other language the line only appears from 50 % on, and
 * the model can still answer from the overview.
 */
export const BUDGET_QUESTION =
  /\b(?:budget\w*|credits?|openrouter|api[- ]?costs?|how\s+much\s+(?:do|did)\s+(?:you|serain)\s+cost|(?:your|serain'?s)\s+costs?|(?:have\s+you|you've)\s+spent|kostest|ausgegeben|guthaben|deckel|api-?kosten|(?:deine|serains?)\s+kosten|was\s+kostet\s+(?:du|serain))\b/i;

/** Month names and amounts for the model: English, so the line reads the same in every language. */
const MODEL_MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });
const modelUsd = (value: number) => `$${value.toFixed(2)}`;
const modelPercent = (ratio: number) => `${Math.round(ratio * 100)} %`;

/** Amounts and shares for the owner, in their locale ("1,23 $", "$1.23"). */
function ownerUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value).replace(/\u00a0/g, " ");
}
function ownerPercent(ratio: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(ratio).replace(/\u00a0/g, " ");
}

/**
 * The line for the `<context>`: month, share of the total cap, paid API and
 * what is still possible at OpenRouter. Pure, so threshold and wording are
 * testable. Null means: nothing to say.
 */
export function budgetLine(status: BudgetStatus, openRouterLeftUsd: number | null, now: Date, asked: boolean): string | null {
  const relevant = Math.max(status.apiRatio, status.totalRatio) >= BUDGET_CONTEXT_RATIO;
  if (!asked && !relevant) return null;
  const parts = [
    `Budget ${MODEL_MONTH.format(now)}: ${modelUsd(status.totalCostUsd)} of ${modelUsd(MONTHLY_BUDGET_USD)} total cap (${modelPercent(status.totalRatio)}),`,
    `of which paid API ${modelUsd(status.apiCostUsd)} of ${modelUsd(MONTHLY_API_BUDGET_USD)} (${modelPercent(status.apiRatio)});`,
    // Without this sentence Serain once worked out "$19.03 still there" live against the total cap.
    `so ${modelUsd(Math.max(0, MONTHLY_API_BUDGET_USD - status.apiCostUsd))} is left for paid things, the API cap allows no more`,
  ];
  let line = parts.join(" ");
  line += openRouterLeftUsd === null ? "." : `, ${modelUsd(openRouterLeftUsd)} still free at OpenRouter.`;
  if (status.apiExhausted) {
    line += status.chatStops
      ? " The API cap is reached: no paid calls, no tasks and no chat until the first of the month."
      : " The API cap is reached: no paid calls and no tasks until the first of the month, the chat runs on the subscription.";
  } else if (status.throttled) {
    line += " Throttled until the first of the month: paid fallback only with the saving model, no heartbeat, no morning look.";
  }
  return line;
}

interface BudgetSnapshot {
  status: BudgetStatus;
  openRouterLeftUsd: number | null;
  at: number;
  /** When OpenRouter was last asked: less often than `usage_log`, it is a call to the outside. */
  openRouterAt: number;
}

/** How often the monitor asks OpenRouter for the credit. */
const OPENROUTER_REFRESH_MS = 30 * 60_000;

export interface BudgetMonitorDeps {
  status(): Promise<BudgetStatus>;
  openRouterLeft(): Promise<number | null>;
  now?: () => Date;
}

/**
 * The budget state in memory (D50: the turn does not wait for a query). Read
 * at start, after every turn and at the latest every five minutes when someone
 * needs it. Heartbeat and overview ask `throttled()`, the context
 * `contextLine()`.
 */
export class BudgetMonitor {
  private snapshot: BudgetSnapshot | null = null;
  private pending: Promise<void> | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: BudgetMonitorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Read again. If that fails, the old state stays; without a state nothing counts as throttled. */
  refresh(): Promise<void> {
    this.pending ??= (async () => {
      try {
        const at = this.now().getTime();
        const previous = this.snapshot;
        const stale = !previous || at - previous.openRouterAt >= OPENROUTER_REFRESH_MS;
        const [status, openRouterLeftUsd] = await Promise.all([
          this.deps.status(),
          stale ? this.deps.openRouterLeft() : Promise.resolve(previous.openRouterLeftUsd),
        ]);
        this.snapshot = { status, openRouterLeftUsd, at, openRouterAt: stale ? at : previous.openRouterAt };
      } catch (error) {
        log.error("Budget state not readable:", (error as Error).message);
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  private async current(): Promise<BudgetSnapshot | null> {
    if (!this.snapshot || this.now().getTime() - this.snapshot.at >= BUDGET_REFRESH_MS) await this.refresh();
    return this.snapshot;
  }

  /** Throttled? For heartbeat and overview. Reads again at most every five minutes. */
  async throttled(): Promise<boolean> {
    return (await this.current())?.status.throttled ?? false;
  }

  /**
   * The line for the `<context>`, or null. Without a question only from memory;
   * when the owner asks, an old state is read again first, because that is
   * exactly what they want to know then.
   */
  async contextLine(asked: boolean): Promise<string | null> {
    const snapshot = asked ? await this.current() : this.snapshot;
    if (!snapshot) return null;
    return budgetLine(snapshot.status, snapshot.openRouterLeftUsd, this.now(), asked);
  }
}

/** What the owner has already heard, per month: throttled and used up. */
export interface BudgetNotice {
  month: string;
  throttle: boolean;
  exhausted: boolean;
}

export interface BudgetWarning {
  kind: "throttle" | "exhausted";
  text: string;
}

/** Month key in UTC, matching the month window in `usage_log`. */
export function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Which message is due? Pure, so the thresholds are testable without a
 * database. Exactly once per month and stage; if the state jumps over both,
 * only the higher one.
 *
 * The sentences are the code's, not the model's (`core.budget*`), in the
 * owner's language. Wording from the style round (addendum D23 of 2026-10-08).
 */
export function dueWarnings(status: BudgetStatus, notice: BudgetNotice | null, month: string, lang: string = currentLanguage()): BudgetWarning[] {
  const seen = notice && notice.month === month ? notice : { month, throttle: false, exhausted: false };
  if (status.apiExhausted) {
    if (seen.exhausted) return [];
    const message = status.chatStops ? core.budgetExhaustedAll : core.budgetExhaustedChat;
    const used = textLanguage(message, lang);
    return [{ kind: "exhausted", text: t(message, { spent: ownerUsd(status.apiCostUsd, currentLocale(used)) }, used) }];
  }
  if (status.throttled && !seen.throttle) {
    const used = textLanguage(core.budgetThrottle, lang);
    const locale = currentLocale(used);
    return [
      {
        kind: "throttle",
        text: t(
          core.budgetThrottle,
          { percent: ownerPercent(status.apiRatio, locale), spent: ownerUsd(status.apiCostUsd, locale), cap: ownerUsd(MONTHLY_API_BUDGET_USD, locale) },
          used,
        ),
      },
    ];
  }
  return [];
}

async function readNotice(): Promise<BudgetNotice | null> {
  const { data, error } = await db
    .from("agent_state")
    .select("value")
    .eq("key", NOTICE_KEY)
    .maybeSingle();
  if (error) throw new Error(`Budget notice not readable: ${error.message}`);
  const value = data?.value as Partial<BudgetNotice> | undefined;
  if (!value || typeof value.month !== "string") return null;
  // Before 2026-10-08 this held `api` for the old warning at 70 %; that counts for neither stage.
  return { month: value.month, throttle: value.throttle === true, exhausted: value.exhausted === true };
}

/**
 * Fetch due notices and mark them as done right away. The mark comes before
 * sending: better to lose a notice than to send the owner the same notice with
 * every message.
 */
export async function claimBudgetWarnings(now = new Date()): Promise<BudgetWarning[]> {
  const month = monthKey(now);
  let warnings: BudgetWarning[];
  let notice: BudgetNotice;
  try {
    const status = await budgetStatus();
    const stored = await readNotice();
    notice = stored && stored.month === month ? stored : { month, throttle: false, exhausted: false };
    warnings = dueWarnings(status, notice, month);
  } catch (error) {
    log.error("Budget state not checkable:", (error as Error).message);
    return [];
  }
  if (warnings.length === 0) return [];

  const exhausted = warnings.some((warning) => warning.kind === "exhausted");
  const { error } = await db.from("agent_state").upsert(
    {
      key: NOTICE_KEY,
      // Whoever heard "used up" no longer needs "throttled".
      value: { ...notice, throttle: true, exhausted: notice.exhausted || exhausted },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  );
  if (error) {
    log.error("Budget notice not saved, rather not warning at all:", error.message);
    return [];
  }
  return warnings;
}
