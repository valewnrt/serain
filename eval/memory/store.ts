import type { PGliteInterface } from "@electric-sql/pglite";
import type {
  ActiveFact,
  AreaFactQuery,
  ConsolidationState,
  ContextFact,
  FactCandidate,
  FactChanges,
  FactSearch,
  ForgetResult,
  HistoryHit,
  MemoryStore,
  MessageRow,
  NewFact,
  NewOpenQuestion,
  NewSummary,
  OpenQuestion,
  SituationQuery,
  StoredFact,
  SummaryRow,
} from "../../src/memory/store.js";
import { areaFromStored, type FactArea } from "../../src/memory/areas.js";
import type { FactKind } from "../../src/memory/kinds.js";
import type {
  NewProcedure,
  NewProposal,
  ProcedureHit,
  ProcedureSearch,
  ProposalKind,
  ProposalStatus,
  StoredProcedure,
  StoredProposal,
} from "../../src/memory/proposal-store.js";
import type { NewUserModelVersion, UserModelSource, UserModelVersion } from "../../src/memory/user-model.js";
import type { MemorySnapshot } from "./types.js";

/**
 * `MemoryStore` via SQL on PGlite, for the memory eval.
 *
 * Production talks to Supabase via PostgREST (`SupabaseMemoryStore`); here
 * the same goes directly as SQL to the same schema. The two places where
 * logic lives in the database are the same functions as in production:
 * `search_facts` (vector plus full text, rank fusion, validity) and
 * `forget_fact` (supersession chain, overlapping summaries). Everything else
 * is simple row operations that both stores express the same way.
 *
 * Two deliberate differences from production, both for the set clock:
 * - `searchFacts` passes `p_now` from the eval clock. Without it,
 *   `search_facts` would check validity against the run's real time.
 * - `userModel` reads the newest row from `user_model_versions` (0010) instead of
 *   `agent_state`; that is the schema state production moves to with V1/H1,
 *   and the layer in which a forgetting sentinel can survive.
 *
 * Only type imports from `src/`: the store loads neither the Supabase client nor env and
 * therefore also runs in the unit test without credentials.
 */

import { renderUserModel } from "../../src/memory/user-model.js";

type Clock = () => Date;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

/** pgvector takes a literal `[1,2,3]`; `null` stays null and turns off vector search. */
function vectorLiteral(embedding: readonly number[] | null): string | null {
  return embedding ? `[${embedding.join(",")}]` : null;
}

interface FactRow {
  id: string;
  subject: string;
  category: string;
  content: string;
  confidence: number;
  source_message_id: string | null;
  superseded_by: string | null;
  created_at: Date | string;
  kind: FactKind;
  valid_from: Date | string | null;
  valid_until: Date | string | null;
  /** As stored: a current key, or a legacy key from before 0037. */
  area: string | null;
}

interface VersionRow {
  id: string;
  base: string;
  learned: string;
  source: UserModelSource;
  facts_cursor: Date | string | null;
  diff: Record<string, unknown> | null;
  created_at: Date | string;
}

function toVersion(row: VersionRow): UserModelVersion {
  return {
    id: row.id,
    base: row.base,
    learned: row.learned,
    source: row.source,
    factsCursor: isoOrNull(row.facts_cursor),
    diff: row.diff ?? {},
    createdAt: iso(row.created_at),
  };
}

function toActive(row: FactRow): ActiveFact {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    confidence: Number(row.confidence),
    kind: row.kind,
    validFrom: isoOrNull(row.valid_from),
    validUntil: isoOrNull(row.valid_until),
    area: areaFromStored(row.area),
    sourceMessageId: row.source_message_id,
    createdAt: iso(row.created_at),
  };
}

interface ProposalRow {
  id: string;
  kind: ProposalKind;
  title: string;
  body: string;
  trigger: string;
  status: ProposalStatus;
  offer_external_id: string | null;
  source_message_id: string | null;
  correction_message_id: string | null;
  taint_sources: string[];
  created_at: Date | string;
  offered_at: Date | string | null;
  decided_at: Date | string | null;
}

