/**
 * List prices of the Claude models in $ per million tokens, for the Claude path
 * with an API key (`env.claudeAuth === "api_key"`). With the subscription token
 * a call costs $0 and this table is not needed.
 *
 * It is only needed when the Agent SDK reports no cost: a turn that ends with
 * `end_turn` ends the CLI right away (D50), and then no result frame with
 * `total_cost_usd` arrives anymore. The tokens are still known (stream events,
 * `UsageMeter` in `src/agent/model.ts`); they are priced here. If the SDK
 * reports a cost, that one applies.
 *
 * As of 2026-10-06 (Anthropic price list). Surcharges for fast mode, very long
 * prompts and data residency are not modeled; Serain does not use them.
 * Cache writes apply to the 5-minute lifetime (1.25 × input).
 */
export interface ClaudePrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function price(input: number, output: number, cacheRead = input / 10): ClaudePrice {
  return { input, output, cacheRead, cacheWrite: input * 1.25 };
}

/** By prefix of the model ID, without the date suffix. The longest matching prefix wins. */
export const CLAUDE_PRICES: Readonly<Record<string, ClaudePrice>> = {
  "claude-fable-5-1": price(10, 50, 0.25),
  "claude-fable-5": price(10, 50),
  "claude-opus-5-5": price(4, 20, 0.2),
  "claude-opus-5": price(5, 25),
  "claude-opus-4": price(5, 25),
  "claude-sonnet-5-5": price(2, 10, 0.2),
  "claude-sonnet-5": price(2, 10),
  "claude-sonnet-4": price(3, 15),
  "claude-haiku-5-5": price(0.1, 0.5),
  "claude-haiku-4": price(1, 5),
};

/**
 * The price for a model ID (`claude-sonnet-5-5`) or an Agent SDK alias
 * (`sonnet`). Unknown means expensive: then the highest price of the family
 * applies, without a recognizable family the highest of all. A cap that kicks
 * in too early is annoying; one that counts too little is no cap.
 */
export function claudePrice(model: string): { price: ClaudePrice; known: boolean } {
  const id = model.trim().toLowerCase();
  const match = Object.keys(CLAUDE_PRICES)
    .filter((prefix) => id === prefix || id.startsWith(`${prefix}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (match) return { price: CLAUDE_PRICES[match]!, known: true };
  const family = ["fable", "opus", "sonnet", "haiku"].find((name) => id.includes(name));
  const candidates = Object.entries(CLAUDE_PRICES)
    .filter(([prefix]) => !family || prefix.includes(family))
    .map(([, value]) => value);
  const highest = candidates.reduce((max, value) => (value.output > max.output ? value : max));
  return { price: highest, known: false };
}

export interface ClaudeTokens {
  /** Input without cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Cost in $ for one response of a model. */
export function claudeCostUsd(model: string, tokens: ClaudeTokens): number {
  const { price: rate } = claudePrice(model);
  return (
    (tokens.input * rate.input +
      tokens.output * rate.output +
      tokens.cacheRead * rate.cacheRead +
      tokens.cacheCreation * rate.cacheWrite) /
    1_000_000
  );
}
