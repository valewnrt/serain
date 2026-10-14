import { db } from "./client.js";
import type { InboundMessage, SendResult } from "../channel/types.js";
import { RECIPIENT_VERIFY_MAX } from "../config/limits.js";
import { addressesIn } from "../mail/recipients.js";

/**
 * Persistence of messages and at the same time the dedupe mechanism:
 * `messages(channel, external_id)` is unique. An insert that fails on this
 * constraint is a replay (catch-up after a reconnect) and is dropped. This
 * survives a restart; an in-memory set would not.
 */
const UNIQUE_VIOLATION = "23505";

export interface StoredMessage {
  id: string;
  created_at: string;
}

export type StoreInboundResult =
  | { stored: true; message: StoredMessage }
  | { stored: false; reason: "duplicate" };

export async function storeInbound(message: InboundMessage): Promise<StoreInboundResult> {
  const { data, error } = await db
    .from("messages")
    .insert({
      channel: message.channel,
      direction: "inbound",
      external_id: message.externalId,
      chat_id: message.chatId,
      peer: message.from,
      is_group: message.isGroup,
      body: message.text,
      attachments: message.attachments,
      raw: message.raw,
      created_at: message.receivedAt.toISOString(),
      // Until its turn is through: a crash in between catches it up at startup (D52).
      turn_status: "pending",
    })
    .select("id, created_at")
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { stored: false, reason: "duplicate" };
    throw new Error(`Inbound message not saved: ${error.message}`);
  }
  return { stored: true, message: data as StoredMessage };
}

/**
 * What an outgoing message was derived from (D8.4). Required, so every new path
 * to the outside has to decide instead of silently counting as clean.
 */
export interface OutboundProvenance {
  /**
   * Sources of untrusted content the turn had seen when the message went out.
   * Empty means: by Serain from the owner's words or from its own code. Not
   * empty: the text is derived from untrusted content and is framed as such in
   * later turns, never as Serain's own words.
   */
  taintSources: readonly string[];
}

export async function storeOutbound(
  channel: string,
  to: string,
  text: string,
  result: SendResult,
  provenance: OutboundProvenance,
  meta: { editable?: boolean; dedupe?: string } = {},
): Promise<StoredMessage> {
  const { data, error } = await db
    .from("messages")
    .insert({
      channel,
      direction: "outbound",
      external_id: result.externalId,
      chat_id: result.chatId,
      peer: to,
      is_group: false,
      body: text,
      raw: {
        status: result.status,
        service: result.service,
        ...(meta.editable ? { editable: true } : {}),
        ...(meta.dedupe ? { dedupe: meta.dedupe } : {}),
      },
      taint_sources: [...provenance.taintSources],
    })
    .select("id, created_at")
    .single();

  if (error) throw new Error(`Outbound message not saved: ${error.message}`);
  return data as StoredMessage;
}

/** A read attachment as it is attached to the message (D21). */
export interface StoredAttachmentReading {
  kind: "image" | "voice";
  text: string;
}

/**
 * Records what was read from a message's attachments so later turns see it in
 * the history. The owner's own words (voice message) move into `body` if the
 * message was otherwise empty: they are the owner's text, and history and
 * summaries read only `body`. Image descriptions stay attached to
 * `attachments`: untrusted content never becomes the owner's words.
 */
export async function storeAttachmentReadings(
  messageId: string,
  update: { body?: string; attachments: unknown[] },
): Promise<void> {
  const { error } = await db
    .from("messages")
    .update({ attachments: update.attachments, ...(update.body === undefined ? {} : { body: update.body }) })
    .eq("id", messageId);
  if (error) throw new Error(`Attachments not saved: ${error.message}`);
}

/** Last N messages of the conversation, oldest first, for building the context. */
export async function recentMessages(
  peer: string,
  limit: number,
): Promise<
  Array<{
    id: string;
    direction: string;
    body: string;
    created_at: string;
    external_id?: string | null;
    attachments?: unknown;
    /** See `OutboundProvenance`. Empty for everything that came from the owner. */
    taint_sources?: string[];
  }>
