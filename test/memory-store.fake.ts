import type {
  ActiveFact,
  AreaFactQuery,
  ConsolidationState,
  ContextFact,
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
  StoredFact,
  SummaryRow,
  FactCandidate,
  SituationQuery,
} from "../src/memory/store.js";
import type {
  NewProcedure,
  NewProposal,
  ProcedureHit,
  ProcedureSearch,
  ProposalKind,
  ProposalStatus,
  StoredProcedure,
  StoredProposal,
} from "../src/memory/proposal-store.js";
import type { FactArea } from "../src/memory/areas.js";
import type { Judge, JudgeAnswer, JudgeQuestion, JudgeRequest, JudgeResult } from "../src/agent/judge/types.js";
import { storedAreaKeys } from "../src/memory/areas.js";
import { renderUserModel, type NewUserModelVersion, type UserModelVersion } from "../src/memory/user-model.js";

/**
 * Fake database and fake judge for the memory tests. Both reproduce exactly the
 * guarantees the production code relies on, above all: superseded
 * facts never come back anywhere, and forgetting takes the whole
 * supersession chain with it.
 */

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3),
  );
}

/**
 * Share of common word stems in the smaller of the two texts. Stands in here for
 * what pgvector does in production: the first four characters as a stem are enough
 * for "wohne" and "wohnt" to count as the same.
 */
