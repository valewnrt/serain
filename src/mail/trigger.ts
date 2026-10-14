import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  MAIL_CLASSIFY_MAX_ATTACHMENTS,
  MAIL_CLASSIFY_MAX_CHARS,
  MAIL_CLASSIFY_MIN_CONFIDENCE,
  MAIL_KNOWN_ITEMS,
  MAIL_KNOWN_MAX_AGE_MS,
  MAIL_NOTIFY_BUNDLE,
  MAIL_NOTIFY_MAX_PER_DAY,
  MAIL_NOTIFY_MIN_INTERVAL_MS,
  MAIL_POLL_BATCH,
  MAIL_POLL_INTERVAL_MS,
  MAIL_SENT_REPLY_MAX_AGE_MS,
} from "../config/limits.js";
import { audit } from "../db/audit.js";
import { JUDGE_NONE_KEY, type Judge, type JudgeChoiceAnswer, type JudgeRequest } from "../agent/judge/types.js";
import { log } from "../log.js";
import { inQuietHours } from "../proactive/heartbeat.js";
import { WHENCE_RULE } from "../proactive/whence.js";
import { wrapUntrusted } from "../security/untrusted.js";
import { formatWallTime, toWallTime } from "../time.js";
import { maskCodes } from "./codes.js";
import { answeredOf } from "./replied.js";
import { validDue } from "./due.js";
import { busyLabel, type Busy } from "../calendar/match.js";
import { eventSpan, FINDING_QUESTION, judgedFinding, looksLikeFinding, validEvent, type BookingEvent } from "./findings.js";
import { KIND_OPTIONS, MAIL_KIND_INSTRUCTIONS, MAILBOX_LABEL, type Mailbox } from "./rules.js";
import { senderTrust, type SenderTrust } from "./sender-auth.js";
import { repliedIds, type SentMailStore } from "./sent.js";
import type { MailAccount, MailMessage } from "./types.js";
import { owner } from "../config/owner.js";

/**
 * The mail trigger (D33): classify new mails and write to the owner only when
 * something concerns them now.
 *
 * **Three occasions, not one (W14).** Any spam filter recognises urgency
 * alone. What makes an assistant useful is the moment "your appointment on
 * Friday was moved": a mail that changes something *known*. For that, the
 * trigger remembers commitments and appointments from classified mails
 * (`mail_items`, never the mail text) and hands them, together with the next
 * calendar events, to the classifier as a list.
 *
 * **First the code, then `judge`, then a model** (like the heartbeat and the
 * memory gate, D13, D19): own mails and bulk mail drop out at the header and
 * cost nothing. `judge` classifies the rest, typed and with a threshold (W31).
 * Only what is left gets a digest from a model. Here `judge` decides about
 * attention, never about permissions (D12).
 *
 * **A mail is untrusted content and stays so.** The turn that tells the owner
 * about it has the origin `untrusted`: three tools, no owner-only tools, no
 * standing approval, no way out. The digest comes from a model that has read
 * the mail, and is therefore framed just like the mail itself.
 */

export type MailCategory = "none" | "new_commitment" | "change" | "urgent";

/**
 * What exists in a mail turn. The registry refuses everything else.
 * `calendar_offer` exists only with a connected calendar and only with a
 * preview (addendum D33 of 2026-10-10). `mission_note` records a reply in the
 * history of a mission (D63, building block B): the note carries the mail's
 * taint, and the code limits the next check.
 */
export const MAIL_TRIGGER_TOOLS = ["send_message", "cancel_silently", "calendar_offer", "mission_note", "end_turn"] as const;

export interface KnownItem {
  /** Stable key for the classifier: `item:<uuid>` or `cal:<id>`. */
  key: string;
  what: string;
  when: string;
  from: string;
}

/**
 * How a mail is stored. The trigger reports the three from `MailCategory`
 * right away; it offers `booking` when the appointment is not yet in the
 * calendar; it never reports `lapse` itself, the deadline comes via the
 * heartbeat (D46); `reply` answers a mail Serain sent, `awaited` is one for
 * which Serain promised the owner to get in touch; both are always reported
 * (addendum D33 of 2026-10-13).
 */
export type ItemCategory = Exclude<MailCategory, "none"> | "booking" | "lapse" | AwaitedCategory;

/** Mails the owner is waiting for: without `judge`, always reported, also during probation. */
export type AwaitedCategory = "reply" | "awaited";

