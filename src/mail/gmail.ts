import addressparser from "nodemailer/lib/addressparser/index.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { GoogleError, type GoogleClient } from "../google/client.js";
import { htmlToText } from "../executor/fetch.js";
import { attachmentLabel, isBulk } from "./parse.js";
import { mailSnippet } from "./codes.js";
import { getDomain } from "tldts";
import {
  DATA_GMAIL_MAX_ROWS,
  DATA_GMAIL_PARALLEL,
  DATA_MAIL_HEADER_MAX_BYTES,
  KNOWN_SENDER_CHECK_MAX,
  MAIL_CLEANUP_GMAIL_CACHE,
  MAIL_CLEANUP_GMAIL_PARALLEL,
  MAIL_CLEANUP_GMAIL_PER_MINUTE,
  MAIL_CLEANUP_GMAIL_SCAN_MAX,
  RECIPIENT_HISTORY_DAYS,
  RECIPIENT_VERIFY_MAX,
} from "../config/limits.js";
import { addressesIn } from "./recipients.js";
import { GMAIL_TRUST, verifiedSenderDomain } from "./sender-auth.js";
import { formatSize } from "../files/name.js";
import { unsubscribeLink } from "./unsubscribe.js";
import {
  MailError,
  type MailAccount,
  type MailAttachmentFile,
  type MailCleanup,
  type MailFolder,
  type MailHeader,
  type MailHeaderExport,
  type MailMessage,
  type MailQuery,
  type MailSearchFolder,
  type MailSourceFolder,
  type NewMail,
  type OutgoingMail,
  type UnsubscribePage,
} from "./types.js";

/**
 * Gmail via the REST API (D32). Deliberately not via IMAP: with Google, IMAP
 * requires the scope `https://mail.google.com/`, i.e. full access including
 * deletion. The API makes do with `gmail.modify` and `gmail.send` (W3);
 * `gmail.modify` sets labels but never deletes for good. Until 2026-10-13 it
 * was `gmail.readonly`; such a grant can do everything except clean up.
 *
 * Reading uses `format=full` and takes the text from the parts instead of
 * loading the raw mail: attachments thus stay with Google. Searching happens
 * in every folder, also in trash and spam (addendum D31 of 2026-10-03); with
 * Gmail, IDs are independent of the label anyway.
 */

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const BULK_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"]);
/** Gmail's search operator per folder. `in:anywhere` includes trash and spam, without it both are missing. */
const SCOPE: Record<MailSearchFolder, string> = { all: "in:anywhere", inbox: "in:inbox", sent: "in:sent", trash: "in:trash", junk: "in:spam" };
/** With Gmail, labels are folders only in appearance: the first match wins, otherwise the mail is archived. */
const FOLDER_LABELS: Array<[string, string]> = [
  ["TRASH", "Trash"],
  ["SPAM", "Spam"],
  ["DRAFT", "Drafts"],
  ["INBOX", "Inbox"],
  ["SENT", "Sent"],
];

export function gmailFolder(labelIds: readonly string[] | undefined): string {
  return FOLDER_LABELS.find(([label]) => (labelIds ?? []).includes(label))?.[1] ?? "Archive";
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

/** An attachment as Gmail describes it: small parts carry their content, large ones only an ID for fetching. */
interface GmailFile {
  label: string;
  mimeType: string;
  size: number;
  data?: string;
  attachmentId?: string;
}

function collect(part: GmailPart | undefined, out: { plain: string[]; html: string[]; files: GmailFile[] }): void {
  if (!part) return;
  const header = (name: string) => part.headers?.find((entry) => entry.name.toLowerCase() === name)?.value ?? "";
  if (part.filename || part.mimeType === "text/calendar") {
    const inline = header("content-id") !== "" && !header("content-disposition").toLowerCase().startsWith("attachment");
    const label = attachmentLabel({ filename: part.filename, contentType: part.mimeType, inline });
    if (label) {
      out.files.push({
        label,
        mimeType: part.mimeType ?? "",
        size: part.body?.size ?? 0,
        ...(part.body?.data ? { data: part.body.data } : {}),
        ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}),
      });
    }
  } else if (part.mimeType === "text/plain") out.plain.push(decode(part.body?.data));
  else if (part.mimeType === "text/html") out.html.push(decode(part.body?.data));
  for (const child of part.parts ?? []) collect(child, out);
}

