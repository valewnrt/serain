import type { MailKeepStore } from "../src/mail/keep.js";
import { addressesIn } from "../src/mail/recipients.js";
import { MailError, type MailAccount, type MailAttachmentFile, type MailFolder, type MailHeader, type MailMessage, type MailQuery, type MailSourceFolder, type OutgoingMail } from "../src/mail/types.js";

/** A mailbox in memory. Searches like an IMAP server: substring, case-insensitive. */
export function fakeMailAccount(
  id: string,
  address: string,
  initial: Array<Partial<MailMessage> & { listUnsubscribe?: string; listUnsubscribePost?: string }> = [],
) {
  const sent: OutgoingMail[] = [];
  const moved: Array<{ from: MailSourceFolder; ids: string[]; to: MailFolder }> = [];
  /** The spam folder the provider fills. */
  const junk: MailMessage[] = [];
  /** Trash: what Alex or the cleanup threw away. */
  const trash: MailMessage[] = [];
  const headersFromQueries: string[][] = [];
  const linksFromQueries: string[][] = [];
  /** Unsubscribe links in the mail text, per mail ID. */
  const bodyLinks = new Map<string, string>();
  const unsubscribeHeaders = new Map<string, { listUnsubscribe: string; listUnsubscribePost: string }>();
  const queries: MailQuery[] = [];
  /** Attachments with content, per mail ID, in the order of `attachments`. */
  const files = new Map<string, MailAttachmentFile[]>();
  const attachmentRequests: Array<{ providerId: string; index: number; maxBytes: number }> = [];
  const inbox: MailMessage[] = [];
  let failWith: Error | null = null;
  /** Recipient check that never answers: for the preview's time limit. */
  let hangCorrespondence = false;
  const correspondenceQueries: string[] = [];
  let nextUid = 0;
  /**
   * One point in time for the whole mailbox: mails without their own `date` are equally
   * old and keep the order in which the test creates them when sorted by date.
   * With `new Date()` per mail, a millisecond change in the middle of setup reversed the IDs.
   */
  const now = new Date().toISOString();
  const add =(partial: Partial<MailMessage>): MailMessage => {
    const uid = String((nextUid += 1));
    const text = partial.text ?? "";
    const mail: MailMessage = {
      id: `${id}:${uid}`,
      threadKey: partial.messageId ?? `<${uid}@test>`,
      from: "Absender <absender@example.org>",
      to: address,
      subject: "",
      date: now,
      snippet: text.replace(/\s+/g, " ").slice(0, 220),
      bulk: false,
      folder: "Inbox",
      text,
      attachments: [],
      messageId: `<${uid}@test>`,
      references: [],
      ...partial,
    };
    inbox.push(mail);
    return mail;
  };
  for (const { listUnsubscribe = "", listUnsubscribePost = "", ...partial } of initial) {
    unsubscribeHeaders.set(add(partial).id, { listUnsubscribe, listUnsubscribePost });
  }
  const has = (haystack: string, needle?: string) => !needle || haystack.toLowerCase().includes(needle.toLowerCase());
  const header = (mail: MailMessage): MailHeader => ({
    providerId: mail.id.slice(id.length + 1),
    fromAddress: (/<([^>]+)>/.exec(mail.from)?.[1] ?? mail.from).toLowerCase(),
    fromName: /^(.*?)\s*<[^>]+>$/.exec(mail.from)?.[1]?.trim() ?? "",
    subject: mail.subject,
    date: mail.date,
    bulk: mail.bulk,
    listUnsubscribe: unsubscribeHeaders.get(mail.id)?.listUnsubscribe ?? "",
    listUnsubscribePost: unsubscribeHeaders.get(mail.id)?.listUnsubscribePost ?? "",
  });

  const account: MailAccount = {
    id,
    address,
    async search(query) {
      if (failWith) throw failWith;
      queries.push(query);
      const since = Date.now() - query.sinceDays * 86_400_000;
      const where = { inbox, trash, junk, sent: [] as MailMessage[] };
      return (query.folder === "all" ? [...inbox, ...trash, ...junk] : where[query.folder])
        .filter((mail) => new Date(mail.date).getTime() >= since && has(mail.from, query.from) && has(`${mail.subject}\n${mail.text}`, query.text))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, query.limit);
    },
    async read(providerId) {
      if (failWith) throw failWith;
      return [...inbox, ...trash, ...junk].find((mail) => mail.id === `${id}:${providerId}`) ?? null;
    },
    async attachment(providerId, index, maxBytes) {
      if (failWith) throw failWith;
      attachmentRequests.push({ providerId, index, maxBytes });
      const file = files.get(`${id}:${providerId}`)?.[index - 1];
      if (!file) return null;
      if (file.body.length > maxBytes) throw new MailError("The attachment is too large to open.");
      return file;
    },
    async send(mail) {
      if (failWith) throw failWith;
      sent.push(mail);
      return { messageId: `<sent-${sent.length}@test>` };
    },
    async hasCorresponded(recipient) {
      correspondenceQueries.push(recipient);
      if (hangCorrespondence) return new Promise<boolean>(() => undefined);
      if (failWith) throw failWith;
      // Like the adapter: sender in the inbox, To/Cc in sent mail, exact address.
      const target = recipient.toLowerCase();
      return (
        inbox.some((mail) => addressesIn(mail.from).includes(target)) ||
        sent.some((mail) => [...mail.to, ...mail.cc].some((entry) => entry.toLowerCase() === target))
      );
    },
    async newSince(cursor, limit) {
      if (failWith) throw failWith;
      const from = typeof cursor?.["next"] === "number" ? (cursor["next"] as number) : null;
      if (from === null) return { cursor: { next: inbox.length }, messages: [] };
      const messages = inbox.slice(from, from + limit);
      return { cursor: { next: from + messages.length }, messages };
    },
    cleanup: {
      async scan(folder, sinceDays, max) {
        if (failWith) throw failWith;
        const since = Date.now() - sinceDays * 86_400_000;
        return (folder === "junk" ? junk : inbox)
          .filter((mail) => new Date(mail.date).getTime() >= since)
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, max)
          .map(header);
      },
      async headersFrom(addresses, sinceDays, max) {
        if (failWith) throw failWith;
        headersFromQueries.push([...addresses]);
        const since = Date.now() - sinceDays * 86_400_000;
        // Like the adapter: all folders except spam, with the folder key in the ID.
        return [...inbox, ...trash]
          .filter((mail) => new Date(mail.date).getTime() >= since)
          .map((mail) => (trash.includes(mail) ? { ...header(mail), providerId: `0000aaaa-${mail.id.slice(id.length + 1)}` } : header(mail)))
          .filter((mail) => addresses.includes(mail.fromAddress))
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, max);
      },
      async linksFrom(addresses, sinceDays) {
        if (failWith) throw failWith;
        linksFromQueries.push([...addresses]);
        const since = Date.now() - sinceDays * 86_400_000;
        const found = new Map<string, { url: string; host: string }>();
        for (const mail of [...inbox, ...trash].sort((a, b) => b.date.localeCompare(a.date))) {
          const address = header(mail).fromAddress;
          const url = bodyLinks.get(mail.id);
          if (!url || found.has(address) || !addresses.includes(address) || new Date(mail.date).getTime() < since) continue;
          found.set(address, { url, host: new URL(url).hostname });
        }
        return found;
      },
      async move(from, providerIds, to) {
        if (failWith) throw failWith;
        moved.push({ from, ids: [...providerIds], to });
        const source = from === "junk" ? junk : inbox;
        for (const providerId of providerIds) {
          const index = source.findIndex((mail) => mail.id === `${id}:${providerId}`);
          if (index < 0) continue;
          const [mail] = source.splice(index, 1);
          if (mail && to === "inbox") inbox.push({ ...mail, folder: "Inbox" });
          if (mail && to === "junk") junk.push({ ...mail, folder: "Spam" });
          if (mail && to === "trash") trash.push({ ...mail, folder: "Trash" });
        }
        return providerIds.length;
      },
    },
    async close() {},
  };
  /** Puts a mail directly into the spam folder, as the provider's filter would. */
  const addJunk = (partial: Partial<MailMessage> & { listUnsubscribe?: string; listUnsubscribePost?: string; bodyLink?: string }): void => {
    const { listUnsubscribe = "", listUnsubscribePost = "", bodyLink, ...rest } = partial;
    const mail = add(rest);
    unsubscribeHeaders.set(mail.id, { listUnsubscribe, listUnsubscribePost });
    if (bodyLink) bodyLinks.set(mail.id, bodyLink);
    inbox.splice(inbox.indexOf(mail), 1);
    junk.push({ ...mail, folder: "Spam" });
  };
  /** Puts a mail directly into the trash, as if Alex threw it away. */
  const addTrash = (partial: Partial<MailMessage> & { listUnsubscribe?: string; listUnsubscribePost?: string; bodyLink?: string }): void => {
    const { listUnsubscribe = "", listUnsubscribePost = "", bodyLink, ...rest } = partial;
    const mail = add(rest);
    unsubscribeHeaders.set(mail.id, { listUnsubscribe, listUnsubscribePost });
    if (bodyLink) bodyLinks.set(mail.id, bodyLink);
    inbox.splice(inbox.indexOf(mail), 1);
    trash.push({ ...mail, folder: "Trash" });
  };
  return {
    account,
    add,
    addJunk,
    addTrash,
    trash,
    headersFromQueries,
    linksFromQueries,
    attachmentRequests,
    /** Attaches a file to a mail; it then also appears in `attachments`. */
    attach: (mailId: string, file: MailAttachmentFile) => {
      files.set(mailId, [...(files.get(mailId) ?? []), file]);
      const mail = inbox.find((entry) => entry.id === mailId);
      if (mail) mail.attachments = [...mail.attachments, file.name];
    },
    /** Gives a mail in the inbox an unsubscribe link in its text. */
    link: (mailId: string, url: string) => void bodyLinks.set(mailId, url),
    sent,
    moved,
    queries,
    correspondenceQueries,
    fail: (error: Error | null) => void (failWith = error),
    hang: () => void (hangCorrespondence = true),
  };
}

/** Keep list in memory. */
export function memoryKeep(initial: string[] = []): MailKeepStore & { entries: () => string[] } {
  let entries = [...initial];
  return {
    load: async () => [...entries],
    save: async (next) => void (entries = [...next]),
    entries: () => [...entries],
  };
}
