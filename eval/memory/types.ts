import { z } from "zod";

/**
 * Types and load validation of the memory eval (H4, blueprint in
 * `docs/research/memory-eval-benchmarks.md`, section 3).
 *
 * A case follows "ground truth first": first comes the truth (which facts
 * hold, from when, until when, what replaces what), the messages are
 * written from it, and the checks from those. The truth is not compared against
 * the store automatically (free-text facts cannot be mapped deterministically
 * onto a truth ID); it is the reasoning every check comes from,
 * and it stands in the case so that a reader can hold the check against it.
 *
 * This file knows neither database nor model: the unit test loads and checks
 * the cases without network.
 */

export const CATEGORIES = [
  "abruf",
  "zusammenfuehren",
  "update",
  "gueltigkeit",
  "vergessen",
  "schreibgate",
  "enthaltung",
  "personalisierung",
  "urheberschaft",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** The same four kinds as `facts_kind_check` in `0009_fact_kinds.sql`. */
export const FACT_KINDS = ["identity", "preference", "situation", "episode"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export type Level = 1 | 2 | 3;

/**
 * Placeholder in `anyOf`: "Serain admits not knowing", in German and English. One list in
 * one place instead of anew in every abstention case, otherwise every case measures a
 * different definition of "I don't know".
 */
export const UNKNOWN_MACRO = "@unbekannt";
export const UNKNOWN_VARIANTS = [
  "weiß ich nicht",
  "weiss ich nicht",
  "weiß ich leider nicht",
  "keine ahnung",
  "hast du mir nicht",
  "hast du mir nie",
  "nicht erzählt",
  "nicht gesagt",
  "nie gesagt",
  "kenn ich nicht",
  "kenne ich nicht",
  "hab ich nicht",
  "habe ich nicht",
  "nicht gespeichert",
  "nichts gespeichert",
  "sagt mir nichts",
  "erinner mich nicht",
  "erinnere mich nicht",
  "keine info",
  "weiß ich gerade nicht",
  "weiß ich grad nicht",
  "hab ich keine",
  "habe ich keine",
  "nicht bekannt",
  "nicht sicher",
  // Added after the first run: two clear abstentions ("weiß ich gar
  // nicht", "hab keinen hausarzt von dir gespeichert") fell through the list.
  // That is a fault of the rule, not of the answer; the list describes
  // abstention, not a particular wording.
  "weiß ich gar nicht",
  "weiss ich gar nicht",
  "hab keinen",
  "habe keinen",
  "hab nichts",
  "habe nichts",
  "nichts dazu",
  // English, so a case for an English-speaking owner measures the same thing.
  "i don't know",
  "i don't remember",
  "no idea",
  "you never told me",
  "you haven't told me",
  "didn't tell me",
  "not saved",
  "nothing saved",
  "haven't saved",
  "don't have that",
  "not sure",
] as const;

function compiles(source: string): boolean {
  try {
    new RegExp(source, "i");
    return true;
  } catch {
    return false;
  }
}

/** Instant with time of day and offset. Without an offset "tomorrow" would be a different day depending on the machine. */
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/, "expected an instant with offset")
  .refine((value) => !Number.isNaN(Date.parse(value)), "not a valid instant");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a date YYYY-MM-DD");
const pattern = z.string().min(1).refine(compiles, "regex does not compile");

export const truthFactSchema = z
  .object({
    id: z.string().min(1),
    content: z.string().min(1),
    kind: z.enum(FACT_KINDS),
    validFrom: day.optional(),
    validUntil: day.optional(),
    /** This truth replaces an earlier one (ID from the same list). */
    supersedes: z.string().optional(),
    /** The owner has it deleted in the script. */
    forgotten: z.boolean().optional(),
    /** Only in the case as a distractor or a third party's statement: must not become a fact about the owner. */
    notAboutOwner: z.boolean().optional(),
  })
  .strict();

export const scriptMessageSchema = z
  .object({
    at: instant,
    from: z.enum(["owner", "serain"]),
    text: z.string().min(1),
    /**
     * This message is a delete instruction. The value is the `what` the real
     * tool `forget_fact` is called with, the way the model would phrase it from
     * the owner's words. The write path then does not run for this
     * message, as in production (`factExtractionBlocked`).
     */
    forget: z.string().min(3).max(300).optional(),
    /**
     * The owner's answer to the follow-up question if `forget_fact` is ambiguous: the
     * pattern picks among the returned candidates, namely all that
     * match ("vergiss das mit den tabletten" means every fact about it). In
     * production the model asks back, the owner answers, the model calls the tool
     * again with `fact_id` for each fact meant; these calls run
     * the same way here. Without a pattern it stays at the follow-up question, and nothing is
     * deleted.
     */
    forgetPick: pattern.optional(),
  })
  .strict()
  .refine((message) => message.forget === undefined || message.from === "owner", {
    message: "only the owner can have something forgotten",
  })
  .refine((message) => message.forgetPick === undefined || message.forget !== undefined, {
    message: "forgetPick only together with forget",
  });

const seedSchema = z
  .object({
    /** A row in `user_model_versions` (source `seed`), older than every message. */
    userModel: z.object({ base: z.string().min(1), learned: z.string().default("") }).strict().optional(),
    summaries: z
      .array(z.object({ windowStart: instant, windowEnd: instant, content: z.string().min(1) }).strict())
      .default([]),
    /** Existing facts before the script, mostly distractors. They get real embeddings. */
    facts: z
      .array(z.object({ category: z.string().min(1), content: z.string().min(1), at: instant }).strict())
      .default([]),
  })
  .strict();

const v2Flag = { needsV2: z.boolean().optional(), note: z.string().optional() };

export const stateCheckSchema = z.discriminatedUnion("type", [
  /** An active (not superseded) fact matches the pattern. */
  z.object({ type: z.literal("fact_present"), pattern, ...v2Flag }).strict(),
  /**
   * No active fact matches the pattern. `allowIf`: facts that additionally match
   * it are allowed (e.g. "Jonas zieht nach Talwies" may stay, "Alex
   * zieht nach Talwies" may not). `includeSuperseded`: superseded facts count too.
   */
  z
    .object({
      type: z.literal("fact_absent"),
      pattern,
      allowIf: pattern.optional(),
      includeSuperseded: z.boolean().default(false),
      ...v2Flag,
    })
    .strict(),
  /** A fact with the pattern exists and is superseded (`superseded_by` set), no active one matches any more. */
  z.object({ type: z.literal("superseded"), pattern, ...v2Flag }).strict(),
  /** At most this many active facts outside the seeds. For the write gate. */
  z.object({ type: z.literal("fact_count"), max: z.number().int().min(0), ...v2Flag }).strict(),
  /** The active fact with the pattern has this kind. Needs V2. */
  z.object({ type: z.literal("kind"), pattern, kind: z.enum(FACT_KINDS), ...v2Flag }).strict(),
  /** `valid_until` of the active fact lies within ±3 days of the date, `null` means: no expiry. Needs V2. */
  z.object({ type: z.literal("valid_until"), pattern, date: day.nullable(), ...v2Flag }).strict(),
  /** Like `valid_until`, for the start. */
  z.object({ type: z.literal("valid_from"), pattern, date: day.nullable(), ...v2Flag }).strict(),
  /** The word is in no layer any more: facts (superseded ones too), summaries, user model, follow-up questions. */
  z.object({ type: z.literal("sentinel_absent"), sentinel: z.string().min(3), ...v2Flag }).strict(),
]);

export const recallCheckSchema = z.discriminatedUnion("type", [
  /** A fact with the pattern is in the top k of `search_facts` at time `at`. */
  z
    .object({
      type: z.literal("recall"),
      at: instant,
      query: z.string().min(1),
      pattern,
      k: z.array(z.number().int().min(1).max(12)).min(1).default([5, 12]),
      ...v2Flag,
    })
    .strict(),
  /** No fact with the pattern is among the first k. */
  z
    .object({
      type: z.literal("absence"),
      at: instant,
      query: z.string().min(1),
      pattern,
      k: z.number().int().min(1).max(12).default(3),
      ...v2Flag,
    })
    .strict(),
]);

export const answerSchema = z
  .object({
    at: instant,
    question: z.string().min(1),
    /** Every group must appear with at least one variant. `@unbekannt` stands for the abstention list. */
    anyOf: z.array(z.array(z.string().min(1)).min(1)).default([]),
    /** None of these may appear. */
    notContains: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine((answer) => answer.anyOf.length + answer.notContains.length > 0, {
    message: "an answer check needs at least one rule",
  });

export const memoryCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z]+-\d{2}$/, "ID like abruf-01"),
    category: z.enum(CATEGORIES),
    /** Not for tuning: whoever adjusts prompts does not look at these cases. */
    holdout: z.boolean(),
    /** Counter-check of the category: here the opposite of the main claim is correct. */
    negative: z.boolean().default(false),
    note: z.string().min(1),
    truth: z.array(truthFactSchema),
    seed: seedSchema.default({ summaries: [], facts: [] }),
    script: z.array(scriptMessageSchema).min(1),
    state: z.array(stateCheckSchema).default([]),
    recall: z.array(recallCheckSchema).default([]),
    answer: answerSchema.optional(),
  })
  .strict();