function toProposal(row: ProposalRow): StoredProposal {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    trigger: row.trigger,
    status: row.status,
    offerExternalId: row.offer_external_id,
    sourceMessageId: row.source_message_id,
    correctionMessageId: row.correction_message_id,
    taintSources: row.taint_sources ?? [],
    createdAt: iso(row.created_at),
    offeredAt: isoOrNull(row.offered_at),
    decidedAt: isoOrNull(row.decided_at),
  };
}

interface ProcedureRow {
  id: string;
  title: string;
  body: string;
  trigger: string;
  proposal_id: string | null;
  created_at: Date | string;
}

function toProcedure(row: ProcedureRow): StoredProcedure {
  return { id: row.id, title: row.title, body: row.body, trigger: row.trigger, proposalId: row.proposal_id, createdAt: iso(row.created_at) };
}

const PROPOSAL_COLUMNS =
  "id, kind, title, body, trigger, status, offer_external_id, source_message_id, correction_message_id, taint_sources, created_at, offered_at, decided_at";
const VERSION_COLUMNS = "id, base, learned, source, facts_cursor, diff, created_at";

interface QuestionRow {
  id: string;
  question: string;
  fact_id: string;
  rival_fact_id: string;
  importance: number;
  status: OpenQuestion["status"];
  created_at: Date | string;
}

function toStoredFact(row: FactRow): StoredFact {
  return {
    id: row.id,
    subject: row.subject,
    category: row.category,
    content: row.content,
    confidence: Number(row.confidence),
    sourceMessageId: row.source_message_id,
    supersededBy: row.superseded_by,
    createdAt: iso(row.created_at),
    kind: row.kind,
    validFrom: isoOrNull(row.valid_from),
    validUntil: isoOrNull(row.valid_until),
    area: areaFromStored(row.area),
  };
}

function toContextFact(row: FactRow): ContextFact {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    confidence: Number(row.confidence),
    sourceMessageId: row.source_message_id,
    createdAt: iso(row.created_at),
    kind: row.kind,
    validFrom: isoOrNull(row.valid_from),
    validUntil: isoOrNull(row.valid_until),
  };
}

function toQuestion(row: QuestionRow): OpenQuestion {
  return {
    id: row.id,
    question: row.question,
    factId: row.fact_id,
    rivalFactId: row.rival_fact_id,
    importance: Number(row.importance),
    status: row.status,
    createdAt: iso(row.created_at),
  };
}

const FACT_COLUMNS =
  "id, subject, category, content, confidence, source_message_id, superseded_by, created_at, kind, valid_from, valid_until, area";

export class PgliteMemoryStore implements MemoryStore {
  /** IDs of the facts set as the starting state. `fact_count` counts only what was learned. */
  private readonly seeded = new Set<string>();

  constructor(
    private readonly db: PGliteInterface,
    private readonly now: Clock,
  ) {}

  async userModel(): Promise<string> {
    // The same rendering as in production (base text plus "## Learned").
    return renderUserModel(await this.activeUserModel());
  }

  async activeUserModel(): Promise<UserModelVersion | null> {
    const { rows } = await this.db.query<VersionRow>(
      `select ${VERSION_COLUMNS} from public.user_model_versions order by created_at desc, id desc limit 1`,
    );
    return rows[0] ? toVersion(rows[0]) : null;
  }

  async userModelVersions(): Promise<UserModelVersion[]> {
    const { rows } = await this.db.query<VersionRow>(
      `select ${VERSION_COLUMNS} from public.user_model_versions order by created_at desc, id desc`,
    );
    return rows.map(toVersion);
  }