export interface MailItem {
  integrationId: string;
  externalId: string;
  threadKey: string;
  sender: string;
  subject: string;
  receivedAt: string;
  category: ItemCategory;
  summary: string;
  /**
   * `due`: due date as `YYYY-MM-DD`, resolved and checked (`validDue`), else
   * null (V4). `event`: only for `booking`, checked with `validEvent`.
   */
  commitment: { what: string; when: string; due: string | null; event?: BookingEvent } | null;
  /** `id` of the row this mail changes. Only for `change` on an `item:`. */
  changesItem: string | null;
  /** Already settled when stored: the trigger does not report it (`lapse`). */
  quiet?: boolean;
  /** What the code knows about the sender (`senderTrust`). Missing: not checked or nothing to say. */
  senderTrust?: SenderTrust | null;
}

export interface PendingItem extends MailItem {
  id: string;
  /** What the changed commitment said before, if there is one. */
  previous: { what: string; when: string } | null;
  /** Only when reporting: what is in the calendar around the time of a proposed appointment, from the code. */
  calendar?: Busy[];
  /** Only in the overview: has the owner already replied in the thread? Missing: not checked. */
  replied?: boolean;
  /** Only when reporting a reply (`reply`): its appointment is not yet in the calendar, the code offers it. */
  offer?: boolean;
}

export interface MailItemStore {
  known(since: Date, limit: number): Promise<KnownItem[]>;
  /** False if the mail already exists (crash between classifying and the cursor). */
  insert(item: MailItem): Promise<boolean>;
  pending(limit: number): Promise<PendingItem[]>;
  markNotified(ids: string[], at: Date): Promise<void>;
}

export interface MailTriggerState {
  lastPolledAt: string | null;
  lastNotifiedAt: string | null;
  notifyDay: string | null;
  notifyCount: number;
}

export const EMPTY_TRIGGER_STATE: MailTriggerState = { lastPolledAt: null, lastNotifiedAt: null, notifyDay: null, notifyCount: 0 };

export interface Digest {
  summary: string;
  what: string | null;
  when: string | null;
  /** Due date as `YYYY-MM-DD`, as the model resolves it; it is only checked when stored. */
  due: string | null;
  /** Only for a booking: the appointment as the model reads it. Checked with `validEvent`. */
  event?: { title: string; start: string; end: string | null; place: string | null; kind?: string | null | undefined } | null | undefined;
}

export interface MailTriggerDeps {
  accounts: readonly MailAccount[];
  items: MailItemStore;
  state: { load(): Promise<MailTriggerState>; save(state: MailTriggerState): Promise<void> };
  cursor: { load(accountId: string): Promise<Record<string, unknown> | null>; save(accountId: string, cursor: Record<string, unknown>): Promise<void> };
  judge: Judge;
  /** Digest of a mail the classifier let through. */
  digest(mail: { from: string; subject: string; text: string; received: string; booking?: boolean }): Promise<Digest>;
  /** Next calendar events as known items (W14). Optional: without a calendar only earlier mails count. */
  upcoming?: () => Promise<KnownItem[]>;
  /**
   * Is there already an event in the calendar at this time
   * (`FINDING_CALENDAR_MATCH_MS` around the start)? Null: no calendar or not
   * readable, then nothing is offered, because an offer for an appointment
   * that is already in it is noise.
   */
  calendarHas?: (span: { from: Date; to: Date; allDay: boolean }) => Promise<boolean | null>;
  /**
   * What is busy in the calendar at this time, only times, never titles. For a
   * proposed appointment: the owner should know right away whether they can make it.
   */
  calendarBusy?: (span: { from: Date; to: Date }) => Promise<Busy[]>;
  paused(): Promise<boolean>;
  /**
   * Every new mail, before classifying and independent of it, also bulk mail
   * and own mail: the watchers (D43). "Tell me when the shipping mail arrives"
   * is usually bulk mail. Gets only header data, never the text. `true`: Serain
   * promised the owner to get in touch about this mail (`expect_mail`,
   * addendum D33 of 2026-10-13).
   */
  onNewMail?(accountId: string, mail: { id: string; from: string; subject: string; date: string }): Promise<boolean>;
  /** Probation period of the proactive behaviour (W12, D26). */
  inProbation(): Promise<boolean>;
  /**
   * What Serain has sent (addendum D33 of 2026-10-13): the trigger always
   * reports a reply to it, without `judge`. Missing: every mail goes through `judge`.
   */
  sent?: SentMailStore;
  /** Whether the mailbox was readable, for src/health/integrations.ts: a trigger that cannot read should not stay silent. */
  health?(account: MailAccount, ok: boolean, error?: unknown): void;
  /** `recallQuery`: what memory searches for in the turn (`mailRecallQuery`). */
  fire(incoming: string, recallQuery: string): void;
  now?: () => Date;
}

