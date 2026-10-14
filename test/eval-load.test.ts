import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSuite, parseChatCases, parseJudgeCases, parseToolsCases } from "../eval/load.js";
import { ownerDate, datesCases } from "../eval/cases/dates.js";
import { SUITE_ROLE, candidatesForRole } from "../eval/config.js";
import { SUITES } from "../eval/types.js";
import { EVAL_OWNER_NAME } from "../eval/persona.js";
import { feedbackPrompt } from "../src/agent/feedback.js";
import { owner } from "../src/config/owner.js";
import type { ChatCase, DatesCase, JudgeCase, RoleName, ToolsCase } from "../eval/types.js";

/**
 * The loader decides what the style comparison runs on. The most important case
 * is the fallback: if there is no local file with the owner's real turns,
 * the run must use the synthetic cases and say so.
 */

const temps: string[] = [];

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), "serain-eval-"));
  temps.push(dir);
  const path = resolve(dir, name);
  writeFileSync(path, content, "utf8");
  // The loader resolves against cwd, so pass it relative.
  return relative(process.cwd(), path);
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop() as string, { recursive: true, force: true });
});

describe("chat suite", () => {
  it("falls back to the 30 synthetic turns without a local file", () => {
    const suite = loadSuite("chat", { localChatFile: "data/eval/does-not-exist.json" });
    expect(suite.cases.filter((entry) => entry.id.startsWith("chat-"))).toHaveLength(30);
    expect(suite.source).toContain("synthetic");
  });

  it("takes the local file if it exists", () => {
    const path = tempFile(
      "chat.local.json",
      JSON.stringify([{ id: "real-1", input: "moin, was geht" }]),
    );
    const suite = loadSuite("chat", { localChatFile: path });
    expect(suite.cases[0]?.id).toBe("real-1");
    expect(suite.source).toContain("local");
  });

  it("always appends the style cases, whatever the source", () => {
    // Whether the owner's real history happens to contain a greeting or a tech question
    // must not decide whether the style rules get measured.
    const path = tempFile("chat.local.json", JSON.stringify([{ id: "real-1", input: "moin" }]));
    const withLocal = loadSuite("chat", { localChatFile: path });
    const withoutLocal = loadSuite("chat", { localChatFile: "data/eval/does-not-exist.json" });
    for (const suite of [withLocal, withoutLocal]) {
      const ids = suite.cases.map((entry) => entry.id);
      expect(ids.filter((id) => id.startsWith("stil-")).length).toBeGreaterThan(0);
      expect(suite.source).toContain("style cases");
    }
  });

  it("does not hide broken JSON instead of silently falling back", () => {
    const path = tempFile("chat.local.json", "{ this is not json");
    expect(() => loadSuite("chat", { localChatFile: path })).toThrow();
  });

  it("the synthetic cases cover the announced mixed cases", () => {
    const cases = loadSuite("chat", { localChatFile: "data/eval/does-not-exist.json" })
      .cases as ChatCase[];
    expect(cases.some((item) => item.tapbackSuffices)).toBe(true);
    expect(cases.some((item) => item.infoRequest)).toBe(true);
    expect(cases.some((item) => (item.history?.length ?? 0) > 0)).toBe(true);
    expect(cases.some((item) => item.input.includes("\n"))).toBe(true);
    // Lowercase is the point: the owner writes like that, and Serain should mirror it.
    const lowercase = cases.filter((item) => item.input === item.input.toLowerCase());
    expect(lowercase.length).toBeGreaterThan(cases.length * 0.8);
  });

  it("names the expected language for every repo case: German owner, English owner, language switches", () => {
    const cases = loadSuite("chat", { localChatFile: "data/eval/does-not-exist.json" }).cases as ChatCase[];
    expect(cases.every((item) => typeof item.language === "string")).toBe(true);
    const english = cases.filter((item) => item.id.startsWith("en-"));
    expect(english.length).toBeGreaterThanOrEqual(6);
    expect(english.every((item) => item.language === "en")).toBe(true);
    // A switch: the history is German, the latest message is in another language, and the reply has to follow it.
    const switches = cases.filter((item) => item.id.startsWith("sprache-") && item.language !== "de");
    expect(switches.length).toBeGreaterThanOrEqual(3);
    expect(new Set(switches.map((item) => item.language))).toEqual(new Set(["tr", "es", "en"]));
    for (const item of switches) expect(item.history?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("tools and judge suites", () => {
  it("loads twenty-two tool cases with hard expectations", () => {
    const cases = loadSuite("tools").cases as ToolsCase[];
    expect(cases).toHaveLength(22);
    expect(cases.some((item) => item.web === true && item.expect.requiredTools?.includes("run_task"))).toBe(true);
    expect(cases.every((item) => item.expect !== undefined)).toBe(true);
    expect(cases.some((item) => item.expect.reactions?.max === 0)).toBe(true);
    expect(cases.some((item) => item.expect.threadReply === true)).toBe(true);
    expect(cases.some((item) => (item.expect.forbiddenTools?.length ?? 0) > 0)).toBe(true);
    const mailCases = cases.filter((item) => item.expect.requiredTools?.includes("mail_search"));
    expect(mailCases.length).toBeGreaterThan(0);
    expect(mailCases.every((item) => (item.mailbox?.length ?? 0) > 0)).toBe(true);
  });

  it("loads the judge cases across all three question types", () => {
    const cases = loadSuite("judge").cases as JudgeCase[];
    const kinds = new Set(cases.map((item) => item.question.kind));
    expect([...kinds].sort()).toEqual(["boolean", "choice", "score"]);
    expect(cases.every((item) => item.tolerance !== undefined)).toBe(true);
  });

  /**
   * The gate cases are the reason the suite exists (live test
   * 2026-09-18). This check keeps the set together: enough cases, both
   * answers represented, and the types the gate actually failed on
   * actually in it.
   */
  it("has at least 25 gate cases, balanced, with history for the borderline cases", () => {
    const cases = loadSuite("judge").cases as JudgeCase[];
    const gateCases = cases.filter(
      (item) => item.question.kind === "boolean" && item.question.gate === true,
    );
    expect(gateCases.length).toBeGreaterThanOrEqual(25);

    const positives = gateCases.filter(
      (item) => item.expected.kind === "boolean" && item.expected.value,
    );
    // A set of only yes cases could be passed with "always yes".
    expect(positives.length).toBeGreaterThanOrEqual(10);
    expect(gateCases.length - positives.length).toBeGreaterThanOrEqual(10);

    // Without history, correction and partial retraction are not borderline cases but
    // sentences without reference, and that is exactly where the gate failed live.
    const withHistory = gateCases.filter((item) => (item.history?.length ?? 0) > 0);
    expect(withHistory.length).toBeGreaterThanOrEqual(6);
    expect(
      withHistory.some((item) => item.expected.kind === "boolean" && !item.expected.value),
    ).toBe(true);
  });
});

describe("Validation", () => {
  it("reports missing required fields", () => {
    expect(() => parseChatCases([{ id: "x" }], "test")).toThrow(/input/);
    expect(() => parseToolsCases([{ id: "x", input: "y" }], "test")).toThrow(/expect/);
  });

  it("reports a language that is not a base language tag, and an event case without one", () => {
    expect(() => parseChatCases([{ id: "x", input: "a", language: "de-DE" }], "test")).toThrow(/base language/);
    expect(() => parseChatCases([{ id: "x", input: "a", language: "german" }], "test")).toThrow(/base language/);
    expect(() => parseChatCases([{ id: "x", input: "a", speaker: "Event" }], "test")).toThrow(/no "language"/);
    expect(parseChatCases([{ id: "x", input: "a", language: "tr" }], "test")).toHaveLength(1);
  });

  it("reports duplicate IDs", () => {
    expect(() =>
      parseChatCases([{ id: "x", input: "a" }, { id: "x", input: "b" }], "test"),
    ).toThrow(/duplicate/);
  });

  it("reports when the judge question and the expectation do not match", () => {
    expect(() =>
      parseJudgeCases(
        [
          {
            id: "j",
            message: "m",
            question: { kind: "boolean", prompt: "p" },
            expected: { kind: "score", value: 1 },
            tolerance: { kind: "exact" },
          },
        ],
        "test",
      ),
    ).toThrow(/but expects/);
  });
});

describe("dates suite", () => {
  it("computes against the owner's time zone (Europe/Berlin in tests), not the system time", () => {
    // 2026-03-15 23:30 UTC is already March 16 in Berlin.
    const date = ownerDate(new Date("2026-03-15T23:30:00Z"));
    expect(date).toEqual({ year: 2026, month: 3, day: 16 });
  });

  it("produces day-dependent expectations", () => {
    const friday = datesCases(new Date("2026-09-18T09:00:00Z")) as DatesCase[];
    expect(friday).toHaveLength(10);
    expect(friday[0]?.expect.anyOf?.[0]).toEqual(["Freitag"]);
    // The day after tomorrow is Sunday the 20th.
    expect(friday[1]?.expect.anyOf?.[0]).toContain("20.");
    // 2026 is not a leap year.
    expect(friday[6]?.expect.anyOf?.[0]).toContain("kein schaltjahr");
    // Next Monday is the 21st, today does not count.
    expect(friday[7]?.expect.anyOf?.[0]).toContain("21.");
  });

  it("skips today when today is already Monday", () => {
    const monday = datesCases(new Date("2026-09-21T09:00:00Z")) as DatesCase[];
    expect(monday[7]?.expect.anyOf?.[0]).toContain("28.");
  });

  it("demands an admission for everything after the cutoff", () => {
    const cases = datesCases(new Date("2026-09-18T09:00:00Z")) as DatesCase[];
    expect(cases.filter((item) => item.expect.admitsUnknown)).toHaveLength(2);
  });
});

describe("Suites and roles", () => {
  it("each suite measures exactly one role (D3, judge from D12)", () => {
    expect(SUITE_ROLE["chat"]).toBe("chat");
    expect(SUITE_ROLE["tools"]).toBe("executor");
    expect(SUITE_ROLE["dates"]).toBe("chat");
    expect(SUITE_ROLE["judge"]).toBe("judge");
  });

  it("every candidate of the judge role brings a backend order", () => {
    const judges = candidatesForRole("judge");
    expect(judges.length).toBeGreaterThan(1);
    expect(judges.every((candidate) => (candidate.judgeBackends?.length ?? 0) > 0)).toBe(true);
  });

  it("each suite has at least one candidate", () => {
    for (const suite of SUITES) {
      expect(candidatesForRole(SUITE_ROLE[suite] as RoleName).length).toBeGreaterThan(0);
    }
  });
});

// --- judge bridge ----------------------------------------------------------

describe("judge bridge", () => {
  it("translates all three question types into the production form", async () => {
    const { toProductionQuestion } = await import("../eval/judge-map.js");
    expect(toProductionQuestion("j1", { kind: "boolean", prompt: "merkenswert?" })).toEqual({
      key: "j1",
      type: "boolean",
      instructions: "merkenswert?",
    });
    expect(
      toProductionQuestion("j2", {
        kind: "choice",
        prompt: "ersetzt was?",
        options: [{ id: "f1", text: "Alex mag Sushi" }],
      }),
    ).toEqual({
      key: "j2",
      type: "choice",
      instructions: "ersetzt was?",
      options: [{ key: "f1", criterion: "Alex mag Sushi" }],
    });
    expect(
      toProductionQuestion("j3", { kind: "score", prompt: "wichtig?", min: 1, max: 3 }),
    ).toMatchObject({ type: "score", scale: ["1", "2", "3"] });
  });

  it("converts the 0-based production scale back into the case's scale", async () => {
    const { fromProductionAnswer } = await import("../eval/judge-map.js");
    const question = { kind: "score" as const, prompt: "wichtig?", min: 1, max: 5 };
    expect(
      fromProductionAnswer(question, {
        type: "score",
        source: "generative",
        score: 3.8,
        index: 4,
        label: "sehr wichtig",
        probabilities: {},
        confidence: 0.7,
      }),
    ).toEqual({ kind: "score", value: 5 });
  });

  it("turns a probability into a yes or no", async () => {
    const { fromProductionAnswer } = await import("../eval/judge-map.js");
    const question = { kind: "boolean" as const, prompt: "merkenswert?" };
    const answer = (probability: number) =>
      fromProductionAnswer(question, { type: "boolean", source: "jev", probability });
    expect(answer(0.9)).toEqual({ kind: "boolean", value: true });
    expect(answer(0.2)).toEqual({ kind: "boolean", value: false });
  });

  it("throws when the answer type does not match the question", async () => {
    const { fromProductionAnswer } = await import("../eval/judge-map.js");
    expect(() =>
      fromProductionAnswer(
        { kind: "boolean", prompt: "p" },
        { type: "choice", source: "jev", choice: "f1", probabilities: {}, confidence: 1 },
      ),
    ).toThrow(/the question was/);
  });

  it("builds the state without anything that does not belong to the verdict", async () => {
    const { judgeState } = await import("../eval/judge-map.js");
    const withContext = judgeState({
      id: "j",
      message: "ne doch kein sushi",
      context: "Bekannte Fakten: f1",
      question: { kind: "boolean", prompt: "p" },
      expected: { kind: "boolean", value: true },
      tolerance: { kind: "exact" },
    });
    expect(withContext).toContain("Bekannte Fakten: f1");
    expect(withContext).toContain("ne doch kein sushi");
  });
});

describe("Persona of the evals (eval/persona.ts)", () => {
  it("is the same as in the tests", () => {
    expect(owner.name).toBe(EVAL_OWNER_NAME);
  });

  it("matches the event texts the code builds with the name", () => {
    // The 👎 cases quote feedbackPrompt() verbatim; with a different name the model would see two owners.
    const cases = loadSuite("chat", { localChatFile: "data/eval/does-not-exist.json" }).cases as ChatCase[];
    const correction = cases.filter((entry) => entry.id.includes("-korrektur-"));
    expect(correction.map((entry) => entry.id)).toEqual(["stil-korrektur-01", "stil-korrektur-02", "en-korrektur-01"]);
    for (const entry of correction) {
      const quoted = entry.history?.find((turn) => turn.role === "assistant" && entry.input.includes(turn.content));
      expect(quoted).toBeDefined();
      expect(entry.input).toBe(feedbackPrompt("correction", "👎", quoted?.content ?? ""));
    }
  });
});
