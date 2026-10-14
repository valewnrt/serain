/**
 * A mailbox, no matter where (D31). IMAP providers speak IMAP/SMTP, Gmail the
 * REST API; the tools and the trigger know only this interface. Credentials
 * do not appear here (W16): an adapter gets them when built and never hands
 * them out.
 */

export interface MailSummary {
  /** `<account>:<provider id>`, as `mail_read` expects it. */
  id: string;
  /** Same value for all mails of a thread, as far as the provider allows. */
  threadKey: string;
  from: string;
  to: string;
  subject: string;
  /** ISO time of receipt. */
  date: string;
  snippet: string;
  /** Newsletters, advertising, bulk mail: recognised by the header, not guessed. */
  bulk: boolean;
  /** From a machine, but not a list (`Auto-Submitted`): confirmations, tickets. Missing: no. */
  automated?: boolean;
  /** Where the mail lies, for display: "Inbox", "Trash", "Spam", "Sent", a custom folder. */
  folder: string;
}

export interface MailMessage extends MailSummary {
  /** Plain text, derived from HTML if there is none. Raw: masking happens one level up (W17). */
  text: string;
  /** Only file names, in the order in which `MailAccount.attachment` counts them. */
  attachments: string[];
  /** `Message-ID` header, for replies. */
  messageId: string;
  references: string[];
  /**
   * The sender's domain, confirmed by the owner's provider via DMARC on receipt
   * (`src/mail/sender-auth.ts`, addendum D8.4 of 2026-10-12). Missing: not confirmed.
   */
  senderDomain?: string;
}

/** Where to search: everywhere (addendum D31 of 2026-10-03) or in one of the folders every provider has. */
export type MailSearchFolder = "all" | "inbox" | "sent" | "trash" | "junk";

export interface MailQuery {
  text?: string;
  from?: string;
  sinceDays: number;
  limit: number;
  folder: MailSearchFolder;
}

export interface OutgoingMail {
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  /** Reply to this mail: sets `In-Reply-To` and `References`. */
  inReplyTo?: { messageId: string; references: string[] };
  /** Files the owner sent (addendum D34 of 2026-10-08). Missing if there are none. */
  attachments?: MailAttachment[];
}

export interface MailAttachment {
  name: string;
  mimeType: string;
  body: Buffer;
}

/**
 * An attachment from a mail, as the provider delivers it (addendum D31 of
 * 2026-10-12): foreign bytes. It is only opened in the sandbox.
 */
export interface MailAttachmentFile {
  name: string;
  /** Stated by the mail, not checked. */
  mimeType: string;
  body: Buffer;
}

export interface NewMail {
  /** Opaque cursor, goes into `integrations.state`. */
  cursor: Record<string, unknown>;
  messages: MailMessage[];
}

/** Header lines of a mail, without text. Basis for the cleanup (D37). */
export interface MailHeader {
  /** Provider id, without the account prefix. */
  providerId: string;
  /** Only the address, lowercase. */
  fromAddress: string;
  /** Display name from the header, foreign content: only for the spelling in `senderLabel`. */
  fromName: string;
  subject: string;
  date: string;
  bulk: boolean;
  /** Raw values of `List-Unsubscribe` and `List-Unsubscribe-Post`, empty if missing. */
  listUnsubscribe: string;
  listUnsubscribePost: string;
}

/** A mail as header lines for analysis (D63, building block D): never text, never attachment. */
export interface MailHeaderExport {
  /** Provider id, without the account prefix, as with `search`. */
  providerId: string;
  /** Display name of the folder. */
  folder: string;
  /** Receipt at the provider, ISO. */
  date: string;
  /** The raw header, as the provider delivers it, at most `DATA_MAIL_HEADER_MAX_BYTES`. */
  headers: string;
}

/** An unsubscribe page: the address from the mail text and its host for the preview. */
export interface UnsubscribePage {
  url: string;
  host: string;
}

export type MailFolder = "inbox" | "trash" | "junk";
/** Where to clean up: in the inbox, or in the spam folder the provider fills itself. */
export type MailSourceFolder = "inbox" | "junk";

/**
 * Cleanup (D37): read header lines in breadth and move mails between inbox,
 * trash and spam folder. Nothing is ever deleted for good; the provider does
 * that itself after its period. A mailbox without this capability does not
 * offer the cleanup tools.
 */
