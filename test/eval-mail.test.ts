import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMailCases, summarize, type MailCaseResult } from "../eval/mail/score.js";

describe("Mail eval (addendum to D33 of 2026-10-08)", () => {
  it("has valid synthetic cases with both verdicts and unique IDs", () => {
    const cases = parseMailCases(JSON.parse(readFileSync("eval/cases/mail.json", "utf8")));
    expect(cases.length).toBeGreaterThan(30);
    expect(new Set(cases.map((testCase) => testCase.expected))).toEqual(new Set(["wichtig", "unwichtig"]));
  });

  it("rejects duplicate IDs", () => {
    const one = { id: "a", from: "x", subject: "y", text: "z", expected: "wichtig" };
    expect(() => parseMailCases([one, one])).toThrow(/duplicated/);
  });

  it("counts false alarms, misses and what was already lost at the header", () => {
    const result = (id: string, expected: MailCaseResult["expected"], category: MailCaseResult["category"], error: string | null = null): MailCaseResult => ({
      id,
      expected,
      category,
      pSomething: null,
      source: null,
      error,
    });
    const summary = summarize([
      result("treffer", "wichtig", "urgent"),
      result("ruhe", "unwichtig", "none"),
      result("fehlalarm", "unwichtig", "new_commitment"),
      result("verpasst", "wichtig", "none"),
      result("header", "wichtig", "header"),
      result("kaputt", "wichtig", "none", "Timeout"),
    ]);
    expect(summary).toEqual({
      total: 6,
      correct: 2,
      falseAlarms: ["fehlalarm"],
      misses: ["verpasst", "header"],
      lostAtHeader: ["header"],
      errors: ["kaputt"],
      findings: { total: 0, correct: 0, wrong: [] },
    });
  });

  it("scores findings separately, and only where a finding is expected (addendum to D33 of 2026-10-10)", () => {
    const result = (id: string, expected: MailCaseResult["expected"], category: MailCaseResult["category"]): MailCaseResult => ({
      id,
      expected,
      category,
      pSomething: null,
      source: null,
      error: null,
    });
    const summary = summarize([
      { ...result("zug", "unwichtig", "header"), expectedFinding: "booking", finding: "booking" },
      { ...result("paket", "unwichtig", "header"), expectedFinding: "lapse", finding: null },
      { ...result("werbung", "unwichtig", "header"), expectedFinding: "none", finding: null },
      result("ohne", "unwichtig", "none"),
    ]);
    expect(summary.findings).toEqual({ total: 3, correct: 2, wrong: ["paket (lapse → none)"] });
  });
});
