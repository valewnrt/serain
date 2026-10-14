import { db } from "../db/client.js";
import { activeFacts as activeFactRows } from "./facts.js";
import { areaFromStored, storedAreaKeys, type FactArea } from "./areas.js";
import type { FactKind } from "./kinds.js";
import * as proposalRows from "./proposal-store.js";
import type {
  NewProcedure,
  NewProposal,
  ProcedureHit,
  ProcedureSearch,
  ProposalKind,
  ProposalStatus,
  StoredProcedure,
  StoredProposal,
} from "./proposal-store.js";
import {
  activeUserModel,
  addForgottenMarker,
  deleteUserModelVersions,
  forgottenMarkers,
  insertUserModelVersion,
  userModel,
  userModelVersions,
  type NewUserModelVersion,
  type UserModelVersion,
} from "./user-model.js";

/**
 * Everything the memory does against the database, behind one interface.
 *
 * Not a matter of taste: the regression test from W8 has to set a fact,
 * correct it twice, fast-forward three days and then check what lands in the
 * context. With a real database that would be an integration test writing to
 * production data. With this seam it is a normal unit test with an injected
 * clock.
 */

/** Kind and validity (V2, D39). `validUntil` is exclusive: from this point on the fact no longer holds. */
export interface FactValidity {
  kind: FactKind;
  validFrom: string | null;
  validUntil: string | null;
}

export interface StoredFact extends FactValidity {
  id: string;
  subject: string;
  category: string;
  content: string;
  confidence: number;
  sourceMessageId: string | null;
  supersededBy: string | null;
  createdAt: string;
  /** Area for `show_memory`; null until maintenance has classified it. */
  area: FactArea | null;
}

/**
 * An active fact as `show_memory`, classification and consolidation see it. Expired ones are included.
 * Source and time are the provenance (D6): with a message the owner said it, without one it came from the seed.
 */
export type ActiveFact = Pick<
  StoredFact,
  "id" | "category" | "content" | "confidence" | "kind" | "validFrom" | "validUntil" | "area" | "sourceMessageId" | "createdAt"
>;

export interface FactCandidate extends FactValidity {
  id: string;
  category: string;
  content: string;
  confidence: number;
  sourceMessageId: string | null;
  createdAt: string;
  /** Cosine similarity, 0 if the hit came only from full-text search. */
  similarity: number;
  /** Rank fusion of vector and full-text search. Sort key. */
  score: number;
  /** Did full-text search hit? Then the fact counts even with a weak vector (D45). */
  textHit: boolean;
}

/**
 * A fact for the context, without search scores: what holds right now and what a playbook
 * needs (memory package of 2026-10-10). Every search hit is one too.
 */
export type ContextFact = Pick<
  FactCandidate,
  "id" | "category" | "content" | "confidence" | "sourceMessageId" | "createdAt" | "kind" | "validFrom" | "validUntil"
>;

/** What holds right now (`active_situations`, 0028). Timestamps as ISO. */
export interface SituationQuery {
  subject: string;
  now: string;
  /** Situations starting up to this point already count (`MEMORY.situationLeadDays`). */
  startsBefore: string;
  /** Situations without an end only count if they were said since then (`MEMORY.situationFreshDays`). */
  freshSince: string;
  limit: number;
}

/** Facts from areas, for an injected playbook (`area_facts`, 0028). */
export interface AreaFactQuery {
  subject: string;
  areas: readonly FactArea[];
  /** Kinds that fall into these areas when no area is stored (`kindsFallingInto`). */
  kinds: readonly FactKind[];
  /** Message as a vector; without one only keywords and age count. */
  embedding: number[] | null;
  /** The playbook's keywords, compared unstemmed through the full-text configuration `public.serain_text` (simple plus English and German stop words, migration 0035). */
  terms: string;
  now: string;
  limit: number;
}

export interface NewFact extends FactValidity {
  /** Empty if not given; maintenance classifies it later. */
  area?: FactArea | null;
  subject: string;
  category: string;
  content: string;
  confidence: number;
  sourceMessageId: string | null;
  embedding: number[] | null;
  createdAt: string;
}

