import type { Judge } from "../agent/judge/index.js";
import type { MemoryContextTurn } from "./context.js";
import type { Embedder } from "./embeddings.js";
import type { FactArea } from "./areas.js";
import type { FactKind } from "./kinds.js";
import type { ActiveFact, MemoryStore, MessageRow } from "./store.js";

/**
 * The four moving parts of the memory in one place: database, decider,
 * embeddings, clock, plus the generative steps that cannot be a decider
 * (extraction, summary, consolidation and the selections for forgetting).
 *
 * Everything injectable, because the regression test from W8 does not work
 * otherwise: there the same code runs with a fake database, a fake judge and
 * a set clock over three days.
 */

export interface ExtractedFact {
  category: string;
  content: string;
  confidence: number;
  /** Kind (D39). The extraction sets it, the code checks it. */
  kind: FactKind;
  /** Checked validity as ISO instant, null means without a limit or already in effect. */
  validFrom: string | null;
  validUntil: string | null;
  /** Area for `show_memory` (package 2 of 2026-10-08). If missing, the maintenance classifies it later. */
  area?: FactArea | null;
}

export type FactExtractor = (input: {
  /** What the owner just wrote. Facts come only from this (D8.4). */
  text: string;
  /**
   * The turns before it, only for understanding. Without them a correction or
   * partial retraction cannot be resolved ("nah actually, now and then": what?).
   */
  context?: readonly MemoryContextTurn[];
  /** Categories that already exist, so that not every fact gets a new one. */
  knownCategories: readonly string[];
  /**
   * Instant of the message. "Until the end of August" and "from next month"
   * are resolved against it, in the prompt as a calendar day in the owner's
   * time zone (D39).
   */
  now: Date;
}) => Promise<ExtractedFact[]>;

export type Summarizer = (input: {
  messages: readonly MessageRow[];
  /** What is already stored as a fact anyway and therefore does not belong in the summary. */
  knownFacts: readonly string[];
}) => Promise<string>;

/** Which lines of the user model depend on what is to be forgotten? Returns 0-based indices (D40). */
export type LineSelector = (input: { what: string; facts: readonly string[]; lines: readonly string[] }) => Promise<number[]>;

/**
 * Which stored facts carry what is to be forgotten (addendum D45)? `index` is
 * 0-based. `rest` is the fact without the information if it contains
 * something else besides; null means delete entirely. Whether a rest is fit
 * is checked by the code.
 */
export type FactSelector = (input: { what: string; facts: readonly string[] }) => Promise<Array<{ index: number; rest: string | null }>>;

/**
 * The nightly consolidation as a model call (H1, D40). `learned` is in the
 * keyed format of `renderLearned` (`consolidate-rules.ts`), `outdatedBaseLines`
 * are 0-based.
 */
export type Consolidator = (input: {
  now: Date;
  baseLines: readonly string[];
  learned: string;
  added: readonly ActiveFact[];
  superseded: ReadonlyArray<{ old: string; replacement: string }>;
  expired: readonly ActiveFact[];
  summaries: readonly string[];
}) => Promise<{ learned: string; outdatedBaseLines: number[] }>;

/** Assigns facts to an area, in the same order; null means: fits nowhere with certainty. */
export type AreaClassifier = (input: { facts: readonly string[] }) => Promise<Array<FactArea | null>>;

export interface MemoryDeps {
  store: MemoryStore;
  judge: Judge;
  embed: Embedder;
  extractFacts: FactExtractor;
  summarize: Summarizer;
  selectLines: LineSelector;
  selectFacts: FactSelector;
  consolidate: Consolidator;
  classifyAreas: AreaClassifier;
  /**
   * Key for the markers for forgotten facts (D40), derived from
   * `SERAIN_INTEGRATION_KEY`. Without it there are no markers; deleting works
   * anyway.
   */
  markerKey: Buffer | null;
  /** Injectable clock. In production `() => new Date()`. */
  now: () => Date;
}
