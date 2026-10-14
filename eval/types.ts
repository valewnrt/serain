/**
 * Data formats of the eval harness (D3, PLAN phase 1). Everything here is pure
 * description: cases, results, run manifest. None of it knows an SDK or a
 * database.
 *
 * The suites come from D3: `chat` (30 turns, style), `tools` (tasks about
 * choosing tools), `dates` (10 date-critical fact questions). `judge` sits
 * next to them and measures memory decisions; see `eval/judge.ts`.
 */

import type { Thinking } from "../src/config/models.js";

export const SUITES = ["chat", "tools", "dates", "judge"] as const;
export type SuiteName = (typeof SUITES)[number];

/**
 * Roles from D3, plus `judge` from D12. The first three are `ModelRole` from
 * `src/config/models.ts`; `judge` is not a model role but a choice between
 * backends (`jev` or `generative`), and is therefore carried along here, not
 * there.
 */
export const ROLES = ["chat", "executor", "extraction", "judge"] as const;
export type RoleName = (typeof ROLES)[number];
/** The subset that can be pinned as a model with `ModelPin`. */
export type ModelRoleName = Exclude<RoleName, "judge">;

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
  /**
   * When the message was sent, relative to the run: that many calendar days
   * before, at this wall-clock time in the owner's time zone (`HH:MM`).
   * Without: just now. Fixed dates would not work, "tomorrow" depends on the
   * day of the run (finding 2026-10-09).
   */
  at?: { daysAgo: number; time: string };
  /** Serain wrote this after untrusted content: the write path only sees the placeholder (D8.4). */
  fromUntrusted?: boolean;
}

interface CaseBase {
  /** Stable, because baselines and the owner's choice depend on it. */
  id: string;
  /** Why this case is in the set. The owner sees it in the report. */
  note?: string;
}

// --- chat -------------------------------------------------------------------

export interface ChatCase extends CaseBase {
  input: string;
  history?: HistoryTurn[];
  /**
   * The language the reply must be in (BCP 47 base, `de`, `en`, `tr`):
   * Serain answers in the language the owner writes in. Without: the language
   * of `input` as the detector reads it; if that says nothing, the language
   * is not checked. Cases with a `speaker` always need it, because their input
   * is Serain's own English event text, not the owner's words.
   */
  language?: string;
  /**
   * A tapback alone would be the whole answer here ("danke dir", "ok").
   * A message is then no error, but a deduction.
   */
  tapbackSuffices?: boolean;
  /**
   * A real information question. Length mirroring does not apply here: to
   * "what's the difference between …" more than three words may come back.
   */
  infoRequest?: boolean;
  /**
   * A pure greeting. "hi" gets "hi": very short and without emoji, otherwise it
   * is the assistant introducing itself.
   */
  greeting?: boolean;
  /**
   * The owner explicitly asks about the technology. Then Serain may name
   * internal names, and has to answer honestly instead of claiming not to know.
   */
  technicalQuestion?: boolean;
  /**
   * An answer that may be detailed and therefore belongs in the thread of the
   * triggering message, in several bubbles.
   */
  longAnswer?: boolean;
  /**
   * Who speaks in `input`. Without: the owner. An event speaker replays a turn
   * Serain triggered itself, such as the result of a research task.
   */
  speaker?: string;
  /**
   * Memory block as production puts it before the message (`turnContext`).
   * Synthetic, never real facts of the owner: this way a turn can be replayed
   * that only the memory made go wrong.
   */
  memory?: string;
  /** Must not appear in the answer (case-insensitive). For "don't follow up". */
  notContains?: string[];
  /** Every group has to stand in the answer with at least one variant. */
  anyOf?: string[][];
  /**
   * Like `anyOf`, but only in the first line of the first message: the answer
   * comes first, the rest is optional (audit 2026-10-02, V8, candidate for the
   * next style round).
   */
  firstLineAnyOf?: string[][];
  /**
   * The turn has to set exactly one reminder, and its text has to be a
   * sentence that stands on its own: at least this many words, none of these
   * openers.
   */
  reminderText?: { minWords: number; notStartsWith?: string[] };
}

// --- tools ------------------------------------------------------------------

export interface Range {
  min: number;
  max: number;
}

