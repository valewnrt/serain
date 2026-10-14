import type { MailAccount, MailMessage } from "../src/mail/types.js";
import type { EvalMail } from "./types.js";

/**
 * In-memory mailbox for eval cases with `mailbox`. Searches like an IMAP server:
 * case-insensitive substring in sender, or in subject and text. Sending and
 * new mail do not exist here: an eval turn never sends a real mail, and
 * `mail_send` ends in the preview to the owner anyway.
 */
export function evalMailAccount(mails: readonly EvalMail[], now: Date): MailAccount {
  const inbox: MailMessage[] = mails.map((mail, index) => {
    const uid = String(index + 1);
    return {
      id: `eval:${uid}`,
      threadKey: `<${uid}@eval>`,
      from: mail.from,
      to: "alex@example.org",
      subject: mail.subject,
      date: new Date(now.getTime() - mail.daysAgo * 86_400_000).toISOString(),
      snippet: mail.text.replace(/\s+/g, " ").slice(0, 220),
      bulk: false,
      folder: "Posteingang",
      text: mail.text,
      attachments: [],
      messageId: `<${uid}@eval>`,
      references: [],
    };
  });
  const has = (haystack: string, needle?: string) => !needle || haystack.toLowerCase().includes(needle.toLowerCase());

  return {
    id: "eval",
    address: "alex@example.org",
    async search(query) {
      const since = now.getTime() - query.sinceDays * 86_400_000;
      // Eval mailboxes only have an inbox.
      if (query.folder !== "all" && query.folder !== "inbox") return [];
      return inbox
        .filter((mail) => new Date(mail.date).getTime() >= since)
        .filter((mail) => has(mail.from, query.from) && has(`${mail.subject}\n${mail.text}`, query.text))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, query.limit);
    },
    async read(providerId) {
      return inbox.find((mail) => mail.id === `eval:${providerId}`) ?? null;
    },
    async send() {
      throw new Error("Eval mailbox sends nothing");
    },
    async newSince() {
      return { cursor: {}, messages: [] };
    },
    async close() {},
  };
}
