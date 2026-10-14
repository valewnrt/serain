import { afterEach, describe, expect, it, vi } from "vitest";
import { pickClaudeAuth } from "../src/config/env.js";
import { claudeCostUsd, claudePrice, CLAUDE_PRICES } from "../src/config/prices.js";

/**
 * Which Claude access applies (the API key is the default, the subscription
 * token the option), that neither ever shows up in a log, and how tokens become
 * costs when the SDK does not report any.
 */

describe("Claude access", () => {
  it("takes the API key, otherwise the subscription token, otherwise none", () => {
    expect(pickClaudeAuth("sk-ant-api03-x", "")).toBe("api_key");
    expect(pickClaudeAuth("", "sk-ant-oat01-x")).toBe("oauth");
    expect(pickClaudeAuth("", "")).toBeNull();
  });

  it("takes the key when both are set: the billed, capped path wins", () => {
    expect(pickClaudeAuth("sk-ant-api03-x", "sk-ant-oat01-x")).toBe("api_key");
  });
});

describe("Redaction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("registers key and token as soon as the env loads, not only in the main program", async () => {
    const apiKey = "sk-ant-api03-dummy-0123456789";
    const token = "sk-ant-oat01-dummy-0123456789";
    vi.stubEnv("ANTHROPIC_API_KEY", apiKey);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", token);
    vi.resetModules();
    const { env } = await import("../src/config/env.js");
    const { log } = await import("../src/log.js");
    expect(env.claudeAuth).toBe("api_key");

    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    log.error(`Agent SDK: 401 for ${apiKey}`, { token });
    const output = lines.join("");
    expect(output).not.toContain(apiKey);
    expect(output).not.toContain(token);
    expect(output).toContain("[redacted]");
  });
});

describe("List prices", () => {
  it("takes the longest matching prefix, also with a date suffix", () => {
    expect(claudePrice("claude-sonnet-5-5")).toEqual({ price: CLAUDE_PRICES["claude-sonnet-5-5"], known: true });
    expect(claudePrice("claude-sonnet-5")).toEqual({ price: CLAUDE_PRICES["claude-sonnet-5"], known: true });
    expect(claudePrice("claude-haiku-4-5-20251001").price).toBe(CLAUDE_PRICES["claude-haiku-4"]);
    expect(claudePrice("claude-opus-4-8").price).toBe(CLAUDE_PRICES["claude-opus-4"]);
  });

  it("prices unknown models at the family's highest price, never at 0", () => {
    const alias = claudePrice("sonnet");
    expect(alias.known).toBe(false);
    expect(alias.price).toBe(CLAUDE_PRICES["claude-sonnet-4"]);
    const stranger = claudePrice("claude-new-9");
    expect(stranger.known).toBe(false);
    expect(stranger.price.output).toBe(Math.max(...Object.values(CLAUDE_PRICES).map((price) => price.output)));
  });

  it("prices input, output, cache reads and cache writes separately", () => {
    // Sonnet 5.5: $2 input, $10 output, $0.20 cache read, $2.50 cache write per million.
    expect(claudeCostUsd("claude-sonnet-5-5", { input: 10, output: 42, cacheRead: 1000, cacheCreation: 5 })).toBeCloseTo(652.5e-6, 12);
  });
});
