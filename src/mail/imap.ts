import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { getDomain } from "tldts";
import {
  DATA_MAIL_HEADER_MAX_BYTES,
  KNOWN_SENDER_CHECK_MAX,
  MAIL_ATTACHMENT_SOURCE_MAX_BYTES,
  MAIL_SOURCE_MAX_BYTES,
  RECIPIENT_HISTORY_DAYS,
  RECIPIENT_VERIFY_MAX,
} from "../config/limits.js";
import { formatSize } from "../files/name.js";
import type { ImapSecret } from "../integrations/types.js";
import { log } from "../log.js";
import { isBulk, listedAttachments, toMailMessage } from "./parse.js";
import { imapTrust } from "./sender-auth.js";
import { unsubscribeLink } from "./unsubscribe.js";
import {
  MailError,
  SERAIN_SENDER_NAME,
  type MailAccount,
  type MailAttachmentFile,
  type MailFolder,
  type MailHeader,
  type MailHeaderExport,
  type MailSourceFolder,
  type MailMessage,
  type MailQuery,
  type MailSearchFolder,
  type NewMail,
  type OutgoingMail,
  type UnsubscribePage,
} from "./types.js";

/**
 * A mailbox via IMAP and SMTP (D31): GMX, Posteo, mailbox.org and any other
 * provider with an (app) password.
 *
 * **One connection, kept open.** GMX throttles frequent logins; the
 * connection therefore stays up (imapflow keeps it awake with IDLE) and is
 * only rebuilt when it is gone. All accesses run one after another over the
 * same connection.
 *
 * **Reading happens in every folder** (addendum D31 of 2026-10-03): inbox,
 * sent, trash, spam and the owner's own folders. UIDs only apply in their
 * folder, so the ID of a mail outside the inbox carries a key for the folder:
 * `<8 hex characters>-<uid>`. Mails in the inbox keep the bare UID, so IDs
 * from before stay valid.
 *
 * **Reading changes nothing.** Nothing is marked as read: fetching uses
 * `BODY.PEEK` (imapflow default); the recipient check (`hasCorresponded`)
 * reads only envelopes in the inbox and "Sent". Writing happens in two places:
 * the copy of a sent mail in "Sent", and `cleanup.move` (D37), which moves
 * mails to the trash or spam folder. Nothing is ever deleted for good.
 */

const INBOX = "INBOX";
/** Folders the adapter opens: those of the cleanup and "Sent" for the recipient check. */
type Folder = MailFolder | "sent";
const SPECIAL_USE: Record<Exclude<Folder, "inbox">, string> = { trash: "\\Trash", junk: "\\Junk", sent: "\\Sent" };
const FOLDER_NAME: Record<Exclude<Folder, "inbox">, string> = { trash: "the trash", junk: "spam", sent: "sent mail" };
const CLEANUP_HEADERS = ["list-unsubscribe", "list-unsubscribe-post", "list-id", "precedence", "auto-submitted"];
/** This many senders at once in an IMAP search with OR, GMX does not like nesting more. */
const HEADERS_FROM_CHUNK = 20;
/** This many of a sender's newest mails are searched for an unsubscribe link. */
const LINK_TRIES = 3;

/** Display name of a folder: what it is, not what the provider calls it. */
const LABEL: Record<string, string> = {
  "\\Inbox": "Inbox",
  "\\Sent": "Sent",
  "\\Trash": "Trash",
  "\\Junk": "Spam",
  "\\Drafts": "Drafts",
  "\\Archive": "Archive",
  "\\All": "All Mail",
};
const SEARCH_USE: Record<Exclude<MailSearchFolder, "all">, string> = { inbox: "\\Inbox", sent: "\\Sent", trash: "\\Trash", junk: "\\Junk" };

/** A folder as the search needs it. `key` is empty for the inbox. */
interface Box {
  path: string;
  key: string;
  label: string;
  use: string;
}

const INBOX_BOX: Box = { path: INBOX, key: "", label: "Inbox", use: "\\Inbox" };

/** Short and stable as long as the folder has this name; no state that can get lost. */
export function folderKey(path: string): string {
  return path.toUpperCase() === INBOX ? "" : createHash("sha256").update(path).digest("hex").slice(0, 8);
}