export function fromGmail(accountId: string, message: GmailMessage): MailMessage {
  const headers = new Map((message.payload?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value]));
  const parts = { plain: [] as string[], html: [] as string[], files: [] as GmailFile[] };
  collect(message.payload, parts);
  const text = (parts.plain.join("\n").trim() || parts.html.map((html) => htmlToText(html).text).join("\n").trim())
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  const precedence = (headers.get("precedence") ?? "").toLowerCase();
  const auto = (headers.get("auto-submitted") ?? "").toLowerCase();
  // The map above keeps the last one for duplicate names; here the order counts, top first.
  const senderDomain = verifiedSenderDomain(message.payload?.headers ?? [], GMAIL_TRUST);
  return {
    id: `${accountId}:${message.id}`,
    threadKey: message.threadId,
    from: headers.get("from") ?? "",
    to: headers.get("to") ?? "",
    subject: (headers.get("subject") ?? "").trim(),
    date: new Date(Number(message.internalDate ?? Date.now())).toISOString(),
    snippet: mailSnippet(text, undefined, { subject: headers.get("subject") ?? "", from: headers.get("from") ?? "" }),
    bulk:
      headers.has("list-unsubscribe") ||
      headers.has("list-id") ||
      ["bulk", "list", "junk"].includes(precedence) ||
      (message.labelIds ?? []).some((label) => BULK_LABELS.has(label)),
    automated: auto !== "" && auto !== "no",
    folder: gmailFolder(message.labelIds),
    text,
    attachments: parts.files.map((file) => file.label),
    messageId: headers.get("message-id") ?? "",
    references: (headers.get("references") ?? "").split(/\s+/).filter(Boolean),
    ...(senderDomain ? { senderDomain } : {}),
  };
}

/** Quotes removed: the value itself stands in quotes, and Gmail knows no escaping. */
const quoted = (value: string) => `"${value.replace(/["\\]/g, " ").trim()}"`;

export function gmailQuery(query: MailQuery): string {
  return [SCOPE[query.folder], `newer_than:${query.sinceDays}d`, query.from ? `from:${quoted(query.from)}` : "", query.text ? quoted(query.text) : ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * Mail from or to exactly this address (addendum D34). Without `in:inbox`:
 * sent and archived mail counts too, Gmail does not search spam and trash anyway.
 */
export function gmailCorrespondenceQuery(address: string): string {
  const value = quoted(address);
  return `newer_than:${RECIPIENT_HISTORY_DAYS}d (from:${value} OR to:${value} OR cc:${value})`;
}

/** Google errors become `MailError` with the mailbox in the text, as with IMAP. */
function mailErrors(id: string) {
  return async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GoogleError) throw new MailError(`Gmail (${id}): ${error.message}`);
      throw error;
    }
  };
}

/** Gmail's IDs for mails and threads: hex, 16 characters with Gmail. Anything else does not go into a URL or a `batchModify`. */
const GMAIL_ID = /^[A-Za-z0-9]{6,40}$/;

/** What the cleanup needs (D37): sender, subject and the list header lines. Never text, never attachment. */
const CLEANUP_HEADERS = ["From", "Subject", "List-Unsubscribe", "List-Unsubscribe-Post", "List-Id", "Precedence"];
const CLEANUP_METADATA = `format=metadata${CLEANUP_HEADERS.map((name) => `&metadataHeaders=${encodeURIComponent(name)}`).join("")}`;
/** With Gmail, folders are labels. Reading goes through `labelIds`, the label itself, without Gmail's search language in between. */
const LABEL: Record<MailFolder, string> = { inbox: "INBOX", trash: "TRASH", junk: "SPAM" };
/**
 * Where to look for the unsubscribe route: everywhere except spam, sent and
 * drafts, so including trash and archive, as with IMAP. The search hits
 * threads, so the code checks the labels of every mail once more.
 */