export interface OpenQuestion {
  id: string;
  question: string;
  factId: string;
  rivalFactId: string;
  importance: number;
  status: "open" | "asked" | "resolved";
  createdAt: string;
}

export interface NewOpenQuestion {
  question: string;
  factId: string;
  rivalFactId: string;
  importance: number;
  createdAt: string;
}

export interface SummaryRow {
  id: string;
  windowStart: string;
  windowEnd: string;
  content: string;
  messageCount: number;
  /** Only for `similarSummaries`: cosine similarity to the message. */
  similarity?: number;
}

export interface NewSummary {
  windowStart: string;
  windowEnd: string;
  content: string;
  messageCount: number;
  embedding: number[] | null;
}

export interface MessageRow {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  createdAt: string;
  /** Serain's message from a turn with untrusted content (D8.4). Goes into no summary. */
  fromUntrusted: boolean;
}

/** What has changed in the facts since the last consolidation run (H1, D40). */
export interface FactChanges {
  /** New and still active. */
  added: ActiveFact[];
  /** Superseded: old version and the one that replaced it. */
  superseded: Array<{ old: string; replacement: string }>;
  /** Expired since then (`valid_until` between cursor and now). */
  expired: ActiveFact[];
}

/** State of the nightly consolidation in `agent_state`. */
export interface ConsolidationState {
  /** Day of the last run in the owner's time zone, with or without a model. */
  lastRunDay: string | null;
  /** Facts and summaries are consolidated up to here. */
  cursor: string | null;
}

/** A hit from the owner's history (V3, D41). */
export interface HistoryHit {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  createdAt: string;
  /** Empty means clean; otherwise derived from untrusted content and to be framed as such (D8.4). */
  taintSources: string[];
  similarity: number;
  score: number;
}

export interface ForgetResult {
  deletedIds: string[];
  /** Only categories, never contents: the audit log records THAT something was deleted. */
  categories: string[];
  summariesDeleted: number;
}

export interface MemoryStore {
  /** The active user model, rendered (base text plus learned). */
  userModel(): Promise<string>;
  activeUserModel(): Promise<UserModelVersion | null>;
  /** Newest first. */
  userModelVersions(): Promise<UserModelVersion[]>;
  insertUserModelVersion(version: NewUserModelVersion): Promise<UserModelVersion>;
  deleteUserModelVersions(ids: readonly string[]): Promise<void>;
  forgottenMarkers(): Promise<string[][]>;
  addForgottenMarker(hmacs: readonly string[]): Promise<void>;
  factChangesSince(cursor: string, now: string, subject?: string): Promise<FactChanges>;
  summariesSince(cursor: string): Promise<SummaryRow[]>;
  consolidationState(): Promise<ConsolidationState>;
  saveConsolidationState(state: ConsolidationState): Promise<void>;
  /** All non-superseded facts, expired ones too: the caller decides what to filter. */
  activeFacts(subject?: string): Promise<ActiveFact[]>;
  /** Active facts without an area, oldest first (package 2 of 2026-10-08). */
  unclassifiedFacts(limit: number): Promise<Array<{ id: string; content: string }>>;
  setFactAreas(updates: ReadonlyArray<{ id: string; area: FactArea }>): Promise<void>;
  /**
   * Wording of all facts, superseded ones too. Only for the summary: what is
   * already stored as a fact (and all the more what has been corrected before)
   * must not wander back into the context via a summary (W8).
   */
  allFactContents(subject?: string): Promise<string[]>;
  searchFacts(input: FactSearch): Promise<FactCandidate[]>;
  /** Situations that hold now (or shortly), newest first. Only the owner's own facts (`subject`). */
  activeSituations(input: SituationQuery): Promise<ContextFact[]>;
  /** Facts from areas, by keywords, then closeness to the message, then age. */
  areaFacts(input: AreaFactQuery): Promise<ContextFact[]>;
  insertFact(fact: NewFact): Promise<StoredFact>;
  supersedeFact(oldId: string, newId: string, at: string): Promise<void>;
  /**
   * A fact expires at a point in time instead of being replaced right away: "vegan
   * from November" ends "eats meat" only in November (D39).
   */
  expireFactAt(id: string, until: string, at: string): Promise<void>;
  forgetFact(id: string): Promise<ForgetResult>;
  addOpenQuestion(question: NewOpenQuestion): Promise<OpenQuestion | null>;
  nextOpenQuestion(): Promise<OpenQuestion | null>;
  markQuestionAsked(id: string, at: string): Promise<void>;
  recentSummaries(limit: number): Promise<SummaryRow[]>;
  /** Older summaries by closeness to the message, all before `before` (V3). */
  similarSummaries(embedding: number[], limit: number, before: string | null): Promise<SummaryRow[]>;
  searchMessages(input: { peer: string; embedding: number[] | null; query: string; limit: number; from?: string; to?: string }): Promise<HistoryHit[]>;
  /** Messages with text but without a vector: the post-turn pass catches up on them (V3). */
  messagesWithoutEmbedding(limit: number): Promise<Array<{ id: string; body: string }>>;
  setMessageEmbedding(id: string, embedding: number[]): Promise<void>;
  lastSummaryEnd(): Promise<string | null>;
  messagesAfter(cursor: string | null, limit: number): Promise<MessageRow[]>;
  insertSummary(summary: NewSummary): Promise<void>;

