import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * judge tests without network and without database. The Jev client gets its
 * own `fetch` injected so the shape of the request (above all the ZDR
 * parameters) and the behaviour on broken answers can be checked.
 */
const auditMock = vi.fn(async () => undefined);
const usageMock = vi.fn(async () => undefined);

vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...(args as [])) }));
vi.mock("../src/db/usage.js", () => ({
  recordModelUsage: (...args: unknown[]) => usageMock(...(args as [])),
}));
vi.mock("../src/config/env.js", () => ({
  env: {
    openrouterApiKey: "sk-or-v1-test",
    claudeOauthToken: "",
    dataDir: "/tmp",
    supabaseUrl: "http://localhost:54321",
    supabaseSecretKey: "sb_secret_test",
  },
}));

const { JevBackend, jevRequestBody, toJudgeAnswer } = await import("../src/agent/judge/jev.js");
const { RoutedJudge, argmax, normalizeDistribution, askJudge } = await import(
  "../src/agent/judge/index.js"
);
const { JUDGE_NONE_KEY } = await import("../src/agent/judge/types.js");
type JudgeQuestion = import("../src/agent/judge/types.js").JudgeQuestion;
type JudgeBackend = import("../src/agent/judge/types.js").JudgeBackend;

const gate: JudgeQuestion = {
  key: "memorable",
  type: "boolean",
  instructions: "Does the message contain a fact worth remembering for good?",
};

const replaces: JudgeQuestion = {
  key: "supersedes",
  type: "choice",
  instructions: "Which existing fact does the new one replace?",
  options: [
    { key: "f1", criterion: "Place of residence" },
    { key: "f2", criterion: "Occupation" },
    { key: JUDGE_NONE_KEY, criterion: "None of these" },
  ],
};

const importance: JudgeQuestion = {
  key: "importance",
  type: "score",
  instructions: "How expensive would a wrong assumption be?",
  scale: ["irrelevant", "slightly annoying", "noticeably expensive", "very expensive"],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  auditMock.mockClear();
  usageMock.mockClear();
});

describe("Jev request", () => {
  it("sets the ZDR parameters for every question type", () => {
    for (const question of [gate, replaces, importance]) {
      const body = jevRequestBody("state", question);
      expect(body["provider"]).toEqual({ zdr: true, data_collection: "deny" });
    }
  });

  it("sends exactly one question per request", () => {
    const body = jevRequestBody("state", gate);
    expect(Object.keys(body["questions"] as object)).toEqual(["memorable"]);
  });

  it("calls boolean by the endpoint's name: noul", () => {
    const questions = jevRequestBody("state", gate)["questions"] as Record<string, { type: string }>;
    expect(questions["memorable"]?.type).toBe("noul");
  });

  it("sends choice criteria as an object, score criteria as an array", () => {
    // Measured on 2026-09-18: an array for choice is rejected with HTTP 400.
    const choice = (jevRequestBody("state", replaces)["questions"] as Record<string, { criteria: unknown }>)[
      "supersedes"
    ];
    expect(choice?.criteria).toEqual({ f1: "Place of residence", f2: "Occupation", [JUDGE_NONE_KEY]: "None of these" });

    const score = (jevRequestBody("state", importance)["questions"] as Record<string, { criteria: unknown }>)[
      "importance"
    ];
    expect(score?.criteria).toEqual(["irrelevant", "slightly annoying", "noticeably expensive", "very expensive"]);
  });
});

describe("Jev answer", () => {
  it("reads noul as the probability of yes", () => {
    const answer = toJudgeAnswer(gate, { type: "noul", noul: 0.82 });
    expect(answer).toEqual({ type: "boolean", source: "jev", probability: 0.82 });
  });

  it("maps score via the position in the scale array, not via the text", () => {
    const answer = toJudgeAnswer(importance, {
      type: "score",
      score: 1.68,
      legend: { "0": "irrelevant", "1": "slightly annoying", "2": "noticeably expensive", "3": "very expensive" },
      probabilities: { "0": 0.12, "1": 0.29, "2": 0.38, "3": 0.21 },
      confidence: 0.38,
    });
    if (answer.type !== "score") throw new Error("wrong answer type");
    expect(answer.index).toBe(2);
    expect(answer.label).toBe("noticeably expensive");
    expect(answer.score).toBeCloseTo(1.68);
  });

  it("rejects a level outside the scale", () => {
    expect(() =>
      toJudgeAnswer(importance, {
        type: "score",
        score: 4,
        legend: {},
        probabilities: { "9": 1 },
        confidence: 1,
      }),
    ).toThrow(/level/);
  });

  it("rejects an option that was never on offer", () => {
    expect(() =>
      toJudgeAnswer(replaces, {
        type: "choice",
        choice: "invented",
        probabilities: { invented: 1 },
        confidence: 1,
      }),
    ).toThrow(/was not an option/);
  });

  it("normalizes the distribution to sum 1", () => {
    const answer = toJudgeAnswer(replaces, {
      type: "choice",
      choice: "f1",
      probabilities: { f1: 0.6, f2: 0.2, [JUDGE_NONE_KEY]: 0.1 },
      confidence: 0.6,
    });
    if (answer.type !== "choice") throw new Error("wrong answer type");
    const total = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
    expect(answer.confidence).toBeCloseTo(0.6 / 0.9);
  });
});

