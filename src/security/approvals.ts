import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  APPROVAL_LATER_BATCH,
  APPROVAL_LATER_GRACE_MS,
  APPROVAL_LATER_MAX_MS,
  APPROVAL_LATER_MIN_MS,
  APPROVAL_TTL_MS,
  MAX_PENDING_APPROVALS,
  MAX_SCHEDULED_APPROVALS,
} from "../config/limits.js";
import { owner } from "../config/owner.js";
import { audit } from "../db/audit.js";
import { log } from "../log.js";
import { stricterLevel, type ConfirmLater, type ToolDefinition, type ToolLevel, type ToolResult, type TurnState } from "../agent/tools/types.js";
import type { OutboundFile } from "../channel/types.js";
import { t, textLanguage } from "../i18n/catalog.js";
import { describeGrant, encodeGrant } from "../agent/tools/grants.js";
import { currentLanguage } from "../i18n/language.js";
import { security } from "../i18n/messages/security.js";
import { parseCommand, parseConsent, primaryWord } from "../i18n/words.js";
import { formatLater, laterExample, type LaterParse, type LaterRefusal } from "./later.js";

/**
 * Confirmation protocol (D8.3, D14). A tool of level `irreversible` or
 * `money` never runs out of a model turn. Instead:
 *
 * 1. The registry calls `request`: a preview goes to the owner, built by the tool
 *    from the validated arguments, never by the model. From now on the
 *    arguments are fixed in `approvals`.
 * 2. The owner puts 👍 on the preview or answers "yes" in its thread. Both are
 *    matched to the preview by its channel ID and evaluated deterministically:
 *    no model and no `judge` decides here (D12).
 * 3. `decide` claims the row atomically (only `pending`, only before expiry).
 *    Exactly the stored arguments run then, byte for byte what the preview
 *    showed.
 *
 * Everything here is deliberately dumb and narrow: a decision that does not
 * match exactly is none.
 */

export type ApprovalStatus = "pending" | "scheduled" | "approved" | "denied" | "expired" | "executed" | "failed" | "cancelled";
export type ApprovalScope = "once" | "standing";

export interface ApprovalRow {
  id: string;
  tool: string;
  level: "irreversible" | "money";
  args: Record<string, unknown>;
  preview: string;
  undo: string;
  grantKey: string;
  scope: ApprovalScope;
  status: ApprovalStatus;
  previewExternalId: string;
  /** Files in the thread below the preview (addendum D34 of 2026-10-08): a 👍 on one counts like one on the preview. */
  previewFileExternalIds: string[];
  requestMessageId: string | null;
  expiresAt: string;
  /** Scheduled for (addendum D14 of 2026-10-08), else null: then it runs with the approval. */
  executeAt: string | null;
  /** What the tool pinned when scheduling (`ConfirmLater.pin`); recomputed before running. */
  laterPin: Record<string, unknown> | null;
  /** Origin of the preview (D8.4), copied when scheduling so the overview can frame it. */
  taintSources: string[];
  /** Reissued from this expired confirmation (addendum D8 of 2026-10-10), else null. */
  reissuedFrom: string | null;
}

export interface NewApproval {
  tool: string;
  level: "irreversible" | "money";
  args: Record<string, unknown>;
  preview: string;
  undo: string;
  grantKey: string;
  token: string;
  previewExternalId: string;
  previewFileExternalIds: string[];
  requestMessageId: string | null;
  expiresAt: string;
  /** Only when reissuing an expired preview: its ID. */
  reissuedFrom?: string | null;
}

/** "yes, but later": what is fixed when scheduling. */
export interface ApprovalSchedule {
  executeAt: string;
  pin: Record<string, unknown>;
  taintSources: string[];
  decisionMessageId: string | null;
  now: string;
}

export type CancelVia = "thread_reply" | "tapback" | "cancel_schedule" | "kill_switch";

export interface ApprovalClaim {
  status: "approved" | "denied";
  scope: ApprovalScope;
  via: DecisionVia;
  decisionMessageId: string | null;
  now: string;
}