export const digestSchema = z.object({
  summary: z.string().trim().min(1).max(240),
  what: z.string().trim().max(120).nullable(),
  when: z.string().trim().max(80).nullable(),
  // Lenient in the schema, strict in code (`validDue`): a badly formatted date should not cost the whole digest.
  due: z.string().trim().max(40).nullable(),
  event: z
    .object({
      title: z.string().trim().max(160),
      start: z.string().trim().max(40),
      end: z.string().trim().max(40).nullable(),
      place: z.string().trim().max(240).nullable(),
      // Lenient in the schema, strict in code (`bookingKind`): an unknown kind costs only the sentence, not the appointment.
      kind: z.string().trim().max(20).nullable().optional(),
    })
    .nullable()
    .optional(),
});

/**
 * The threshold is on "is it anything at all", not on the single category.
 * Live on 2026-09-20: "does Friday at 10 work for you?" split in half between
 * "new appointment" and "urgent", 0.5 per category, and therefore fell
 * through as "nothing", although the model was sure it was *something*.
 * Which of the three kinds it is, the most likely one decides afterwards.
 */
export function decideCategory(probabilities: Record<string, number>, choice: string): MailCategory {
  const kinds = ["change", "new_commitment", "urgent"] as const;
  const known = Object.keys(probabilities).some((key) => key === "none" || (kinds as readonly string[]).includes(key));
  // A backend without a usable distribution: then only its choice counts.
  if (!known) return (kinds as readonly string[]).includes(choice) ? (choice as MailCategory) : "none";
  const something = kinds.reduce((sum, key) => sum + (probabilities[key] ?? 0), 0);
  if (something < MAIL_CLASSIFY_MIN_CONFIDENCE) return "none";
  return [...kinds].sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0))[0] ?? "none";
}