  async insertUserModelVersion(version: NewUserModelVersion): Promise<UserModelVersion> {
    const { rows } = await this.db.query<VersionRow>(
      `insert into public.user_model_versions (base, learned, source, facts_cursor, diff, created_at)
       values ($1, $2, $3, $4, $5, $6) returning ${VERSION_COLUMNS}`,
      [version.base, version.learned, version.source, version.factsCursor, JSON.stringify(version.diff), version.createdAt ?? this.now().toISOString()],
    );
    const row = rows[0];
    if (!row) throw new Error("user model not written");
    return toVersion(row);
  }

  async deleteUserModelVersions(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query("delete from public.user_model_versions where id = any($1::uuid[])", [[...ids]]);
  }

  async forgottenMarkers(): Promise<string[][]> {
    const { rows } = await this.db.query<{ token_hmacs: string[] }>("select token_hmacs from public.forgotten_markers");
    return rows.map((row) => row.token_hmacs);
  }

  async addForgottenMarker(hmacs: readonly string[]): Promise<void> {
    await this.db.query("insert into public.forgotten_markers (token_hmacs) values ($1)", [[...hmacs]]);
  }

  async factChangesSince(cursor: string, now: string, subject = "owner"): Promise<FactChanges> {
    const added = await this.db.query<FactRow>(
      `select ${FACT_COLUMNS} from public.facts where subject = $1 and superseded_by is null and created_at > $2`,
      [subject, cursor],
    );
    const superseded = await this.db.query<{ old: string; replacement: string }>(
      `select o.content as old, n.content as replacement from public.facts o
       join public.facts n on n.id = o.superseded_by
       where o.subject = $1 and o.updated_at > $2`,
      [subject, cursor],
    );
    const expired = await this.db.query<FactRow>(
      `select ${FACT_COLUMNS} from public.facts
       where subject = $1 and superseded_by is null and valid_until > $2 and valid_until <= $3`,
      [subject, cursor, now],
    );
    return { added: added.rows.map(toActive), superseded: superseded.rows, expired: expired.rows.map(toActive) };
  }

  async summariesSince(cursor: string): Promise<SummaryRow[]> {
    const { rows } = await this.db.query<{ id: string; window_start: Date | string; window_end: Date | string; content: string; message_count: number }>(
      "select id, window_start, window_end, content, message_count from public.summaries where created_at > $1 order by window_end asc",
      [cursor],
    );
    return rows.map((row) => ({ id: row.id, windowStart: iso(row.window_start), windowEnd: iso(row.window_end), content: row.content, messageCount: Number(row.message_count) }));
  }

  private consolidation: ConsolidationState = { lastRunDay: null, cursor: null };

  async consolidationState(): Promise<ConsolidationState> {
    return { ...this.consolidation };
  }

  async saveConsolidationState(state: ConsolidationState): Promise<void> {
    this.consolidation = { ...state };
  }

  async activeFacts(subject = "owner"): Promise<ActiveFact[]> {
    const { rows } = await this.db.query<FactRow>(
      `select ${FACT_COLUMNS} from public.facts where subject = $1 and superseded_by is null order by category asc`,
      [subject],
    );
    return rows.map(toActive);
  }

  async unclassifiedFacts(limit: number): Promise<Array<{ id: string; content: string }>> {
    const { rows } = await this.db.query<{ id: string; content: string }>(
      "select id, content from public.facts where superseded_by is null and area is null order by created_at asc limit $1",
      [limit],
    );
    return rows;
  }

  async setFactAreas(updates: ReadonlyArray<{ id: string; area: FactArea }>): Promise<void> {
    for (const update of updates) {
      await this.db.query("update public.facts set area = $2 where id = $1 and area is null", [update.id, update.area]);
    }
  }

  async allFactContents(subject = "owner"): Promise<string[]> {
    const { rows } = await this.db.query<{ content: string }>(
      "select content from public.facts where subject = $1",
      [subject],
    );
    return rows.map((row) => row.content);
  }

