import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeCategory } from "../src/memory/extract.js";
import { factId } from "../src/memory/facts.js";
import { systemPrompt, turnContext } from "../src/agent/prompt.js";

const ROOT = resolve(import.meta.dirname, "..");

describe("factId", () => {
  it("is stable for the same fact", () => {
    expect(factId("sport", "Alex runs")).toBe(factId("sport", "Alex runs"));
  });

  it("separates category and content cleanly", () => {
    // Without a separator, ("ab", "c") and ("a", "bc") would collide.
    expect(factId("ab", "c")).not.toBe(factId("a", "bc"));
  });

  it("returns a UUID v5", () => {
    expect(factId("style", "answer briefly")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("systemPrompt", () => {
  const now = new Date("2026-09-17T20:00:00Z");

  it("works without a user model", () => {
    const prompt = systemPrompt();
    expect(prompt).toContain("You are Serain");
    expect(prompt).not.toContain("<user_model>");
  });

  it("appends the user model after the behaviour rules", () => {
    const prompt = systemPrompt("Alex wohnt in Musterstadt.");
    expect(prompt).toContain("<user_model>\nAlex wohnt in Musterstadt.\n</user_model>");
    expect(prompt.indexOf("</style>")).toBeLessThan(prompt.indexOf("<user_model>"));
  });

  it("tells the model that Alex is the newer source", () => {
    expect(systemPrompt("x")).toContain("always beats");
  });

  it("stays the same across turns: time and memory are in the context, not in the system prompt (V7)", () => {
    expect(systemPrompt("x")).not.toMatch(/2026|<memory>/);
    const context = turnContext(now, "[style] likes it short");
    expect(context).toContain("It is now Thursday, 17 September 2026 at 22:00 (Europe/Berlin).");
    expect(context).toContain("<memory>\n[style] likes it short\n</memory>");
    expect(turnContext(now)).not.toContain("<memory>");
  });
});

/**
 * The template in the repo (`data.example/facts.json`) and, if present, your
 * own facts in `data/facts.json` (gitignored), which `pnpm memory:push` pushes.
 */
for (const file of ["data.example/facts.json", "data/facts.json"].filter((path) => existsSync(resolve(ROOT, path)))) {
  describe(file, () => {
    const facts = JSON.parse(readFileSync(resolve(ROOT, file), "utf8")) as Array<{
      category: string;
      content: string;
      confidence: number;
    }>;

    it("is complete and plausible", () => {
      expect(facts.length).toBeGreaterThan(0);
      for (const fact of facts) {
        // Same form as extracted facts (`normalizeCategory`): umlauts are allowed, transliteration is unnecessary.
        expect(fact.category).toBe(normalizeCategory(fact.category));
        expect(fact.content.length).toBeGreaterThan(20);
        expect(fact.confidence).toBeGreaterThan(0);
        expect(fact.confidence).toBeLessThanOrEqual(1);
      }
    });

    it("contains no duplicates", () => {
      const ids = facts.map((fact) => factId(fact.category, fact.content));
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
}

it("the template data.example/facts.json is in the repo", () => {
  expect(existsSync(resolve(ROOT, "data.example/facts.json"))).toBe(true);
});