> {
  const { data, error } = await db
    .from("messages")
    .select("id, direction, body, created_at, external_id, attachments, taint_sources")
    .eq("peer", peer)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`History not readable: ${error.message}`);
  return (data ?? []).reverse();
}

/**
 * A message Serain sent to the owner, by its channel ID. An incoming tapback
 * hangs on it (W24): only tapbacks on Serain's own messages lead to anything.
 */
export async function findOutbound(
  peer: string,
  externalId: string,
): Promise<{ id: string; body: string; created_at: string; taint_sources?: string[] } | null> {
  if (!externalId) return null;
  const { data, error } = await db
    .from("messages")
    .select("id, body, created_at, taint_sources")
    .eq("peer", peer)
    .eq("direction", "outbound")
    .eq("external_id", externalId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Message not readable: ${error.message}`);
  return (data as { id: string; body: string; created_at: string; taint_sources: string[] } | null) ?? null;
}

/** One of Serain's own messages that it may still edit (D48). */
export interface EditableOutbound {
  id: string;
  external_id: string;
  body: string;
  created_at: string;
  taint_sources: string[];
  raw: Record<string, unknown>;
}

/**
 * Serain's messages to the owner since `since` that were marked as editable
 * when sent, newest first. Only messages from the message tools are marked;
 * previews, suggestions and reminders never are (D48).
 */
export async function editableOutbound(peer: string, since: Date): Promise<EditableOutbound[]> {
  const { data, error } = await db
    .from("messages")
    .select("id, external_id, body, created_at, taint_sources, raw")
    .eq("peer", peer)
    .eq("direction", "outbound")
    .eq("raw->>editable", "true")
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`Messages not readable: ${error.message}`);
  return ((data ?? []) as EditableOutbound[]).map((row) => ({ ...row, taint_sources: row.taint_sources ?? [] }));
}

/**
 * Fingerprints of the messages to the owner since `since`, for the duplicate
 * guard after a restart (`OutboundGate.restoreRecent`). Only the hash, never
 * the text.
 */
export async function recentOutboundFingerprints(peer: string, since: Date): Promise<Array<{ fingerprint: string; at: string }>> {
  const { data, error } = await db
    .from("messages")
    .select("raw->>dedupe, created_at")
    .eq("peer", peer)
    .eq("direction", "outbound")
    .gte("created_at", since.toISOString())
    .not("raw->>dedupe", "is", null)
    .limit(200);
  if (error) throw new Error(`Recent messages not readable: ${error.message}`);
  return ((data ?? []) as Array<{ dedupe: string; created_at: string }>).map((row) => ({ fingerprint: row.dedupe, at: row.created_at }));
}

/**
 * Writes the new text of an edited message. The vector is dropped so the
 * history search embeds the new text again instead of finding the old one.
 */
export async function storeEdit(id: string, body: string, raw: Record<string, unknown>): Promise<void> {
  const { error } = await db
    .from("messages")
    .update({ body, raw, embedding: null })
    .eq("id", id);
  if (error) throw new Error(`Edited message not saved: ${error.message}`);
}

/**
 * Has the owner ever written this mail address themselves (addendum D34)? Only
 * the owner's own messages (`inbound` from their number), never Serain's: a
 * reply from Serain can repeat an address from an untrusted mail, and the
 * repetition would then make it "known".
 *
 * The database searches roughly for the substring (`%` and `_` escaped;
 * PostgREST still turns `*` into a wildcard); only rows where the address
 * appears exactly in the text count.
 */
export async function ownerMentionedAddress(peer: string, address: string): Promise<boolean> {
  const target = address.trim().toLowerCase();
  const pattern = target.replace(/[\\%_]/g, (char) => `\\${char}`);
  const { data, error } = await db
    .from("messages")
    .select("body")
    .eq("peer", peer)
    .eq("direction", "inbound")
    .ilike("body", `%${pattern}%`)
    .order("created_at", { ascending: false })
    .limit(RECIPIENT_VERIFY_MAX);
  if (error) throw new Error(`History not readable: ${error.message}`);
  return (data ?? []).some((row: { body: string | null }) => addressesIn(row.body ?? "").includes(target));
}