const ROUTE_QUERY = "in:anywhere -in:spam -in:sent -in:drafts";
const ROUTE_EXCLUDED = ["SPAM", "SENT", "DRAFT"];
/** This many senders in a search with OR, this many of a sender's newest mails searched for an unsubscribe link. As with IMAP. */
const HEADERS_FROM_CHUNK = 20;
const LINK_TRIES = 3;
/** `batchModify` takes at most 1,000 IDs. */
const MODIFY_CHUNK = 1_000;

/** Sender from the `From` header, as IMAP takes it from the envelope: first address, lowercase. */
export function gmailSender(from: string): { address: string; name: string } {
  const [first] = addressparser(from, { flatten: true });
  const address = (first?.address ?? "").trim().toLowerCase();
  return { address: address.includes("@") ? address : "", name: (first?.name ?? "").trim() };
}

/** Header lines of a Gmail mail as `MailHeader`. Duplicate header lines: the first value counts, as with IMAP. */
export function gmailHeader(message: GmailMessage): MailHeader {
  const headers = new Map<string, string>();
  for (const header of message.payload?.headers ?? []) {
    const name = header.name.toLowerCase();
    if (!headers.has(name)) headers.set(name, header.value);
  }
  const sender = gmailSender(headers.get("from") ?? "");
  return {
    providerId: message.id,
    fromAddress: sender.address,
    fromName: sender.name,
    subject: (headers.get("subject") ?? "").trim(),
    date: new Date(Number(message.internalDate ?? 0)).toISOString(),
    // Only the header, never Gmail's categories: what gets cleaned up is what identifies itself as bulk mail (D33).
    bulk: isBulk(headers),
    listUnsubscribe: headers.get("list-unsubscribe") ?? "",
    listUnsubscribePost: headers.get("list-unsubscribe-post") ?? "",
  };
}

/**
 * Cleanup for Gmail (D37, addendum of 2026-10-13): the same capability as with
 * IMAP, via labels. Moving means adding one label and removing the source
 * folder's, in one `batchModify`; trash and spam folder are just labels with
 * Gmail too. `gmail.modify` cannot delete for good.
 *
 * Gmail delivers header lines only mail by mail and allows around 300
 * requests per minute; the cleanup takes `MAIL_CLEANUP_GMAIL_PER_MINUTE` of
 * them, every request waits for its slot in the pace. A whole inbox thus costs
 * minutes (`slowScan`, at most `MAIL_CLEANUP_GMAIL_SCAN_MAX` mails); with
 * `senders`, `scan` only searches for these senders. What `scan` has already
 * fetched stays in memory (`MAIL_CLEANUP_GMAIL_CACHE`): the header lines of a
 * mail never change, only its labels, and those come fresh from the list on
 * every run.
 */
