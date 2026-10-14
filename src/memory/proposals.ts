import { PROACTIVE_IDLE_MS, PROACTIVE_MAX_PER_DAY } from "../config/limits.js";
import { PROPOSALS } from "../config/memory.js";
import { audit } from "../db/audit.js";
import { log } from "../log.js";
import type { SendReceipt } from "../outbound.js";
import { inQuietHours } from "../proactive/heartbeat.js";
import { catalog, t, textLanguage, type Message } from "../i18n/catalog.js";
import { currentLanguage, currentLocale } from "../i18n/language.js";
import { memory as messages, memoryWords } from "../i18n/messages/memory.js";
import { normalizePhrase, wordSet } from "../i18n/words.js";
import { addDays, atWallTime, ownerDate, daysBetween, OWNER_TIMEZONE } from "../time.js";
import type { MemoryDeps } from "./deps.js";
import type { LessonDeriver } from "./lesson.js";
import { comparableText } from "./procedures.js";
import type { StoredProposal } from "./proposal-store.js";
import { owner } from "../config/owner.js";

/**
 * Proposals the owner confirms (V5, H5, D42). Two kinds, one path:
 *
 * - **Lesson** (V5): from a 👎 and the owner's correction after it, a model
 *   makes at most one sentence ("Alex wants real data for traffic
 *   questions").
 *   Collected, asked as one message on Sundays from 18:00. Confirmed, it
 *   becomes a fact (`preference`, category `style`) and reaches the model
 *   through the normal recall and the nightly consolidation, never through
 *   the style prompt (D23: only the owner changes that).
 * - **Procedure** (H5): after a successful multi-step task Serain proposes
 *   one through `propose_procedure`, the question goes out at once.
 *   Confirmed, it lands in `procedures` and is shown when a task fits.
 *
 * What the audit cannot afford (Hermes: 20 of 22 writes garbage, OpenClaw:
 * prompt laundering through the memory) is in the code here: no proposal
 * takes effect without the owner's 👍, the decision is made by code before
 * any model (pattern of D14), and a lesson never comes from a message Serain
 * wrote after untrusted content (D8.4, D13).
 *
 * The questions are fixed texts in the owner's language (`messages/memory.ts`);
 * the proposals in them (lesson, title, steps) stay as the model wrote them.
 */

/** The owner's answer to a proposal question, read in code. Numbers start at 1. */
export type ProposalChoice = { kind: "all" } | { kind: "none" } | { kind: "some"; numbers: number[] };

