import type { SentMailStore } from "../mail/sent.js";
import { db } from "./client.js";

/** `mail_sent` (addendum D33 of 2026-10-13): only the identifier of sent mails, never content. Read per new mail, not on the tick. */
export const sentMailStore: SentMailStore = {
  async record(integrationId, messageId, at) {
    const { error } = await db.from("mail_sent").insert({ integration_id: integrationId, message_id: messageId, sent_at: at.toISOString() });
    if (error && error.code !== "23505") throw new Error(`Sent mail not recorded: ${error.message}`);
  },

  async ours(messageIds, since) {
    if (messageIds.length === 0) return false;
    const { data, error } = await db
      .from("mail_sent")
      .select("id")
      .in("message_id", [...messageIds])
      .gt("sent_at", since.toISOString())
      .limit(1);
    if (error) throw new Error(`Sent mails not readable: ${error.message}`);
    return (data ?? []).length > 0;
  },
};