export interface ToolsExpectation {
  messages?: Range;
  reactions?: Range;
  /** The turn has to end with `end_turn`. Default: yes. */
  endTurn?: boolean;
  /** The answer belongs in the thread of the triggering message. */
  threadReply?: boolean;
  /** These tools must not appear in this case. */
  forbiddenTools?: string[];
  /** The turn has to call these tools, each at least once. */
  requiredTools?: string[];
  /** These tapbacks have to be set, as emoji from the signal table (addendum to D23 of 2026-10-08). */
  reactionEmoji?: string[];
  /** One bubble has to carry exactly this text, nothing around it: a value to copy. */
  exactBubble?: string;
  /** The first message starts with this sentence (case-insensitive): fixed wording from the code. */
  firstMessageStartsWith?: string;
  /** A call of this tool carries at least one of the variants in its arguments (case-insensitive). */
  toolArgsAnyOf?: { tool: string; anyOf: string[] };
}

/** A mail in the mock mailbox of a case. Synthetic, never from the owner's mailbox. */
export interface EvalMail {
  from: string;
  subject: string;
  text: string;
  /** Arrived that many days before the run. */
  daysAgo: number;
}

export interface ToolsCase extends CaseBase {
  input: string;
  history?: HistoryTurn[];
  /**
   * With a mailbox: the turn gets the real mail tools over a mailbox in
   * memory, and the prompt says that mail is connected. Without: no mail.
   */
  mailbox?: EvalMail[];
  /**
   * With web: `run_task` is available, and the prompt says that research
   * works. Nothing is started; only what the turn does and says up to then is measured.
   */
  web?: boolean;
  /** With watchers: `watch_create` over a store in the process, rates from a fixed answer. */
  watch?: boolean;
  /** With `compute`, but without a sandbox: measured is whether the turn has things calculated. */
  compute?: boolean;
  /** Memory block as in chat cases, synthetic. */
  memory?: string;
  expect: ToolsExpectation;
}

// --- dates ------------------------------------------------------------------

export interface DatesExpectation {
  /**
   * Every group has to stand in the answer with at least one of its variants.
   * Groups, because "Freitag" and "freitag" and "Fr" mean the same.
   */
  anyOf?: string[][];
  /** Must not appear. Catches the typical miscalculation. */
  notContains?: string[];
  /**
   * Expects an honest "I don't know" instead of an invented answer
   * (D3: everything after the knowledge cutoff).
   */
  admitsUnknown?: boolean;
}

export interface DatesCase extends CaseBase {
  input: string;
  expect: DatesExpectation;
}

// --- judge ------------------------------------------------------------------

/**
 * Typed question to the memory judge. Three forms, D6 needs no more:
 * "worth remembering?" (boolean), "replaces which fact?" (choice), "how
 * important?" (score).
 */
export type JudgeQuestion =
  | {
      kind: "boolean";
      /** Own wording. Not needed with `gate`, then the question comes from production. */
      prompt?: string;
      /**
       * This case measures the memory gate (D13). Question and frame then come
       * verbatim from `src/memory/write.ts`: a suite that measures a rebuilt
       * question ranks a wording that stands nowhere in production.
       */
      gate?: boolean;
    }
  | { kind: "choice"; prompt: string; options: Array<{ id: string; text: string }> }
  | {
      kind: "score";
      prompt: string;
      min: number;
      max: number;
      /** Label per level, ascending. The judge judges words, not numbers. */
      scale?: string[];
    };

export type JudgeAnswer =
  | { kind: "boolean"; value: boolean }
  | { kind: "choice"; value: string | null }
  | { kind: "score"; value: number };

/**
 * The raw answer of the `judge` role, before a threshold was put on it.
 *
 * The reason it is recorded: the gate threshold in `src/config/memory.ts` is a
 * number one can move, and the question "what happens at 0.4 instead of 0.6?"
 * should be answerable without repeating the run and its money. A
 * `true`/`false` in the result can't do that.
 */
export interface JudgeRawAnswer {
  /** Which backend really answered: after a fallback that is not the primary one. */
  backend: JudgeBackendName;
  /** Only with `boolean`: P(yes), between 0 and 1. */
  probability?: number;
  /** Only with `choice`: the chosen key. */
  choice?: string;
  /** Only with `score`: expected value on production's 0-based scale. */
  score?: number;
  /** Distribution as the backend delivered it. Empty with `boolean`. */
  probabilities?: Record<string, number>;
  confidence?: number;
}

