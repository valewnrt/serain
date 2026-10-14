import { OPENROUTER_PROVIDER_POLICY } from "../src/config/models.js";
import type { Candidate, RoleName } from "./types.js";

/**
 * Eval configuration in one place (D3): candidates, caps, thresholds.
 *
 * **The filler lists deliberately no longer stand here**, but in
 * `src/agent/style.ts`. Since the style step ran (2026-09-18), the same
 * phrases stand in the system prompt; two lists would be two truths, and the
 * eval would measure what the prompt no longer forbids.
 */
export { FORBIDDEN_OPENERS, FORBIDDEN_PHRASES, GREETING_MAX_CHARS } from "../src/agent/style.js";

// --- Candidates (D3 table) --------------------------------------------------

/**
 * The model IDs are as of 2026-09-18 and have to be held against the
 * OpenRouter model list before a full run: OpenRouter renames IDs, and a dead
 * name costs only an error message in the run, but also the comparison.
 * `pnpm eval --list` shows what is in here right now.
 *
 * Checked on 2026-09-18 against `GET /api/v1/models` and
 * `GET /api/v1/models?zdr=true`: every ID below exists and has a ZDR endpoint.
 * That also settled the open question from D3: "Claude Sonnet 5" is called
 * `anthropic/claude-sonnet-5` at OpenRouter and now stands here, instead of
 * being represented by the 4.5 ID as before.
 */