/** The seam to the database, so the protocol is testable without Supabase. */
export interface ApprovalStore {
  insert(row: NewApproval): Promise<ApprovalRow>;
  pendingByPreview(previewExternalId: string): Promise<ApprovalRow | null>;
  /** Atomic: only a `pending` row before expiry changes. Else null. */
  claim(id: string, claim: ApprovalClaim): Promise<ApprovalRow | null>;
  finish(id: string, status: "executed" | "failed", result: Record<string, unknown>): Promise<void>;
  /** Sets overdue rows to `expired` and returns them. */
  expireDue(now: string): Promise<ApprovalRow[]>;
  /** Kill switch: everything open expires at once. */
  expireAllPending(): Promise<number>;
  /** At start: whatever is still `approved` was running at the crash. Becomes `failed` and is returned (D52). */
  failApproved(result: Record<string, unknown>): Promise<ApprovalRow[]>;
  countPending(now: string): Promise<number>;
  hasGrant(tool: string, grantKey: string): Promise<boolean>;
  /** Atomic `pending` → `scheduled`, only before the preview expires. Else null. */
  schedule(id: string, plan: ApprovalSchedule): Promise<ApprovalRow | null>;
  /** A scheduled confirmation for this preview (or a file below it). */
  scheduledByPreview(previewExternalId: string): Promise<ApprovalRow | null>;
  /** All scheduled ones, next first. */
  scheduled(): Promise<ApprovalRow[]>;
  countScheduled(): Promise<number>;
  /** Due scheduled ones, next first. */
  dueScheduled(now: string, limit: number): Promise<ApprovalRow[]>;
  /** Atomic `scheduled` → `approved`, only once `execute_at` is reached. Else null. */
  claimDue(id: string, now: string): Promise<ApprovalRow | null>;
  /** Atomic `scheduled` → `failed` (missed). Else null. */
  missScheduled(id: string, result: Record<string, unknown>): Promise<ApprovalRow | null>;
  /** Atomic `scheduled` → `cancelled`. Else null. */
  cancelScheduled(id: string, via: CancelVia, now: string): Promise<ApprovalRow | null>;
  /** Kill switch: everything scheduled is cancelled. */
  cancelAllScheduled(now: string): Promise<number>;
  addGrant(grant: { tool: string; grantKey: string; approvalId: string }): Promise<void>;
  revokeGrants(via: string): Promise<number>;
  /**
   * The most recently expired confirmation for this preview (or a file below
   * it), only if it expired at its deadline, never through the kill switch.
   * Else null.
   */
  expiredByPreview(previewExternalId: string): Promise<ApprovalRow | null>;
  /**
   * Atomic: an expired confirmation is answered exactly once (reissued or
   * "this one expired."). Null if that already happened.
   */
  claimExpired(id: string, now: string): Promise<ApprovalRow | null>;
}

export type DecisionVia = "tapback" | "thread_reply";
export type Decision = "approve" | "approve_standing" | "deny";

/**
 * Reads a thread reply as a decision. Only the whole message counts: "yes but
 * change the subject" is not consent but conversation, and goes to the model
 * as a normal turn. The words are those of `src/i18n/words.ts` (English,
 * German and the current language; no wins; unknown is never consent).
 */
export function parseDecision(text: string, lang: string = currentLanguage()): Decision | null {
  return parseConsent(text, lang);
}

/** 👍 approves, 👎 declines, in every language. Any other tapback is no decision. */
export function decisionFromReaction(emoji: string): Decision | null {
  if (emoji === "👍") return "approve";
  if (emoji === "👎") return "deny";
  return null;
}

/** "serain revoke" ("serain widerruf", or the current language's word) withdraws all standing approvals. Outside the model. */
export function isRevokeCommand(text: string, lang: string = currentLanguage()): boolean {
  return parseCommand(text, lang) === "revoke";
}

export interface PreviewReceipt {
  externalId: string;
  messageId: string;
}

