import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Run, anonymization, cap and evaluation. The "model" here is a script:
 * what is checked is not what a model answers, but that the harness aborts
 * correctly, writes blind correctly and counts correctly.
 */

interface ScriptedTurn {
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  costUsd: number;
}

const script = new Map<string, ScriptedTurn>();
let seenPins: Array<{ provider: string; model: string; detail?: Record<string, unknown> }> = [];

vi.mock("../src/db/audit.js", () => ({
  audit: async () => undefined,
  setAuditActor: () => undefined,
}));

vi.mock("../src/agent/model.js", () => ({
  runModelTurn: async (req: {
    pin?: { provider: string; model: string; usageDetail?: Record<string, unknown> };
    execute: (name: string, args: Record<string, unknown>) => Promise<{ endsTurn: boolean }>;
  }) => {
    const pin = req.pin;
    if (!pin) throw new Error("Eval must pin the candidate");
    seenPins.push({
      provider: pin.provider,
      model: pin.model,
      ...(pin.usageDetail ? { detail: pin.usageDetail } : {}),
    });
    const turn = script.get(pin.model) ?? { calls: [{ tool: "end_turn", args: {} }], costUsd: 0 };
    for (const call of turn.calls) {
      const result = await req.execute(call.tool, call.args);
      if (result.endsTurn) break;
    }
    return { provider: pin.provider, model: pin.model, costUsd: turn.costUsd, text: "" };
  },
  BudgetExceededError: class extends Error {},
}));

const { runEval } = await import("../eval/run.js");
const { RunCap, RunCapReached } = await import("../eval/cap.js");
const { anonymize, aliasAt, aliasOf, shuffle } = await import("../eval/anonymize.js");
const { renderReport } = await import("../eval/report.js");
const { compareRuns, gateSweep, rankRun, renderGateSweep, renderRanking } = await import(
  "../eval/rank.js",
);
const { blind, readRun, runPaths } = await import("../eval/store.js");
type Candidate = import("../eval/types.js").Candidate;
type CaseRun = import("../eval/types.js").CaseRun;
type JudgeCase = import("../eval/types.js").JudgeCase;

const CHEAP: Candidate = {
  id: "chat:sub:sonnet",
  role: "chat",
  provider: "subscription",
  model: "sonnet",
  label: "Subscription · Sonnet",
};
const PRICEY: Candidate = {
  id: "chat:or:kimi-k2",
  role: "chat",
  provider: "openrouter",
  model: "moonshotai/kimi-k2",
  label: "Kimi K2",
};

let root: string;

beforeEach(() => {
  script.clear();
  seenPins = [];
  root = relative(process.cwd(), mkdtempSync(resolve(tmpdir(), "serain-runs-")));
});

afterEach(() => {
  rmSync(resolve(process.cwd(), root), { recursive: true, force: true });
});

describe("Run cap", () => {
  it("stops once the cap is reached", () => {
    const cap = new RunCap(0.05);
    expect(cap.blockedReason()).toBeNull();
    cap.record(0.04);
    expect(cap.blockedReason()).toBeNull();
    cap.record(0.02);
    expect(cap.blockedReason()).toContain("Run cap");
    expect(() => cap.assertOpen()).toThrow(RunCapReached);
  });

  it("also applies when everything costs 0 $", () => {
    const cap = new RunCap(2, 2);
    cap.record(0);
    cap.record(0);
    expect(cap.blockedReason()).toContain("Too many requests");
  });

  it("requires a cap above zero", () => {
    expect(() => new RunCap(0)).toThrow();
  });

  it("aborts the run instead of spending more money", async () => {
    script.set("moonshotai/kimi-k2", {
      calls: [{ tool: "send_message", args: { text: "moin" } }, { tool: "end_turn", args: {} }],
      costUsd: 0.06,
    });
    const result = await runEval({
      suites: ["chat"],
      candidates: [PRICEY],
      capUsd: 0.05,
      runsRoot: root,
    });
    expect(result.manifest.abortedAt).toContain("Run cap");
    // One request goes over the cap, because the cost is only known from the response.
    expect(result.results).toHaveLength(1);
    expect(result.manifest.spentUsd).toBeCloseTo(0.06, 5);
  });
});

