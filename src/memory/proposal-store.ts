import { db } from "../db/client.js";

/**
 * Proposals and approved procedures in the database (`0012_proposals.sql`,
 * `0015_search_procedures.sql`, D42). A file of its own like `user-model.ts`, so
 * that `store.ts` only describes the seam and the queries live here.
 *
 * One rule holds for every write path here: once a proposal is decided or
 * expired, its text is cleared (`clearProposalBody`). If accepted, it then lives
 * as a fact or procedure where `forget_fact` and `forget_procedure` find it;
 * if rejected, it should not be stored anywhere anymore. Otherwise a second copy in
 * `memory_proposals` would keep what the owner wants forgotten (D13).
 */

export type ProposalKind = "lesson" | "procedure";
export type ProposalStatus = "pending" | "offered" | "accepted" | "rejected" | "expired";

export interface StoredProposal {
  id: string;
  kind: ProposalKind;
  title: string;
  body: string;
  trigger: string;
  status: ProposalStatus;
  offerExternalId: string | null;
  sourceMessageId: string | null;
  correctionMessageId: string | null;
  taintSources: string[];
  createdAt: string;
  offeredAt: string | null;
  decidedAt: string | null;
}

export interface NewProposal {
  kind: ProposalKind;
  title: string;
  body: string;
  trigger: string;
  /** `pending` collects (lessons), `offered` has already been asked (procedures). */
  status: "pending" | "offered";
  offerExternalId: string | null;
  sourceMessageId: string | null;
  correctionMessageId: string | null;
  taintSources: readonly string[];
  createdAt: string;
  offeredAt: string | null;
}

export interface StoredProcedure {
  id: string;
  title: string;
  body: string;
  trigger: string;
  proposalId: string | null;
  createdAt: string;
}

export interface NewProcedure {
  title: string;
  body: string;
  trigger: string;
  embedding: number[] | null;
  proposalId: string | null;
  createdAt: string;
}

export interface ProcedureHit extends StoredProcedure {
  /** Cosine similarity of title and trigger to the message, 0 without an embedding. */
  similarity: number;
  /** Shared words between message and title plus trigger, compared unstemmed through the full-text configuration `public.serain_text` (simple plus English and German stop words, migration 0035). */
  sharedTerms: number;
}

export interface ProcedureSearch {
  embedding: number[] | null;
  query: string;
  limit: number;
}

const PROPOSAL_COLUMNS =
  "id, kind, title, body, trigger, status, offer_external_id, source_message_id, correction_message_id, taint_sources, created_at, offered_at, decided_at";

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
  taint_sources: string[] | null;
  created_at: string;
  offered_at: string | null;
  decided_at: string | null;
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
    createdAt: row.created_at,
    offeredAt: row.offered_at,
    decidedAt: row.decided_at,
  };
}

const PROCEDURE_COLUMNS = "id, title, body, trigger, proposal_id, created_at";

interface ProcedureRow {
  id: string;
  title: string;
  body: string;
  trigger: string;
  proposal_id: string | null;
  created_at: string;
}

function toProcedure(row: ProcedureRow): StoredProcedure {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    trigger: row.trigger,
    proposalId: row.proposal_id,
    createdAt: row.created_at,
  };
}

export async function insertProposal(proposal: NewProposal): Promise<StoredProposal> {
  const { data, error } = await db
    .from("memory_proposals")
    .insert({
      kind: proposal.kind,
      title: proposal.title,
      body: proposal.body,
      trigger: proposal.trigger,
      status: proposal.status,
      offer_external_id: proposal.offerExternalId,
      source_message_id: proposal.sourceMessageId,
      correction_message_id: proposal.correctionMessageId,
      taint_sources: [...proposal.taintSources],
      created_at: proposal.createdAt,
      offered_at: proposal.offeredAt,
    })
    .select(PROPOSAL_COLUMNS)
    .single();
  if (error) throw new Error(`Proposal not saved: ${error.message}`);
  return toProposal(data as ProposalRow);
}

