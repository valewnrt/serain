import { createHash } from "node:crypto";
import { SIGNALS } from "./channel/signals.js";
import type { Channel, MessageEffect, OutboundFile, SendExtras } from "./channel/types.js";
import {
  DELIVERY_WINDOW_MS,
  EDIT_WINDOW_MS,
  FILE_MAX_BYTES,
  MAX_BUBBLE_CHARS,
  MAX_EDITS_PER_MESSAGE,
  OUTBOUND_DEDUPE_WINDOW_MS,
  OUTBOUND_MAX_PER_HOUR,
  OUTBOUND_MIN_INTERVAL_MS,
} from "./config/limits.js";
import { audit } from "./db/audit.js";
import { editableOutbound, recentOutboundFingerprints, storeEdit, storeOutbound } from "./db/messages.js";
import { DeliveryLog, type DeliveryHealth } from "./health/delivery.js";
import { dedupeKey, plainOutbound, prepareOutbound, splitIntoBubbles, stripMarkdown, styledBubble } from "./text/format.js";
import { log } from "./log.js";
import { VOICE_MESSAGE_MARKER } from "./media/attachments.js";

/**
 * The only way out. Target check, Markdown translation, chunking into bubbles,
 * dedupe (W23), rate limit (D8.8) and the audit hang here. No other code calls
 * `channel.send` directly. That is also why delivery is counted here (D44):
 * what the channel throws when sending is the only signal that messages do not
 * arrive while Photon's stream stands.
 */

export interface SendOptions {
  /** Channel id of the message being replied to. Only if the channel can do threads. */
  replyTo?: string;
  /**
   * Send an identical message anyway. Only for previews of the confirmation
   * protocol: two identical actions are two confirmations, and a swallowed
   * preview means the action never runs (live test 2026-09-20). This is capped
   * by the number of open previews.
   */
  allowDuplicate?: boolean;
  /**
   * Do not split into bubbles. For previews (D14): a 👍 is matched by the
   * preview's channel id, and there is only one. A mail with paragraphs would
   * otherwise make several bubbles, and the 👍 on the last one, where the
   * question is, would hit nothing.
   */
  singleBubble?: boolean;
  /**
   * Foreign content the text is derived from (D8.4). Travels to every bubble
   * in `messages`; later turns then frame them as foreign content instead of
   * Serain's own word. Without it: text from Serain's own code.
   */
  taintSources?: readonly string[];
  /** Effect on the first bubble if the channel can do it (D48). */
  effect?: MessageEffect;
  /**
   * May Serain edit this message later (D48)? Only for messages from the
   * message tools. Everything else stays as it went out: a preview that
   * changes after the 👍 is one the owner never confirmed.
   */
  editable?: boolean;
  /**
   * Verbatim as one bubble, without Markdown parsing. For values to copy
   * (addendum D23 of 2026-10-08): `ab_cd_ef` must not turn into italics.
   */
  verbatim?: boolean;
}

/** How an attempt to edit one's own message went. */
export type EditOutcome =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "not_found" | "ambiguous" | "empty" | "too_long" | "edit_limit" | "rate_limited" | "failed" };

/** Channel and DB id of a sent bubble. */
export interface SendReceipt {
  externalId: string;
  messageId: string;
}

/**
 * How a send attempt went. `duplicate` means: the same words just went out,
 * so the owner has it. For a reminder that is delivered, not a failure.
 * `failed`: nothing went out (empty, limit, channel). `undelivered`: the
 * channel broke off before all bubbles were out; with `sent` the first ones got
 * through (addendum D52 of 2026-10-13).
 */
export type SendOutcome =
  | { status: "sent"; receipt: SendReceipt; undelivered?: true }
  | { status: "duplicate" }
  | { status: "failed"; undelivered?: true };

interface RecentSend {
  /** `fingerprint` of the normalized text or the file bytes. */
  key: string;
  at: number;
}