export interface MailCleanup {
  /**
   * At most this many header lines are read by a `scan` when the provider
   * delivers every mail individually (Gmail, addendum D37 of 2026-10-13).
   * Missing: `MAIL_CLEANUP_SCAN_MAX`.
   */
  readonly scanMax?: number;
  /**
   * A whole inbox costs minutes (Gmail). The tools then only read it in full
   * where the answer depends on it.
   */
  readonly slowScan?: boolean;
  /**
   * Newest first, at most `max`. IDs only apply in the folder read.
   * `senders`: only mails from these addresses are needed. An adapter may
   * still deliver more; the caller filters by the exact address itself.
   */
  scan(folder: MailSourceFolder, sinceDays: number, max: number, senders?: readonly string[]): Promise<MailHeader[]>;
  /**
   * Header lines of the mails from exactly these addresses in all folders
   * except spam, sent and drafts, newest first. Only for the unsubscribe route:
   * a newsletter whose mails the owner has already thrown away or filed can
   * still be unsubscribed (addendum D37 of 2026-10-03). The IDs are no good
   * for moving.
   */
  headersFrom(addresses: readonly string[], sinceDays: number, max: number): Promise<MailHeader[]>;
  /**
   * The unsubscribe link in the mail text, per address from the newest mail
   * that has one; the same folders as `headersFrom`, so never spam. Reads the
   * text of these senders' most recent mails, but returns only the link
   * (addendum D37 of 2026-10-03).
   */
  linksFrom(addresses: readonly string[], sinceDays: number): Promise<Map<string, UnsubscribePage>>;
  /** Moves from `from` to `to` and returns how many there were. */
  move(from: MailSourceFolder, providerIds: readonly string[], to: MailFolder): Promise<number>;
}

export interface MailAccount {
  readonly id: string;
  readonly address: string;
  /**
   * Serain's own mailbox (addendum D31 of 2026-10-08), not the owner's: from
   * there Serain writes as itself, with the name "Serain". If missing, it is
   * the owner's.
   */
  readonly serains?: boolean;
  readonly cleanup?: MailCleanup;
  search(query: MailQuery): Promise<MailSummary[]>;
  /** `id` without the account prefix. Null if the mail does not exist (any more). */
  read(providerId: string): Promise<MailMessage | null>;
  /**
   * Attachment number `index` (from 1, as in `MailMessage.attachments`) of a
   * mail, `providerId` without the account prefix. Null if mail or attachment
   * does not exist. Throws `MailError` if it is larger than `maxBytes`; it is
   * then not loaded. Without this capability attachments in this mailbox stay
   * closed.
   */
  attachment?(providerId: string, index: number, maxBytes: number): Promise<MailAttachmentFile | null>;
  /** `messageId`: the `Message-ID` header of the sent mail, empty if the provider does not reveal it. */
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  /**
   * New mails in the inbox since the cursor. Without a cursor: none, only the
   * current state, so that the first run does not classify the whole mailbox.
   */
  newSince(cursor: Record<string, unknown> | null, limit: number): Promise<NewMail>;
  /**
   * Has there been mail with this address before (addendum D34)? A mail from it
   * in the inbox or one to it (To or Cc) in the Sent folder, in the last
   * `RECIPIENT_HISTORY_DAYS` days, exactly this address. Reads only envelopes,
   * never text. Basis for the hint in the preview of `mail_send`; a mailbox
   * without this capability does not count there.
   */
  hasCorresponded?(address: string): Promise<boolean>;
  /**
   * Has the owner written in this thread themselves since `since` (addendum D33
   * of 2026-10-10)? A mail in the Sent folder whose `References` or
   * `In-Reply-To` names the thread (with Gmail: the same `threadId` with label
   * SENT). Reads only header lines. Then Serain no longer reports the mail; the
   * heartbeat still reminds of a deadline in it (`src/mail/replied.ts`).
   * Without this capability: unknown.
   */
  repliedSince?(threadKey: string, since: Date): Promise<boolean>;
  /**
   * Did mail come from this registrable domain before `before` (addendum D8.4
   * of 2026-10-12)? Senders with exactly this domain or a subdomain, in all
   * folders except spam, sent and drafts. Reads only envelopes. Only then does
   * Serain link the home page after a confirmed mail. Without this capability:
   * never.
   */
  knewDomainBefore?(domain: string, before: Date): Promise<boolean>;
  /**
   * All header lines of the mails of a folder (or of all) received in
   * `[since, before)`, newest first, at most `max`, for `analyze_data` (D63,
   * building block D). Never text, never attachment. Without this capability
   * the mailbox is not a source.
   */
  exportHeaders?(query: { folder: MailSearchFolder; since: Date; before: Date; max: number }): Promise<{ rows: MailHeaderExport[]; truncated: boolean }>;
  close(): Promise<void>;
}

/** The sender name from Serain's own mailbox (addendum D31 of 2026-10-08: only "Serain"). */
export const SERAIN_SENDER_NAME = "Serain";

export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailError";
  }
}