export async function proposals(filter: {
  kind: ProposalKind;
  statuses: readonly ProposalStatus[];
  limit?: number;
}): Promise<StoredProposal[]> {
  let request = db
    .from("memory_proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("kind", filter.kind)
    .in("status", [...filter.statuses])
    .order("created_at", { ascending: true });
  if (filter.limit !== undefined) request = request.limit(filter.limit);
  const { data, error } = await request;
  if (error) throw new Error(`Proposals not readable: ${error.message}`);
  return ((data ?? []) as ProposalRow[]).map(toProposal);
}

export async function proposalsByOffer(offerExternalId: string): Promise<StoredProposal[]> {
  if (!offerExternalId) return [];
  const { data, error } = await db
    .from("memory_proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("offer_external_id", offerExternalId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Proposals for question not readable: ${error.message}`);
  return ((data ?? []) as ProposalRow[]).map(toProposal);
}

export async function markProposalsOffered(ids: readonly string[], offerExternalId: string, at: string): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db
    .from("memory_proposals")
    .update({ status: "offered", offer_external_id: offerExternalId, offered_at: at })
    .in("id", [...ids])
    .eq("status", "pending");
  if (error) throw new Error(`Proposals not marked as offered: ${error.message}`);
}

/** Atomic: only an `offered` proposal changes. Of two signals, exactly one wins. */
export async function decideProposal(id: string, status: "accepted" | "rejected", at: string): Promise<boolean> {
  const { data, error } = await db
    .from("memory_proposals")
    .update({ status, decided_at: at })
    .eq("id", id)
    .eq("status", "offered")
    .select("id");
  if (error) throw new Error(`Proposal not decided: ${error.message}`);
  return (data ?? []).length > 0;
}

export async function clearProposalBody(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db.from("memory_proposals").update({ body: "" }).in("id", [...ids]);
  if (error) throw new Error(`Proposal text not cleared: ${error.message}`);
}

/** Asked before `before` and never answered: expires silently, the text goes with it. */
export async function expireOffers(before: string, at: string): Promise<string[]> {
  const { data, error } = await db
    .from("memory_proposals")
    .update({ status: "expired", decided_at: at, body: "" })
    .eq("status", "offered")
    .lt("offered_at", before)
    .select("id");
  if (error) throw new Error(`Proposals not expired: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
}

export async function lastOfferAt(kind: ProposalKind): Promise<string | null> {
  const { data, error } = await db
    .from("memory_proposals")
    .select("offered_at")
    .eq("kind", kind)
    .not("offered_at", "is", null)
    .order("offered_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Last question not readable: ${error.message}`);
  return (data as { offered_at: string } | null)?.offered_at ?? null;
}

export async function procedures(): Promise<StoredProcedure[]> {
  const { data, error } = await db.from("procedures").select(PROCEDURE_COLUMNS).order("created_at", { ascending: true });
  if (error) throw new Error(`Procedures not readable: ${error.message}`);
  return ((data ?? []) as ProcedureRow[]).map(toProcedure);
}

export async function insertProcedure(procedure: NewProcedure): Promise<StoredProcedure> {
  const { data, error } = await db
    .from("procedures")
    .insert({
      title: procedure.title,
      body: procedure.body,
      trigger: procedure.trigger,
      embedding: procedure.embedding,
      proposal_id: procedure.proposalId,
      created_at: procedure.createdAt,
    })
    .select(PROCEDURE_COLUMNS)
    .single();
  if (error) throw new Error(`Procedure not saved: ${error.message}`);
  return toProcedure(data as ProcedureRow);
}

export async function searchProcedures(input: ProcedureSearch): Promise<ProcedureHit[]> {
  const { data, error } = await db.rpc("search_procedures", {
    p_embedding: input.embedding,
    p_query: input.query,
    p_limit: input.limit,
  });
  if (error) throw new Error(`Procedure search failed: ${error.message}`);
  return ((data ?? []) as Array<ProcedureRow & { similarity: number; shared_terms: number }>).map((row) => ({
    ...toProcedure(row),
    similarity: Number(row.similarity ?? 0),
    sharedTerms: Number(row.shared_terms ?? 0),
  }));
}

/**
 * Hard, like `forget_fact` (D13): the procedure and the proposal it came from.
 * The proposal still carries the title, and forgetting means it is not stored
 * anywhere anymore. The question to the owner in `messages` stays, like every message.
 */
export async function deleteProcedure(id: string): Promise<boolean> {
  const { data, error } = await db.from("procedures").delete().eq("id", id).select("proposal_id");
  if (error) throw new Error(`Procedure not deleted: ${error.message}`);
  const rows = (data ?? []) as Array<{ proposal_id: string | null }>;
  const proposalIds = rows.flatMap((row) => (row.proposal_id ? [row.proposal_id] : []));
  if (proposalIds.length > 0) {
    const { error: proposalError } = await db.from("memory_proposals").delete().in("id", proposalIds);
    if (proposalError) throw new Error(`Proposal for procedure not deleted: ${proposalError.message}`);
  }
  return rows.length > 0;
}