describe("Run through the production path", () => {
  it("pins every candidate and books it as eval", async () => {
    script.set("sonnet", {
      calls: [{ tool: "send_message", args: { text: "moin" } }, { tool: "end_turn", args: {} }],
      costUsd: 0,
    });
    const result = await runEval({
      suites: ["chat"],
      candidates: [CHEAP],
      capUsd: 1,
      limit: 2,
      runsRoot: root,
    });
    expect(result.results).toHaveLength(2);
    expect(seenPins).toHaveLength(2);
    expect(seenPins[0]?.model).toBe("sonnet");
    expect(seenPins[0]?.detail).toMatchObject({ eval: "chat", candidate: CHEAP.id });
  });

  it("records what would have been sent, without sending", async () => {
    script.set("sonnet", {
      calls: [
        { tool: "send_message", args: { text: "bin gleich da" } },
        { tool: "react", args: { signal: "ok" } },
        { tool: "end_turn", args: {} },
      ],
      costUsd: 0,
    });
    const result = await runEval({
      suites: ["chat"],
      candidates: [CHEAP],
      capUsd: 1,
      limit: 1,
      runsRoot: root,
    });
    const record = result.results[0]?.record;
    expect(record?.messages[0]?.text).toBe("bin gleich da");
    expect(record?.reactions[0]?.emoji).toBe("👍");
    expect(record?.toolCalls.map((call) => call.name)).toEqual([
      "send_message",
      "react",
      "end_turn",
    ]);
  });

  it("records a failed candidate as an error instead of killing the run", async () => {
    script.set("sonnet", {
      calls: [{ tool: "end_turn", args: {} }],
      costUsd: 0,
    });
    const boom = { ...PRICEY, model: "broken" };
    script.set("broken", { calls: [], costUsd: Number.NaN });
    const result = await runEval({
      suites: ["chat"],
      candidates: [CHEAP, boom],
      capUsd: 1,
      limit: 1,
      runsRoot: root,
    });
    expect(result.results).toHaveLength(2);
    expect(result.results.every((run) => run.ok)).toBe(true);
  });
});

describe("Anonymization", () => {
  it("assigns stable blind names per run", () => {
    const key = anonymize([CHEAP, PRICEY], "run-1");
    const again = anonymize([CHEAP, PRICEY], "run-1");
    expect(key.aliases).toEqual(again.aliases);
    expect(Object.keys(key.aliases).sort()).toEqual(["A", "B"]);
    expect(aliasOf(key, CHEAP.id)).toMatch(/^[AB]$/);
  });

  it("shuffles the order so that the same one is not always on the left", () => {
    const ids = Array.from({ length: 8 }, (_unused, index) => `c${index}`);
    expect(shuffle(ids, "seed-a")).not.toEqual(shuffle(ids, "seed-b"));
    expect([...shuffle(ids, "seed-a")].sort()).toEqual([...ids].sort());
  });

  it("keeps counting past Z", () => {
    expect(aliasAt(0)).toBe("A");
    expect(aliasAt(25)).toBe("Z");
    expect(aliasAt(26)).toBe("AA");
  });

  it("throws when a candidate does not belong to the run", () => {
    expect(() => aliasOf(anonymize([CHEAP], "l"), PRICEY.id)).toThrow();
  });

  it("writes results.json without candidate names", async () => {
    script.set("sonnet", { calls: [{ tool: "end_turn", args: {} }], costUsd: 0 });
    script.set("moonshotai/kimi-k2", { calls: [{ tool: "end_turn", args: {} }], costUsd: 0 });
    const result = await runEval({
      suites: ["chat"],
      candidates: [CHEAP, PRICEY],
      capUsd: 1,
      limit: 1,
      runsRoot: root,
    });
    const raw = readFileSync(runPaths(result.runId, root).results, "utf8");
    expect(raw).not.toContain("kimi");
    expect(raw).not.toContain("sonnet");
    expect(raw).not.toContain("candidateId");
    // The key lies next to it and can be applied again.
    const loaded = readRun(result.runId, root);
    expect(loaded.results.map((run) => run.candidateId).sort()).toEqual(
      [CHEAP.id, PRICEY.id].sort(),
    );
  });

  it("blind() removes exactly that one field", () => {
    const run = {
      caseId: "c1",
      suite: "chat" as const,
      input: "moin",
      alias: "A",
      candidateId: CHEAP.id,
      ok: true,
      checks: [],
      costUsd: 0,
      latencyMs: 1,
    };
    const [stored] = blind([run]);
    expect(stored).not.toHaveProperty("candidateId");
    expect(stored?.alias).toBe("A");
  });
});

// --- Evaluation ------------------------------------------------------------

function caseRun(partial: Partial<CaseRun> & { caseId: string; alias: string; candidateId: string }): CaseRun {
  return {
    suite: "chat",
    input: "moin",
    ok: true,
    checks: [],
    costUsd: 0,
    latencyMs: 100,
    ...partial,
  };
}

