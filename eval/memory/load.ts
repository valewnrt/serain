import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CATEGORIES, memoryCaseSchema, type Category, type MemoryCase } from "./types.js";

/**
 * Loads `eval/cases/memory.json` and checks more than just the shape: a case in
 * which the question is asked before the source message would be valid JSON and
 * still a wrong case. What gets through here is internally consistent.
 */

export const CASES_FILE = resolve(import.meta.dirname, "../cases/memory.json");

function ms(at: string): number {
  return Date.parse(at);
}

/** Content checks beyond the schema. Throws with case ID and reason. */
function assertCoherent(testCase: MemoryCase): void {
  const fail = (reason: string): never => {
    throw new Error(`Case ${testCase.id}: ${reason}`);
  };

  const truthIds = new Set<string>();
  for (const truth of testCase.truth) {
    if (truthIds.has(truth.id)) fail(`truth "${truth.id}" duplicated`);
    truthIds.add(truth.id);
  }
  for (const truth of testCase.truth) {
    if (truth.supersedes && !truthIds.has(truth.supersedes)) {
      fail(`truth "${truth.id}" supersedes unknown "${truth.supersedes}"`);
    }
    if (truth.validFrom && truth.validUntil && truth.validFrom >= truth.validUntil) {
      fail(`truth "${truth.id}": validFrom is not before validUntil`);
    }
  }

  // The messages are a timeline. Equal timestamps would leave the
  // order in the history to chance.
  for (let i = 1; i < testCase.script.length; i += 1) {
    const before = testCase.script[i - 1];
    const current = testCase.script[i];
    if (before && current && ms(current.at) <= ms(before.at)) {
      fail(`message ${i + 1} is not after message ${i}`);
    }
  }
  const first = ms(testCase.script[0]?.at ?? "");
  const last = ms(testCase.script.at(-1)?.at ?? "");

  for (const fact of testCase.seed.facts) {
    if (ms(fact.at) >= first) fail("a seed fact is not before the first message");
  }
  for (const summary of testCase.seed.summaries) {
    if (ms(summary.windowStart) >= ms(summary.windowEnd)) fail("summary with an empty window");
  }

  // Questions after the script: otherwise the case asks about something that does not
  // exist yet, and measures guessing instead of remembering.
  for (const check of testCase.recall) {
    if (ms(check.at) <= last) fail(`recall question "${check.query}" is not after the last message`);
  }
  if (testCase.answer && ms(testCase.answer.at) <= last) {
    fail("the answer question is not after the last message");
  }

  if (testCase.state.length + testCase.recall.length === 0 && !testCase.answer) {
    fail("not a single check");
  }

  // Forgetting needs something to forget, and the eval only checks it if it
  // also looks for a sentinel or misses a fact.
  if (testCase.category === "vergessen" && !testCase.script.some((message) => message.forget)) {
    fail("forgetting case without a delete instruction");
  }
}

export function parseMemoryCases(raw: unknown): MemoryCase[] {
  if (!Array.isArray(raw)) throw new Error("memory.json: expected a list of cases");
  const cases = raw.map((row, index) => {
    const parsed = memoryCaseSchema.safeParse(row);
    if (!parsed.success) {
      const id = (row as { id?: unknown })?.id;
      const issue = parsed.error.issues[0];
      throw new Error(
        `memory.json, case ${typeof id === "string" ? id : `#${index + 1}`}: ` +
          `${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
      );
    }
    return parsed.data;
  });

  const seen = new Set<string>();
  for (const testCase of cases) {
    if (seen.has(testCase.id)) throw new Error(`memory.json: duplicate case ID "${testCase.id}"`);
    seen.add(testCase.id);
    assertCoherent(testCase);
  }
  return cases;
}

export function loadMemoryCases(path = CASES_FILE): MemoryCase[] {
  return parseMemoryCases(JSON.parse(readFileSync(path, "utf8")));
}

export interface CaseFilter {
  only?: readonly string[];
  category?: Category;
}

export function selectCases(cases: readonly MemoryCase[], filter: CaseFilter): MemoryCase[] {
  if (filter.category && !CATEGORIES.includes(filter.category)) {
    throw new Error(`Unknown category "${filter.category}". Possible: ${CATEGORIES.join(", ")}`);
  }
  const unknown = (filter.only ?? []).filter((id) => !cases.some((testCase) => testCase.id === id));
  if (unknown.length > 0) throw new Error(`Unknown case ID(s): ${unknown.join(", ")}`);
  return cases.filter(
    (testCase) =>
      (!filter.only?.length || filter.only.includes(testCase.id)) &&
      (!filter.category || testCase.category === filter.category),
  );
}