const providerIdOf = (box: Box, uid: number) => (box.key ? `${box.key}-${uid}` : String(uid));

/** Where to look for unsubscribe routes: never in spam (D37), not in sent and drafts, those are from the owner. */
const unsubscribeBoxes = (boxes: readonly Box[]) =>
  searchedBoxes(boxes, "all").filter((box) => !["\\Junk", "\\Sent", "\\Drafts"].includes(box.use));

/**
 * Which folders a search opens. "All" means every selectable folder, without
 * virtual collections: `\Flagged` only shows what already lies elsewhere. If
 * the server has an `\All` folder (Gmail-like), everything except trash and
 * spam is already there; the other folders would be duplicates.
 */
export function searchedBoxes(boxes: readonly Box[], folder: MailSearchFolder): Box[] {
  if (folder !== "all") return boxes.filter((box) => box.use === SEARCH_USE[folder]);
  const everything = boxes.some((box) => box.use === "\\All");
  return boxes.filter((box) =>
    everything ? ["\\All", "\\Trash", "\\Junk"].includes(box.use) : box.use !== "\\Flagged" && box.use !== "\\All",
  );
}

/** Raw header lines as IMAP delivers them: unfold, then `Name: value`. */
export function parseRawHeaders(raw: Buffer | undefined): Map<string, string> {
  const headers = new Map<string, string>();
  const unfolded = (raw?.toString("utf8") ?? "").replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

function smtpTransport(secret: ImapSecret) {
  return nodemailer.createTransport({
    host: secret.smtpHost,
    port: secret.smtpPort,
    secure: secret.smtpPort === 465,
    requireTLS: true,
    auth: { user: secret.user, pass: secret.password },
  });
}

/** Login to the SMTP server, without sending anything. For `pnpm integration connect`: check first, then store. */
export async function verifySmtp(secret: ImapSecret): Promise<void> {
  const transport = smtpTransport(secret);
  try {
    await transport.verify();
  } catch (error) {
    throw new MailError(`SMTP login failed: ${(error as Error).message}`);
  } finally {
    transport.close();
  }
}

type ImapOptions = ConstructorParameters<typeof ImapFlow>[0];

export function imapAccount(
  id: string,
  address: string,
  secret: ImapSecret,
  /** Only for tests: an IMAP client without network. */
  createClient: (options: ImapOptions) => ImapFlow = (options) => new ImapFlow(options),
): MailAccount {
  let client: ImapFlow | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const trust = imapTrust(secret.imapHost);

  async function connected(): Promise<ImapFlow> {
    if (client?.usable) return client;
    const next = createClient({
      host: secret.imapHost,
      port: secret.imapPort,
      secure: true,
      auth: { user: secret.user, pass: secret.password },
      logger: false,
    });
    // Without a listener a dropped connection ends the process.
    next.on("error", (error: Error) => log.warn(`IMAP ${id}: ${error.message}`));
    try {
      await next.connect();
    } catch (error) {
      throw new MailError(`Login to mailbox ${id} failed: ${(error as Error).message}`);
    }
    client = next;
    return next;
  }

  /** Trash and spam folder are named differently by every provider; the server marks them (RFC 6154). */
  const paths = new Map<Folder, string>([["inbox", INBOX]]);
  async function pathOf(imap: ImapFlow, folder: Folder): Promise<string> {
    const known = paths.get(folder);
    if (known) return known;
    const use = SPECIAL_USE[folder as Exclude<Folder, "inbox">];
    const found = (await imap.list()).find((box) => box.specialUse === use);
    if (!found) throw new MailError(`The mailbox ${id} names no folder for ${FOLDER_NAME[folder as Exclude<Folder, "inbox">]}.`);
    paths.set(folder, found.path);
    return found.path;
  }

  /** One access after the other over the same connection. */
  function serial<T>(work: (imap: ImapFlow) => Promise<T>): Promise<T> {
    const run = chain.then(async () => work(await connected()));
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function locked<T>(imap: ImapFlow, path: string, work: () => Promise<T>): Promise<T> {
    const lock = await imap.getMailboxLock(path);
    try {
      return await work();
    } finally {
      lock.release();
    }
  }

  function inInbox<T>(work: (imap: ImapFlow) => Promise<T>): Promise<T> {
    return inFolder("inbox", work);
  }

  /** The mail for an ID from `search`: folder key and UID, or just the UID in the inbox. */
  function atMail<T>(providerId: string, work: (imap: ImapFlow, box: Box, uid: number) => Promise<T | null>): Promise<T | null> {
    const match = /^(?:([0-9a-f]{8})-)?([1-9][0-9]*)$/.exec(providerId);
    if (!match) return Promise.resolve(null);
    const [, key, uid] = match;
    return serial(async (imap) => {
      const box = key ? (await boxes(imap)).find((entry) => entry.key === key) : INBOX_BOX;
      // The folder was renamed or is gone: then the mail no longer exists under this ID.
      if (!box) return null;
      return locked(imap, box.path, () => work(imap, box, Number(uid)));
    });
  }

  function inFolder<T>(folder: MailSourceFolder | "sent", work: (imap: ImapFlow) => Promise<T>): Promise<T> {
    return serial(async (imap) => locked(imap, await pathOf(imap, folder), () => work(imap)));
  }

  /** All selectable folders, fresh from the server: the owner creates and renames folders. */
  async function boxes(imap: ImapFlow): Promise<Box[]> {
    return (await imap.list())
      .filter((box) => !box.flags?.has("\\Noselect") && !box.flags?.has("\\NonExistent"))
      .map((box) => {
        const use = box.path.toUpperCase() === INBOX ? "\\Inbox" : (box.specialUse ?? "");
        return { path: box.path, key: folderKey(box.path), label: LABEL[use] ?? box.path, use };
      });
  }

  async function load(imap: ImapFlow, box: Box, uids: number[]): Promise<MailMessage[]> {
    if (uids.length === 0) return [];
    const fetched = await imap.fetchAll(
      uids,
      { uid: true, internalDate: true, source: { maxLength: MAIL_SOURCE_MAX_BYTES } },
      { uid: true },
    );
    const messages: MailMessage[] = [];
    for (const item of fetched) {
      if (!item.source) continue;
      const parsed = await simpleParser(item.source, { skipImageLinks: true, skipTextToHtml: true });
      const date = item.internalDate instanceof Date ? item.internalDate : new Date(item.internalDate ?? Date.now());
      messages.push(toMailMessage(id, providerIdOf(box, item.uid), parsed, date, box.label, trust));
    }
    return messages.sort((a, b) => b.date.localeCompare(a.date));
  }

  /** Envelope and five header lines of the mails in the open folder: no text, no attachment leaves the server. */
  async function headerRows(imap: ImapFlow, key: string, uids: number[]): Promise<MailHeader[]> {
    if (uids.length === 0) return [];
    const fetched = await imap.fetchAll(uids, { uid: true, internalDate: true, envelope: true, headers: CLEANUP_HEADERS }, { uid: true });
    return fetched
      .map((item): MailHeader => {
        const headers = parseRawHeaders(item.headers);
        const date = item.internalDate instanceof Date ? item.internalDate : new Date(item.internalDate ?? Date.now());
        return {
          providerId: key ? `${key}-${item.uid}` : String(item.uid),
          fromAddress: (item.envelope?.from?.[0]?.address ?? "").trim().toLowerCase(),
          fromName: (item.envelope?.from?.[0]?.name ?? "").trim(),
          subject: (item.envelope?.subject ?? "").trim(),
          date: date.toISOString(),
          bulk: isBulk(headers),
          listUnsubscribe: headers.get("list-unsubscribe") ?? "",
          listUnsubscribePost: headers.get("list-unsubscribe-post") ?? "",
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * Mails from exactly these addresses in the folders searched for unsubscribe
   * routes: one OR search per folder and chunk, then `read` in the open folder.
   * IMAP searches substrings; the caller filters what comes back exactly.
   */
  async function fromAddresses<T>(imap: ImapFlow, targets: readonly string[], since: Date, read: (box: Box, uids: number[]) => Promise<T[]>): Promise<T[]> {
    const rows: T[] = [];
    for (const box of unsubscribeBoxes(await boxes(imap))) {
      for (let start = 0; start < targets.length; start += HEADERS_FROM_CHUNK) {
        const chunk = targets.slice(start, start + HEADERS_FROM_CHUNK);
        rows.push(
          ...(await locked(imap, box.path, async () => {
            const found = await imap.search(chunk.length === 1 ? { since, from: chunk[0] as string } : { since, or: chunk.map((from) => ({ from })) }, { uid: true });
            return read(box, (Array.isArray(found) ? found : []).sort((a, b) => b - a));
          })),
        );
      }
    }
    return rows;
  }

  /**
   * Is there a mail in the open folder whose envelope has exactly this
   * address? IMAP only searches substrings (`anna@example.org` would also match
   * `hanna@example.org`), so the newest hits are checked in the envelope. No
   * text, no attachment.
   */
  async function envelopeHas(
    imap: ImapFlow,
    query: Parameters<ImapFlow["search"]>[0],
    target: string,
    fields: ReadonlyArray<"from" | "to" | "cc">,
  ): Promise<boolean> {
    const found = await imap.search(query, { uid: true });
    const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, RECIPIENT_VERIFY_MAX);
    if (uids.length === 0) return false;
    const fetched = await imap.fetchAll(uids, { uid: true, envelope: true }, { uid: true });
    return fetched.some((item) =>
      fields.some((field) => (item.envelope?.[field] ?? []).some((entry) => (entry.address ?? "").trim().toLowerCase() === target)),
    );
  }

  const serains = secret.owner === "serain";
  const account: MailAccount = {
    id,
    address,

    // Only where the incoming server's verdict is readable (`imapTrust`): without a confirmed sender "known" is worth nothing.
    ...(trust
      ? {
          knewDomainBefore(domain: string, before: Date) {
            const site = getDomain(domain);
            if (!site) return Promise.resolve(false);
            return serial(async (imap) => {
              // Without the trash: `mail_spam_folder` moves spam there (D37), and spam makes nobody known.
              for (const box of unsubscribeBoxes(await boxes(imap)).filter((box) => box.use !== "\\Trash")) {
                const known = await locked(imap, box.path, async () => {
                  const found = await imap.search({ before, from: site }, { uid: true });
                  const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, KNOWN_SENDER_CHECK_MAX);
                  if (uids.length === 0) return false;
                  // The search is a substring; only a sender of exactly this domain counts.
                  const fetched = await imap.fetchAll(uids, { uid: true, envelope: true }, { uid: true });
                  return fetched.some((item) => (item.envelope?.from ?? []).some((entry) => getDomain(entry.address?.split("@").pop() ?? "") === site));
                });
                if (known) return true;
              }
              return false;
            });
          },
        }
      : {}),

    exportHeaders(query) {
      return serial(async (imap) => {
        const targets = query.folder === "inbox" ? [INBOX_BOX] : searchedBoxes(await boxes(imap), query.folder);
        // Like `search`: first per folder only UID and receipt, then the newest across all folders.
        // The receipt draws the exact boundary afterwards. BEFORE only for an end in the past:
        // GMX supports WITHIN, and imapflow turns an end in the future into "older than 0 seconds",
        // which finds nothing (live finding 2026-10-13); the same holds for an end only seconds ago.
        const criteria = query.before.getTime() < Date.now() - 60_000 ? { since: query.since, before: query.before } : { since: query.since };
        const candidates: Array<{ box: Box; uid: number; date: number }> = [];
        for (const box of targets) {
          await locked(imap, box.path, async () => {
            const found = await imap.search(criteria, { uid: true });
            const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a);
            if (uids.length === 0) return;
            for (const item of await imap.fetchAll(uids, { uid: true, internalDate: true }, { uid: true })) {
              const date = (item.internalDate instanceof Date ? item.internalDate : new Date(item.internalDate ?? 0)).getTime();
              if (date >= query.since.getTime() && date < query.before.getTime()) candidates.push({ box, uid: item.uid, date });
            }
          });
        }
        const chosen = candidates.sort((a, b) => b.date - a.date).slice(0, query.max);
        const rows: MailHeaderExport[] = [];
        for (const box of new Set(chosen.map((entry) => entry.box))) {
          const picked = chosen.filter((entry) => entry.box === box);
          const fetched = await locked(imap, box.path, () => imap.fetchAll(picked.map((entry) => entry.uid), { uid: true, headers: true }, { uid: true }));
          const heads = new Map(fetched.map((item) => [item.uid, item.headers]));
          for (const entry of picked) {
            rows.push({
              providerId: providerIdOf(box, entry.uid),
              folder: box.label,
              date: new Date(entry.date).toISOString(),
              headers: (heads.get(entry.uid)?.toString("utf8") ?? "").slice(0, DATA_MAIL_HEADER_MAX_BYTES).trimEnd(),
            });
          }
        }
        return { rows: rows.sort((a, b) => b.date.localeCompare(a.date)), truncated: candidates.length > query.max };
      });
    },

    async hasCorresponded(recipient: string) {
      const target = recipient.trim().toLowerCase();
      const since = new Date(Date.now() - RECIPIENT_HISTORY_DAYS * 86_400_000);
      if (await inInbox((imap) => envelopeHas(imap, { since, from: target }, target, ["from"]))) return true;
      // Without a Sent folder `pathOf` throws: then "never written" is unchecked, not false.
      return inFolder("sent", (imap) => envelopeHas(imap, { since, or: [{ to: target }, { cc: target }] }, target, ["to", "cc"]));
    },

    async repliedSince(threadKey: string, since: Date) {
      const key = threadKey.trim();
      // Only a real Message-ID: an empty or short value would match almost every mail as a substring.
      if (!/^<[^<>\s]{6,}>$/.test(key)) return false;
      return inFolder("sent", async (imap) => {
        const found = await imap.search({ since, or: [{ header: { references: key } }, { header: { "in-reply-to": key } }] }, { uid: true });
        const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, RECIPIENT_VERIFY_MAX);
        if (uids.length === 0) return false;
        // The server's search is a substring; only where the ID stands exactly as an entry counts.
        const fetched = await imap.fetchAll(uids, { uid: true, internalDate: true, headers: ["references", "in-reply-to"] }, { uid: true });
        return fetched.some((item) => {
          const at = item.internalDate instanceof Date ? item.internalDate : new Date(item.internalDate ?? 0);
          if (at < since) return false;
          const headers = parseRawHeaders(item.headers);
          return `${headers.get("references") ?? ""} ${headers.get("in-reply-to") ?? ""}`.split(/\s+/).includes(key);
        });
      });
    },

    search(query: MailQuery) {
      return serial(async (imap) => {
        const criteria = {
          since: new Date(Date.now() - query.sinceDays * 86_400_000),
          ...(query.from ? { from: query.from } : {}),
          ...(query.text ? { or: [{ subject: query.text }, { body: query.text }] } : {}),
        };
        const targets = query.folder === "inbox" ? [INBOX_BOX] : searchedBoxes(await boxes(imap), query.folder);
        // First per folder only UID and receipt, then load the newest across all folders in full:
        // otherwise a search over twelve folders would fetch up to 120 mails including text.
        const candidates: Array<{ box: Box; uid: number; date: number }> = [];
        for (const box of targets) {
          await locked(imap, box.path, async () => {
            const found = await imap.search(criteria, { uid: true });
            const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, query.limit);
            if (uids.length === 0) return;
            for (const item of await imap.fetchAll(uids, { uid: true, internalDate: true }, { uid: true })) {
              const date = item.internalDate instanceof Date ? item.internalDate : new Date(item.internalDate ?? 0);
              candidates.push({ box, uid: item.uid, date: date.getTime() });
            }
          });
        }
        const chosen = candidates.sort((a, b) => b.date - a.date).slice(0, query.limit);
        const messages: MailMessage[] = [];
        for (const box of new Set(chosen.map((entry) => entry.box))) {
          const uids = chosen.filter((entry) => entry.box === box).map((entry) => entry.uid);
          messages.push(...(await locked(imap, box.path, () => load(imap, box, uids))));
        }
        return messages.sort((a, b) => b.date.localeCompare(a.date));
      });
    },

    read(providerId: string) {
      return atMail(providerId, async (imap, box, uid) => (await load(imap, box, [uid]))[0] ?? null);
    },

    attachment(providerId: string, index: number, maxBytes: number) {
      return atMail(providerId, async (imap, _box, uid): Promise<MailAttachmentFile | null> => {
        // First the size, then the mail: what is too large is not loaded. The whole mail comes, so that
        // the attachment is counted exactly as in `read`; the cap lies above the attachment including Base64.
        const [head] = await imap.fetchAll([uid], { uid: true, size: true }, { uid: true });
        if (!head) return null;
        const limit = Math.min(MAIL_ATTACHMENT_SOURCE_MAX_BYTES, Math.ceil((maxBytes * 4) / 3) + 1024 * 1024);
        if ((head.size ?? 0) > limit) throw new MailError(`At ${formatSize(head.size ?? 0)} the mail is too large to open an attachment from it.`);
        const [item] = await imap.fetchAll([uid], { uid: true, source: { maxLength: limit } }, { uid: true });
        if (!item?.source) return null;
        const file = listedAttachments(await simpleParser(item.source, { skipImageLinks: true, skipTextToHtml: true }))[index - 1];
        if (!file) return null;
        if (file.content.length > maxBytes) throw new MailError(`At ${formatSize(file.content.length)} the attachment is too large to open.`);
        return { name: file.label, mimeType: file.mimeType, body: file.content };
      });
    },

    newSince(cursor, limit): Promise<NewMail> {
      return inInbox(async (imap) => {
        const mailbox = imap.mailbox;
        if (!mailbox) throw new MailError("Inbox not open.");
        const validity = String(mailbox.uidValidity);
        const known = cursor && cursor["uidValidity"] === validity && typeof cursor["uidNext"] === "number";
        if (!known) {
          // First run, or the server has reassigned the UIDs: count from now. Asked fresh via STATUS,
          // because `mailbox.uidNext` is the state of the SELECT and goes stale on a long-open
          // connection.
          const status = await imap.status(INBOX, { uidNext: true });
          return { cursor: { uidValidity: validity, uidNext: status.uidNext ?? mailbox.uidNext }, messages: [] };
        }
        const from = cursor["uidNext"] as number;
        // Always search, never compare `mailbox.uidNext`: the connection stays open for hours
        // (GMX throttles logins), and imapflow does not update `uidNext` on new mail.
        // Measured on 2026-09-20: two new mails in the mailbox, `uidNext` of the open connection
        // unchanged, the trigger saw nothing.
        const found = await imap.search({ uid: `${from}:*` }, { uid: true });
        // `n:*` always returns at least the last mail, even if it is older.
        const uids = (Array.isArray(found) ? found : []).filter((uid) => uid >= from).sort((a, b) => a - b).slice(0, limit);
        // In order of receipt, not newest first as in the search: a postponement can only
        // change what was classified before it (live test 2026-09-20: reply read before request).
        const position = new Map(uids.map((uid, index) => [`${id}:${uid}`, index]));
        const messages = (await load(imap, INBOX_BOX, uids)).sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
        const last = uids[uids.length - 1];
        return { cursor: { uidValidity: validity, uidNext: last === undefined ? from : last + 1 }, messages };
      });
    },

    cleanup: {
      // IMAP does not need `senders`: the whole folder costs one second here (measured 2026-09-21).
      scan(folder: MailSourceFolder, sinceDays: number, max: number) {
        return inFolder(folder, async (imap) => {
          const found = await imap.search({ since: new Date(Date.now() - sinceDays * 86_400_000) }, { uid: true });
          const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, max);
          // Bare UIDs, also in the spam folder: `move` gets the source folder as well.
          return headerRows(imap, "", uids);
        });
      },

      headersFrom(addresses: readonly string[], sinceDays: number, max: number) {
        const targets = [...new Set(addresses.map((address) => address.trim().toLowerCase()))].filter(Boolean);
        if (targets.length === 0) return Promise.resolve([]);
        return serial(async (imap) => {
          const since = new Date(Date.now() - sinceDays * 86_400_000);
          // With the folder key: `move` never accidentally moves such an ID in the inbox.
          const rows = await fromAddresses(imap, targets, since, (box, uids) => headerRows(imap, box.key, uids.slice(0, max)));
          return rows.filter((row) => targets.includes(row.fromAddress)).sort((a, b) => b.date.localeCompare(a.date));
        });
      },

      linksFrom(addresses: readonly string[], sinceDays: number) {
        const targets = [...new Set(addresses.map((address) => address.trim().toLowerCase()))].filter(Boolean);
        if (targets.length === 0) return Promise.resolve(new Map<string, UnsubscribePage>());
        return serial(async (imap) => {
          const since = new Date(Date.now() - sinceDays * 86_400_000);
          // First only envelopes, to know each sender's newest mails; text only from those.
          const seen = await fromAddresses(imap, targets, since, async (box, uids) => {
            if (uids.length === 0) return [];
            const fetched = await imap.fetchAll(uids.slice(0, LINK_TRIES * targets.length), { uid: true, internalDate: true, envelope: true }, { uid: true });
            return fetched.map((item) => ({
              box,
              uid: item.uid,
              address: (item.envelope?.from?.[0]?.address ?? "").trim().toLowerCase(),
              date: (item.internalDate instanceof Date ? item.internalDate : new Date(item.internalDate ?? 0)).getTime(),
            }));
          });
          const links = new Map<string, UnsubscribePage>();
          for (const address of targets) {
            const newest = seen.filter((entry) => entry.address === address).sort((a, b) => b.date - a.date).slice(0, LINK_TRIES);
            for (const entry of newest) {
              const source = await locked(imap, entry.box.path, async () => {
                const [item] = await imap.fetchAll([entry.uid], { uid: true, source: { maxLength: MAIL_SOURCE_MAX_BYTES } }, { uid: true });
                return item?.source;
              });
              if (!source) continue;
              const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
              const route = unsubscribeLink(typeof parsed.html === "string" ? parsed.html : "");
              if (route?.kind !== "page") continue;
              links.set(address, { url: route.url, host: route.host });
              break;
            }
          }
          return links;
        });
      },

      move(from: MailSourceFolder, providerIds: readonly string[], to: MailFolder) {
        const uids = providerIds.map(Number).filter((uid) => Number.isInteger(uid) && uid > 0);
        if (uids.length === 0 || from === to) return Promise.resolve(0);
        return inFolder(from, async (imap) => {
          const path = await pathOf(imap, to);
          const moved = await imap.messageMove(uids, path, { uid: true });
          if (!moved) throw new MailError(`The server refused the move to ${path}.`);
          return moved.uidMap?.size ?? uids.length;
        });
      },
    },

    async send(mail: OutgoingMail) {
      const message = {
        // From Serain's own mailbox with a name: the recipient should see that it is not the owner writing.
        from: serains ? { name: SERAIN_SENDER_NAME, address } : address,
        to: mail.to,
        ...(mail.cc.length > 0 ? { cc: mail.cc } : {}),
        subject: mail.subject,
        text: mail.text,
        ...(mail.inReplyTo
          ? { inReplyTo: mail.inReplyTo.messageId, references: [...mail.inReplyTo.references, mail.inReplyTo.messageId] }
          : {}),
        ...(mail.attachments?.length
          ? { attachments: mail.attachments.map((file) => ({ filename: file.name, contentType: file.mimeType, content: file.body })) }
          : {}),
      };
      const transport = smtpTransport(secret);
      let messageId: string;
      try {
        messageId = (await transport.sendMail(message)).messageId;
      } catch (error) {
        throw new MailError(`Sending failed: ${(error as Error).message}`);
      } finally {
        transport.close();
      }
      // With GMX, SMTP stores no copy. Without it the owner would not find the mail in
      // "Sent"; if only the copy fails, the mail is out regardless.
      try {
        const raw = await new MailComposer({ ...message, messageId }).compile().build();
        await serial(async (imap) => {
          const sent = (await imap.list()).find((box) => box.specialUse === "\\Sent");
          if (sent) await imap.append(sent.path, raw, ["\\Seen"]);
        });
      } catch (error) {
        log.warn(`Copy to "Sent" for ${id} failed: ${(error as Error).message}`);
      }
      return { messageId };
    },

    async close() {
      const open = client;
      client = null;
      await open?.logout().catch(() => undefined);
    },
  };
  if (!serains) return account;
  // Cleanup (D37) is for the owner's inbox. Serain's mailbox receives replies, not newsletters.
  const { cleanup: _cleanup, ...own } = account;
  return { ...own, serains: true };
}