  // Proposals the owner confirms, and approved procedures (V5, H5, D42).
  insertProposal(proposal: NewProposal): Promise<StoredProposal>;
  /** Oldest first. */
  proposals(filter: { kind: ProposalKind; statuses: readonly ProposalStatus[]; limit?: number }): Promise<StoredProposal[]>;
  /** All proposals of one question, in any status, oldest first: the order is the numbering. */
  proposalsByOffer(offerExternalId: string): Promise<StoredProposal[]>;
  markProposalsOffered(ids: readonly string[], offerExternalId: string, at: string): Promise<void>;
  /** Atomic: only an `offered` proposal changes. Otherwise false. */
  decideProposal(id: string, status: "accepted" | "rejected", at: string): Promise<boolean>;
  clearProposalBody(ids: readonly string[]): Promise<void>;
  /** Sets unanswered proposals asked before `before` to `expired` and returns their IDs. */
  expireOffers(before: string, at: string): Promise<string[]>;
  lastOfferAt(kind: ProposalKind): Promise<string | null>;
  procedures(): Promise<StoredProcedure[]>;
  insertProcedure(procedure: NewProcedure): Promise<StoredProcedure>;
  searchProcedures(input: ProcedureSearch): Promise<ProcedureHit[]>;
  /** Hard delete, together with the proposal the procedure came from. False if it did not exist. */
  deleteProcedure(id: string): Promise<boolean>;
}

const CONSOLIDATION_KEY = "memory_consolidation";

export interface FactSearch {
  subject: string;
  embedding: number[] | null;
  query: string;
  limit: number;
  /** Clock of the recall: what expired before it no longer comes back (D39). */
  now: string;
  /** Also find expired facts, for `forget_fact`: forgetting always works. */
  includeExpired?: boolean;
}

const FACT_COLUMNS =
  "id, subject, category, content, confidence, source_message_id, superseded_by, created_at, kind, valid_from, valid_until, area";

interface FactDbRow {
  id: string;
  subject: string;
  category: string;
  content: string;
  confidence: number;
  source_message_id: string | null;
  superseded_by: string | null;
  created_at: string;
  kind: FactKind;
  valid_from: string | null;
  valid_until: string | null;
  /** As stored: a current or a legacy key (`areaFromStored`). */
  area: string | null;
}

function toStoredFact(row: FactDbRow): StoredFact {
  return {
    id: row.id,
    subject: row.subject,
    category: row.category,
    content: row.content,
    confidence: row.confidence,
    sourceMessageId: row.source_message_id,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    kind: row.kind,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    area: areaFromStored(row.area),
  };
}

function toContextFact(row: Pick<FactDbRow, "id" | "category" | "content" | "confidence" | "source_message_id" | "created_at" | "kind" | "valid_from" | "valid_until">): ContextFact {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    confidence: row.confidence,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    kind: row.kind,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
  };
}

/** The production path: Supabase with the secret key, like everywhere else. */
export class SupabaseMemoryStore implements MemoryStore {
  userModel(): Promise<string> {
    return userModel();
  }

