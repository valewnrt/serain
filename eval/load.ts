import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { baseLanguage } from "../src/i18n/language.js";
import { LOCAL_CHAT_FILE } from "./config.js";
import { datesCases } from "./cases/dates.js";
import type { ChatCase, DatesCase, JudgeCase, SuiteData, SuiteName, ToolsCase } from "./types.js";

/**
 * Loads the case sets. One rule governs everything here:
 *
 * **The owner's real chat turns never go into the repo.** The `chat` suite therefore
 * reads `data/eval/chat.local.json` first (`data/` is in `.gitignore`) and
 * falls back to the synthetic turns in the repo (German, English and language switches). The report says
 * every time which source was used, so that nobody mistakes a run on
 * artificial language for a run on the owner's language.
 *
 * `pnpm eval:export-chat` fills the local file from Supabase.
 */

function repoPath(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected a list`);
  return value;
}

/** Minimal check so that a typo in the case data does not only show up during the run. */
function requireStringField(row: unknown, field: string, what: string): string {
  const value = (row as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${what}: field "${field}" is missing or empty`);
  }
  return value;
}

function requireUniqueIds(cases: ReadonlyArray<{ id: string }>, what: string): void {
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) throw new Error(`${what}: duplicate case ID "${item.id}"`);
    seen.add(item.id);
  }
}

export function parseChatCases(raw: unknown, what: string): ChatCase[] {
  const cases = asArray(raw, what).map((row) => {
    const id = requireStringField(row, "id", what);
    requireStringField(row, "input", what);
    const record = row as Record<string, unknown>;
    const language = record["language"];
    // A base language `Intl` knows, so the check compares like with like (`de`, not `de-DE`).
    if (language !== undefined && (typeof language !== "string" || baseLanguage(language) !== language)) {
      throw new Error(`${what}: case "${id}" has no base language tag in "language" (e.g. de, en, tr)`);
    }
    // An event case's input is Serain's own English text: the owner's language has to be named.
    if (record["speaker"] !== undefined && language === undefined) {
      throw new Error(`${what}: case "${id}" has a speaker but no "language"`);
    }
    return row as ChatCase;
  });
  requireUniqueIds(cases, what);
  return cases;
}

export function parseToolsCases(raw: unknown, what: string): ToolsCase[] {
  const cases = asArray(raw, what).map((row) => {
    requireStringField(row, "id", what);
    requireStringField(row, "input", what);
    const expect = (row as Record<string, unknown>)["expect"];
    if (!expect || typeof expect !== "object") {
      throw new Error(`${what}: case without "expect"`);
    }
    return row as ToolsCase;
  });
  requireUniqueIds(cases, what);
  return cases;
}

export function parseJudgeCases(raw: unknown, what: string): JudgeCase[] {
  const cases = asArray(raw, what).map((row) => {
    requireStringField(row, "id", what);
    requireStringField(row, "message", what);
    const record = row as Record<string, unknown>;
    const question = record["question"] as
      | { kind?: string; prompt?: string; gate?: boolean }
      | undefined;
    const expected = record["expected"] as { kind?: string } | undefined;
    if (!question?.kind || !expected?.kind) {
      throw new Error(`${what}: case "${String(record["id"])}" without question.kind or expected.kind`);
    }
    // A boolean question needs either its own wording or the
    // `gate` flag, which fetches the question from production. Forgetting both
    // would otherwise only show up during the run, in the middle of a paid call.
    if (question.kind === "boolean" && !question.prompt && question.gate !== true) {
      throw new Error(
        `${what}: case "${String(record["id"])}" is boolean without "prompt" and without "gate": true`,
      );
    }
    if (question.kind !== expected.kind) {
      throw new Error(
        `${what}: case "${String(record["id"])}" asks ${question.kind} but expects ${expected.kind}`,
      );
    }
    if (!record["tolerance"]) {
      throw new Error(`${what}: case "${String(record["id"])}" without tolerance`);
    }
    return row as JudgeCase;
  });
  requireUniqueIds(cases, what);
  return cases;
}

export interface LoadOptions {
  /** Lets tests use a different local file. */
  localChatFile?: string;
  /** Reference time for the `dates` suite. Default: now. */
  now?: Date;
}

/**
 * The style cases from the repo. They **always** run along, even when there are
 * real turns from the owner: they check the rules from the style step (W2, W19,
 * W20, W21) specifically, and whether the owner's real history happens to contain a
 * tech question or a bare greeting is no criterion. Synthetic and
 * therefore harmless in the repo.
 */
function styleCases(): ChatCase[] {
  const path = repoPath("eval/cases/chat.style.json");
  return parseChatCases(readJson(path), path);
}

export function loadChatSuite(options: LoadOptions = {}): SuiteData {
  const style = styleCases();
  const local = repoPath(options.localChatFile ?? LOCAL_CHAT_FILE);
  try {
    const cases = parseChatCases(readJson(local), local);
    if (cases.length > 0) {
      const merged = [...cases, ...style];
      requireUniqueIds(merged, "chat suite");
      return { suite: "chat", source: `local (${local}) + style cases (repo)`, cases: merged };
    }
  } catch (error) {
    // Only a missing file is normal. Broken JSON would be a silent
    // fallback to the synthetic cases, and exactly that should stand out.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  const fallback = repoPath("eval/cases/chat.fallback.json");
  const merged = [...parseChatCases(readJson(fallback), fallback), ...style];
  requireUniqueIds(merged, "chat suite");
  return { suite: "chat", source: "repo (synthetic) + style cases (repo)", cases: merged };
}

export function loadSuite(suite: SuiteName, options: LoadOptions = {}): SuiteData {
  switch (suite) {
    case "chat":
      return loadChatSuite(options);
    case "tools": {
      const path = repoPath("eval/cases/tools.json");
      return { suite, source: "repo", cases: parseToolsCases(readJson(path), path) };
    }
    case "dates": {
      const cases: DatesCase[] = datesCases(options.now ?? new Date());
      requireUniqueIds(cases, "eval/cases/dates.ts");
      return { suite, source: "repo (computed per day)", cases };
    }
    case "judge": {
      const path = repoPath("eval/cases/judge.json");
      return { suite, source: "repo", cases: parseJudgeCases(readJson(path), path) };
    }
  }
}