export interface ApprovalServiceDeps {
  store: ApprovalStore;
  /**
   * Sends the preview to the owner, as a message of its own and deliberately
   * not in the thread of the request: in iMessage a thread reply points to the
   * root of the thread. Were the preview below his message, his "yes" would
   * carry the ID of his own message instead of the preview's and could not be
   * matched. Null if it did not go out.
   *
   * `taintSources` is the taint of the requesting turn: the model chose the
   * arguments in the preview after it had seen foreign content. The preview is
   * stored with that origin (D8.4).
   */
  sendPreview(text: string, taintSources: readonly string[]): Promise<PreviewReceipt | null>;
  /**
   * Sends a file in the thread right below the preview (`ConfirmSpec.files`)
   * and returns its channel ID, null if it did not go out. Without this
   * function the preview only names the file.
   */
  sendPreviewFile?(file: OutboundFile, previewExternalId: string, taintSources: readonly string[]): Promise<string | null>;
  /**
   * May this tool run later (`ConfirmSpec.later`)? Read from the registry on
   * every scheduling, so a tool that no longer exists schedules nothing.
   */
  later?(tool: string): ConfirmLater | null;
  /**
   * A tool's definition from the registry, for an expired preview that is
   * reissued (addendum D8 of 2026-10-10). Without this function or without the
   * tool there is no new preview.
   */
  definition?(tool: string): ToolDefinition | null;
  /**
   * The origin of a preview from `messages` (D8.4). The reissued one carries
   * the same. Without the function, or when unreadable, it counts as foreign.
   */
  previewTaint?(previewExternalId: string): Promise<readonly string[]>;
  now?: () => Date;
}

export type DecisionOutcome =
  | { kind: "none" }
  | { kind: "denied"; approval: ApprovalRow }
  | { kind: "cancelled"; approval: ApprovalRow }
  | { kind: "approved"; approval: ApprovalRow }
  /** A 👍 on an expired preview: the same preview went out fresh, nothing runs. */
  | { kind: "reissued"; approval: ApprovalRow; from: ApprovalRow }
  /** A 👍 on an expired preview that is not reissued. `text` goes into its thread. */
  | { kind: "expired"; approval: ApprovalRow; text: string };

/** Fixed text above a reissued preview (decision of 2026-10-10). */
export function reissueHead(lang: string = currentLanguage()): string {
  return t(security.reissueHead, undefined, lang);
}

/** Fixed text when an expired preview is not reissued. */
export function expiredText(lang: string = currentLanguage()): string {
  return t(security.expired, undefined, lang);
}

export type LaterRefusalReason = LaterRefusal | "not_supported" | "too_many" | string;

export type LaterOutcome =
  | { kind: "none" }
  | { kind: "scheduled"; approval: ApprovalRow; at: Date; text: string }
  | { kind: "refused"; reason: LaterRefusalReason; text: string };

export type DueApproval =
  | { kind: "due"; approval: ApprovalRow; lateMs: number }
  | { kind: "missed"; approval: ApprovalRow; lateMs: number };

/** What the owner reads in the thread when he writes "yes, but later". Fixed text from the code, wording from the style round (addendum D23 of 2026-10-08). */
export function laterReply(
  outcome: { kind: "scheduled"; at: Date } | { kind: "refused"; reason: LaterRefusal | "not_supported" | "too_many"; at?: Date },
  lang: string = currentLanguage(),
): string {
  const yes = primaryWord("yes", lang);
  const no = primaryWord("no", lang);
  if (outcome.kind === "scheduled") {
    return t(security.laterScheduled, { when: formatLater(outcome.at, lang), no }, lang);
  }
  switch (outcome.reason) {
    case "past":
      return outcome.at
        ? t(security.laterPastAt, { when: formatLater(outcome.at, lang), example: laterExample(lang) }, lang)
        : t(security.laterPast, { example: laterExample(lang) }, lang);
    case "too_soon":
      return t(security.laterTooSoon, { minutes: Math.round(APPROVAL_LATER_MIN_MS / 60_000), yes }, lang);
    case "too_far":
      return t(security.laterTooFar, { days: Math.round(APPROVAL_LATER_MAX_MS / 86_400_000), yes }, lang);
    case "too_many":
      return t(security.laterTooMany, { count: MAX_SCHEDULED_APPROVALS, yes }, lang);
    case "not_supported":
      return t(security.laterNotSupported, { yes, no }, lang);
  }
}