export const CANDIDATES: Candidate[] = [
  // Claude path (Agent SDK, with the owner's subscription token or API key).
  // Always included, because it comes first in production and the comparison
  // would otherwise only rank the fallbacks.
  { id: "chat:sub:sonnet", role: "chat", provider: "subscription", model: "sonnet", label: "Claude · Sonnet" },
  { id: "chat:sub:opus", role: "chat", provider: "subscription", model: "opus", label: "Claude · Opus" },
  // The same model with less thinking (D50): does what it saves in seconds cost quality?
  { id: "chat:sub:sonnet:direct", role: "chat", provider: "subscription", model: "sonnet", label: "Claude · Sonnet without thinking", thinking: "off" },
  { id: "chat:sub:sonnet:medium", role: "chat", provider: "subscription", model: "sonnet", label: "Claude · Sonnet, medium thinking", thinking: "medium" },
  { id: "chat:sub:sonnet:low", role: "chat", provider: "subscription", model: "sonnet", label: "Claude · Sonnet, low thinking", thinking: "low" },
  { id: "exec:sub:sonnet:direct", role: "executor", provider: "subscription", model: "sonnet", label: "Claude · Sonnet without thinking", thinking: "off" },
  { id: "exec:sub:sonnet:medium", role: "executor", provider: "subscription", model: "sonnet", label: "Claude · Sonnet, medium thinking", thinking: "medium" },
  { id: "exec:sub:sonnet:low", role: "executor", provider: "subscription", model: "sonnet", label: "Claude · Sonnet, low thinking", thinking: "low" },
  { id: "exec:sub:sonnet", role: "executor", provider: "subscription", model: "sonnet", label: "Claude · Sonnet" },
  { id: "extract:sub:haiku", role: "extraction", provider: "subscription", model: "haiku", label: "Claude · Haiku" },

  // Chat: style in the owner's language, brevity, naturalness.
  { id: "chat:or:kimi-k2", role: "chat", provider: "openrouter", model: "moonshotai/kimi-k2", label: "Kimi K2" },
  { id: "chat:or:gpt5-mini", role: "chat", provider: "openrouter", model: "openai/gpt-5-mini", label: "GPT-5 mini" },
  { id: "chat:or:gemini-flash", role: "chat", provider: "openrouter", model: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "chat:or:sonnet", role: "chat", provider: "openrouter", model: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
  // Saver model in the throttled fallback (addendum to D3 of 2026-10-08).
  { id: "chat:or:haiku", role: "chat", provider: "openrouter", model: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
  // Open models with a ZDR endpoint (audit 2026-10-02, V9): if the Claude path
  // fell away, a $6.50 cap with Sonnet would not last a month. Checked on
  // 2026-10-02 against `GET /api/v1/models?zdr=true`, all with tool calls.
  // DeepSeek was excluded in D3 because it had no ZDR endpoint; through
  // OpenRouter with `zdr: true` there is one now, and only that way may it run.
  { id: "chat:or:glm-5.3", role: "chat", provider: "openrouter", model: "z-ai/glm-5.3", label: "GLM 5.3" },
  { id: "chat:or:deepseek-v4-pro", role: "chat", provider: "openrouter", model: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "chat:or:kimi-k3", role: "chat", provider: "openrouter", model: "moonshotai/kimi-k3", label: "Kimi K3" },
  { id: "chat:or:minimax-m3", role: "chat", provider: "openrouter", model: "minimax/minimax-m3", label: "MiniMax M3" },

  // Executor: tool call reliability over several steps.
  { id: "exec:or:kimi-k2", role: "executor", provider: "openrouter", model: "moonshotai/kimi-k2", label: "Kimi K2" },
  { id: "exec:or:gpt5", role: "executor", provider: "openrouter", model: "openai/gpt-5", label: "GPT-5" },
  { id: "exec:or:sonnet", role: "executor", provider: "openrouter", model: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "exec:or:haiku", role: "executor", provider: "openrouter", model: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "exec:or:gemini-pro", role: "executor", provider: "openrouter", model: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "exec:or:glm-5.3", role: "executor", provider: "openrouter", model: "z-ai/glm-5.3", label: "GLM 5.3" },
  { id: "exec:or:deepseek-v4-pro", role: "executor", provider: "openrouter", model: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },

  // Extraction, heartbeat, classification: price, runs 50× a day.
  { id: "extract:or:flash-lite", role: "extraction", provider: "openrouter", model: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
  { id: "extract:or:gpt5-nano", role: "extraction", provider: "openrouter", model: "openai/gpt-5-nano", label: "GPT-5 nano" },
  { id: "extract:or:haiku", role: "extraction", provider: "openrouter", model: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "extract:or:glm-5.3-flash", role: "extraction", provider: "openrouter", model: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash" },
  { id: "extract:or:deepseek-v4.1-flash", role: "extraction", provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },

  // judge (D12): no model choice here, but the order of the backends.
  // `generative` is primary today because the Jev endpoint is alpha; whether
  // that stays is for the judge suite to answer.
  {
    id: "judge:generative-first",
    role: "judge",
    provider: "openrouter",
    model: "generative → jev",
    label: "judge · generative first",
    judgeBackends: ["generative", "jev"],
  },
  {
    id: "judge:jev-first",
    role: "judge",
    provider: "openrouter",
    model: "jev → generative",
    label: "judge · jev first",
    judgeBackends: ["jev", "generative"],
  },
];

/** Which role is measured by which suite (D3). */
export const SUITE_ROLE: Record<string, RoleName> = {
  chat: "chat",
  tools: "executor",
  dates: "chat",
  judge: "judge",
};

export function candidatesForRole(role: RoleName): Candidate[] {
  return CANDIDATES.filter((candidate) => candidate.role === role);
}

export function candidateById(id: string): Candidate | undefined {
  return CANDIDATES.find((candidate) => candidate.id === id);
}

// --- Caps -------------------------------------------------------------------

/**
 * Hard cap per run, on top of the monthly cap from `src/config/limits.ts`. The
 * monthly cap protects the budget, this one protects against a slipped command
 * ("all candidates, all suites").
 *
 * It is measured after every request, not before: the cost only stands in the
 * answer. In the worst case one request goes over the cap, then it stops.
 */
export const DEFAULT_RUN_CAP_USD = 2;

/** Subscription requests cost $0; without this limit a derailed run would go on forever. */
export const MAX_REQUESTS_PER_RUN = 400;

// --- Rule checks (W2) -------------------------------------------------------

/**
 * Length mirroring: the answer is about as long as the input. It may be a
 * multiple of the input, but is never measured below a floor: otherwise two
 * words would already be too much for "ok".
 */
export const LENGTH_MIRROR = {
  factor: 3,
  floorChars: 160,
  /** Real information questions may be considerably longer. */
  infoFactor: 8,
  infoFloorChars: 600,
};

/**
 * ZDR duty from D3. The model layer sets the policy for all OpenRouter
 * requests; the eval checks before the first paid call that it still stands
 * there. Without this assurance no eval runs over OpenRouter.
 */
export function assertZeroDataRetention(): void {
  const policy = OPENROUTER_PROVIDER_POLICY as Record<string, unknown>;
  const missing: string[] = [];
  // Both, not one of the two: `zdr: true` requires an endpoint that stores
  // nothing, `data_collection: "deny"` additionally excludes providers that may
  // use prompts for their own purposes.
  if (policy["zdr"] !== true) missing.push("zdr: true");
  if (policy["data_collection"] !== "deny") missing.push('data_collection: "deny"');
  if (missing.length > 0) {
    throw new Error(
      `OPENROUTER_PROVIDER_POLICY lacks ${missing.join(" and ")}. ` +
        "Without Zero Data Retention no paid eval call runs (D3).",
    );
  }
}

/** Where the local eval data that is never checked in lives. `data/` is gitignored. */
export const LOCAL_CHAT_FILE = "data/eval/chat.local.json";
export const RUNS_DIR = "data/eval/runs";