/**
 * How generously to compare. `exact` for boolean, `alsoOk` for choices with
 * more than one defensible answer, `plusMinus` for scores.
 */
export type JudgeTolerance =
  | { kind: "exact" }
  | { kind: "alsoOk"; ids: Array<string | null> }
  | { kind: "plusMinus"; value: number };

export interface JudgeCase extends CaseBase {
  /** The chat message in question. German, lowercase, slang, the way the test owner writes. */
  message: string;
  /**
   * The entries before it, oldest first. Without them a correction or partial
   * retraction is no borderline case but a sentence without reference, and that
   * is exactly where the gate failed on 2026-09-18.
   */
  history?: HistoryTurn[];
  /** What else the judge knows (known facts, point in time). */
  context?: string;
  question: JudgeQuestion;
  expected: JudgeAnswer;
  tolerance: JudgeTolerance;
}

export type EvalCase = ChatCase | ToolsCase | DatesCase | JudgeCase;

export interface SuiteData {
  suite: SuiteName;
  /** Where the cases came from. For `chat` either "repo" or "local". */
  source: string;
  cases: EvalCase[];
}

// --- Candidates -------------------------------------------------------------

/** Backends of the judge role (D12). Mirrored from `src/config/models.ts`. */
export type JudgeBackendName = "jev" | "generative";

export interface Candidate {
  /** Stable key, e.g. "chat:or:kimi-k2". Stands in the result and the baseline. */
  id: string;
  role: RoleName;
  provider: "subscription" | "openrouter";
  /** Model ID at the provider. Only informative for role `judge`. */
  model: string;
  /** What the owner calls it, for the reveal after the blind choice. */
  label: string;
  /**
   * Only for role `judge`: the backend order this candidate runs. The judge
   * role chooses no model but a decider plus fallback.
   */
  judgeBackends?: readonly JudgeBackendName[];
  /** Thinking on the Claude path (D50). Without: the one from the role config. */
  thinking?: Thinking;
}

// --- Results -------------------------------------------------------------

export interface CheckResult {
  id: string;
  passed: boolean;
  detail?: string;
}

/** What really happened in the turn. The fake port records it. */
export interface TurnRecord {
  messages: Array<{ text: string; kind: string; replyTo?: string }>;
  reactions: Array<{ messageId: string; emoji: string }>;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; ok: boolean }>;
  unknownTools: string[];
  usedTextFallback: boolean;
  stopReason: string | null;
  steps: number;
}

export interface CaseRun {
  caseId: string;
  suite: SuiteName;
  /** What the model got. Makes `results.json` and the report self-contained. */
  input: string;
  note?: string;
  /** Blind name (A, B, C …). Only that stands in `results.json` and in the report. */
  alias: string;
  /** Real candidate. Removed when writing and kept only in `key.json`. */
  candidateId: string;
  ok: boolean;
  /** Set when the turn itself failed (rate limit, network, budget). */
  error?: string;
  record?: TurnRecord;
  /** Only in the `judge` suite: the distribution before the threshold. */
  judge?: JudgeRawAnswer;
  checks: CheckResult[];
  costUsd: number;
  latencyMs: number;
}

export interface RunManifest {
  runId: string;
  startedAt: string;
  suites: SuiteName[];
  candidateIds: string[];
  capUsd: number;
  spentUsd: number;
  /** Set when the run was aborted at the cap. */
  abortedAt?: string;
}

/**
 * The result as it goes to disk: without the candidate name. Whoever opens
 * `results.json` sees A, B, C and nothing else.
 */
export type StoredCaseRun = Omit<CaseRun, "candidateId">;

/** The resolution of the blind names. Kept apart from the report and the results. */
export interface RunKey {
  runId: string;
  /** Blind name (A, B, C …) → candidate. */
  aliases: Record<string, Candidate>;
}

/** The owner's choice per case. Blind name, not candidate. */
export interface ChoiceFile {
  runId: string;
  /** Case ID → blind name, or null for "neither of them". */
  choices: Record<string, string | null>;
}