/** Accepted words of a kind, normalised: English, German and the current language (`wordSet` rules). */
function proposalWords(message: Message, lang: string): string[] {
  const lists = [message.en.split("|"), message.de.split("|"), lang === "en" || lang === "de" ? null : catalog.translatedWords(message, lang)];
  return [...new Set(lists.flatMap((list) => list ?? []).map(normalizePhrase).filter(Boolean))];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reads a thread reply as a decision. Only the whole message counts, as with
 * previews (D14): "1 and 3", "1,3", "only 2", "all", "none", in English,
 * German and the current language (translated words, after their check).
 * The consent words count too ("yes" takes all, "no" takes none; a word that
 * is both counts as none), numbers and 👍/👎 in every language. A number that
 * does not exist, anything next to it ("1, but shorter") or a word the code
 * does not know (another language without a translated catalog) is
 * conversation and goes to the model.
 */
export function parseProposalReply(text: string, count: number, lang: string = currentLanguage()): ProposalChoice | null {
  const value = normalizePhrase(text).replace(/[\s.!]+$/u, "");
  if (!value || count < 1) return null;
  if (value === "👎" || wordSet("no", lang).has(value) || proposalWords(memoryWords.proposalNone, lang).includes(value)) return { kind: "none" };
  if (value === "👍" || wordSet("yes", lang).has(value) || proposalWords(memoryWords.proposalAll, lang).includes(value)) return { kind: "all" };
  let rest = value;
  for (const only of proposalWords(memoryWords.proposalOnly, lang)) {
    if (rest.startsWith(`${only} `)) {
      rest = rest.slice(only.length + 1);
      break;
    }
  }
  for (const and of proposalWords(memoryWords.proposalAnd, lang)) {
    rest = rest.replace(new RegExp(`\\s+${escapeRegExp(and)}\\s+`, "gu"), " ");
  }
  const tokens = rest.split(/\s*[,;&+]\s*|\s+/u).filter(Boolean);
  if (tokens.length === 0 || !tokens.every((token) => /^\d{1,2}$/.test(token))) return null;
  const numbers = [...new Set(tokens.map(Number))].sort((a, b) => a - b);
  if (numbers.some((number) => number < 1 || number > count)) return null;
  return numbers.length === count ? { kind: "all" } : { kind: "some", numbers };
}

/** 👍 takes all, 👎 none. Any other tapback is no decision. */
export function proposalChoiceFromReaction(emoji: string): ProposalChoice | null {
  if (emoji === "👍") return { kind: "all" };
  if (emoji === "👎") return { kind: "none" };
  return null;
}

/** "today" or a short weekday within the last week, else the date, in the owner's time zone and in `lang`. */
function lessonLine(lesson: { body: string; createdAt: string }, number: number, now: Date, lang: string): string {
  const at = new Date(lesson.createdAt);
  const day = ownerDate(at);
  const ago = daysBetween(day, ownerDate(now));
  const body = lesson.body.replace(/[.!\s]+$/u, "");
  if (ago === 0) return t(messages.lessonLineToday, { number, lesson: body }, lang);
  const locale = currentLocale(lang);
  const spoken =
    ago > 0 && ago < 7
      ? new Intl.DateTimeFormat(locale, { timeZone: OWNER_TIMEZONE, weekday: "short" }).format(at).toLocaleLowerCase(locale).replace(/\.$/u, "")
      : new Intl.DateTimeFormat(locale, { timeZone: OWNER_TIMEZONE, day: "2-digit", month: "2-digit" }).format(at);
  return t(messages.lessonLineOn, { number, lesson: body, day: spoken }, lang);
}

/**
 * The collected question. Built by the code, so that the owner recognises the
 * pattern and the numbers are right. Per item where it comes from (style
 * round, addendum D23 of 2026-10-10): a lesson always comes from a 👎 and the
 * owner's words after it (V5), the day is the one it was made on. Lowercase
 * weekdays without a trailing dot, like the rest of the text.
 */
export function renderLessonOffer(lessons: ReadonlyArray<{ body: string; createdAt: string }>, now: Date): string {
  const lang = textLanguage(messages.lessonOfferHead);
  const head = t(messages.lessonOfferHead, { count: lessons.length }, lang);
  const tail = t(lessons.length === 1 ? messages.lessonOfferTailOne : messages.lessonOfferTailMany, {}, lang);
  return [head, ...lessons.map((lesson, index) => lessonLine(lesson, index + 1, now, lang)), tail].join("\n");
}

/** The question about a procedure. The owner reads exactly the title and steps that will later be in the context. */
export function renderProcedureOffer(procedure: { title: string; steps: string; when: string }): string {
  return [
    t(messages.procedureOfferHead),
    procedure.title,
    procedure.steps.trim(),
    t(messages.procedureOfferWhen, { when: procedure.when }),
    t(messages.procedureOfferYes),
  ].join("\n");
}

/** The latest instant "Sunday 18:00 in the owner's wall time" that is not in the future. */
export function offerWindowStart(now: Date): Date {
  const today = ownerDate(now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const back = (weekday - PROPOSALS.offerWeekday + 7) % 7;
  const start = atWallTime(addDays(today, -back), PROPOSALS.offerHour, 0);
  return start <= now ? start : atWallTime(addDays(today, -back - 7), PROPOSALS.offerHour, 0);
}

export type OfferSkip = "not_due" | "paused" | "quiet_hours" | "in_conversation" | "daily_limit" | "nothing_waiting";

/**
 * May the collected question go out now? Without I/O, so that every rule can
 * be tested on its own. The same silence rules as the heartbeat (D19),
 * because it is a message the owner did not ask for: not at night, not in
 * the middle of a conversation, not over the daily cap, not with the kill
 * switch pulled. If it misses the Sunday (conversation, cap, process gone),
 * it catches up within the same week, once.
 */
export function decideOffer(input: {
  now: Date;
  lastOfferAt: Date | null;
  paused: boolean;
  lastMessageAt: Date | null;
  sentToday: number;
  /** Proposals made before the latest Sunday 18:00 and not asked yet. */
  waiting: number;
}): { offer: true } | { offer: false; reason: OfferSkip } {
  const { now } = input;
  if (input.lastOfferAt && input.lastOfferAt >= offerWindowStart(now)) return { offer: false, reason: "not_due" };
  if (input.paused) return { offer: false, reason: "paused" };
  if (inQuietHours(now)) return { offer: false, reason: "quiet_hours" };
  if (input.lastMessageAt && now.getTime() - input.lastMessageAt.getTime() < PROACTIVE_IDLE_MS) {
    return { offer: false, reason: "in_conversation" };
  }
  if (input.sentToday >= PROACTIVE_MAX_PER_DAY) return { offer: false, reason: "daily_limit" };
  if (input.waiting === 0) return { offer: false, reason: "nothing_waiting" };
  return { offer: true };
}

/** The sentence the model proposes, checked in code. Null means: no proposal. */
export function cleanLesson(raw: string | null): string | null {
  if (!raw) return null;
  const lesson = raw.replace(/\s+/g, " ").trim();
  if (lesson.length < 8 || lesson.length > PROPOSALS.lessonMaxChars) return null;
  return lesson;
}

/** The criticised message, kept until the owner's next own message. */
export interface PendingCorrection {
  /** DB id of Serain's message. */
  messageId: string;
  body: string;
  /** Untrusted content it was derived from. Not empty: nothing is learned. */
  taintSources: readonly string[];
  at: number;
}

export interface ProposalDeps {
  memory: Pick<MemoryDeps, "store" | "embed" | "now">;
  deriveLesson: LessonDeriver;
  /** A question to the owner built by the code, as one bubble through the OutboundGate. Null if it did not go out. */
  send(text: string, kind: "lesson_offer" | "procedure_offer", taintSources: readonly string[]): Promise<SendReceipt | null>;
  /** 👍 on the owner's thread reply, with a text version if the tapback does not work. */
  acknowledge(externalId: string, fallbackText: string): Promise<void>;
  /** Kill switch (D8.2), freshly read. */
  paused(): Promise<boolean>;
  lastMessageAt(): Promise<Date | null>;
  /** Proactive messages today (daily cap of the heartbeat, W12). */
  sentToday(): Promise<number>;
  /** The collected question counts against the same cap. */
  recordSent(): Promise<void>;
}

export interface ProcedureOffer {
  title: string;
  steps: string;
  when: string;
  /** Taint of the turn (D8.4): the text can be influenced by untrusted content. The owner reads it verbatim. */
  taintSources: readonly string[];
  sourceMessageId: string;
}

export class ProposalService {
  private correction: PendingCorrection | null = null;
  private nextCheckAt = 0;
  /** Time of the last collected question, read once from the database. `undefined`: not read yet. */
  private lastOffer: Date | null | undefined = undefined;
  private lastSkip: OfferSkip | null = null;

  constructor(private readonly deps: ProposalDeps) {}

  private now(): Date {
    return this.deps.memory.now();
  }

  // ── V5: a 👎 and a correction become a proposal ─────────────────────────────

  /** The owner put 👎 on one of Serain's fresh messages (D24). The most recent counts. */
  noteCorrection(target: Omit<PendingCorrection, "at">): void {
    this.correction = { ...target, taintSources: [...target.taintSources], at: this.now().getTime() };
  }

  /**
   * The owner's next own message picks up the noted criticism, whether it came
   * in the same debounce window (folded) or after it. Once: the message after
   * that is no correction any more.
   */
  takeCorrection(): PendingCorrection | null {
    const correction = this.correction;
    this.correction = null;
    if (!correction) return null;
    return this.now().getTime() - correction.at <= PROPOSALS.correctionWindowMs ? correction : null;
  }

  /**
   * Runs after the turn, on the memory's chain. Carries its own errors: a
   * proposal that does not come about must not take the chat down with it.
   */
  async learnFromCorrection(input: { correction: PendingCorrection; text: string; messageId: string }): Promise<void> {
    const { correction } = input;
    try {
      // Prompt laundering (D8.4, D13): if the criticised message was derived
      // from untrusted content, the memory never sees it, not even as a cause.
      if (correction.taintSources.length > 0) {
        await audit("memory_proposal", { action: "skipped", kind: "lesson", reason: "tainted_source" }, input.messageId);
        return;
      }
      const lesson = cleanLesson(await this.deps.deriveLesson({ said: correction.body, correction: input.text }));
      if (!lesson) {
        await audit("memory_proposal", { action: "skipped", kind: "lesson", reason: "no_lesson" }, input.messageId);
        return;
      }
      const open = await this.deps.memory.store.proposals({ kind: "lesson", statuses: ["pending", "offered"] });
      if (open.some((proposal) => comparableText(proposal.body) === comparableText(lesson))) {
        await audit("memory_proposal", { action: "skipped", kind: "lesson", reason: "duplicate" }, input.messageId);
        return;
      }
      const stored = await this.deps.memory.store.insertProposal({
        kind: "lesson",
        title: "",
        body: lesson,
        trigger: "",
        status: "pending",
        offerExternalId: null,
        sourceMessageId: correction.messageId,
        correctionMessageId: input.messageId,
        taintSources: [],
        createdAt: this.now().toISOString(),
        offeredAt: null,
      });
      await audit("memory_proposal", { action: "created", kind: "lesson", proposal_id: stored.id }, input.messageId);
    } catch (error) {
      await audit("memory_error", { stage: "proposal_lesson", reason: (error as Error).message }, input.messageId);
      log.error("Proposal from the correction failed:", error);
    }
  }

  /** On the scheduler's tick: clean up what expired, ask on Sundays. Does something at most every ten minutes. */
  async maybeOffer(): Promise<void> {
    try {
      const now = this.now();
      if (now.getTime() < this.nextCheckAt) return;
      this.nextCheckAt = now.getTime() + PROPOSALS.offerCheckIntervalMs;
      await this.expire(now);
      await this.offerLessons(now);
    } catch (error) {
      await audit("memory_error", { stage: "proposal_offer", reason: (error as Error).message });
      log.error("Proposals: tick failed:", error);
    }
  }

  private async expire(now: Date): Promise<void> {
    const ids = await this.deps.memory.store.expireOffers(new Date(now.getTime() - PROPOSALS.offerTtlMs).toISOString(), now.toISOString());
    if (ids.length > 0) await audit("memory_proposal", { action: "expired", count: ids.length, proposal_ids: ids });
  }

  private async offerLessons(now: Date): Promise<void> {
    const store = this.deps.memory.store;
    if (this.lastOffer === undefined) {
      const last = await store.lastOfferAt("lesson");
      this.lastOffer = last ? new Date(last) : null;
    }
    const windowStart = offerWindowStart(now);
    // Cheap first: in the week after a question and at night not a single query.
    if ((this.lastOffer && this.lastOffer >= windowStart) || inQuietHours(now)) return;
    const waiting = (await store.proposals({ kind: "lesson", statuses: ["pending"], limit: PROPOSALS.offerMaxItems })).filter(
      (proposal) => new Date(proposal.createdAt) < windowStart,
    );
    if (waiting.length === 0) return;
    const [paused, lastMessageAt, sentToday] = await Promise.all([
      this.deps.paused(),
      this.deps.lastMessageAt(),
      this.deps.sentToday(),
    ]);
    const decision = decideOffer({ now, lastOfferAt: this.lastOffer, paused, lastMessageAt, sentToday, waiting: waiting.length });
    if (!decision.offer) {
      // The reason goes into the audit log, but only when it changes: otherwise the same one every ten minutes.
      if (decision.reason !== this.lastSkip) {
        this.lastSkip = decision.reason;
        await audit("memory_proposal", { action: "offer_skipped", kind: "lesson", reason: decision.reason, waiting: waiting.length });
      }
      return;
    }
    this.lastSkip = null;
    // Derived from the owner's words and Serain's clean message: no taint.
    const receipt = await this.deps.send(renderLessonOffer(waiting, now), "lesson_offer", []);
    if (!receipt?.externalId) {
      await audit("memory_proposal", { action: "offer_failed", kind: "lesson", waiting: waiting.length });
      return;
    }
    const ids = waiting.map((proposal) => proposal.id);
    await store.markProposalsOffered(ids, receipt.externalId, now.toISOString());
    this.lastOffer = now;
    await this.deps.recordSent();
    await audit("memory_proposal", { action: "offered", kind: "lesson", count: ids.length, proposal_ids: ids }, receipt.messageId);
  }

  // ── H5: procedures the owner approves ────────────────────────────────────────

  /** For `propose_procedure`. Checks cap and duplicate in code, sends the question, creates the proposal. */
  async offerProcedure(input: ProcedureOffer): Promise<{ ok: boolean; text: string }> {
    const store = this.deps.memory.store;
    const title = input.title.replace(/\s+/g, " ").trim();
    const when = input.when.replace(/\s+/g, " ").trim();
    const steps = input.steps.trim();
    const key = comparableText(title);
    const [active, asked] = await Promise.all([
      store.procedures(),
      store.proposals({ kind: "procedure", statuses: ["offered", "rejected"] }),
    ]);
    if (active.some((procedure) => comparableText(procedure.title) === key)) {
      return { ok: false, text: "A procedure with this title already exists. Do not ask again." };
    }
    const same = asked.find((proposal) => comparableText(proposal.title) === key);
    if (same) {
      return {
        ok: false,
        text:
          same.status === "offered"
            ? `The question about this procedure is already with ${owner.name}.`
            : `${owner.name} already declined this procedure. Do not ask again.`,
      };
    }
    const open = asked.filter((proposal) => proposal.status === "offered").length;
    if (active.length + open >= PROPOSALS.maxActiveProcedures) {
      return {
        ok: false,
        text: `There are already ${PROPOSALS.maxActiveProcedures} procedures or open questions about them. A new one only works once ${owner.name} deletes one.`,
      };
    }

    const receipt = await this.deps.send(renderProcedureOffer({ title, steps, when }), "procedure_offer", input.taintSources);
    if (!receipt?.externalId) return { ok: false, text: "The question did not go out, so nothing is remembered." };
    const now = this.now().toISOString();
    const stored = await store.insertProposal({
      kind: "procedure",
      title,
      body: steps,
      trigger: when,
      status: "offered",
      offerExternalId: receipt.externalId,
      sourceMessageId: input.sourceMessageId || null,
      correctionMessageId: null,
      taintSources: input.taintSources,
      createdAt: now,
      offeredAt: now,
    });
    await audit(
      "memory_proposal",
      { action: "offered", kind: "procedure", proposal_id: stored.id, tainted: input.taintSources.length > 0 },
      input.sourceMessageId || undefined,
    );
    return {
      ok: true,
      text: `The question is with ${owner.name}, 👍 means yes. Do not write them anything more about it.`,
    };
  }

  // ── Decision, for both kinds in one place ────────────────────────────────────

  /**
   * A tapback. The caller has checked allowlist and kill switch and already
   * asked the previews of the confirmation protocol (D14 takes precedence).
   * True means: the signal belonged to a proposal question and is done, even
   * if the question was already decided. A 👎 on an old collected question
   * must not start a correction turn that would then turn into a proposal
   * about proposals.
   */
  async onReaction(offerExternalId: string, emoji: string): Promise<boolean> {
    const choice = proposalChoiceFromReaction(emoji);
    if (!choice) return false;
    let offer: StoredProposal[];
    try {
      offer = await this.deps.memory.store.proposalsByOffer(offerExternalId);
    } catch (error) {
      // Not readable means here: rather do nothing than read a 👎 on a question as a correction.
      await audit("memory_error", { stage: "proposal_decision", reason: (error as Error).message });
      log.error("Proposals of the question not readable:", error);
      return true;
    }
    if (offer.length === 0) return false;
    await this.decide(offer, choice, "tapback", null, "");
    return true;
  }

  /**
   * A reply in the thread of a proposal question. Only a message that is a
   * decision as a whole counts; everything else is conversation (false).
   */
  async onReply(input: { offerExternalId: string; text: string; decisionMessageId: string; ackExternalId: string }): Promise<boolean> {
    let offer: StoredProposal[];
    try {
      offer = await this.deps.memory.store.proposalsByOffer(input.offerExternalId);
    } catch (error) {
      await audit("memory_error", { stage: "proposal_decision", reason: (error as Error).message }, input.decisionMessageId);
      log.error("Proposals of the question not readable:", error);
      return false;
    }
    if (!offer.some((proposal) => proposal.status === "offered")) return false;
    const choice = parseProposalReply(input.text, offer.length);
    if (!choice) return false;
    await this.decide(offer, choice, "thread_reply", input.decisionMessageId, input.ackExternalId);
    return true;
  }

  private async decide(
    offer: readonly StoredProposal[],
    choice: ProposalChoice,
    via: "tapback" | "thread_reply",
    decisionMessageId: string | null,
    ackExternalId: string,
  ): Promise<void> {
    const store = this.deps.memory.store;
    const at = this.now().toISOString();
    const accepted: string[] = [];
    const rejected: string[] = [];
    const created: string[] = [];
    const settled: string[] = [];
    for (const [index, proposal] of offer.entries()) {
      if (proposal.status !== "offered") continue;
      const take = choice.kind === "all" || (choice.kind === "some" && choice.numbers.includes(index + 1));
      if (!(await store.decideProposal(proposal.id, take ? "accepted" : "rejected", at))) continue;
      if (!take) {
        rejected.push(proposal.id);
        settled.push(proposal.id);
        continue;
      }
      accepted.push(proposal.id);
      try {
        created.push(await this.apply(proposal, at));
        settled.push(proposal.id);
      } catch (error) {
        // The text stays at the proposal, so nothing the owner confirmed is lost.
        await audit("memory_error", { stage: "proposal_apply", proposal_id: proposal.id, reason: (error as Error).message });
        log.error("Confirmed proposal not applied:", error);
      }
    }
    // Decided means: afterwards the text is only in the fact or procedure (D13).
    await store.clearProposalBody(settled);
    if (accepted.length + rejected.length === 0) return;
    const kind = offer[0]?.kind ?? "lesson";
    await audit(
      "memory_proposal",
      {
        action: "decided",
        kind,
        via,
        accepted: accepted.length,
        rejected: rejected.length,
        proposal_ids: [...accepted, ...rejected],
        [kind === "lesson" ? "fact_ids" : "procedure_ids"]: created,
      },
      decisionMessageId ?? undefined,
    );
    // Nothing follows a tapback, it already is the whole conversation. A typed
    // answer gets a 👍 as acknowledgement, like with previews.
    if (ackExternalId) await this.deps.acknowledge(ackExternalId, t(accepted.length > 0 ? messages.proposalAccepted : messages.proposalRejected));
  }

  /** Confirmed: a lesson becomes a fact, a procedure a procedure. Returns the new id. */
  private async apply(proposal: StoredProposal, at: string): Promise<string> {
    const store = this.deps.memory.store;
    const embedText = proposal.kind === "lesson" ? proposal.body : `${proposal.title}\n${proposal.trigger}`;
    // Without an embedding it goes on, only worse: it is then found through the full text.
    let embedding: number[] | null = null;
    try {
      const [vector] = await this.deps.memory.embed([embedText]);
      embedding = vector ?? null;
    } catch (error) {
      log.warn("Proposal applied without embedding:", (error as Error).message);
    }
    if (proposal.kind === "lesson") {
      const fact = await store.insertFact({
        subject: "owner",
        category: "style",
        content: proposal.body,
        // The owner confirmed the sentence verbatim.
        confidence: 1,
        kind: "preference",
        // A lesson is how the owner wants something.
        area: "preferences",
        validFrom: null,
        validUntil: null,
        sourceMessageId: proposal.correctionMessageId,
        embedding,
        createdAt: at,
      });
      return fact.id;
    }
    const procedure = await store.insertProcedure({
      title: proposal.title,
      body: proposal.body,
      trigger: proposal.trigger,
      embedding,
      proposalId: proposal.id,
      createdAt: at,
    });
    return procedure.id;
  }
}