export type TruthFact = z.infer<typeof truthFactSchema>;
export type ScriptMessage = z.infer<typeof scriptMessageSchema>;
export type StateCheck = z.infer<typeof stateCheckSchema>;
export type RecallCheck = z.infer<typeof recallCheckSchema>;
export type AnswerSpec = z.infer<typeof answerSchema>;
export type MemoryCase = z.infer<typeof memoryCaseSchema>;

/** Checks that can only pass with fact kind and validity (V2). */
export const V2_STATE_TYPES: ReadonlySet<StateCheck["type"]> = new Set(["kind", "valid_until", "valid_from"]);

// --- Results -----------------------------------------------------------------

export interface CheckResult {
  /** Stable across runs, so that `--repeat` and before/after add up. */
  id: string;
  level: Level;
  /** Kind of check, e.g. `fact_present`, `recall@5`, `sentinel:user_model`, `answer`. */
  kind: string;
  needsV2: boolean;
  passed: boolean;
  detail?: string;
}

/** What the write path did with a script message. From the result and the audit stream. */
export interface MessageTrace {
  at: string;
  from: "owner" | "serain";
  text: string;
  gate?: number;
  gateKept?: boolean;
  stored: string[];
  superseded: number;
  conflicts: number;
  decisions: string[];
  forget?: {
    what: string;
    ok: boolean;
    text: string;
    /** The tool asked back instead of deleting. */
    ambiguous: boolean;
    /** What the owner chose in answer to the follow-up question, if the case prescribes a choice. */
    picked?: string[];
  };
  error?: string;
}