  activeUserModel() {
    return activeUserModel();
  }

  userModelVersions() {
    return userModelVersions();
  }

  insertUserModelVersion(version: NewUserModelVersion) {
    return insertUserModelVersion(version);
  }

  deleteUserModelVersions(ids: readonly string[]) {
    return deleteUserModelVersions(ids);
  }

  forgottenMarkers() {
    return forgottenMarkers();
  }

  addForgottenMarker(hmacs: readonly string[]) {
    return addForgottenMarker(hmacs);
  }

  async factChangesSince(cursor: string, now: string, subject = "owner"): Promise<FactChanges> {
    const columns = "id, category, content, confidence, kind, valid_from, valid_until, superseded_by, area, source_message_id, created_at";
    const [fresh, replaced, expired] = await Promise.all([
      db.from("facts").select(columns).eq("subject", subject).is("superseded_by", null).gt("created_at", cursor),
      // Superseding is an update: `updated_at` shows when.
      db.from("facts").select("content, superseded_by").eq("subject", subject).not("superseded_by", "is", null).gt("updated_at", cursor),
      db.from("facts").select(columns).eq("subject", subject).is("superseded_by", null).gt("valid_until", cursor).lte("valid_until", now),
    ]);
    for (const result of [fresh, replaced, expired]) {
      if (result.error) throw new Error(`Fact changes not readable: ${result.error.message}`);
    }
    const toActive = (row: FactDbRow): ActiveFact => ({
      id: row.id,
      category: row.category,
      content: row.content,
      confidence: row.confidence,
      kind: row.kind,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      area: areaFromStored(row.area),
      sourceMessageId: row.source_message_id,
      createdAt: row.created_at,
    });
    const replacedRows = (replaced.data ?? []) as Array<{ content: string; superseded_by: string }>;
    const replacements = new Map<string, string>();
    if (replacedRows.length > 0) {
      const { data, error } = await db.from("facts").select("id, content").in("id", replacedRows.map((row) => row.superseded_by));
      if (error) throw new Error(`Replacing facts not readable: ${error.message}`);
      for (const row of (data ?? []) as Array<{ id: string; content: string }>) replacements.set(row.id, row.content);
    }
    return {
      added: ((fresh.data ?? []) as FactDbRow[]).map(toActive),
      superseded: replacedRows.map((row) => ({ old: row.content, replacement: replacements.get(row.superseded_by) ?? "" })),
      expired: ((expired.data ?? []) as FactDbRow[]).map(toActive),
    };
  }

  async summariesSince(cursor: string): Promise<SummaryRow[]> {
    const { data, error } = await db
      .from("summaries")
      .select("id, window_start, window_end, content, message_count")
      .gt("created_at", cursor)
      .order("window_end", { ascending: true });
    if (error) throw new Error(`Summaries not readable: ${error.message}`);
    return ((data ?? []) as Array<{ id: string; window_start: string; window_end: string; content: string; message_count: number }>).map((row) => ({
      id: row.id,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      content: row.content,
      messageCount: row.message_count,
    }));
  }

  /**
   * Written only by this process (`maybeConsolidate`): after the first read,
   * memory is enough. Asked every 30 s, work happens once per night.
   */
  private consolidation: ConsolidationState | null = null;

  async consolidationState(): Promise<ConsolidationState> {
    if (this.consolidation) return { ...this.consolidation };
    const { data, error } = await db.from("agent_state").select("value").eq("key", CONSOLIDATION_KEY).maybeSingle();
    if (error) throw new Error(`Consolidation state not readable: ${error.message}`);
    const value = (data?.value ?? {}) as Partial<ConsolidationState>;
    this.consolidation = {
      lastRunDay: typeof value.lastRunDay === "string" ? value.lastRunDay : null,
      cursor: typeof value.cursor === "string" ? value.cursor : null,
    };
    return { ...this.consolidation };
  }