  async searchFacts(input: FactSearch): Promise<FactCandidate[]> {
    const { rows } = await this.db.query<
      FactRow & { similarity: number | null; score: number | null; text_hit: boolean | null }
    >(
      `select * from public.search_facts($1, $2::extensions.vector, $3, $4, $5::timestamptz, $6)`,
      [input.subject, vectorLiteral(input.embedding), input.query, input.limit, input.now, input.includeExpired ?? false],
    );
    return rows.map((row) => ({
      id: row.id,
      category: row.category,
      content: row.content,
      confidence: Number(row.confidence),
      sourceMessageId: row.source_message_id,
      createdAt: iso(row.created_at),
      kind: row.kind,
      validFrom: isoOrNull(row.valid_from),
      validUntil: isoOrNull(row.valid_until),
      similarity: Number(row.similarity ?? 0),
      score: Number(row.score ?? 0),
      textHit: row.text_hit === true,
    }));
  }

  async activeSituations(input: SituationQuery): Promise<ContextFact[]> {
    const { rows } = await this.db.query<FactRow>(
      "select * from public.active_situations($1, $2::timestamptz, $3::timestamptz, $4::timestamptz, $5)",
      [input.subject, input.now, input.startsBefore, input.freshSince, input.limit],
    );
    return rows.map(toContextFact);
  }

  async areaFacts(input: AreaFactQuery): Promise<ContextFact[]> {
    const { rows } = await this.db.query<FactRow>(
      "select * from public.area_facts($1, $2::text[], $3::text[], $4::extensions.vector, $5, $6::timestamptz, $7)",
      [input.subject, [...input.areas], [...input.kinds], vectorLiteral(input.embedding), input.terms, input.now, input.limit],
    );
    return rows.map(toContextFact);
  }