/**
 * The text of the preview. The tool asks the question itself, at the start or
 * after the mail that is to go out (decision of 2026-10-13: "should i
 * unsubscribe you? yes, done"). Below it only the way back (W4) and, where a
 * standing approval exists, what "yes always" means. How to approve (👍 or
 * "yes" in the thread) and when the preview expires the owner knows; a 👍 on
 * an expired one comes back fresh (addendum D8 of 2026-10-10).
 *
 * With `ask` (only the offer from the mail, addendum D62 of 2026-10-10)
 * Serain's own sentence from the code stands above the preview; it already
 * contains the 👍. `standingFor` is the stored grant key; `describeGrant` puts
 * it in words in the language of the line (old plain-text keys verbatim).
 */
export function renderPreview(preview: string, undo: string, standingFor: string | null, ask: string | null = null, lang: string = currentLanguage()): string {
  const used = textLanguage(security.standingFor, lang);
  const standing = standingFor
    ? [t(security.standingFor, { yes: primaryWord("yes", used), always: primaryWord("always", used), scope: describeGrant(standingFor, used) }, used)]
    : [];
  const tail = [undo.trim(), ...standing];
  return [...(ask ? [ask.trim(), ""] : []), preview.trim(), ...tail].join("\n");
}

/** What a preview needs, built by the tool from the arguments. Throws if the tool cannot build it. */
async function buildPreview(
  def: ToolDefinition,
  level: "irreversible" | "money",
  args: Record<string, unknown>,
  standing: boolean,
): Promise<{ preview: string; undo: string; grantKey: string; ttlMs: number; text: string }> {
  const confirm = def.confirm!;
  const preview = await confirm.preview(args);
  const undo = confirm.undo(args);
  const scope = standing && level === "irreversible" ? confirm.grantKey?.(args) : undefined;
  // Stored and matched as canonical JSON, put in words only when shown (`src/agent/tools/grants.ts`).
  const grantKey = scope ? encodeGrant(scope) : "";
  const ttlMs = confirm.ttlMs ?? APPROVAL_TTL_MS;
  // Never for money, even though registration already rules it out: second belt.
  const ask = level === "irreversible" ? (confirm.ask?.(args) ?? null) : null;
  return { preview, undo, grantKey, ttlMs, text: renderPreview(preview, undo, grantKey || null, ask) };
}

export class ApprovalService {
  private readonly now: () => Date;