export interface FactRowSnapshot {
  id: string;
  category: string;
  content: string;
  kind: string;
  validFrom: string | null;
  validUntil: string | null;
  supersededBy: string | null;
  createdAt: string;
  seeded: boolean;
}

export interface MemorySnapshot {
  facts: FactRowSnapshot[];
  summaries: string[];
  userModels: Array<{ base: string; learned: string; source: string }>;
  openQuestions: string[];
}

export interface UsageTotals {
  calls: Array<{ provider: string; role: string; model: string; count: number; inputTokens: number; outputTokens: number; costUsd: number }>;
  openrouterUsd: number;
  embeddingChars: number;
  fallbacks: number;
  unexpectedDbAccess: string[];
}

export interface CaseResult {
  caseId: string;
  category: Category;
  holdout: boolean;
  negative: boolean;
  iteration: number;
  control: boolean;
  ok: boolean;
  error?: string;
  checks: CheckResult[];
  trace: MessageTrace[];
  answer?: { question: string; text: string; tools: string[]; stopReason: string | null };
  snapshot?: MemorySnapshot;
  usage: UsageTotals;
  durationMs: number;
}

export interface MemoryRunManifest {
  runId: string;
  startedAt: string;
  finishedAt: string;
  levels: Level[];
  repeat: number;
  concurrency: number;
  control: "none" | null;
  capUsd: number;
  caseIds: string[];
  usage: UsageTotals;
  /** Estimate from the counted characters, to compare with the reported cost. */
  embeddingEstimateUsd: number;
  abortedAt?: string;
}