export function gmailCleanup(id: string, google: GoogleClient, clock: { now: () => number; wait: (ms: number) => Promise<void> } = REAL_CLOCK): MailCleanup {
  const wrap = mailErrors(id);
  const known = new Map<string, MailHeader>();
  let nextSlot = 0;

  /** The next free slot in the pace, across all calls of this mailbox. */
  async function paced<T>(request: () => Promise<T>): Promise<T> {
    const at = Math.max(clock.now(), nextSlot);
    nextSlot = at + 60_000 / MAIL_CLEANUP_GMAIL_PER_MINUTE;
    if (at > clock.now()) await clock.wait(at - clock.now());
    return request();
  }

  /** IDs of the newest mails for label and search, at most `max`, newest first. */
  async function listIds(params: { label?: string; q: string; spamTrash?: boolean }, max: number): Promise<string[]> {
    const ids: string[] = [];
    let page = "";
    do {
      const query = new URLSearchParams({ maxResults: String(Math.min(500, max - ids.length)), q: params.q });
      if (params.label) query.set("labelIds", params.label);
      if (params.spamTrash) query.set("includeSpamTrash", "true");
      if (page) query.set("pageToken", page);
      const list = await google.request<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(`${BASE}/messages?${query.toString()}`);
      ids.push(...(list.messages ?? []).map((entry) => entry.id).filter((messageId) => GMAIL_ID.test(messageId)));
      page = list.nextPageToken ?? "";
    } while (page && ids.length < max);
    return ids.slice(0, max);
  }

  /** Header lines and labels, fresh, side by side. What disappeared between list and fetch is missing. */
  async function metadata(ids: readonly string[]): Promise<GmailMessage[]> {
    const messages: GmailMessage[] = [];
    for (let start = 0; start < ids.length; start += MAIL_CLEANUP_GMAIL_PARALLEL) {
      const batch = await Promise.all(
        ids
          .slice(start, start + MAIL_CLEANUP_GMAIL_PARALLEL)
          .map((messageId) => paced(() => missingIsNull(google.request<GmailMessage>(`${BASE}/messages/${encodeURIComponent(messageId)}?${CLEANUP_METADATA}`)))),
      );
      messages.push(...batch.filter((message): message is GmailMessage => message !== null));
    }
    return messages;
  }

  const byDate = (a: MailHeader, b: MailHeader) => b.date.localeCompare(a.date);

  /** `from:` parts of the search, at most `HEADERS_FROM_CHUNK` senders per request. */
  const fromChunks = (addresses: readonly string[]): string[] => {
    const targets = [...new Set(addresses.map((address) => address.trim().toLowerCase()))].filter(Boolean);
    const chunks: string[] = [];
    for (let start = 0; start < targets.length; start += HEADERS_FROM_CHUNK) {
      chunks.push(`(${targets.slice(start, start + HEADERS_FROM_CHUNK).map((address) => `from:${quoted(address)}`).join(" OR ")})`);
    }
    return chunks;
  };

  return {
    scanMax: MAIL_CLEANUP_GMAIL_SCAN_MAX,
    slowScan: true,

    scan: (folder: MailSourceFolder, sinceDays: number, max: number, senders?: readonly string[]) =>
      wrap(async () => {
        const params = { label: LABEL[folder], spamTrash: folder === "junk" };
        const limit = Math.min(max, MAIL_CLEANUP_GMAIL_SCAN_MAX);
        const ids: string[] = [];
        if (senders) {
          for (const from of fromChunks(senders)) ids.push(...(await listIds({ ...params, q: `newer_than:${sinceDays}d ${from}` }, limit)));
        } else {
          ids.push(...(await listIds({ ...params, q: `newer_than:${sinceDays}d` }, limit)));
        }
        for (const message of await metadata(ids.filter((messageId) => !known.has(messageId)))) known.set(message.id, gmailHeader(message));
        const rows = [...new Set(ids)].flatMap((messageId) => {
          const row = known.get(messageId);
          if (!row) return [];
          // Last seen to the back: what has not appeared for longest drops out first.
          known.delete(messageId);
          known.set(messageId, row);
          return [row];
        });
        for (const stale of known.keys()) {
          if (known.size <= MAIL_CLEANUP_GMAIL_CACHE) break;
          known.delete(stale);
        }
        return rows.sort(byDate);
      }),

    headersFrom: (addresses: readonly string[], sinceDays: number, max: number) =>
      wrap(async () => {
        const targets = addresses.map((address) => address.trim().toLowerCase());
        const rows: MailHeader[] = [];
        for (const from of fromChunks(addresses)) {
          const ids = await listIds({ q: `${ROUTE_QUERY} newer_than:${sinceDays}d ${from}`, spamTrash: true }, max);
          // Fetched fresh, not from memory: the labels count here, no unsubscribe route comes from the spam folder.
          for (const message of await metadata(ids)) {
            if ((message.labelIds ?? []).some((label) => ROUTE_EXCLUDED.includes(label))) continue;
            const row = gmailHeader(message);
            if (targets.includes(row.fromAddress)) rows.push(row);
          }
        }
        return rows.sort(byDate);
      }),

    linksFrom: (addresses: readonly string[], sinceDays: number) =>
      wrap(async () => {
        const targets = [...new Set(addresses.map((address) => address.trim().toLowerCase()))].filter(Boolean);
        const links = new Map<string, UnsubscribePage>();
        for (const address of targets) {
          // Gmail's `from:` is fuzzy: fetch a few more, only mails of exactly this sender count.
          const ids = await listIds({ q: `${ROUTE_QUERY} newer_than:${sinceDays}d from:${quoted(address)}`, spamTrash: true }, LINK_TRIES * 2);
          let tries = 0;
          for (const messageId of ids) {
            if (tries >= LINK_TRIES) break;
            const message = await paced(() => missingIsNull(google.request<GmailMessage>(`${BASE}/messages/${encodeURIComponent(messageId)}?format=full`)));
            if (!message || (message.labelIds ?? []).some((label) => ROUTE_EXCLUDED.includes(label))) continue;
            if (gmailHeader(message).fromAddress !== address) continue;
            tries += 1;
            const parts = { plain: [] as string[], html: [] as string[], files: [] as GmailFile[] };
            collect(message.payload, parts);
            const route = unsubscribeLink(parts.html.join("\n"));
            if (route?.kind !== "page") continue;
            links.set(address, { url: route.url, host: route.host });
            break;
          }
        }
        return links;
      }),

    move: (from: MailSourceFolder, providerIds: readonly string[], to: MailFolder) =>
      wrap(async () => {
        const ids = [...new Set(providerIds)].filter((messageId) => GMAIL_ID.test(messageId));
        if (ids.length === 0 || from === to) return 0;
        // Gmail IDs apply everywhere. The callers only pass on IDs from `scan` of the same folder; the source
        // folder's label is removed, the target's added, like a move in the Gmail interface.
        for (let start = 0; start < ids.length; start += MODIFY_CHUNK) {
          await google.request(`${BASE}/messages/batchModify`, {
            method: "POST",
            body: { ids: ids.slice(start, start + MODIFY_CHUNK), addLabelIds: [LABEL[to]], removeLabelIds: [LABEL[from]] },
          });
        }
        return ids.length;
      }),
  };
}