  async insertFact(fact: NewFact): Promise<StoredFact> {
    const { rows } = await this.db.query<FactRow>(
      `insert into public.facts
         (subject, category, content, confidence, source_message_id, embedding, created_at, updated_at, kind, valid_from, valid_until, area)
       values ($1, $2, $3, $4, $5, $6::extensions.vector, $7, $7, $8, $9, $10, $11)
       returning ${FACT_COLUMNS}`,
      [
        fact.subject,
        fact.category,
        fact.content,
        fact.confidence,
        fact.sourceMessageId,
        vectorLiteral(fact.embedding),
        fact.createdAt,
        fact.kind,
        fact.validFrom,
        fact.validUntil,
        fact.area ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("fact not stored: no row returned");
    return toStoredFact(row);
  }

  async supersedeFact(oldId: string, newId: string, at: string): Promise<void> {
    await this.db.query("update public.facts set superseded_by = $2, updated_at = $3 where id = $1", [
      oldId,
      newId,
      at,
    ]);
  }

  async expireFactAt(id: string, until: string, at: string): Promise<void> {
    await this.db.query("update public.facts set valid_until = $2, updated_at = $3 where id = $1", [id, until, at]);
  }

  async forgetFact(id: string): Promise<ForgetResult> {
    const { rows } = await this.db.query<{
      deleted_ids: string[] | null;
      categories: string[] | null;
      summaries_deleted: number | null;
    }>("select * from public.forget_fact($1)", [id]);
    const row = rows[0];
    return {
      deletedIds: row?.deleted_ids ?? [],
      categories: row?.categories ?? [],
      summariesDeleted: row?.summaries_deleted ?? 0,
    };
  }

  async addOpenQuestion(question: NewOpenQuestion): Promise<OpenQuestion | null> {
    // As in production: a follow-up question already queued for the same pair is not an
    // error but null. There error code 23505 catches it, here the
    // conflict clause on the same partial index.
    const { rows } = await this.db.query<QuestionRow>(
      `insert into public.open_questions (question, fact_id, rival_fact_id, importance, created_at)
       values ($1, $2, $3, $4, $5)
       on conflict (fact_id, rival_fact_id) where status <> 'resolved' do nothing
       returning id, question, fact_id, rival_fact_id, importance, status, created_at`,
      [question.question, question.factId, question.rivalFactId, question.importance, question.createdAt],
    );
    const row = rows[0];
    return row ? toQuestion(row) : null;
  }

  async nextOpenQuestion(): Promise<OpenQuestion | null> {
    const { rows } = await this.db.query<QuestionRow>(
      `select id, question, fact_id, rival_fact_id, importance, status, created_at
       from public.open_questions where status = 'open'
       order by importance desc, created_at asc limit 1`,
    );
    const row = rows[0];
    return row ? toQuestion(row) : null;
  }

  async markQuestionAsked(id: string, at: string): Promise<void> {
    await this.db.query("update public.open_questions set status = 'asked', asked_at = $2 where id = $1", [id, at]);
  }

  async recentSummaries(limit: number): Promise<SummaryRow[]> {
    const { rows } = await this.db.query<{
      id: string;
      window_start: Date | string;
      window_end: Date | string;
      content: string;
      message_count: number;
    }>(
      `select id, window_start, window_end, content, message_count from public.summaries
       order by window_end desc limit $1`,
      [limit],
    );
    return rows
      .map((row) => ({
        id: row.id,
        windowStart: iso(row.window_start),
        windowEnd: iso(row.window_end),
        content: row.content,
        messageCount: Number(row.message_count),
      }))
      .reverse();
  }

  async similarSummaries(embedding: number[], limit: number, before: string | null): Promise<SummaryRow[]> {
    const { rows } = await this.db.query<{ id: string; window_start: Date | string; window_end: Date | string; content: string; message_count: number; similarity: number }>(
      "select * from public.search_summaries($1::extensions.vector, $2, $3::timestamptz)",
      [vectorLiteral(embedding), limit, before],
    );
    return rows.map((row) => ({ id: row.id, windowStart: iso(row.window_start), windowEnd: iso(row.window_end), content: row.content, messageCount: Number(row.message_count), similarity: Number(row.similarity) }));
  }

  async searchMessages(input: { peer: string; embedding: number[] | null; query: string; limit: number; from?: string; to?: string }): Promise<HistoryHit[]> {
    const { rows } = await this.db.query<{ id: string; direction: "inbound" | "outbound"; body: string; created_at: Date | string; taint_sources: string[]; similarity: number; score: number }>(
      "select * from public.search_messages($1, $2::extensions.vector, $3, $4, $5::timestamptz, $6::timestamptz)",
      [input.peer, vectorLiteral(input.embedding), input.query, input.limit, input.from ?? null, input.to ?? null],
    );
    return rows.map((row) => ({ id: row.id, direction: row.direction, body: row.body, createdAt: iso(row.created_at), taintSources: row.taint_sources ?? [], similarity: Number(row.similarity ?? 0), score: Number(row.score ?? 0) }));
  }

  async messagesWithoutEmbedding(limit: number): Promise<Array<{ id: string; body: string }>> {
    const { rows } = await this.db.query<{ id: string; body: string }>(
      "select id, body from public.messages where embedding is null and body <> '' order by created_at desc limit $1",
      [limit],
    );
    return rows;
  }

  async setMessageEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.db.query("update public.messages set embedding = $2::extensions.vector where id = $1", [id, vectorLiteral(embedding)]);
  }

  async lastSummaryEnd(): Promise<string | null> {
    const { rows } = await this.db.query<{ window_end: Date | string }>(
      "select window_end from public.summaries order by window_end desc limit 1",
    );
    return isoOrNull(rows[0]?.window_end);
  }

  async messagesAfter(cursor: string | null, limit: number): Promise<MessageRow[]> {
    const { rows } = await this.db.query<{
      id: string;
      direction: "inbound" | "outbound";
      body: string;
      created_at: Date | string;
      taint_sources: string[];
    }>(
      `select id, direction, body, created_at, taint_sources from public.messages
       where ($1::timestamptz is null or created_at > $1::timestamptz)
       order by created_at asc limit $2`,
      [cursor, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      direction: row.direction,
      body: row.body,
      createdAt: iso(row.created_at),
      fromUntrusted: row.direction === "outbound" && row.taint_sources.length > 0,
    }));
  }