function ownerDay(now: Date): string {
  const wall = toWallTime(now);
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

const sameAddress = (from: string, address: string) => from.toLowerCase().includes(address.toLowerCase());

/** What `judge` and the digest see of the text: codes masked, shortened. */
export function prepareMailText(text: string): string {
  return maskCodes(text).slice(0, MAIL_CLASSIFY_MAX_CHARS);
}

/**
 * Attachment names for `judge`: only names, never content. They come from the
 * mail and are untrusted content like the text, hence shortened, without line
 * breaks and with masked codes.
 */
export function prepareAttachmentNames(names: readonly string[]): string[] {
  return names.slice(0, MAIL_CLASSIFY_MAX_ATTACHMENTS).map((name) => maskCodes(name.replace(/[\u0000-\u001f\u007f]+/g, " ")).trim().slice(0, 100));
}

/**
 * The question to `judge` for a mail. Public, so that `pnpm eval:mail` asks
 * exactly the same request as the trigger. `text` comes from
 * `prepareMailText`, `attachments` from `prepareAttachmentNames`.
 */
export function mailJudgeRequest(
  mail: { from: string; subject: string; date: string; text: string; attachments: readonly string[] },
  known: readonly KnownItem[],
  mailbox: Mailbox,
  ask: { kind: boolean; finding: boolean } = { kind: true, finding: looksLikeFinding(mail.subject, mail.text) },
): JudgeRequest {
  const state = JSON.stringify({
    mail: {
      mailbox: MAILBOX_LABEL[mailbox],
      from: mail.from,
      subject: mail.subject,
      received: formatWallTime(new Date(mail.date)),
      text: mail.text,
      ...(mail.attachments.length > 0 ? { attachments: mail.attachments } : {}),
    },
    known: known.map((item) => ({ key: item.key, what: item.what, when: item.when, from: item.from })),
  });
  return {
    state,
    questions: [
      ...(ask.kind ? [{ key: "kind", type: "choice" as const, instructions: MAIL_KIND_INSTRUCTIONS, options: KIND_OPTIONS }] : []),
      ...(ask.finding ? [FINDING_QUESTION] : []),
      // Asked speculatively: the answer only counts if `kind` lands on `change`.
      ...(ask.kind && known.length > 0
        ? [
            {
              key: "which",
              type: "choice" as const,
              instructions: "Assuming `mail` changes an entry from `known`: which one?",
              options: [
                ...known.map((item) => ({ key: item.key, criterion: `${item.what} (${item.when}), from ${item.from}` })),
                { key: JUDGE_NONE_KEY, criterion: "None of these entries." },
              ],
            },
          ]
        : []),
    ],
  };
}

/**
 * The category from distribution and target: above the threshold the most
 * likely kind, and a change to nothing known is a new appointment for the owner.
 */
export function judgedCategory(
  kind: JudgeChoiceAnswer,
  which: JudgeChoiceAnswer | undefined,
  known: readonly KnownItem[],
): { category: MailCategory; target: KnownItem | null } {
  const category = decideCategory(kind.probabilities, kind.choice);
  if (category !== "change") return { category, target: null };
  const target = which && which.choice !== JUDGE_NONE_KEY && which.confidence >= MAIL_CLASSIFY_MIN_CONFIDENCE
    ? (known.find((item) => item.key === which.choice) ?? null)
    : null;
  return target ? { category, target } : { category: "new_commitment", target: null };
}

/** The arguments for `calendar_offer`, as the code builds them from the checked appointment. */
export function offerArgs(event: BookingEvent): { title: string; start: string; end?: string; location?: string; kind?: string } {
  return {
    title: event.title,
    start: event.start,
    ...(event.end ? { end: event.end } : {}),
    ...(event.place ? { location: event.place } : {}),
    ...(event.kind ? { kind: event.kind } : {}),
  };
}

/** What the code knows about a sender, in words for the reporting turn. */
const SENDER_TRUST_LABEL: Record<SenderTrust, string> = {
  known: `${owner.name} has been getting mail from this domain for a while, and their provider confirmed that the mail comes from there`,
  new: "their provider confirmed the domain, but no mail ever came from it before",
  unverified: "not verified, the sender address may be forged",
};

/**
 * When Serain warns about fraud (addendum D33 of 2026-10-13). Without this
 * rule the turn reported a trusted party (a law firm the owner works with) as
 * phishing based on the digest alone. Warnings continue, just not about what
 * the owner demonstrably knows. A known name alone is not enough: anyone can
 * write it into a mail, but not the domain.
 */
const SCAM_RULE = [
  "You only warn about fraud or phishing if a mail wants something sensitive (money, bank or login details, logging in",
  "via a link). If its sender is confirmed as known above, you do not warn and say factually what it wants. Otherwise",
  `look into the <context>: if ${owner.name} knows the sender, their company or their name, that is no suspicion of fraud, but`,
  "you tell them that the address is new or not verified before they send any data.",
].join(" ");

/** Is the owner waiting for this mail (`reply`, `awaited`)? */
function awaitedItem(item: Pick<MailItem, "category">): boolean {
  return item.category === "reply" || item.category === "awaited";
}

/**
 * What memory searches for in the mail turn: sender, subject and digest,
 * without the instructions around them. Untrusted content, but only as a
 * search: what comes back are the owner's own facts, and the turn has no way
 * out (D33).
 */
export function mailRecallQuery(items: readonly PendingItem[]): string {
  return items.map((item) => [item.sender, item.subject, item.summary].join("\n")).join("\n\n");
}

export function mailTriggerPrompt(items: readonly PendingItem[], serains: ReadonlySet<string> = new Set()): string {
  const label: Record<MailItem["category"], string> = {
    reply: `reply to a mail you sent on ${owner.name}'s behalf`,
    awaited: `mail ${owner.name} is waiting for: you promised them to get in touch as soon as it is here`,
    change: "change to something known",
    new_commitment: "new appointment or new deadline",
    urgent: "requires a reaction from them",
    booking: "booking or fixed appointment, not yet in their calendar",
    lapse: "deadline after which something expires",
  };
  const lines = items.map((item) =>
    [
      // With the mailbox: live on 2026-09-20 the model inferred the mailbox from the sender (a Gmail address).
      `- ${label[item.category]}, in mailbox ${item.integrationId}${serains.has(item.integrationId) ? " (your own address, the mail is to you)" : ""}, mail from ${item.sender}, ${formatWallTime(new Date(item.receivedAt))}, subject "${item.subject}"`,
      `  Digest: ${item.summary}`,
      item.previous ? `  Previously known: ${item.previous.what}${item.previous.when ? `, ${item.previous.when}` : ""}` : "",
      (item.category === "booking" || item.offer) && item.commitment?.event ? `  For calendar_offer: ${JSON.stringify(offerArgs(item.commitment.event))}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  // From the code, without titles: stands outside the frame, like the digest's date received.
  const calendar = items.flatMap((item, index) =>
    item.calendar && item.commitment?.event
      ? [`Calendar for mail ${index + 1} at ${item.commitment.event.start}: ${item.calendar.length === 0 ? "free" : `busy ${item.calendar.map(busyLabel).join(", ")}`}.`]
      : [],
  );
  // Likewise from the code: what is certain about the sender (addendum D33 of 2026-10-13).
  const senders = items.flatMap((item, index) => (item.senderTrust ? [`Sender of mail ${index + 1}: ${SENDER_TRUST_LABEL[item.senderTrust]}.`] : []));
  const bookings = items.some((item) => item.category === "booking");
  const replyOffers = items.some((item) => awaitedItem(item) && item.offer);
  const replies = items.some((item) => item.category === "reply");
  const awaited = items.some((item) => item.category === "awaited");
  return [
    `Mail trigger: something has arrived in ${owner.name}'s mailbox that might concern them. They have not asked anything.`,
    wrapUntrusted(lines.join("\n"), `${owner.name}'s inbox`),
    ...(calendar.length > 0
      ? [...calendar, "If someone asks about an appointment, add in half a sentence whether they have time then or what is already there (only the time)."]
      : []),
    ...senders,
    SCAM_RULE,
    "Write them exactly one short message with send_message, only what they need to know now: what has",
    "changed or what is coming up, from whom. For a change you name old and new. No list of all",
    `mails, no offer to do something${bookings || replyOffers ? " (except for the calendar, see below)" : ""}. If none of it is worth the interruption, call cancel_silently.`,
    ...(replies
      ? [
          `A reply to your own mail is always worth the interruption: ${owner.name} handed the matter to you and is waiting for it.`,
          "Tell them that the reply is here, what it says and what comes next.",
          "If it belongs to a mission under <missions> in the <context>, record it there with mission_note (from whom, what",
          "it says, what remains open). Leave the next check as it is.",
        ]
      : []),
    ...(awaited
      ? [
          `A mail ${owner.name} is waiting for is always worth the interruption: you promised them to get in touch. Tell them that it`,
          "is here and what it says that they wanted to know (time, place, ticket, decision). If it is not the mail they are",
          "waiting for after all, call cancel_silently.",
        ]
      : []),
    WHENCE_RULE,
    ...(bookings
      ? [
          "A booking that is not yet in their calendar, you lay out for them: calendar_offer with exactly the details from",
          "\"For calendar_offer\" (you choose the right calendar). The code sends the preview along with the sentence above it (\"your train",
          "booking for friday isn't in the calendar yet, add it?\"); you write nothing about the booking yourself and do not",
          `ask. If there is nothing else to report, you need no send_message. If it does not look like ${owner.name}'s own booking,`,
          "you offer nothing.",
        ]
      : []),
    ...(replyOffers
      ? [
          `If "For calendar_offer" stands with a reply to your mail or a mail ${owner.name} is waiting for, it is the appointment it is about, and it is not yet`,
          "in their calendar: first your message with send_message, then calendar_offer with exactly these details (you",
          "choose the right calendar). The code sends the sentence above the preview; do not announce the appointment in your message.",
        ]
      : []),
  ].join("\n");
}

export class MailTrigger {
  private readonly now: () => Date;
  private running = false;
  /** Last run, as last read or written: before it, the round does not even ask the database. */
  private lastPolledAt: number | null = null;

  constructor(private readonly deps: MailTriggerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Runs with the scheduler's tick; does something only once per interval. */
  async maybeRun(): Promise<void> {
    if (this.running || this.deps.accounts.length === 0) return;
    this.running = true;
    try {
      const now = this.now();
      // The scheduler ticks every 30 s, polling is rarer: the time in memory saves the query in between.
      if (this.lastPolledAt !== null && now.getTime() - this.lastPolledAt < MAIL_POLL_INTERVAL_MS) return;
      const state = await this.deps.state.load();
      if (state.lastPolledAt) this.lastPolledAt = new Date(state.lastPolledAt).getTime();
      if (this.lastPolledAt !== null && now.getTime() - this.lastPolledAt < MAIL_POLL_INTERVAL_MS) return;
      if (await this.deps.paused()) return;
      await this.deps.state.save({ ...state, lastPolledAt: now.toISOString() });
      this.lastPolledAt = now.getTime();
      for (const account of this.deps.accounts) await this.poll(account);
      await this.notify();
    } catch (error) {
      // A trigger that cannot read stays silent. The mailbox will still be there tomorrow.
      log.error("Mail trigger failed:", error);
      await audit("mail_trigger", { ran: false, reason: "error", detail: (error as Error).message });
    } finally {
      this.running = false;
    }
  }

  private async poll(account: MailAccount): Promise<void> {
    // Outside the try: if the database is gone, it is not the mailbox's fault.
    const cursor = await this.deps.cursor.load(account.id);
    let fresh;
    try {
      fresh = await account.newSince(cursor, MAIL_POLL_BATCH);
      this.deps.health?.(account, true);
    } catch (error) {
      this.deps.health?.(account, false, error);
      log.warn(`Mailbox ${account.id} not readable:`, (error as Error).message);
      await audit("mail_trigger", { ran: false, account: account.id, reason: "unreachable", detail: (error as Error).message });
      return;
    }
    // Oldest first, however the adapter delivers: W14 depends on the order.
    const inOrder = [...fresh.messages].sort((a, b) => a.date.localeCompare(b.date));
    for (const mail of inOrder) {
      const awaited =
        (await this.deps
          .onNewMail?.(account.id, { id: mail.id, from: mail.from, subject: mail.subject, date: mail.date })
          .catch((error: unknown) => void log.warn(`Watcher for mail in ${account.id} failed:`, (error as Error).message))) === true;
      try {
        await this.classify(account, mail, awaited);
      } catch (error) {
        // A mail that cannot be classified does not hold up the others and is not retried.
        log.warn(`Mail in ${account.id} not classified:`, (error as Error).message);
        await audit("mail_classified", { account: account.id, category: "none", reason: "error", detail: (error as Error).message });
      }
    }
    // Only after classifying: if the process crashes before, the round comes again,
    // and the unique constraint in `mail_items` keeps duplicates out.
    // Unchanged means: nothing to write (otherwise one update per mailbox on every run).
    if (!isDeepStrictEqual(fresh.cursor, cursor)) await this.deps.cursor.save(account.id, fresh.cursor);
  }

  private mailboxOf(account: MailAccount): Mailbox {
    return account.serains ? "serain" : account.id === this.deps.accounts.find((other) => !other.serains)?.id ? "main" : "secondary";
  }

  /**
   * Does the mail reply to one Serain sent? Only humans: an out-of-office note
   * is machine mail and takes the normal path. If the database is not
   * readable, `judge` decides as before.
   */
  private async repliesToSerain(account: MailAccount, mail: MailMessage, now: Date): Promise<boolean> {
    if (!this.deps.sent || mail.bulk || mail.automated) return false;
    const ids = repliedIds(mail);
    if (ids.length === 0) return false;
    try {
      return await this.deps.sent.ours(ids, new Date(now.getTime() - MAIL_SENT_REPLY_MAX_AGE_MS));
    } catch (error) {
      log.warn(`Reply to Serain's mail in ${account.id} cannot be checked:`, (error as Error).message);
      return false;
    }
  }

  /**
   * A mail the owner is waiting for (addendum D33 of 2026-10-13): the reply to
   * Serain's mail or one for which Serain promised them to get in touch.
   * Without `judge`, because whether it concerns them is already decided. The
   * digest also reads the appointment it is about: if it is not yet in the
   * calendar, Serain offers it when reporting.
   */
  private async keepAwaited(account: MailAccount, mail: MailMessage, now: Date, category: AwaitedCategory): Promise<void> {
    const trust = await senderTrust(account, mail.senderDomain, now);
    await audit("mail_classified", {
      account: account.id,
      mailbox: this.mailboxOf(account),
      attachments: prepareAttachmentNames(mail.attachments).length,
      category,
      ...(trust ? { sender: trust } : {}),
    });
    const digest = await this.deps.digest({ from: mail.from, subject: mail.subject, text: prepareMailText(mail.text), received: mail.date, booking: true });
    const due = validDue(digest.due, mail.date);
    const event = validEvent(digest.event, mail.date, now);
    await this.deps.items.insert({
      integrationId: account.id,
      externalId: mail.id.slice(mail.id.indexOf(":") + 1),
      threadKey: mail.threadKey,
      sender: mail.from,
      subject: mail.subject.slice(0, 200),
      receivedAt: mail.date,
      category,
      summary: digest.summary,
      commitment: digest.what
        ? { what: digest.what, when: digest.when ?? "", due, ...(event ? { event } : {}) }
        : event
          ? { what: event.title, when: digest.when ?? event.start, due: null, event }
          : null,
      changesItem: null,
      senderTrust: trust,
    });
  }

  private async classify(account: MailAccount, mail: MailMessage, awaited: boolean): Promise<void> {
    if (sameAddress(mail.from, account.address)) return void (await audit("mail_classified", { account: account.id, category: "none", reason: "own_mail" }));
    // Machine mail too: what the owner is waiting for is often a confirmation with a ticket.
    if (awaited) return this.keepAwaited(account, mail, this.now(), "awaited");
    if (await this.repliesToSerain(account, mail, this.now())) return this.keepAwaited(account, mail, this.now(), "reply");
    // Bulk and machine mail never interrupts the owner (D33). If it looks like a finding,
    // `judge` only asks about that (addendum D33 of 2026-10-10).
    const machine = mail.bulk ? "bulk" : mail.automated ? "automated" : null;
    const finding = looksLikeFinding(mail.subject, mail.text, mail.attachments);
    if (machine && !finding) return void (await audit("mail_classified", { account: account.id, category: "none", reason: machine }));

    const now = this.now();
    const [stored, upcoming] = await Promise.all([
      this.deps.items.known(new Date(now.getTime() - MAIL_KNOWN_MAX_AGE_MS), MAIL_KNOWN_ITEMS),
      this.deps.upcoming?.().catch(() => []) ?? Promise.resolve([]),
    ]);
    const known = [...stored, ...upcoming].slice(0, MAIL_KNOWN_ITEMS * 2);
    const text = prepareMailText(mail.text);
    const mailbox = this.mailboxOf(account);
    const attachments = prepareAttachmentNames(mail.attachments);
    const result = await this.deps.judge.ask(
      mailJudgeRequest({ from: mail.from, subject: mail.subject, date: mail.date, text, attachments }, known, mailbox, { kind: !machine, finding }),
    );
    const kind = result.answers["kind"] as JudgeChoiceAnswer | undefined;
    const which = result.answers["which"] as JudgeChoiceAnswer | undefined;
    const found = judgedFinding(result.answers["finding"] as JudgeChoiceAnswer | undefined);
    const { category, target } = kind ? judgedCategory(kind, which, known) : { category: "none" as const, target: null };
    // A change or a request weighs more than a finding. A "new appointment" that is a booking
    // is offered as a booking; a deadline only if the mail is nothing else.
    const planned: ItemCategory | "none" =
      found === "booking" && (category === "none" || category === "new_commitment") ? "booking" : category === "none" && found === "lapse" ? "lapse" : category;
    // Only for what gets reported: the search in the mailbox costs one IMAP round.
    const trust = planned === "none" ? null : await senderTrust(account, mail.senderDomain, now);
    await audit("mail_classified", {
      account: account.id,
      mailbox,
      // Only the count: names are content of the mail and do not belong in the audit log (W13).
      attachments: attachments.length,
      category: planned,
      ...(machine ? { machine } : {}),
      ...(kind
        ? {
            confidence: kind.confidence,
            // For debugging: what the backend chose, and whether it found a target for a change.
            choice: kind.choice,
            ...(kind.choice === "change" ? { change_target: target !== null, which_confidence: which?.confidence ?? null } : {}),
            p_something: Number((1 - (kind.probabilities["none"] ?? 0)).toFixed(2)),
            source: kind.source,
          }
        : {}),
      ...(finding ? { finding: found } : {}),
      ...(trust ? { sender: trust } : {}),
      known: known.length,
    });
    if (planned === "none") return;

    // Read the appointment for a proposal too: then the report sees whether the owner can make it.
    const digest = await this.deps.digest({ from: mail.from, subject: mail.subject, text, received: mail.date, booking: planned === "booking" || planned === "new_commitment" });
    const due = validDue(digest.due, mail.date);
    const event = planned === "booking" || planned === "new_commitment" ? validEvent(digest.event, mail.date, now) : null;
    // Without a checkable appointment a booking is nothing to lay out, without a day a deadline is none.
    const keep: ItemCategory | "none" =
      planned === "booking" && !event ? (category === "new_commitment" ? category : "none") : planned === "lapse" && !due ? "none" : planned;
    if (keep !== planned) await audit("mail_finding_dropped", { account: account.id, finding: planned, reason: planned === "booking" ? "no_event" : "no_due" });
    if (keep === "none") return;
    await this.deps.items.insert({
      integrationId: account.id,
      externalId: mail.id.slice(mail.id.indexOf(":") + 1),
      threadKey: mail.threadKey,
      sender: mail.from,
      subject: mail.subject.slice(0, 200),
      receivedAt: mail.date,
      category: keep,
      summary: digest.summary,
      commitment:
        keep === "booking" && event
          ? { what: event.title, when: digest.when ?? event.start, due: null, event }
          : digest.what
            ? { what: digest.what, when: digest.when ?? "", due, ...(event ? { event } : {}) }
            : null,
      changesItem: target?.key.startsWith("item:") ? target.key.slice(5) : null,
      ...(keep === "lapse" ? { quiet: true } : {}),
      senderTrust: trust,
    });
  }

  private async notify(): Promise<void> {
    const now = this.now();
    const pending = await this.deps.items.pending(MAIL_NOTIFY_BUNDLE);
    if (pending.length === 0) return;
    const state = await this.deps.state.load();
    const day = ownerDay(now);
    const sentToday = state.notifyDay === day ? state.notifyCount : 0;
    // Wait, do not discard: at night and between bundles everything stays and comes bundled.
    const wait = inQuietHours(now)
      ? "quiet_hours"
      : state.lastNotifiedAt && now.getTime() - new Date(state.lastNotifiedAt).getTime() < MAIL_NOTIFY_MIN_INTERVAL_MS
        ? "bundling"
        : null;
    if (wait) return;
    // Discard, do not wait: what fails at today's cap should not come as a backlog tomorrow (D26).
    if (sentToday >= MAIL_NOTIFY_MAX_PER_DAY) {
      await this.deps.items.markNotified(pending.map((item) => item.id), now);
      return void (await audit("mail_trigger", { ran: false, reason: "daily_limit", dropped: pending.length }));
    }
    // Probation (W12): only what the owner is waiting for. A new appointment and a booking are "might be useful".
    const probation = await this.deps.inProbation();
    const waited = probation ? pending.filter((item) => item.category !== "new_commitment" && item.category !== "booking") : pending;
    // If the owner has already replied while the report waited in the bundle or overnight, it is settled.
    const replied = await answeredOf(this.deps.accounts, waited.filter((item) => item.category !== "booking" && item.category !== "lapse"));
    if (replied.size > 0) await audit("mail_trigger", { ran: false, reason: "answered", dropped: replied.size });
    const wanted = await this.offerable(waited.filter((item) => !replied.has(item)));
    await this.deps.items.markNotified(pending.map((item) => item.id), now);
    if (wanted.length === 0) {
      const reason = waited.length < pending.length ? "probation" : replied.size === waited.length ? "answered" : "already_in_calendar";
      return void (await audit("mail_trigger", { ran: false, reason, dropped: pending.length }));
    }
    await audit("mail_trigger", { ran: true, items: wanted.length, dropped: pending.length - wanted.length });
    await this.deps.state.save({ ...(await this.deps.state.load()), lastNotifiedAt: now.toISOString() });
    this.deps.fire(
      mailTriggerPrompt(wanted, new Set(this.deps.accounts.filter((account) => account.serains).map((account) => account.id))),
      mailRecallQuery(wanted),
    );
  }

  /**
   * Bookings only if they are not yet in the calendar. Without a readable
   * calendar the booking is dropped: offering would not work anyway.
   */
  private async offerable(items: readonly PendingItem[]): Promise<PendingItem[]> {
    const kept: PendingItem[] = [];
    for (const item of items) {
      // The appointment it was about: offer only if it is certainly not in yet.
      if (awaitedItem(item)) {
        const span = item.commitment?.event ? eventSpan(item.commitment.event) : null;
        const has = span && this.deps.calendarHas ? await this.deps.calendarHas(span).catch(() => null) : null;
        if (span) await audit("mail_finding", { kind: item.category, offered: has === false, reason: has === true ? "in_calendar" : has === null ? "no_calendar" : null });
        kept.push(has === false ? { ...item, offer: true } : item);
        continue;
      }
      if (item.category === "new_commitment" && item.commitment?.event && this.deps.calendarBusy) {
        const span = eventSpan(item.commitment.event);
        const busy = span && !span.allDay ? await this.deps.calendarBusy(span).catch(() => null) : null;
        kept.push(busy ? { ...item, calendar: busy } : item);
        continue;
      }
      if (item.category !== "booking") {
        kept.push(item);
        continue;
      }
      const span = item.commitment?.event ? eventSpan(item.commitment.event) : null;
      const has = span && this.deps.calendarHas ? await this.deps.calendarHas(span).catch(() => null) : null;
      await audit("mail_finding", { kind: "booking", offered: has === false, reason: has === true ? "in_calendar" : has === null ? "no_calendar" : null });
      if (has === false) kept.push(item);
    }
    return kept;
  }

  /** After the turn: what went out counts against the daily cap. */
  async recordSent(messages: number): Promise<void> {
    if (messages <= 0) return;
    const state = await this.deps.state.load();
    const day = ownerDay(this.now());
    await this.deps.state.save({ ...state, notifyDay: day, notifyCount: (state.notifyDay === day ? state.notifyCount : 0) + messages });
  }
}