  async saveConsolidationState(state: ConsolidationState): Promise<void> {
    const { error } = await db
      .from("agent_state")
      .upsert({ key: CONSOLIDATION_KEY, value: state, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Consolidation state not saved: ${error.message}`);
    this.consolidation = { ...state };
  }

  activeFacts(subject = "owner") {
    return activeFactRows(subject);
  }

  async unclassifiedFacts(limit: number): Promise<Array<{ id: string; content: string }>> {
    const { data, error } = await db
      .from("facts")
      .select("id, content")
      .is("superseded_by", null)
      .is("area", null)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`Facts without area not readable: ${error.message}`);
    return (data ?? []) as Array<{ id: string; content: string }>;
  }

  async setFactAreas(updates: ReadonlyArray<{ id: string; area: FactArea }>): Promise<void> {
    // One update per area: at most six queries, no matter how many facts.
    for (const area of new Set(updates.map((update) => update.area))) {
      const ids = updates.filter((update) => update.area === area).map((update) => update.id);
      const { error } = await db.from("facts").update({ area }).in("id", ids).is("area", null);
      if (error) throw new Error(`Areas not saved: ${error.message}`);
    }
  }

  async allFactContents(subject = "owner"): Promise<string[]> {
    const { data, error } = await db.from("facts").select("content").eq("subject", subject);
    if (error) throw new Error(`Facts not readable: ${error.message}`);
    return ((data ?? []) as Array<{ content: string }>).map((row) => row.content);
  }

  async searchFacts(input: FactSearch): Promise<FactCandidate[]> {
    const { data, error } = await db.rpc("search_facts", {
      p_subject: input.subject,
      p_embedding: input.embedding,
      p_query: input.query,
      p_limit: input.limit,
      p_now: input.now,
      p_include_expired: input.includeExpired ?? false,
    });
    if (error) throw new Error(`Fact search failed: ${error.message}`);
    return ((data ?? []) as Array<FactDbRow & { similarity: number; score: number; text_hit: boolean | null }>).map((row) => ({
      id: row.id,
      category: row.category,
      content: row.content,
      confidence: row.confidence,
      sourceMessageId: row.source_message_id,
      createdAt: row.created_at,
      kind: row.kind,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      similarity: Number(row.similarity ?? 0),
      score: Number(row.score ?? 0),
      textHit: row.text_hit === true,
    }));
  }

  async activeSituations(input: SituationQuery): Promise<ContextFact[]> {
    const { data, error } = await db.rpc("active_situations", {
      p_subject: input.subject,
      p_now: input.now,
      p_starts_before: input.startsBefore,
      p_fresh_since: input.freshSince,
      p_limit: input.limit,
    });
    if (error) throw new Error(`Current situations not readable: ${error.message}`);
    return ((data ?? []) as FactDbRow[]).map(toContextFact);
  }

  async areaFacts(input: AreaFactQuery): Promise<ContextFact[]> {
    const { data, error } = await db.rpc("area_facts", {
      p_subject: input.subject,
      // Current and legacy keys, so facts classified before the English keys are found too.
      p_areas: storedAreaKeys(input.areas),
      p_kinds: [...input.kinds],
      p_embedding: input.embedding,
      p_terms: input.terms,
      p_now: input.now,
      p_limit: input.limit,
    });
    if (error) throw new Error(`Facts by area not readable: ${error.message}`);
    return ((data ?? []) as FactDbRow[]).map(toContextFact);
  }

  async insertFact(fact: NewFact): Promise<StoredFact> {
    const { data, error } = await db
      .from("facts")
      .insert({
        subject: fact.subject,
        category: fact.category,
        content: fact.content,
        confidence: fact.confidence,
        source_message_id: fact.sourceMessageId,
        embedding: fact.embedding,
        kind: fact.kind,
        valid_from: fact.validFrom,
        valid_until: fact.validUntil,
        area: fact.area ?? null,
        created_at: fact.createdAt,
        updated_at: fact.createdAt,
      })
      .select(FACT_COLUMNS)
      .single();
    if (error) throw new Error(`Fact not saved: ${error.message}`);
    return toStoredFact(data as FactDbRow);
  }

  async supersedeFact(oldId: string, newId: string, at: string): Promise<void> {
    const { error } = await db
      .from("facts")
      .update({ superseded_by: newId, updated_at: at })
      .eq("id", oldId);
    if (error) throw new Error(`Fact not superseded: ${error.message}`);
  }

  async expireFactAt(id: string, until: string, at: string): Promise<void> {
    const { error } = await db.from("facts").update({ valid_until: until, updated_at: at }).eq("id", id);
    if (error) throw new Error(`Expiry not set: ${error.message}`);
  }

  async forgetFact(id: string): Promise<ForgetResult> {
    const { data, error } = await db.rpc("forget_fact", { p_id: id });
    if (error) throw new Error(`Fact not deleted: ${error.message}`);
    const row = (data as Array<{
      deleted_ids: string[] | null;
      categories: string[] | null;
      summaries_deleted: number | null;
    }> | null)?.[0];
    return {
      deletedIds: row?.deleted_ids ?? [],
      categories: row?.categories ?? [],
      summariesDeleted: row?.summaries_deleted ?? 0,
    };
  }

  async addOpenQuestion(question: NewOpenQuestion): Promise<OpenQuestion | null> {
    const { data, error } = await db
      .from("open_questions")
      .insert({
        question: question.question,
        fact_id: question.factId,
        rival_fact_id: question.rivalFactId,
        importance: question.importance,
        created_at: question.createdAt,
      })
      .select("id, question, fact_id, rival_fact_id, importance, status, created_at")
      .maybeSingle();
    // The unique index on (fact_id, rival_fact_id) catches duplicates; a
    // follow-up question already queued is not an error.
    if (error) {
      if (error.code === "23505") return null;
      throw new Error(`Follow-up question not queued: ${error.message}`);
    }
    if (!data) return null;
    const row = data as {
      id: string;
      question: string;
      fact_id: string;
      rival_fact_id: string;
      importance: number;
      status: OpenQuestion["status"];
      created_at: string;
    };
    return {
      id: row.id,
      question: row.question,
      factId: row.fact_id,
      rivalFactId: row.rival_fact_id,
      importance: row.importance,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  async nextOpenQuestion(): Promise<OpenQuestion | null> {
    const { data, error } = await db
      .from("open_questions")
      .select("id, question, fact_id, rival_fact_id, importance, status, created_at")
      .eq("status", "open")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Open follow-up questions not readable: ${error.message}`);
    if (!data) return null;
    const row = data as {
      id: string;
      question: string;
      fact_id: string;
      rival_fact_id: string;
      importance: number;
      status: OpenQuestion["status"];
      created_at: string;
    };
    return {
      id: row.id,
      question: row.question,
      factId: row.fact_id,
      rivalFactId: row.rival_fact_id,
      importance: row.importance,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  async markQuestionAsked(id: string, at: string): Promise<void> {
    const { error } = await db
      .from("open_questions")
      .update({ status: "asked", asked_at: at })
      .eq("id", id);
    if (error) throw new Error(`Follow-up question not marked: ${error.message}`);
  }

  async recentSummaries(limit: number): Promise<SummaryRow[]> {
    const { data, error } = await db
      .from("summaries")
      .select("id, window_start, window_end, content, message_count")
      .order("window_end", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Summaries not readable: ${error.message}`);
    return ((data ?? []) as Array<{
      id: string;
      window_start: string;
      window_end: string;
      content: string;
      message_count: number;
    }>)
      .map((row) => ({
        id: row.id,
        windowStart: row.window_start,
        windowEnd: row.window_end,
        content: row.content,
        messageCount: row.message_count,
      }))
      .reverse();
  }

  async similarSummaries(embedding: number[], limit: number, before: string | null): Promise<SummaryRow[]> {
    const { data, error } = await db.rpc("search_summaries", { p_embedding: embedding, p_limit: limit, p_before: before });
    if (error) throw new Error(`Similar summaries not readable: ${error.message}`);
    return ((data ?? []) as Array<{ id: string; window_start: string; window_end: string; content: string; message_count: number; similarity: number }>).map((row) => ({
      id: row.id,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      content: row.content,
      messageCount: row.message_count,
      similarity: Number(row.similarity ?? 0),
    }));
  }

  async searchMessages(input: { peer: string; embedding: number[] | null; query: string; limit: number; from?: string; to?: string }): Promise<HistoryHit[]> {
    const { data, error } = await db.rpc("search_messages", {
      p_peer: input.peer,
      p_embedding: input.embedding,
      p_query: input.query,
      p_limit: input.limit,
      p_from: input.from ?? null,
      p_to: input.to ?? null,
    });
    if (error) throw new Error(`History not searchable: ${error.message}`);
    return ((data ?? []) as Array<{
      id: string;
      direction: "inbound" | "outbound";
      body: string;
      created_at: string;
      taint_sources: string[] | null;
      similarity: number;
      score: number;
    }>).map((row) => ({
      id: row.id,
      direction: row.direction,
      body: row.body,
      createdAt: row.created_at,
      taintSources: row.taint_sources ?? [],
      similarity: Number(row.similarity ?? 0),
      score: Number(row.score ?? 0),
    }));
  }

  async messagesWithoutEmbedding(limit: number): Promise<Array<{ id: string; body: string }>> {
    const { data, error } = await db
      .from("messages")
      .select("id, body")
      .is("embedding", null)
      .neq("body", "")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Messages without vector not readable: ${error.message}`);
    return (data ?? []) as Array<{ id: string; body: string }>;
  }

  async setMessageEmbedding(id: string, embedding: number[]): Promise<void> {
    const { error } = await db.from("messages").update({ embedding }).eq("id", id);
    if (error) throw new Error(`Message vector not written: ${error.message}`);
  }

  async lastSummaryEnd(): Promise<string | null> {
    const { data, error } = await db
      .from("summaries")
      .select("window_end")
      .order("window_end", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Summary cursor not readable: ${error.message}`);
    return (data as { window_end: string } | null)?.window_end ?? null;
  }

  async messagesAfter(cursor: string | null, limit: number): Promise<MessageRow[]> {
    let request = db
      .from("messages")
      .select("id, direction, body, created_at, taint_sources")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (cursor) request = request.gt("created_at", cursor);
    const { data, error } = await request;
    if (error) throw new Error(`Messages not readable: ${error.message}`);
    return ((data ?? []) as Array<{
      id: string;
      direction: "inbound" | "outbound";
      body: string;
      created_at: string;
      taint_sources: string[];
    }>).map((row) => ({
      id: row.id,
      direction: row.direction,
      body: row.body,
      createdAt: row.created_at,
      fromUntrusted: row.direction === "outbound" && row.taint_sources.length > 0,
    }));
  }

  async insertSummary(summary: NewSummary): Promise<void> {
    const { error } = await db.from("summaries").insert({
      window_start: summary.windowStart,
      window_end: summary.windowEnd,
      content: summary.content,
      message_count: summary.messageCount,
      embedding: summary.embedding,
    });
    if (error) throw new Error(`Summary not saved: ${error.message}`);
  }

  insertProposal(proposal: NewProposal) {
    return proposalRows.insertProposal(proposal);
  }

  proposals(filter: { kind: ProposalKind; statuses: readonly ProposalStatus[]; limit?: number }) {
    return proposalRows.proposals(filter);
  }

  proposalsByOffer(offerExternalId: string) {
    return proposalRows.proposalsByOffer(offerExternalId);
  }

  markProposalsOffered(ids: readonly string[], offerExternalId: string, at: string) {
    return proposalRows.markProposalsOffered(ids, offerExternalId, at);
  }

  decideProposal(id: string, status: "accepted" | "rejected", at: string) {
    return proposalRows.decideProposal(id, status, at);
  }

  clearProposalBody(ids: readonly string[]) {
    return proposalRows.clearProposalBody(ids);
  }

  expireOffers(before: string, at: string) {
    return proposalRows.expireOffers(before, at);
  }

  lastOfferAt(kind: ProposalKind) {
    return proposalRows.lastOfferAt(kind);
  }

  procedures() {
    return proposalRows.procedures();
  }

  insertProcedure(procedure: NewProcedure) {
    return proposalRows.insertProcedure(procedure);
  }

  searchProcedures(input: ProcedureSearch) {
    return proposalRows.searchProcedures(input);
  }

  deleteProcedure(id: string) {
    return proposalRows.deleteProcedure(id);
  }
}

let shared: MemoryStore | null = null;

export function memoryStore(): MemoryStore {
  shared ??= new SupabaseMemoryStore();
  return shared;
}