  async insertSummary(summary: NewSummary): Promise<void> {
    await this.db.query(
      `insert into public.summaries (window_start, window_end, content, message_count, embedding)
       values ($1, $2, $3, $4, $5::extensions.vector)`,
      [summary.windowStart, summary.windowEnd, summary.content, summary.messageCount, vectorLiteral(summary.embedding)],
    );
  }

  // --- Proposals and procedures (D42): rarely needed in the eval, but complete ---

  async insertProposal(proposal: NewProposal): Promise<StoredProposal> {
    const { rows } = await this.db.query<ProposalRow>(
      `insert into public.memory_proposals
         (kind, title, body, trigger, status, offer_external_id, source_message_id, correction_message_id, taint_sources, created_at, offered_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning ${PROPOSAL_COLUMNS}`,
      [proposal.kind, proposal.title, proposal.body, proposal.trigger, proposal.status, proposal.offerExternalId, proposal.sourceMessageId, proposal.correctionMessageId, [...proposal.taintSources], proposal.createdAt, proposal.offeredAt],
    );
    const row = rows[0];
    if (!row) throw new Error("proposal not stored");
    return toProposal(row);
  }

  async proposals(filter: { kind: ProposalKind; statuses: readonly ProposalStatus[]; limit?: number }): Promise<StoredProposal[]> {
    const { rows } = await this.db.query<ProposalRow>(
      `select ${PROPOSAL_COLUMNS} from public.memory_proposals where kind = $1 and status = any($2::text[]) order by created_at asc limit $3`,
      [filter.kind, [...filter.statuses], filter.limit ?? 1000],
    );
    return rows.map(toProposal);
  }

  async proposalsByOffer(offerExternalId: string): Promise<StoredProposal[]> {
    const { rows } = await this.db.query<ProposalRow>(
      `select ${PROPOSAL_COLUMNS} from public.memory_proposals where offer_external_id = $1 order by created_at asc`,
      [offerExternalId],
    );
    return rows.map(toProposal);
  }

  async markProposalsOffered(ids: readonly string[], offerExternalId: string, at: string): Promise<void> {
    await this.db.query(
      "update public.memory_proposals set status = 'offered', offer_external_id = $2, offered_at = $3 where id = any($1::uuid[])",
      [[...ids], offerExternalId, at],
    );
  }