export function fakeSimilarity(a: string, b: string): number {
  const stem = (word: string) => word.slice(0, 4);
  const left = new Set([...tokens(a)].map(stem));
  const right = new Set([...tokens(b)].map(stem));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

export class FakeMemoryStore implements MemoryStore {
  facts: StoredFact[] = [];
  summaries: SummaryRow[] = [];
  messages: MessageRow[] = [];
  questions: OpenQuestion[] = [];
  /** Newest first, like `user_model_versions` by `created_at desc`. */
  versions: UserModelVersion[] = [];
  markers: string[][] = [];
  consolidation: ConsolidationState = { lastRunDay: null, cursor: null };
  /** `updated_at` per fact ID, for `factChangesSince` (superseding is an update). */
  updatedAt = new Map<string, string>();
  /** `memory_proposals` and `procedures` (D42). */
  proposalRows: StoredProposal[] = [];
  procedureRows: StoredProcedure[] = [];
  private seq = 0;

  /** Test helper: the user model as one base text, like the former `agent_state.user_model`. */
  set model(text: string) {
    this.versions = text
      ? [{ id: this.id("um"), base: text, learned: "", source: "seed", factsCursor: null, diff: {}, createdAt: "2026-01-01T00:00:00.000Z" }]
      : [];
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  async userModel(): Promise<string> {
    return renderUserModel(this.versions[0] ?? null);
  }

  async activeUserModel(): Promise<UserModelVersion | null> {
    return this.versions[0] ?? null;
  }

  async userModelVersions(): Promise<UserModelVersion[]> {
    return [...this.versions];
  }

  async insertUserModelVersion(version: NewUserModelVersion): Promise<UserModelVersion> {
    const stored: UserModelVersion = {
      id: this.id("um"),
      base: version.base,
      learned: version.learned,
      source: version.source,
      factsCursor: version.factsCursor,
      diff: version.diff,
      createdAt: version.createdAt ?? new Date().toISOString(),
    };
    this.versions.unshift(stored);
    return stored;
  }

  async deleteUserModelVersions(ids: readonly string[]): Promise<void> {
    this.versions = this.versions.filter((version) => !ids.includes(version.id));
  }

  async forgottenMarkers(): Promise<string[][]> {
    return this.markers.map((marker) => [...marker]);
  }

  async addForgottenMarker(hmacs: readonly string[]): Promise<void> {
    this.markers.push([...hmacs]);
  }

  async factChangesSince(cursor: string, now: string, subject = "owner"): Promise<FactChanges> {
    const active = this.facts.filter((fact) => fact.subject === subject && fact.supersededBy === null);
    return {
      added: active.filter((fact) => fact.createdAt > cursor).map(toActive),
      superseded: this.facts
        .filter((fact) => fact.subject === subject && fact.supersededBy !== null && (this.updatedAt.get(fact.id) ?? "") > cursor)
        .map((fact) => ({ old: fact.content, replacement: this.facts.find((entry) => entry.id === fact.supersededBy)?.content ?? "" })),
      expired: active.filter((fact) => fact.validUntil !== null && fact.validUntil > cursor && fact.validUntil <= now).map(toActive),
    };
  }

  async summariesSince(cursor: string): Promise<SummaryRow[]> {
    return this.summaries.filter((summary) => summary.windowEnd > cursor);
  }

  async consolidationState(): Promise<ConsolidationState> {
    return { ...this.consolidation };
  }

  async saveConsolidationState(state: ConsolidationState): Promise<void> {
    this.consolidation = { ...state };
  }

  async activeFacts(subject = "owner"): Promise<ActiveFact[]> {
    return this.facts.filter((fact) => fact.subject === subject && fact.supersededBy === null).map(toActive);
  }

  async unclassifiedFacts(limit: number): Promise<Array<{ id: string; content: string }>> {
    return this.facts
      .filter((fact) => fact.supersededBy === null && fact.area === null)
      .slice(0, limit)
      .map((fact) => ({ id: fact.id, content: fact.content }));
  }

  async setFactAreas(updates: ReadonlyArray<{ id: string; area: FactArea }>): Promise<void> {
    for (const update of updates) {
      const fact = this.facts.find((candidate) => candidate.id === update.id);
      if (fact && fact.area === null) fact.area = update.area;
    }
  }

  async allFactContents(subject = "owner"): Promise<string[]> {
    return this.facts.filter((fact) => fact.subject === subject).map((fact) => fact.content);
  }

  async searchFacts(input: FactSearch): Promise<FactCandidate[]> {
    return this.facts
      .filter((fact) => fact.subject === input.subject && fact.supersededBy === null)
      .filter((fact) => input.includeExpired || fact.validUntil === null || fact.validUntil > input.now)
      .map((fact) => ({
        id: fact.id,
        category: fact.category,
        content: fact.content,
        confidence: fact.confidence,
        sourceMessageId: fact.sourceMessageId,
        createdAt: fact.createdAt,
        kind: fact.kind,
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
        similarity: fakeSimilarity(fact.content, input.query),
        score: fakeSimilarity(fact.content, input.query),
        textHit: false,
      }))
      .filter((candidate) => candidate.similarity > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit);
  }

  /** Like `active_situations` (0027): situation, starts by `startsBefore`, still running or without an end and recent. */
  async activeSituations(input: SituationQuery): Promise<ContextFact[]> {
    return this.facts
      .filter((fact) => fact.subject === input.subject && fact.supersededBy === null && fact.kind === "situation")
      .filter((fact) => fact.validFrom === null || fact.validFrom <= input.startsBefore)
      .filter((fact) => (fact.validUntil !== null ? fact.validUntil > input.now : fact.createdAt >= input.freshSince))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, input.limit)
      .map(toContext);
  }

  /** Like `area_facts` (0027), without a vector: shared word stems with the keywords, then the newest. */
  async areaFacts(input: AreaFactQuery): Promise<ContextFact[]> {
    return this.facts
      .filter((fact) => fact.subject === input.subject && fact.supersededBy === null)
      .filter((fact) => fact.validUntil === null || fact.validUntil > input.now)
      .filter((fact) => (fact.area !== null ? storedAreaKeys(input.areas).includes(fact.area) : input.kinds.includes(fact.kind)))
      .map((fact) => ({ fact, shared: fakeSimilarity(fact.content, input.terms) }))
      .sort((a, b) => b.shared - a.shared || b.fact.createdAt.localeCompare(a.fact.createdAt))
      .slice(0, input.limit)
      .map((entry) => toContext(entry.fact));
  }

  async insertFact(fact: NewFact): Promise<StoredFact> {
    const stored: StoredFact = {
      id: this.id("fact"),
      subject: fact.subject,
      category: fact.category,
      content: fact.content,
      confidence: fact.confidence,
      sourceMessageId: fact.sourceMessageId,
      supersededBy: null,
      createdAt: fact.createdAt,
      kind: fact.kind,
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
      area: fact.area ?? null,
    };
    this.facts.push(stored);
    return stored;
  }

  async supersedeFact(oldId: string, newId: string, at = new Date().toISOString()): Promise<void> {
    const fact = this.facts.find((entry) => entry.id === oldId);
    if (fact) fact.supersededBy = newId;
    this.updatedAt.set(oldId, at);
  }

  async expireFactAt(id: string, until: string, at: string): Promise<void> {
    const fact = this.facts.find((entry) => entry.id === id);
    if (fact) fact.validUntil = until;
    this.updatedAt.set(id, at);
  }

  async forgetFact(id: string): Promise<ForgetResult> {
    // The whole chain: the fact and everything it superseded. Deleting only the
    // top one would make the previous version active again.
    const chain: StoredFact[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.pop();
      const fact = this.facts.find((entry) => entry.id === current);
      if (!fact) continue;
      chain.push(fact);
      for (const other of this.facts) {
        if (other.supersededBy === fact.id) queue.push(other.id);
      }
    }
    if (chain.length === 0) return { deletedIds: [], categories: [], summariesDeleted: 0 };

    const contents = chain.map((fact) => fact.content);
    const sourceAt = this.messages.find(
      (message) => message.id === chain[0]?.sourceMessageId,
    )?.createdAt;

    const before = this.summaries.length;
    this.summaries = this.summaries.filter((summary) => {
      const inWindow =
        sourceAt !== undefined &&
        summary.windowStart <= sourceAt &&
        summary.windowEnd >= sourceAt;
      const mentions = contents.some((content) => summary.content.includes(content));
      return !inWindow && !mentions;
    });

    const ids = new Set(chain.map((fact) => fact.id));
    this.facts = this.facts.filter((fact) => !ids.has(fact.id));
    for (const fact of this.facts) {
      if (fact.supersededBy && ids.has(fact.supersededBy)) fact.supersededBy = null;
    }
    this.questions = this.questions.filter(
      (question) => !ids.has(question.factId) && !ids.has(question.rivalFactId),
    );

    return {
      deletedIds: [...ids],
      categories: chain.map((fact) => fact.category),
      summariesDeleted: before - this.summaries.length,
    };
  }

  async addOpenQuestion(question: NewOpenQuestion): Promise<OpenQuestion | null> {
    const exists = this.questions.some(
      (entry) =>
        entry.factId === question.factId &&
        entry.rivalFactId === question.rivalFactId &&
        entry.status !== "resolved",
    );
    if (exists) return null;
    const stored: OpenQuestion = {
      id: this.id("question"),
      question: question.question,
      factId: question.factId,
      rivalFactId: question.rivalFactId,
      importance: question.importance,
      status: "open",
      createdAt: question.createdAt,
    };
    this.questions.push(stored);
    return stored;
  }

  async nextOpenQuestion(): Promise<OpenQuestion | null> {
    return (
      [...this.questions]
        .filter((question) => question.status === "open")
        .sort((a, b) => b.importance - a.importance || a.createdAt.localeCompare(b.createdAt))[0] ??
      null
    );
  }

  async markQuestionAsked(id: string): Promise<void> {
    const question = this.questions.find((entry) => entry.id === id);
    if (question) question.status = "asked";
  }

  async recentSummaries(limit: number): Promise<SummaryRow[]> {
    return [...this.summaries]
      .sort((a, b) => b.windowEnd.localeCompare(a.windowEnd))
      .slice(0, limit)
      .reverse();
  }

  /** For the dummy all that counts is whether a summary has a "vector": then it counts as similar. */
  summaryEmbeddings = new Set<string>();
  messageEmbeddings = new Map<string, number[]>();

  async similarSummaries(_embedding: number[], limit: number, before: string | null): Promise<SummaryRow[]> {
    return this.summaries
      .filter((summary) => this.summaryEmbeddings.has(summary.id) && (before === null || summary.windowEnd < before))
      .slice(0, limit);
  }

  async searchMessages(input: { peer: string; embedding: number[] | null; query: string; limit: number; from?: string; to?: string }): Promise<HistoryHit[]> {
    return this.messages
      .filter((message) => (!input.from || message.createdAt >= input.from) && (!input.to || message.createdAt < input.to))
      .map((message) => ({
        id: message.id,
        direction: message.direction,
        body: message.body,
        createdAt: message.createdAt,
        taintSources: message.fromUntrusted ? ["Mail"] : [],
        similarity: fakeSimilarity(message.body, input.query),
        score: fakeSimilarity(message.body, input.query),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit);
  }

  async messagesWithoutEmbedding(limit: number): Promise<Array<{ id: string; body: string }>> {
    return this.messages.filter((message) => message.body && !this.messageEmbeddings.has(message.id)).slice(0, limit);
  }

  async setMessageEmbedding(id: string, embedding: number[]): Promise<void> {
    this.messageEmbeddings.set(id, embedding);
  }

  async lastSummaryEnd(): Promise<string | null> {
    return (
      [...this.summaries].sort((a, b) => b.windowEnd.localeCompare(a.windowEnd))[0]?.windowEnd ??
      null
    );
  }

  async messagesAfter(cursor: string | null, limit: number): Promise<MessageRow[]> {
    return this.messages
      .filter((message) => cursor === null || message.createdAt > cursor)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  async insertSummary(summary: NewSummary): Promise<void> {
    this.summaries.push({
      id: this.id("summary"),
      windowStart: summary.windowStart,
      windowEnd: summary.windowEnd,
      content: summary.content,
      messageCount: summary.messageCount,
    });
  }

  async insertProposal(proposal: NewProposal): Promise<StoredProposal> {
    const stored: StoredProposal = {
      id: this.id("proposal"),
      kind: proposal.kind,
      title: proposal.title,
      body: proposal.body,
      trigger: proposal.trigger,
      status: proposal.status,
      offerExternalId: proposal.offerExternalId,
      sourceMessageId: proposal.sourceMessageId,
      correctionMessageId: proposal.correctionMessageId,
      taintSources: [...proposal.taintSources],
      createdAt: proposal.createdAt,
      offeredAt: proposal.offeredAt,
      decidedAt: null,
    };
    this.proposalRows.push(stored);
    return { ...stored };
  }

  async proposals(filter: { kind: ProposalKind; statuses: readonly ProposalStatus[]; limit?: number }): Promise<StoredProposal[]> {
    return this.proposalRows
      .filter((row) => row.kind === filter.kind && filter.statuses.includes(row.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, filter.limit ?? Infinity)
      .map((row) => ({ ...row }));
  }

  async proposalsByOffer(offerExternalId: string): Promise<StoredProposal[]> {
    return this.proposalRows
      .filter((row) => offerExternalId !== "" && row.offerExternalId === offerExternalId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((row) => ({ ...row }));
  }

  async markProposalsOffered(ids: readonly string[], offerExternalId: string, at: string): Promise<void> {
    for (const row of this.proposalRows) {
      if (ids.includes(row.id) && row.status === "pending") {
        row.status = "offered";
        row.offerExternalId = offerExternalId;
        row.offeredAt = at;
      }
    }
  }

  async decideProposal(id: string, status: "accepted" | "rejected", at: string): Promise<boolean> {
    const row = this.proposalRows.find((entry) => entry.id === id && entry.status === "offered");
    if (!row) return false;
    row.status = status;
    row.decidedAt = at;
    return true;
  }

  async clearProposalBody(ids: readonly string[]): Promise<void> {
    for (const row of this.proposalRows) if (ids.includes(row.id)) row.body = "";
  }

  async expireOffers(before: string, at: string): Promise<string[]> {
    const expired = this.proposalRows.filter((row) => row.status === "offered" && row.offeredAt !== null && row.offeredAt < before);
    for (const row of expired) {
      row.status = "expired";
      row.decidedAt = at;
      row.body = "";
    }
    return expired.map((row) => row.id);
  }

  async lastOfferAt(kind: ProposalKind): Promise<string | null> {
    return (
      this.proposalRows
        .filter((row) => row.kind === kind && row.offeredAt !== null)
        .map((row) => row.offeredAt as string)
        .sort()
        .at(-1) ?? null
    );
  }

  async procedures(): Promise<StoredProcedure[]> {
    return this.procedureRows.map((row) => ({ ...row }));
  }

  async insertProcedure(procedure: NewProcedure): Promise<StoredProcedure> {
    const stored: StoredProcedure = {
      id: this.id("procedure"),
      title: procedure.title,
      body: procedure.body,
      trigger: procedure.trigger,
      proposalId: procedure.proposalId,
      createdAt: procedure.createdAt,
    };
    this.procedureRows.push(stored);
    return { ...stored };
  }

  /**
   * Like `search_procedures`: every procedure with its raw scores, the caller sets
   * the threshold. `similarity` stands in for pgvector, `sharedTerms` counts shared
   * word stems like the database's full-text search.
   */
  async searchProcedures(input: ProcedureSearch): Promise<ProcedureHit[]> {
    const stem = (word: string) => word.slice(0, 5);
    const query = new Set([...tokens(input.query)].map(stem));
    return this.procedureRows
      .map((row) => {
        const own = new Set([...tokens(`${row.title} ${row.trigger}`)].map(stem));
        return {
          ...row,
          similarity: input.embedding ? fakeSimilarity(`${row.title} ${row.trigger}`, input.query) : 0,
          sharedTerms: [...own].filter((term) => query.has(term)).length,
        };
      })
      .sort((a, b) => b.similarity - a.similarity || b.sharedTerms - a.sharedTerms)
      .slice(0, input.limit);
  }

  async deleteProcedure(id: string): Promise<boolean> {
    const row = this.procedureRows.find((entry) => entry.id === id);
    if (!row) return false;
    this.procedureRows = this.procedureRows.filter((entry) => entry.id !== id);
    this.proposalRows = this.proposalRows.filter((entry) => entry.id !== row.proposalId);
    return true;
  }

  /** Test helper: store a message and return its ID. */
  addMessage(direction: "inbound" | "outbound", body: string, at: Date, fromUntrusted = false): string {
    const id = this.id("msg");
    this.messages.push({ id, direction, body, createdAt: at.toISOString(), fromUntrusted });
    return id;
  }
}

function toActive(fact: StoredFact): ActiveFact {
  return {
    id: fact.id,
    category: fact.category,
    content: fact.content,
    confidence: fact.confidence,
    kind: fact.kind,
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    area: fact.area,
    sourceMessageId: fact.sourceMessageId,
    createdAt: fact.createdAt,
  };
}

function toContext(fact: StoredFact): ContextFact {
  return {
    id: fact.id,
    category: fact.category,
    content: fact.content,
    confidence: fact.confidence,
    sourceMessageId: fact.sourceMessageId,
    createdAt: fact.createdAt,
    kind: fact.kind,
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
  };
}

/** An extracted fact without kind and validity, as before D39: identity, unlimited. */
export function plainFact(category: string, content: string, confidence = 0.9) {
  return { category, content, confidence, kind: "identity" as const, validFrom: null, validUntil: null };
}

export type JudgeHandler = (question: JudgeQuestion, state: string) => JudgeAnswer;

export class FakeJudge implements Judge {
  readonly asked: JudgeQuestion[] = [];

  constructor(private readonly handler: JudgeHandler) {}

  async ask(request: JudgeRequest): Promise<JudgeResult> {
    const answers: Record<string, JudgeAnswer> = {};
    for (const question of request.questions) {
      this.asked.push(question);
      answers[question.key] = this.handler(question, request.state);
    }
    return { answers, costUsd: 0 };
  }
}

/** Builds a choice answer that picks exactly one candidate with `probability`. */
export function choiceFor(
  question: JudgeQuestion,
  targetIndex: number,
  probability: number,
): JudgeAnswer {
  if (question.type !== "choice") throw new Error("not a choice question");
  const target = question.options[targetIndex];
  if (!target) throw new Error("option does not exist");
  const rest = question.options.filter((option) => option.key !== target.key);
  const share = rest.length > 0 ? (1 - probability) / rest.length : 0;
  const probabilities: Record<string, number> = { [target.key]: probability };
  for (const option of rest) probabilities[option.key] = share;
  return {
    type: "choice",
    source: "generative",
    choice: target.key,
    probabilities,
    confidence: probability,
  };
}