const REAL_CLOCK = { now: Date.now, wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

/** Deleted between list and fetch: then the mail no longer exists. */
async function missingIsNull<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof GoogleError && error.status === 404) return null;
    throw error;
  }
}

export function gmailAccount(id: string, address: string, google: GoogleClient, options: { cleanup?: boolean } = {}): MailAccount {
  const wrap = mailErrors(id);
  const get = (messageId: string) => google.request<GmailMessage>(`${BASE}/messages/${encodeURIComponent(messageId)}?format=full`);

  return {
    id,
    address,
    // Only with `gmail.modify` (`src/integrations/setup.ts`): an older grant may not set labels.
    ...(options.cleanup ? { cleanup: gmailCleanup(id, google) } : {}),

    search: (query) =>
      wrap(async () => {
        const list = await google.request<{ messages?: Array<{ id: string }> }>(
          `${BASE}/messages?maxResults=${query.limit}&q=${encodeURIComponent(gmailQuery(query))}`,
        );
        const messages: MailMessage[] = [];
        for (const entry of list.messages ?? []) messages.push(fromGmail(id, await get(entry.id)));
        return messages;
      }),

    knewDomainBefore: (domain, before) =>
      wrap(async () => {
        const site = getDomain(domain);
        if (!site) return false;
        // Without `in:anywhere`: Gmail does not search spam and trash, sent mail never carries this domain as sender.
        const day = `${before.getUTCFullYear()}/${before.getUTCMonth() + 1}/${before.getUTCDate()}`;
        const list = await google.request<{ messages?: Array<{ id: string }> }>(
          `${BASE}/messages?maxResults=${KNOWN_SENDER_CHECK_MAX}&q=${encodeURIComponent(`from:${quoted(site)} before:${day}`)}`,
        );
        for (const entry of list.messages ?? []) {
          const message = await google.request<GmailMessage>(`${BASE}/messages/${encodeURIComponent(entry.id)}?format=metadata&metadataHeaders=From`);
          const from = (message.payload?.headers ?? []).find((header) => header.name.toLowerCase() === "from")?.value ?? "";
          if (addressesIn(from).some((address) => getDomain(address.split("@").pop() ?? "") === site)) return true;
        }
        return false;
      }),

    exportHeaders: (query) =>
      wrap(async () => {
        // Gmail understands seconds since 1970 in after/before; the boundary is thus exact.
        const q = `${SCOPE[query.folder]} after:${Math.floor(query.since.getTime() / 1000)} before:${Math.floor(query.before.getTime() / 1000)}`;
        const max = Math.min(query.max, DATA_GMAIL_MAX_ROWS);
        const ids: string[] = [];
        let page = "";
        let more = false;
        do {
          const list = await google.request<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
            `${BASE}/messages?maxResults=500&q=${encodeURIComponent(q)}${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
          );
          ids.push(...(list.messages ?? []).map((entry) => entry.id));
          page = list.nextPageToken ?? "";
        } while (page && ids.length <= max);
        more = ids.length > max || page !== "";
        // Only header lines (`format=metadata` without a selection returns all), no text. Parallel, but limited: Gmail throttles per user.
        const picked = ids.slice(0, max);
        const rows: MailHeaderExport[] = [];
        for (let start = 0; start < picked.length; start += DATA_GMAIL_PARALLEL) {
          const batch = await Promise.all(
            picked.slice(start, start + DATA_GMAIL_PARALLEL).map((messageId) => google.request<GmailMessage>(`${BASE}/messages/${encodeURIComponent(messageId)}?format=metadata`)),
          );
          for (const message of batch) {
            rows.push({
              providerId: message.id,
              folder: gmailFolder(message.labelIds),
              date: new Date(Number(message.internalDate ?? 0)).toISOString(),
              headers: (message.payload?.headers ?? [])
                .map((header) => `${header.name}: ${header.value}`)
                .join("\r\n")
                .slice(0, DATA_MAIL_HEADER_MAX_BYTES),
            });
          }
        }
        return { rows: rows.sort((a, b) => b.date.localeCompare(a.date)), truncated: more };
      }),

    hasCorresponded: (recipient) =>
      wrap(async () => {
        const target = recipient.trim().toLowerCase();
        const list = await google.request<{ messages?: Array<{ id: string }> }>(
          `${BASE}/messages?maxResults=${RECIPIENT_VERIFY_MAX}&q=${encodeURIComponent(gmailCorrespondenceQuery(target))}`,
        );
        // Gmail's search is fuzzy; only where the address stands exactly in the header counts. Only header lines, no text.
        for (const entry of list.messages ?? []) {
          const message = await google.request<GmailMessage>(
            `${BASE}/messages/${encodeURIComponent(entry.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
          );
          const headers = (message.payload?.headers ?? []).filter((header) => ["from", "to", "cc"].includes(header.name.toLowerCase()));
          if (headers.some((header) => addressesIn(header.value).includes(target))) return true;
        }
        return false;
      }),

    repliedSince: (threadKey, since) =>
      wrap(async () => {
        if (!GMAIL_ID.test(threadKey)) return false;
        // Only label and receipt, no header lines, no text.
        const thread = await google.request<{ messages?: GmailMessage[] }>(
          `${BASE}/threads/${encodeURIComponent(threadKey)}?format=minimal`,
        );
        return (thread.messages ?? []).some((message) => (message.labelIds ?? []).includes("SENT") && Number(message.internalDate ?? 0) >= since.getTime());
      }),

    read: (providerId) =>
      wrap(async () => {
        try {
          return fromGmail(id, await get(providerId));
        } catch (error) {
          if (error instanceof GoogleError && (error.status === 404 || error.status === 400)) return null;
          throw error;
        }
      }),

    attachment: (providerId, index, maxBytes) =>
      wrap(async (): Promise<MailAttachmentFile | null> => {
        let message: GmailMessage;
        try {
          message = await get(providerId);
        } catch (error) {
          if (error instanceof GoogleError && (error.status === 404 || error.status === 400)) return null;
          throw error;
        }
        const parts = { plain: [] as string[], html: [] as string[], files: [] as GmailFile[] };
        collect(message.payload, parts);
        const file = parts.files[index - 1];
        if (!file) return null;
        // Read access is enough for fetching (D32); Gmail states the size beforehand, anything too large is not loaded.
        if (file.size > maxBytes) throw new MailError(`At ${formatSize(file.size)} the attachment is too large to open.`);
        const data =
          file.data ??
          (file.attachmentId
            ? (
                await google.request<{ data?: string }>(
                  `${BASE}/messages/${encodeURIComponent(providerId)}/attachments/${encodeURIComponent(file.attachmentId)}`,
                )
              ).data
            : undefined);
        if (!data) return null;
        const body = Buffer.from(data, "base64url");
        if (body.length > maxBytes) throw new MailError(`At ${formatSize(body.length)} the attachment is too large to open.`);
        return { name: file.label, mimeType: file.mimeType, body };
      }),

    newSince: (cursor, limit): Promise<NewMail> =>
      wrap(async () => {
        const current = async () => ({ historyId: (await google.request<{ historyId: string }>(`${BASE}/profile`)).historyId });
        const start = typeof cursor?.["historyId"] === "string" ? cursor["historyId"] : null;
        if (!start) return { cursor: await current(), messages: [] };
        let history: { history?: Array<{ messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }> }>; historyId?: string };
        try {
          history = await google.request(
            `${BASE}/history?startHistoryId=${encodeURIComponent(start)}&historyTypes=messageAdded&labelId=INBOX&maxResults=100`,
          );
        } catch (error) {
          // Google keeps the history for only about a week. After that: count from now.
          if (error instanceof GoogleError && error.status === 404) return { cursor: await current(), messages: [] };
          throw error;
        }
        const ids = [
          ...new Set(
            (history.history ?? [])
              .flatMap((entry) => entry.messagesAdded ?? [])
              .filter((added) => (added.message.labelIds ?? []).includes("INBOX"))
              .map((added) => added.message.id),
          ),
        ].slice(0, limit);
        const messages: MailMessage[] = [];
        for (const messageId of ids) {
          // Deleted between history and fetch: then there is nothing to classify.
          const message = await get(messageId).catch((error: unknown) => {
            if (error instanceof GoogleError && error.status === 404) return null;
            throw error;
          });
          if (message) messages.push(fromGmail(id, message));
        }
        return { cursor: { historyId: history.historyId ?? start }, messages };
      }),

    send: (mail: OutgoingMail) =>
      wrap(async () => {
        const raw = await new MailComposer({
          from: address,
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
        })
          .compile()
          .build();
        const sent = await google.request<{ id: string }>(`${BASE}/messages/send`, {
          method: "POST",
          body: { raw: raw.toString("base64url") },
        });
        // Gmail sets the identifier recipients reply to itself: read it back, do not assume our own.
        // If only that fails, the mail is out regardless.
        const meta = await google
          .request<GmailMessage>(`${BASE}/messages/${encodeURIComponent(sent.id)}?format=metadata&metadataHeaders=Message-ID`)
          .catch(() => null);
        const header = meta?.payload?.headers?.find((entry) => entry.name.toLowerCase() === "message-id");
        return { messageId: header?.value ?? "" };
      }),

    async close() {},
  };
}