  constructor(private readonly deps: ApprovalServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Does a standing approval cover this call? Never for money (PLAN phase 5),
   * never in a turn the owner did not start, and never after foreign content
   * (D8.4): there he has to approve every time himself.
   */
  async covered(
    def: ToolDefinition,
    level: ToolLevel,
    args: Record<string, unknown>,
    turn: TurnState,
  ): Promise<boolean> {
    if (level !== "irreversible") return false;
    if (turn.origin !== "owner_message" || turn.tainted) return false;
    const scope = def.confirm?.grantKey?.(args);
    if (!scope) return false;
    return this.deps.store.hasGrant(def.name, encodeGrant(scope));
  }

  /** Creates the confirmation and sends the preview. The tool does not run here. */
  async request(
    def: ToolDefinition,
    level: "irreversible" | "money",
    args: Record<string, unknown>,
    turn: TurnState,
  ): Promise<ToolResult> {
    const confirm = def.confirm;
    if (!confirm) {
      // The registry does not even register such a tool. Second belt.
      return { ok: false, text: `Tool "${def.name}" has no preview and therefore does not run.` };
    }

    const now = this.now();
    const pending = await this.deps.store.countPending(now.toISOString());
    if (pending >= MAX_PENDING_APPROVALS) {
      await audit(
        "approval_denied",
        { tool: def.name, reason: "too_many_pending", pending },
        turn.triggerMessageId,
      );
      return {
        ok: false,
        text: `Too many previews are already waiting for ${owner.name}. Settle those first, then the next one.`,
      };
    }

    const { preview, undo, grantKey, ttlMs, text } = await buildPreview(def, level, args, true);
    const receipt = await this.deps.sendPreview(text, [...turn.taintSources]);
    if (!receipt?.externalId) {
      // Without a channel ID no 👍 can be matched. Then there is no confirmation.
      await audit(
        "approval_denied",
        { tool: def.name, reason: "preview_not_sent" },
        turn.triggerMessageId,
      );
      return { ok: false, text: "The preview did not go out, so nothing happens." };
    }
    turn.previewsSent += 1;
    turn.noteVisible();

    const fileIds = await this.sendFiles(def, args, receipt.externalId, turn.taintSources);

    const row = await this.deps.store.insert({
      tool: def.name,
      level,
      args,
      preview,
      undo,
      grantKey,
      token: randomBytes(24).toString("base64url"),
      previewExternalId: receipt.externalId,
      previewFileExternalIds: fileIds,
      requestMessageId: receipt.messageId,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    });
    await audit(
      "approval_requested",
      {
        approval_id: row.id,
        tool: def.name,
        level,
        args,
        origin: turn.origin,
        tainted: turn.tainted,
        expires_at: row.expiresAt,
      },
      turn.triggerMessageId,
    );
    return {
      ok: true,
      text:
        // The first line is the fact (it later stands in the history), then the instruction.
        `Not done yet, the preview is with ${owner.name}.\n` +
        "If he approves, it runs by itself and you learn the result. Do not write him anything more about it now.",
    };
  }

  /**
   * The file itself, so the owner sees what goes out. If it does not go out,
   * the preview stays valid: it names the file with its size.
   */
  private async sendFiles(def: ToolDefinition, args: Record<string, unknown>, previewExternalId: string, taint: readonly string[]): Promise<string[]> {
    const fileIds: string[] = [];
    for (const file of def.confirm?.files?.(args) ?? []) {
      const id = await this.deps.sendPreviewFile?.(file, previewExternalId, [...taint]);
      if (id) fileIds.push(id);
    }
    return fileIds;
  }

  /**
   * Evaluates a signal from the owner. The caller already checked the
   * allowlist; here it only matters whether it matches an open preview.
   */
  async decide(signal: {
    previewExternalId: string;
    decision: Decision;
    via: DecisionVia;
    decisionMessageId: string | null;
  }): Promise<DecisionOutcome> {
    let pending = await this.deps.store.pendingByPreview(signal.previewExternalId);
    // At its deadline but not yet collected by the tick: now, so it is treated like any expired one.
    if (pending && Date.parse(pending.expiresAt) <= this.now().getTime()) {
      await this.expireDue();
      pending = null;
    }
    if (!pending) {
      // A "yes" on a scheduled preview does nothing more; one on an expired preview no longer
      // fizzles silently (addendum D8 of 2026-10-10). "no" or 👎 on a scheduled one cancels it.
      if (signal.decision !== "deny") return this.onExpired(signal);
      const scheduled = await this.deps.store.scheduledByPreview(signal.previewExternalId);
      if (!scheduled) return { kind: "none" };
      const cancelled = await this.cancelScheduled(scheduled.id, signal.via, signal.decisionMessageId);
      return cancelled ? { kind: "cancelled", approval: cancelled } : { kind: "none" };
    }

    const standing =
      signal.decision === "approve_standing" &&
      pending.level === "irreversible" &&
      pending.grantKey.length > 0;
    const claimed = await this.deps.store.claim(pending.id, {
      status: signal.decision === "deny" ? "denied" : "approved",
      scope: standing ? "standing" : "once",
      via: signal.via,
      decisionMessageId: signal.decisionMessageId,
      now: this.now().toISOString(),
    });
    if (!claimed) {
      // Expired, or already claimed by a second signal.
      await audit("approval_denied", { approval_id: pending.id, reason: "not_claimable" });
      return { kind: "none" };
    }

    await audit(
      "approval_decided",
      {
        approval_id: claimed.id,
        tool: claimed.tool,
        status: claimed.status,
        scope: claimed.scope,
        via: signal.via,
      },
      signal.decisionMessageId ?? undefined,
    );
    if (claimed.status === "denied") return { kind: "denied", approval: claimed };

    if (standing) {
      await this.deps.store.addGrant({
        tool: claimed.tool,
        grantKey: claimed.grantKey,
        approvalId: claimed.id,
      });
      await audit("approval_grant", { tool: claimed.tool, grant_key: claimed.grantKey });
    }
    return { kind: "approved", approval: claimed };
  }

  /**
   * The owner approved an expired preview (addendum D8 of 2026-10-10,
   * decision 9). Nothing runs: the same preview goes out fresh with the same
   * stored arguments, a new deadline and a new ID, and only a new 👍 on it
   * counts.
   *
   * Limits, all in code: only what expired at its deadline (never what the
   * kill switch expired); once per preview (`claimExpired`), and a reissued one
   * is not reissued again; never money; not when the tool is gone, the
   * arguments no longer fit or the action became pointless
   * (`ConfirmSpec.stale`); not above the cap of open previews. Then the code
   * only says it expired. A standing approval never arises this way: the new
   * preview does not offer "yes always", and the expired "yes always" only
   * counts as a wish for a new one.
   */
  private async onExpired(signal: { previewExternalId: string; decisionMessageId: string | null }): Promise<DecisionOutcome> {
    const expired = await this.deps.store.expiredByPreview(signal.previewExternalId);
    if (!expired) return { kind: "none" };
    const now = this.now();
    const row = await this.deps.store.claimExpired(expired.id, now.toISOString());
    // Already answered: a second 👍 on the same old preview stays silent.
    if (!row) return { kind: "none" };
    const messageId = signal.decisionMessageId ?? undefined;
    const refuse = async (reason: string): Promise<DecisionOutcome> => {
      await audit("approval_reissue_refused", { approval_id: row.id, tool: row.tool, reason }, messageId);
      return { kind: "expired", approval: row, text: expiredText() };
    };

    if (row.level === "money") return refuse("money");
    if (row.reissuedFrom) return refuse("already_reissued");
    const def = this.deps.definition?.(row.tool) ?? null;
    if (!def?.confirm) return refuse("tool_gone");
    const parsed = z.object(def.schema).strict().safeParse(row.args);
    if (!parsed.success) return refuse("args_changed");
    const args = parsed.data as Record<string, unknown>;
    const level = def.consequence ? stricterLevel(def.level, def.consequence(args)) : def.level;
    if (level === "money") return refuse("money");
    if (level !== "irreversible") return refuse("level_changed");
    let stale: boolean;
    try {
      stale = def.confirm.stale?.(args) ?? false;
    } catch {
      stale = true;
    }
    if (stale) return refuse("stale");
    if ((await this.deps.store.countPending(now.toISOString())) >= MAX_PENDING_APPROVALS) return refuse("too_many_pending");

    let built: Awaited<ReturnType<typeof buildPreview>>;
    try {
      // Without a standing approval: "yes always" is not in the new preview and counts there as "yes".
      built = await buildPreview(def, level, args, false);
    } catch (error) {
      log.error(`Preview for ${row.tool} cannot be rebuilt:`, error);
      return refuse("preview_failed");
    }
    // The same origin as the old preview (D8.4); unreadable means foreign.
    const unknown = ["preview of unknown origin"];
    const taint = this.deps.previewTaint ? await this.deps.previewTaint(row.previewExternalId).catch(() => unknown) : unknown;
    const receipt = await this.deps.sendPreview(`${reissueHead()}\n\n${built.text}`, [...taint]);
    if (!receipt?.externalId) return refuse("preview_not_sent");
    const fileIds = await this.sendFiles(def, args, receipt.externalId, taint);
    const fresh = await this.deps.store.insert({
      tool: row.tool,
      level,
      // Exactly the stored ones, not the freshly parsed: what runs is what was already fixed.
      args: row.args,
      preview: built.preview,
      undo: built.undo,
      grantKey: "",
      token: randomBytes(24).toString("base64url"),
      previewExternalId: receipt.externalId,
      previewFileExternalIds: fileIds,
      requestMessageId: receipt.messageId,
      expiresAt: new Date(now.getTime() + built.ttlMs).toISOString(),
      reissuedFrom: row.id,
    });
    await audit(
      "approval_reissued",
      { approval_id: fresh.id, reissued_from: row.id, tool: row.tool, level, expires_at: fresh.expiresAt, tainted: taint.length > 0 },
      messageId,
    );
    return { kind: "reissued", approval: fresh, from: row };
  }

  /**
   * "yes, but later" (addendum D14 of 2026-10-08). The owner named a time in
   * the thread of an open preview, read by `parseLater`. Only what the tool
   * allows is scheduled (`ConfirmSpec.later`), never money, at most
   * `MAX_SCHEDULED_APPROVALS`. The arguments are fixed since the preview; only
   * the time, the state of `pin` and the preview's origin are added here. If
   * the preview matches nothing open, it is no decision (`none`) and the
   * message goes to the model as conversation.
   */
  async scheduleLater(signal: {
    previewExternalId: string;
    parse: LaterParse;
    decisionMessageId: string | null;
    /** Origin of the preview from `messages`; the caller reads it, unreadable means foreign. */
    taintSources: readonly string[];
  }): Promise<LaterOutcome> {
    const pending = await this.deps.store.pendingByPreview(signal.previewExternalId);
    if (!pending) return { kind: "none" };

    const refuse = async (reason: LaterRefusalReason, text: string): Promise<LaterOutcome> => {
      await audit("approval_later_refused", { approval_id: pending.id, tool: pending.tool, reason }, signal.decisionMessageId ?? undefined);
      return { kind: "refused", reason, text };
    };
    if (!signal.parse.ok) return refuse(signal.parse.reason, laterReply({ kind: "refused", reason: signal.parse.reason, at: signal.parse.at }));
    const spec = pending.level === "irreversible" ? (this.deps.later?.(pending.tool) ?? null) : null;
    if (!spec) return refuse("not_supported", laterReply({ kind: "refused", reason: "not_supported" }));
    let pin: Record<string, unknown>;
    try {
      const refusal = spec.refuse?.(pending.args) ?? null;
      if (refusal) return refuse(refusal.reason, refusal.text);
      pin = spec.pin(pending.args);
    } catch (error) {
      log.error(`Scheduling of ${pending.tool} cannot be checked:`, error);
      return refuse("not_supported", laterReply({ kind: "refused", reason: "not_supported" }));
    }
    if ((await this.deps.store.countScheduled()) >= MAX_SCHEDULED_APPROVALS) {
      return refuse("too_many", laterReply({ kind: "refused", reason: "too_many" }));
    }

    const at = signal.parse.at;
    const row = await this.deps.store.schedule(pending.id, {
      executeAt: at.toISOString(),
      pin,
      taintSources: [...signal.taintSources],
      decisionMessageId: signal.decisionMessageId,
      now: this.now().toISOString(),
    });
    if (!row) {
      await audit("approval_denied", { approval_id: pending.id, reason: "not_claimable" });
      return { kind: "none" };
    }
    await audit(
      "approval_decided",
      { approval_id: row.id, tool: row.tool, status: "scheduled", scope: "once", via: "thread_reply" },
      signal.decisionMessageId ?? undefined,
    );
    await audit("approval_scheduled", { approval_id: row.id, tool: row.tool, execute_at: row.executeAt }, signal.decisionMessageId ?? undefined);
    return { kind: "scheduled", approval: row, at, text: laterReply({ kind: "scheduled", at }) };
  }

  /** Scheduled ones, next first. For the overview. */
  scheduled(): Promise<ApprovalRow[]> {
    return this.deps.store.scheduled();
  }

  /** Cancels a scheduled confirmation. Null if it does not exist (any more). */
  async cancelScheduled(id: string, via: CancelVia, messageId: string | null = null): Promise<ApprovalRow | null> {
    const row = await this.deps.store.cancelScheduled(id, via, this.now().toISOString());
    if (row) await audit("approval_cancelled", { approval_id: row.id, tool: row.tool, via, execute_at: row.executeAt }, messageId ?? undefined);
    return row;
  }

  /**
   * Due scheduled confirmations, on the scheduler's tick. Whatever is up to
   * `APPROVAL_LATER_GRACE_MS` late is claimed (`approved`) and runs at the
   * caller through `executeApproved`, just like after a 👍; anything later is
   * missed and never runs. A crash on `approved` becomes `failed` at start and
   * is reported (D52), never repeated.
   */
  async dueLater(): Promise<DueApproval[]> {
    const now = this.now();
    const rows = await this.deps.store.dueScheduled(now.toISOString(), APPROVAL_LATER_BATCH);
    const out: DueApproval[] = [];
    for (const row of rows) {
      if (!row.executeAt) continue;
      const lateMs = now.getTime() - Date.parse(row.executeAt);
      // Never early, even if the query returns it (as in the scheduler).
      if (lateMs < 0) continue;
      if (lateMs > APPROVAL_LATER_GRACE_MS) {
        const missed = await this.deps.store.missScheduled(row.id, { ok: false, text: "Missed: Serain was not running at the scheduled time." });
        if (!missed) continue;
        await audit("approval_missed", { approval_id: row.id, tool: row.tool, late_ms: lateMs });
        out.push({ kind: "missed", approval: missed, lateMs });
        continue;
      }
      const claimed = await this.deps.store.claimDue(row.id, now.toISOString());
      if (!claimed) continue;
      await audit("approval_due", { approval_id: row.id, tool: row.tool, late_ms: lateMs });
      out.push({ kind: "due", approval: claimed, lateMs });
    }
    return out;
  }

  async complete(approval: ApprovalRow, result: ToolResult): Promise<void> {
    await this.deps.store.finish(approval.id, result.ok ? "executed" : "failed", {
      ok: result.ok,
      text: result.text.slice(0, 2_000),
    });
  }

  /** Runs on the scheduler's tick. Expiry is silent: no message, only audit. */
  async expireDue(): Promise<number> {
    const expired = await this.deps.store.expireDue(this.now().toISOString());
    for (const row of expired) {
      await audit("approval_expired", { approval_id: row.id, tool: row.tool });
    }
    return expired.length;
  }

  /**
   * Kill switch (D8.2): nothing open may still fire after "serain stop".
   * Scheduled ones are cancelled, not paused: after "serain resume" nothing
   * runs that the owner had approved before the stop.
   */
  async cancelAll(reason: string): Promise<{ expired: number; cancelled: number }> {
    const expired = await this.deps.store.expireAllPending();
    if (expired > 0) await audit("approval_expired", { reason, count: expired });
    const cancelled = await this.deps.store.cancelAllScheduled(this.now().toISOString());
    if (cancelled > 0) await audit("approval_cancelled", { via: "kill_switch", count: cancelled });
    return { expired, cancelled };
  }

  /**
   * At start (D52): a confirmation that was running at the crash is not
   * repeated (an irreversible action had better not run at all than twice),
   * but reported. Whether it went through, nobody knows afterwards.
   */
  async failInterrupted(): Promise<ApprovalRow[]> {
    const rows = await this.deps.store.failApproved({ ok: false, text: "Aborted: Serain was restarted while it ran." });
    for (const row of rows) await audit("approval_interrupted", { approval_id: row.id, tool: row.tool });
    return rows;
  }

  async revokeGrants(via: string): Promise<number> {
    const count = await this.deps.store.revokeGrants(via);
    await audit("approval_revoked", { via, count });
    log.info(`Standing approvals revoked: ${count}`);
    return count;
  }
}