  async decideProposal(id: string, status: "accepted" | "rejected", at: string): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      "update public.memory_proposals set status = $2, decided_at = $3 where id = $1 and status = 'offered' returning id",
      [id, status, at],
    );
    return rows.length > 0;
  }

  async clearProposalBody(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query("update public.memory_proposals set body = '' where id = any($1::uuid[])", [[...ids]]);
  }

  async expireOffers(before: string, at: string): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      "update public.memory_proposals set status = 'expired', decided_at = $2 where status = 'offered' and offered_at < $1 returning id",
      [before, at],
    );
    return rows.map((row) => row.id);
  }

  async lastOfferAt(kind: ProposalKind): Promise<string | null> {
    const { rows } = await this.db.query<{ offered_at: Date | string | null }>(
      "select offered_at from public.memory_proposals where kind = $1 and offered_at is not null order by offered_at desc limit 1",
      [kind],
    );
    return isoOrNull(rows[0]?.offered_at);
  }

  async procedures(): Promise<StoredProcedure[]> {
    const { rows } = await this.db.query<ProcedureRow>(
      "select id, title, body, trigger, proposal_id, created_at from public.procedures order by created_at asc",
    );
    return rows.map(toProcedure);
  }

  async insertProcedure(procedure: NewProcedure): Promise<StoredProcedure> {
    const { rows } = await this.db.query<ProcedureRow>(
      `insert into public.procedures (title, body, trigger, embedding, proposal_id, created_at)
       values ($1, $2, $3, $4::extensions.vector, $5, $6) returning id, title, body, trigger, proposal_id, created_at`,
      [procedure.title, procedure.body, procedure.trigger, vectorLiteral(procedure.embedding), procedure.proposalId, procedure.createdAt],
    );
    const row = rows[0];
    if (!row) throw new Error("procedure not stored");
    return toProcedure(row);
  }

  async searchProcedures(input: ProcedureSearch): Promise<ProcedureHit[]> {
    const { rows } = await this.db.query<ProcedureRow & { similarity: number | null; shared_terms: number | null }>(
      "select * from public.search_procedures($1::extensions.vector, $2, $3)",
      [vectorLiteral(input.embedding), input.query, input.limit],
    );
    return rows.map((row) => ({ ...toProcedure(row), similarity: Number(row.similarity ?? 0), sharedTerms: Number(row.shared_terms ?? 0) }));
  }

  async deleteProcedure(id: string): Promise<boolean> {
    const { rows } = await this.db.query<{ proposal_id: string | null }>("delete from public.procedures where id = $1 returning proposal_id", [id]);
    const row = rows[0];
    if (!row) return false;
    if (row.proposal_id) await this.db.query("delete from public.memory_proposals where id = $1", [row.proposal_id]);
    return true;
  }

  // --- Eval only: set the starting state and read the state -----------------

  /** A chat message with a set timestamp. Its ID is the provenance of the facts from it. */
  async insertMessage(direction: "inbound" | "outbound", body: string, at: string): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into public.messages (channel, direction, peer, body, created_at)
       values ('eval', $1, 'eval', $2, $3) returning id`,
      [direction, body, at],
    );
    const row = rows[0];
    if (!row) throw new Error("message not stored");
    return row.id;
  }

  async seedUserModel(base: string, learned: string, at: string): Promise<void> {
    await this.db.query(
      `insert into public.user_model_versions (base, learned, source, created_at) values ($1, $2, 'seed', $3)`,
      [base, learned, at],
    );
  }

  async seedFact(fact: NewFact): Promise<StoredFact> {
    const stored = await this.insertFact(fact);
    this.seeded.add(stored.id);
    return stored;
  }

  /** Everything level 1 checks, in one go. Superseded facts included. */
  async snapshot(subject = "owner"): Promise<MemorySnapshot> {
    const facts = await this.db.query<{
      id: string;
      category: string;
      content: string;
      kind: string;
      valid_from: Date | string | null;
      valid_until: Date | string | null;
      superseded_by: string | null;
      created_at: Date | string;
    }>(
      `select id, category, content, kind, valid_from, valid_until, superseded_by, created_at
       from public.facts where subject = $1 order by created_at asc, id asc`,
      [subject],
    );
    const summaries = await this.db.query<{ content: string }>("select content from public.summaries");
    const models = await this.db.query<{ base: string; learned: string; source: string }>(
      "select base, learned, source from public.user_model_versions order by created_at asc",
    );
    const questions = await this.db.query<{ question: string }>("select question from public.open_questions");
    return {
      facts: facts.rows.map((row) => ({
        id: row.id,
        category: row.category,
        content: row.content,
        kind: row.kind,
        validFrom: isoOrNull(row.valid_from),
        validUntil: isoOrNull(row.valid_until),
        supersededBy: row.superseded_by,
        createdAt: iso(row.created_at),
        seeded: this.seeded.has(row.id),
      })),
      summaries: summaries.rows.map((row) => row.content),
      userModels: models.rows,
      openQuestions: questions.rows.map((row) => row.question),
    };
  }
}