describe("Report", () => {
  it("names no model", () => {
    const html = renderReport({
      manifest: {
        runId: "r1",
        startedAt: new Date().toISOString(),
        suites: ["chat"],
        candidateIds: [CHEAP.id, PRICEY.id],
        capUsd: 1,
        spentUsd: 0.1,
      },
      results: [
        caseRun({
          caseId: "chat-01",
          alias: "A",
          candidateId: CHEAP.id,
          record: {
            messages: [{ text: "moin", kind: "reply" }],
            reactions: [],
            toolCalls: [],
            unknownTools: [],
            usedTextFallback: false,
            stopReason: null,
            steps: 1,
          },
        }),
        caseRun({ caseId: "chat-01", alias: "B", candidateId: PRICEY.id }),
      ],
      sources: { chat: "repo (synthetic)" },
    });
    expect(html).toContain("chat/chat-01");
    expect(html).not.toContain(CHEAP.id);
    expect(html).not.toContain(PRICEY.id);
    expect(html).not.toContain("Kimi");
    expect(html).not.toContain("kimi-k2");
  });

  it("escapes HTML from model answers", () => {
    const html = renderReport({
      manifest: {
        runId: "r1",
        startedAt: new Date().toISOString(),
        suites: ["chat"],
        candidateIds: [CHEAP.id],
        capUsd: 1,
        spentUsd: 0,
      },
      results: [
        caseRun({
          caseId: "c1",
          alias: "A",
          candidateId: CHEAP.id,
          record: {
            messages: [{ text: "<script>alert(1)</script>", kind: "reply" }],
            reactions: [],
            toolCalls: [],
            unknownTools: [],
            usedTextFallback: false,
            stopReason: null,
            steps: 1,
          },
        }),
      ],
      sources: {},
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("Ranking", () => {
  const key = anonymize([CHEAP, PRICEY], "r1");
  const aliasCheap = aliasOf(key, CHEAP.id);
  const results: CaseRun[] = [
    caseRun({
      caseId: "c1",
      alias: aliasCheap,
      candidateId: CHEAP.id,
      checks: [{ id: "no_dashes", passed: true }],
      latencyMs: 100,
    }),
    caseRun({
      caseId: "c1",
      alias: aliasOf(key, PRICEY.id),
      candidateId: PRICEY.id,
      checks: [{ id: "no_dashes", passed: false }],
      latencyMs: 900,
      costUsd: 0.02,
    }),
  ];

  it("combines the owner's choice, rule checks and speed", () => {
    const byRole = rankRun({
      results,
      key,
      choices: { runId: "r1", choices: { "chat/c1": aliasCheap } },
    });
    const chat = byRole["chat"] ?? [];
    expect(chat[0]?.candidateId).toBe(CHEAP.id);
    expect(chat[0]?.wins).toBe(1);
    expect(chat[0]?.votes).toBe(1);
    expect(chat[1]?.wins).toBe(0);
    expect(chat[1]?.votes).toBe(1);
  });

  it("works without the owner's choice and says so", () => {
    const byRole = rankRun({ results, key, choices: null });
    expect(byRole["chat"]?.[0]?.candidateId).toBe(CHEAP.id);
    expect(byRole["chat"]?.[0]?.votes).toBe(0);
    expect(renderRanking(byRole, { runId: "r1", hasChoices: false })).toContain(
      "half the truth",
    );
  });

  it("keeps cost out of the score and shows it alongside", () => {
    const byRole = rankRun({ results, key, choices: null });
    const table = renderRanking(byRole, { runId: "r1", hasChoices: false });
    expect(table).toContain("0.0200 $");
    expect(table).toContain("deliberately not factored in");
  });

  it("separates roles instead of ranking chat against extraction", () => {
    const extraction: Candidate = {
      id: "extract:or:haiku",
      role: "extraction",
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      label: "Claude Haiku 4.5",
    };
    const mixedKey = anonymize([CHEAP, extraction], "r2");
    const byRole = rankRun({
      results: [
        caseRun({ caseId: "c1", alias: aliasOf(mixedKey, CHEAP.id), candidateId: CHEAP.id }),
        caseRun({
          caseId: "j1",
          suite: "judge",
          alias: aliasOf(mixedKey, extraction.id),
          candidateId: extraction.id,
        }),
      ],
      key: mixedKey,
      choices: null,
    });
    expect(Object.keys(byRole).sort()).toEqual(["chat", "extraction"]);
  });
});

describe("Regression comparison", () => {
  const before: CaseRun[] = [
    caseRun({
      caseId: "c1",
      alias: "A",
      candidateId: CHEAP.id,
      checks: [
        { id: "no_dashes", passed: true },
        { id: "no_filler", passed: true },
      ],
    }),
  ];
  const after: CaseRun[] = [
    caseRun({
      caseId: "c1",
      alias: "A",
      candidateId: CHEAP.id,
      checks: [
        { id: "no_dashes", passed: true },
        { id: "no_filler", passed: false },
      ],
    }),
  ];

  it("shows which check got worse", () => {
    const report = compareRuns({
      baseline: { runId: "old", results: before },
      current: { runId: "new", results: after },
      candidateId: CHEAP.id,
      suite: "chat",
    });
    expect(report.overallBaseline).toBe(1);
    expect(report.overallCurrent).toBe(0.5);
    expect(report.regressions.map((row) => row.checkId)).toEqual(["no_filler"]);
  });

  it("throws when the baseline does not know the candidate at all", () => {
    expect(() =>
      compareRuns({
        baseline: { runId: "old", results: before },
        current: { runId: "new", results: after },
        candidateId: PRICEY.id,
        suite: "chat",
      }),
    ).toThrow(/no results/);
  });
});

/**
 * For the judge role the gate threshold is the real question, and it should be
 * answerable from one run instead of three. That is why the run records
 * the raw probabilities, and the computation happens here.
 */
describe("Gate threshold", () => {
  const JUDGE_A: Candidate = {
    id: "judge:generative-first",
    role: "judge",
    provider: "openrouter",
    model: "generative → jev",
    label: "judge · generative first",
    judgeBackends: ["generative", "jev"],
  };

  const cases: JudgeCase[] = [
    {
      id: "g1",
      message: "ich klettere jetzt zweimal die woche",
      question: { kind: "boolean", gate: true },
      expected: { kind: "boolean", value: true },
      tolerance: { kind: "exact" },
    },
    {
      id: "g2",
      message: "danke dir",
      question: { kind: "boolean", gate: true },
      expected: { kind: "boolean", value: false },
      tolerance: { kind: "exact" },
    },
    {
      id: "g3",
      message: "wie wichtig ist das",
      question: {
        kind: "score",
        prompt: "Wie wichtig?",
        min: 1,
        max: 5,
      },
      expected: { kind: "score", value: 3 },
      tolerance: { kind: "plusMinus", value: 1 },
    },
  ];

  function judgeRun(caseId: string, probability: number): CaseRun {
    return caseRun({
      caseId,
      suite: "judge",
      alias: "A",
      candidateId: JUDGE_A.id,
      judge: { backend: "generative", probability },
    });
  }

  it("turns the same answers into different errors depending on the threshold", () => {
    // 0.52 is worth remembering, 0.45 is not. At 0.4 both pass, at 0.6 neither.
    const results = [judgeRun("g1", 0.52), judgeRun("g2", 0.45)];
    const rows = gateSweep({ results, cases });

    const at = (threshold: number) =>
      rows.find((row) => row.threshold === threshold) as (typeof rows)[number];
    expect(at(0.4).hits).toBe(1);
    expect(at(0.4).falsePositives).toBe(1);
    expect(at(0.5).hits).toBe(2);
    expect(at(0.5).falseNegatives).toBe(0);
    expect(at(0.5).falsePositives).toBe(0);
    expect(at(0.6).hits).toBe(1);
    expect(at(0.6).falseNegatives).toBe(1);
  });

  it("computes only with boolean cases and only with successful runs", () => {
    const results = [
      judgeRun("g1", 0.9),
      // score case: has no probability and does not belong in the rate.
      caseRun({ caseId: "g3", suite: "judge", alias: "A", candidateId: JUDGE_A.id }),
      { ...judgeRun("g2", 0.1), ok: false, error: "Timeout" },
    ];
    const rows = gateSweep({ results, cases, thresholds: [0.5] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cases).toBe(1);
    expect(rows[0]?.hitRate).toBe(1);
  });

  it("reports both kinds of error separately instead of netting them", () => {
    const rows = gateSweep({
      results: [judgeRun("g1", 0.1), judgeRun("g2", 0.9)],
      cases,
      thresholds: [0.5],
    });
    const table = renderGateSweep(rows);
    expect(rows[0]?.falseNegatives).toBe(1);
    expect(rows[0]?.falsePositives).toBe(1);
    expect(table).toContain("false negative");
    expect(table).toContain("false positive");
  });

  it("stays silent when a run had no judge cases", () => {
    expect(gateSweep({ results: [caseRun({ caseId: "c1", alias: "A", candidateId: CHEAP.id })], cases })).toEqual([]);
    expect(renderGateSweep([])).toBe("");
  });
});