describe("Jev client", () => {
  it("books the cost and returns the answer", async () => {
    const backend = new JevBackend(async () =>
      jsonResponse({
        model: "typesafe/jev-1.13-20260917",
        answers: { memorable: { type: "noul", noul: 0.62 } },
        usage: { input_tokens: 338, output_tokens: 22, cost: 0.000014196 },
      }),
    );
    const result = await backend.askOne("state", gate);
    expect(result.answer.source).toBe("jev");
    expect(result.costUsd).toBeCloseTo(0.000014196);
    expect(usageMock).toHaveBeenCalledWith(expect.objectContaining({ role: "judge" }));
  });

  it("throws on an answer that does not match the schema", async () => {
    const backend = new JevBackend(async () => jsonResponse({ answers: { memorable: {} } }));
    await expect(backend.askOne("state", gate)).rejects.toThrow(/schema/);
  });

  it("throws on an HTTP error without dragging the error text along unbounded", async () => {
    const backend = new JevBackend(async () => jsonResponse({ error: "x".repeat(5_000) }, 500));
    await expect(backend.askOne("state", gate)).rejects.toThrow(/HTTP 500/);
  });

  it("books nothing when the answer is discarded", async () => {
    const backend = new JevBackend(async () => jsonResponse({ answers: {} }, 200));
    await expect(backend.askOne("state", gate)).rejects.toThrow();
    expect(usageMock).not.toHaveBeenCalled();
  });
});

describe("Backend choice and fallback", () => {
  function scriptedBackend(name: "jev" | "generative", fail: boolean): JudgeBackend {
    return {
      name,
      askOne: async () => {
        if (fail) throw new Error(`${name} broken`);
        return {
          answer: { type: "boolean" as const, source: name, probability: 0.9 },
          costUsd: 0.001,
        };
      },
    };
  }

  it("falls back to the next backend and leaves a trace", async () => {
    const judge = new RoutedJudge(["jev", "generative"]);
    // Replace the backends directly: the test checks the order, not the clients.
    Reflect.set(judge, "backends", [
      scriptedBackend("jev", true),
      scriptedBackend("generative", false),
    ]);
    const answer = await askJudge(judge, "state", gate);
    expect(answer.source).toBe("generative");
    expect(auditMock).toHaveBeenCalledWith(
      "judge_fallback",
      expect.objectContaining({ from: "jev", to: "generative", question: "memorable" }),
    );
  });

  it("throws when no backend can answer, instead of guessing", async () => {
    const judge = new RoutedJudge(["jev", "generative"]);
    Reflect.set(judge, "backends", [
      scriptedBackend("jev", true),
      scriptedBackend("generative", true),
    ]);
    await expect(askJudge(judge, "state", gate)).rejects.toThrow(/could not answer/);
  });

  it("sums the costs over several questions", async () => {
    const judge = new RoutedJudge(["generative"]);
    Reflect.set(judge, "backends", [scriptedBackend("generative", false)]);
    const result = await judge.ask({
      state: "state",
      questions: [gate, { ...gate, key: "second" }],
    });
    expect(Object.keys(result.answers).sort()).toEqual(["memorable", "second"]);
    expect(result.costUsd).toBeCloseTo(0.002);
  });
});

describe("Distribution helpers", () => {
  it("normalizes and cuts off negative mass", () => {
    expect(normalizeDistribution({ a: 2, b: 2, c: -1 })).toEqual({ a: 0.5, b: 0.5, c: 0 });
  });

  it("throws on a distribution without mass", () => {
    expect(() => normalizeDistribution({ a: 0, b: 0 })).toThrow(/mass/);
  });

  it("finds the maximum", () => {
    expect(argmax({ a: 0.1, b: 0.7, c: 0.2 })).toEqual({ key: "b", value: 0.7 });
  });
});