/**
 * Fingerprint for the duplicate block. Stored on every sent bubble in
 * `messages.raw.dedupe`, so a new process knows what the old one just sent:
 * without it, a reminder that still went out before a crash went out a second
 * time afterwards (`Scheduler.start`).
 */
function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export class OutboundGate {
  private lastSentAt = 0;
  private sentTimestamps: number[] = [];
  private recentSends: RecentSend[] = [];
  private readonly delivery = new DeliveryLog();

  constructor(
    private readonly channel: Channel,
    private readonly ownerPhone: string,
  ) {}

  /**
   * Sends to the owner. Any other number is refused: messages to third parties
   * are level 3 and simply not provided for in phase 0 (D8.8).
   *
   * Long replies go out as several bubbles; the rate limit counts every bubble
   * on its own.
   */
  async sendToOwner(
    text: string,
    context: Record<string, unknown> = {},
    options: SendOptions = {},
  ): Promise<boolean> {
    return (await this.sendToOwnerWithReceipt(text, context, options)) !== null;
  }

  /**
   * Like `sendToOwner`, but returns the ids of the first bubble. The
   * confirmation protocol needs them: a 👍 is matched by the preview's channel
   * id (D8.3). Null if nothing went out.
   */
  async sendToOwnerWithReceipt(
    text: string,
    context: Record<string, unknown> = {},
    options: SendOptions = {},
  ): Promise<SendReceipt | null> {
    const outcome = await this.trySendToOwner(text, context, options);
    return outcome.status === "sent" ? outcome.receipt : null;
  }

  /**
   * Like `sendToOwnerWithReceipt`, but says why nothing went out. The duplicate
   * block applies from the moment of the check, not only after sending: two
   * turns with the same message shortly after each other (say a result and its
   * follow-up turn) both wait for `spaceOut`, and without the reservation both
   * would get through.
   */
  async trySendToOwner(
    text: string,
    context: Record<string, unknown> = {},
    options: SendOptions = {},
  ): Promise<SendOutcome> {
    const prepared = options.verbatim ? plainOutbound(text) : prepareOutbound(text);
    const body = options.verbatim ? prepared : stripMarkdown(text);
    const bubbles = (options.singleBubble || options.verbatim ? [prepared] : splitIntoBubbles(prepared))
      .map(styledBubble)
      .filter((bubble) => bubble.text.length > 0);
    if (bubbles.length === 0) {
      log.warn("Empty message is not sent");
      return { status: "failed" };
    }

    const key = fingerprint(dedupeKey(body));
    if (this.isRecent(key) && !options.allowDuplicate) {
      // W23: the same follow-up question must not go out twice word for word.
      await audit("outbound_duplicate", { chars: body.length, ...context });
      log.warn("Identical message shortly after, not sent again");
      return { status: "duplicate" };
    }
    // Synchronously after the check, before the first `await`: from here it counts as under way.
    const reservation = this.reserve(key);

    let sent = 0;
    let first: SendReceipt | null = null;
    let undelivered = false;
    for (const [index, bubble] of bubbles.entries()) {
      if (!(await this.rateLimitOk(context))) break;
      await this.spaceOut();
      // From here on it is a real attempt at the channel. Rate limit and
      // duplicates already bailed out above and do not count for delivery: those
      // are Serain's own limits, not a broken line.
      let delivered = false;
      try {
        // Every bubble hangs on the thread. When only the first one did, iMessage
        // put a gap between it and the rest (checked 2026-10-03).
        const replyTo = options.replyTo;
        const extras = this.extras(bubble.styles, index === 0 ? options.effect : undefined);
        const result =
          replyTo && this.channel.capabilities.replyThreads && this.channel.sendReply
            ? await this.channel.sendReply(this.ownerPhone, bubble.text, replyTo, extras)
            : await this.channel.send(this.ownerPhone, bubble.text, extras);
        delivered = true;
        this.lastSentAt = Date.now();
        this.sentTimestamps.push(this.lastSentAt);
        await this.recordDelivery(true);
        const stored = await storeOutbound(
          this.channel.name,
          this.ownerPhone,
          bubble.text,
          result,
          { taintSources: options.taintSources ?? [] },
          { editable: options.editable === true, dedupe: key },
        );
        await audit(
          "outbound",
          {
            chars: bubble.text.length,
            bubble: index + 1,
            bubbles: bubbles.length,
            status: result.status,
            service: result.service,
            ...(result.retried ? { retried: true } : {}),
            ...(result.externalId ? {} : { external_id_unknown: true }),
            ...(extras.styles ? { styled: extras.styles.length } : {}),
            ...(extras.effect ? { effect: extras.effect } : {}),
            ...(options.taintSources?.length ? { tainted: true } : {}),
            ...context,
          },
          stored.id,
        );
        first ??= { externalId: result.externalId, messageId: stored.id };
        sent += 1;
      } catch (error) {
        // If only storing fails, the message still arrived at the channel: that
        // is a database problem, not a failed delivery.
        if (!delivered) await this.recordDelivery(false, (error as Error).message);
        undelivered = !delivered;
        await audit("outbound_failed", { reason: (error as Error).message, ...(undelivered ? { bubble: index + 1, bubbles: bubbles.length } : {}), ...context });
        log.error("Sending failed:", error);
        break;
      }
    }

    this.release(reservation, sent > 0);
    const lost = undelivered ? { undelivered: true as const } : {};
    return first ? { status: "sent", receipt: first, ...lost } : { status: "failed", ...lost };
  }

  /**
   * Sends the owner a file Serain's code created (.ics, vCard, PDF). The same
   * limits as for text: only to the owner, rate limit, duplicates, audit,
   * origin on the row in `messages`. Instead of the bytes, `[File: name]` and a
   * line about what it is stand there, so the history knows what went out.
   *
   * For delivery (D44) only success counts: if the channel refuses
   * attachments (Photon Free does not guarantee them), that is not a broken
   * line, and three refused files must not report an outage to the owner.
   */
  async sendFileToOwner(
    file: OutboundFile,
    caption: string,
    context: Record<string, unknown> = {},
    options: Pick<SendOptions, "taintSources" | "replyTo" | "allowDuplicate"> & {
      /** For the owner's own files under a preview; files Serain created stay at `FILE_MAX_BYTES`. */
      maxBytes?: number;
    } = {},
  ): Promise<SendReceipt | null> {
    if (!this.channel.capabilities.files || !this.channel.sendFile) return null;
    if (file.voice && !this.channel.capabilities.voice) return null;
    if (file.body.length === 0 || file.body.length > (options.maxBytes ?? FILE_MAX_BYTES)) {
      await audit("outbound_failed", { reason: "file_size", bytes: file.body.length, ...context });
      return null;
    }
    const key = fingerprint(`file:${createHash("sha256").update(file.body).digest("hex")}`);
    if (this.isRecent(key) && !options.allowDuplicate) {
      await audit("outbound_duplicate", { bytes: file.body.length, file: file.mimeType, ...context });
      return null;
    }
    const reservation = this.reserve(key);
    if (!(await this.rateLimitOk({ kind: "file", ...context }))) {
      this.release(reservation, false);
      return null;
    }
    await this.spaceOut();
    let result;
    try {
      result = await this.channel.sendFile(this.ownerPhone, file, options.replyTo);
    } catch (error) {
      this.release(reservation, false);
      await audit("outbound_failed", { reason: (error as Error).message, file: file.mimeType, ...context });
      log.error("File not sent:", error);
      return null;
    }
    this.lastSentAt = Date.now();
    this.sentTimestamps.push(this.lastSentAt);
    this.release(reservation, true);
    await this.recordDelivery(true);
    let messageId = "";
    try {
      // A voice message is in the history with its spoken text (D59): that is what the owner heard.
      const body = file.voice ? `${VOICE_MESSAGE_MARKER} ${caption}` : `[File: ${file.name}]${caption ? ` ${caption}` : ""}`;
      const stored = await storeOutbound(
        this.channel.name,
        this.ownerPhone,
        body,
        result,
        { taintSources: options.taintSources ?? [] },
        { dedupe: key },
      );
      messageId = stored.id;
      await audit(
        "outbound",
        {
          file: file.mimeType,
          bytes: file.body.length,
          status: result.status,
          ...(file.voice ? { voice: true } : {}),
          ...(options.taintSources?.length ? { tainted: true } : {}),
          ...context,
        },
        stored.id,
      );
    } catch (error) {
      // It arrived; only storing is stuck. As with text, not a failure of delivery.
      await audit("outbound_failed", { reason: (error as Error).message, stage: "store", file: file.mimeType, ...context });
      log.error("Sent file not stored:", error);
    }
    return { externalId: result.externalId, messageId };
  }

  /**
   * Sends the owner a link preview in a bubble of its own (addendum D48 of
   * 2026-10-08). The turn already checked the URL (`TurnState.previewTargets`):
   * a page a tool opened itself, without tracking parameters. The same limits
   * as for text; `messages` holds the URL, the audit log only the host. Null if
   * nothing went out; `duplicate` if the same preview just went out.
   */
  async sendLinkToOwner(
    url: string,
    context: Record<string, unknown> = {},
    options: Pick<SendOptions, "taintSources" | "replyTo"> = {},
  ): Promise<SendReceipt | "duplicate" | null> {
    if (!this.channel.capabilities.richLinks || !this.channel.sendRichLink) return null;
    const host = new URL(url).hostname;
    const key = fingerprint(`link:${url}`);
    if (this.isRecent(key)) {
      await audit("outbound_duplicate", { richlink: true, host, ...context });
      return "duplicate";
    }
    const reservation = this.reserve(key);
    if (!(await this.rateLimitOk({ kind: "richlink", ...context }))) {
      this.release(reservation, false);
      return null;
    }
    await this.spaceOut();
    let result;
    try {
      result = await this.channel.sendRichLink(this.ownerPhone, url, options.replyTo);
    } catch (error) {
      // As with files: a refused preview is not a broken line (D44), the text before it did go out.
      this.release(reservation, false);
      await audit("outbound_failed", { reason: (error as Error).message, richlink: true, host, ...context });
      log.error("Link preview not sent:", error);
      return null;
    }
    this.lastSentAt = Date.now();
    this.sentTimestamps.push(this.lastSentAt);
    this.release(reservation, true);
    await this.recordDelivery(true);
    let messageId = "";
    try {
      const stored = await storeOutbound(this.channel.name, this.ownerPhone, url, result, { taintSources: options.taintSources ?? [] }, { dedupe: key });
      messageId = stored.id;
      await audit(
        "outbound",
        { richlink: true, host, status: result.status, ...(options.taintSources?.length ? { tainted: true } : {}), ...context },
        stored.id,
      );
    } catch (error) {
      await audit("outbound_failed", { reason: (error as Error).message, stage: "store", richlink: true, host, ...context });
      log.error("Sent link preview not stored:", error);
    }
    return { externalId: result.externalId, messageId };
  }

  /**
   * Edits one of Serain's own messages of the last minutes (D48), found by a
   * piece of its text. Only messages marked as editable when sent; the new
   * text goes out as plain text (the channel cannot format when editing) and
   * has to fit into one bubble.
   *
   * The origin stays that of the message: editing only happens from a clean
   * turn the owner triggered (`edit_message` is `ownerOriginOnly`), so no
   * foreign content is added.
   */
  async editOwn(find: string, text: string, context: Record<string, unknown> = {}): Promise<EditOutcome> {
    if (!this.channel.capabilities.edit || !this.channel.edit) return { ok: false, reason: "unsupported" };
    const body = stripMarkdown(text);
    if (!body) return { ok: false, reason: "empty" };
    if (body.length > MAX_BUBBLE_CHARS) return { ok: false, reason: "too_long" };

    const needle = dedupeKey(stripMarkdown(find));
    if (!needle) return { ok: false, reason: "not_found" };
    const candidates = (await editableOutbound(this.ownerPhone, new Date(Date.now() - EDIT_WINDOW_MS))).filter(
      (row) => dedupeKey(row.body).includes(needle),
    );
    if (candidates.length === 0) return { ok: false, reason: "not_found" };
    if (candidates.length > 1) return { ok: false, reason: "ambiguous" };
    const target = candidates[0]!;
    const edits = typeof target.raw.edits === "number" ? target.raw.edits : 0;
    if (edits >= MAX_EDITS_PER_MESSAGE) return { ok: false, reason: "edit_limit" };

    if (!(await this.rateLimitOk({ kind: "edit", ...context }))) return { ok: false, reason: "rate_limited" };
    await this.spaceOut();
    try {
      await this.channel.edit(target.external_id, body);
    } catch (error) {
      await audit("outbound_failed", { reason: (error as Error).message, kind: "edit", ...context }, target.id);
      log.error("Editing failed:", error);
      return { ok: false, reason: "failed" };
    }
    this.lastSentAt = Date.now();
    this.sentTimestamps.push(this.lastSentAt);
    await storeEdit(target.id, body, { ...target.raw, edits: edits + 1 });
    await audit(
      "outbound_edit",
      { chars: body.length, edits: edits + 1, ...(target.taint_sources.length ? { tainted: true } : {}), ...context },
      target.id,
    );
    return { ok: true };
  }

  /**
   * The owner answered this message with 👎 (W24): word for word it does not go
   * out again within the dedupe window. The prompt asks the second attempt for
   * new information; this only catches the crudest case, an identical repeat.
   */
  forbidRepeat(text: string): void {
    this.recentSends.push({ key: fingerprint(dedupeKey(stripMarkdown(text))), at: Date.now() });
  }

  /**
   * What an earlier process sent in the last minutes goes into the duplicate
   * block (call before the channel starts). A restart takes seconds; without
   * this, what it interrupted went out a second time word for word. If the
   * database is not readable, Serain starts without: better a duplicate than no
   * message at all.
   */
  async restoreRecent(): Promise<number> {
    const since = new Date(Date.now() - OUTBOUND_DEDUPE_WINDOW_MS);
    try {
      const rows = await recentOutboundFingerprints(this.ownerPhone, since);
      for (const row of rows) this.recentSends.push({ key: row.fingerprint, at: Date.parse(row.at) });
      return rows.length;
    } catch (error) {
      await audit("error", { stage: "outbound_restore", reason: (error as Error).message });
      log.error("Recent messages not readable, duplicate block starts empty:", error);
      return 0;
    }
  }

  /** Is this fingerprint within the window? Clears out expired ones on the way. */
  private isRecent(key: string): boolean {
    const now = Date.now();
    this.recentSends = this.recentSends.filter((entry) => now - entry.at < OUTBOUND_DEDUPE_WINDOW_MS);
    return this.recentSends.some((entry) => entry.key === key);
  }

  private reserve(key: string): RecentSend {
    const entry = { key, at: Date.now() };
    this.recentSends.push(entry);
    return entry;
  }

  /** If something went out, the window counts from now; otherwise the reservation is gone. */
  private release(entry: RecentSend, sent: boolean): void {
    if (sent) entry.at = Date.now();
    else this.recentSends = this.recentSends.filter((other) => other !== entry);
  }

  /**
   * How delivery is doing (D44), for the heartbeat. Pure evaluation.
   *
   * Tapbacks deliberately do not count: they also fail when the adapter no
   * longer knows the message, and that is not a broken line. A kill switch
   * falls back to text then anyway, and that counts.
   */
  deliveryHealth(now: number = Date.now()): DeliveryHealth {
    return this.delivery.health(now);
  }

  /**
   * When something to the owner last got through at the channel (text, file,
   * preview); null if nothing since the start. After that the scheduler
   * delivers what failed before (`src/scheduler/missed.ts`).
   */
  lastDeliveredAt(): number | null {
    return this.delivery.lastSuccess();
  }

  /** Records an attempt and keeps every change of state in the audit log. */
  private async recordDelivery(ok: boolean, reason?: string): Promise<void> {
    const now = Date.now();
    if (!this.delivery.record(now, ok, reason)) return;
    const health = this.delivery.health(now);
    await audit("delivery_health", {
      healthy: health.healthy,
      attempts: health.attempts,
      failures: health.failures,
      consecutive_failures: health.consecutiveFailures,
      last_error: health.lastError,
    });
    if (health.healthy) log.info("Delivery works again");
    else log.error(`Delivery disrupted: ${health.consecutiveFailures} failures in a row, ${health.failures} of ${health.attempts} in ${DELIVERY_WINDOW_MS / 60_000} min`);
  }

  /** Tapback on a message of the owner. Counts in the rate limit like a message. */
  async react(messageId: string, emoji: string): Promise<boolean> {
    if (!this.channel.capabilities.reactions) {
      log.warn(`Channel ${this.channel.name} cannot do tapbacks`);
      return false;
    }
    if (!(await this.rateLimitOk({ kind: "reaction" }))) return false;
    await this.spaceOut();

    try {
      await this.channel.react(this.ownerPhone, messageId, emoji);
      this.lastSentAt = Date.now();
      this.sentTimestamps.push(this.lastSentAt);
      await audit("outbound_reaction", { external_id: messageId, emoji });
      return true;
    } catch (error) {
      await audit("outbound_failed", {
        reason: (error as Error).message,
        kind: "reaction",
        external_id: messageId,
      });
      log.error("Tapback failed:", error);
      return false;
    }
  }

  /**
   * Short acknowledgement to the owner: a tapback on their own message, no
   * text. For receipts where a sentence would only be noise, above all the
   * kill switch ("serain stop" / "serain resume").
   *
   * **Emergency exit:** if the channel cannot do a tapback, it fails, or a
   * limit applies, the short text version goes out. An acknowledgement that
   * silently disappears is no option for a kill switch: the owner has to see
   * that their instruction arrived.
   */
  async acknowledge(
    messageId: string,
    fallbackText: string,
    context: Record<string, unknown> = {},
  ): Promise<"reaction" | "text" | "none"> {
    const emoji = SIGNALS.ok;
    if (messageId && (await this.react(messageId, emoji))) {
      await audit("outbound_ack", { via: "reaction", emoji, external_id: messageId, ...context });
      return "reaction";
    }
    log.warn("Tapback as acknowledgement failed, sending the text version");
    const sent = await this.sendToOwner(fallbackText, { ...context, ack: "text_fallback" });
    await audit("outbound_ack", { via: sent ? "text" : "none", external_id: messageId, ...context });
    return sent ? "text" : "none";
  }

  private async rateLimitOk(context: Record<string, unknown>): Promise<boolean> {
    const now = Date.now();
    this.sentTimestamps = this.sentTimestamps.filter((ts) => now - ts < 3_600_000);
    if (this.sentTimestamps.length >= OUTBOUND_MAX_PER_HOUR) {
      await audit("outbound_failed", { reason: "rate_limited", window: "hour", ...context });
      log.error("Outbound rate limit reached, nothing sent");
      return false;
    }
    return true;
  }

  /** Only what the channel can do. Without formatting the ranges fall away, the text stays. */
  private extras(styles: SendExtras["styles"], effect: MessageEffect | undefined): SendExtras {
    const { formatting, effects } = this.channel.capabilities;
    return {
      ...(formatting && styles?.length ? { styles } : {}),
      ...(effects && effect ? { effect } : {}),
    };
  }

  /** Minimum interval between two outbound actions. */
  private async spaceOut(): Promise<void> {
    const wait = OUTBOUND_MIN_INTERVAL_MS - (Date.now() - this.lastSentAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
