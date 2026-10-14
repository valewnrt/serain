import { z } from "zod";
import {
  MAIL_CLEANUP_LIST_OTHERS,
  MAIL_CLEANUP_LIST_SENDERS,
  MAIL_CLEANUP_LIST_SPAM,
  MAIL_CLEANUP_MAX_DAYS,
  MAIL_CLEANUP_MAX_SENDERS,
  MAIL_CLEANUP_MAX_SPAM,
  MAIL_CLEANUP_SCAN_MAX,
  MAIL_ATTACHMENT_MAX_BYTES,
  MAIL_BATCH_MAX,
  MAIL_ATTACHMENT_TOOL_TIMEOUT_MS,
  MAIL_BULK_TOOL_TIMEOUT_MS,
  MAIL_CODE_MAX_AGE_MS,
  MAIL_MAX_RECIPIENTS,
  MAIL_OPEN_DEFAULT_DAYS,
  MAIL_OPEN_MAX_DAYS,
  MAIL_OPEN_MAX_ITEMS,
  MAIL_OPEN_REPLY_CHECKS,
  MAIL_READ_MAX_CHARS,
  MAIL_SEARCH_MAX_DAYS,
  MAIL_SEARCH_MAX_RESULTS,
  MAIL_SEND_MAX_CHARS,
  MAIL_SEND_MAX_FILE_BYTES,
  MAIL_SEND_MAX_FILES,
  MAIL_SPAM_CORRESPONDENCE_CHECKS,
  MAIL_SPAM_MAX_RESCUE,
  MAIL_UNSUBSCRIBE_PAGES_MAX,
} from "../../config/limits.js";
import {
  cleanupUndo,
  describePlan,
  named,
  describeSpamFolder,
  findRoutes,
  NAMED_SENDERS_MAX,
  ownerNamedSenders,
  planCleanup,
  planSpamFolder,
  runCleanup,
  runSpamFolder,
  senderOverview,
  type CleanupDeps,
  type CleanupStep,
} from "../../mail/cleanup.js";
import { openMailAttachment, type AttachmentOpener } from "../../mail/attachment.js";
import { describeBatch } from "../../mail/batch.js";
import { answeredOf } from "../../mail/replied.js";
import { extractCodes, maskCodes } from "../../mail/codes.js";
import { addKeep, isKept, loadKeep, removeKeep, type MailKeepStore } from "../../mail/keep.js";
import { describeOpen, selectOpen, type MailItemReader } from "../../mail/open-items.js";
import { checkRecipients, describeRecipientWarnings, mailboxSource, type RecipientSource } from "../../mail/recipients.js";
import { senderTrust } from "../../mail/sender-auth.js";
import { normalizeMessageId, type SentMailStore } from "../../mail/sent.js";
import { MailError, SERAIN_SENDER_NAME, type MailAccount, type MailCleanup, type MailSummary } from "../../mail/types.js";
import { formatSize } from "../../files/name.js";
import { currentLocale } from "../../i18n/language.js";
import { FILE_ID, type FileShelf, type ShelvedFile } from "../../files/shelf.js";
import { t, textLanguage } from "../../i18n/catalog.js";
import { tools as messages } from "../../i18n/messages/tools.js";
import { primaryWord } from "../../i18n/words.js";
import { formatWallTime } from "../../time.js";
import { audit } from "../../db/audit.js";
import { log } from "../../log.js";
import { defineTool, type ToolDefinition, type ToolResult } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * Mail (D31, D34). Four tools, three boundaries:
 *
 * - **Reading belongs to the chat, not the executor,** for the same reason as
 *   the Apple data (D28): the executor can fetch addresses; with the owner's
 *   mails in hand a prepared page would be a way out. A mail is untrusted
 *   content par excellence, hence `returnsUntrusted`: after it, the same turn
 *   gets neither `run_task` nor owner-only tools nor standing approvals.
 * - **Narrow per call (W3):** few mails, few days, a shortened text. There is
 *   no "give me the mailbox". Results are not in the audit log
 *   (`privateResult`, W13). Narrow does not mean "only the inbox": every
 *   folder is searched (decision of 2026-10-03), every mail names its folder.
 * - **Only the sandbox opens attachments** (addendum D31 of 2026-10-12):
 *   `mail_attachment` turns a PDF into text and an image into a description,
 *   as untrusted as the mail itself. Other file types stay closed.
 * - **Codes are their own level (W17):** `mail_search` and `mail_read` hide
 *   them before a model sees the text. `mail_code` hands them out, but only on
 *   the owner's direct instruction in a clean turn, only from mails of the
 *   last quarter of an hour, and only the string itself.
 * - **Sending is level 3 (D8.3):** `mail_send` never runs from the turn but
 *   through the preview, which shows every recipient and the whole text. If a
 *   recipient has not appeared anywhere yet (mailbox, contacts, the owner's
 *   messages), the first line says so (addendum D34). Only what the owner sent
 *   via iMessage themselves can be attached, and with an attachment there is
 *   always a preview (addendum D34 of 2026-10-08).
 * - **Serain's own mailbox** (addendum D31 of 2026-10-08) is never the
 *   default. Whoever writes from there writes as Serain, and the preview says
 *   so in the sender; the same levels, its own standing approval.
 * - **Cleaning up is level 3 (D37):** `mail_senders` shows who fills the inbox
 *   with bulk mail, only from headers. `mail_cleanup` unsubscribes and moves,
 *   but only after a preview whose numbers the code counted in the mailbox.
 *   Nothing is ever deleted for good.
 *
 * The previews are fixed texts from the catalog (`src/i18n/messages/tools.ts`)
 * with the content (recipients, subject, text, file names) as verbatim values.
 */

export interface MailToolDeps {
  /** Connected mailboxes, the first is the main mailbox. Never empty. */
  accounts: readonly MailAccount[];
  now?: () => Date;
  /** One-click POST (without network in tests) and the browser for unsubscribe pages; without `openPage` no page. */
  cleanup?: CleanupDeps;
  /** Keep list (D37). Required as soon as a mailbox can clean up. */
  keep?: MailKeepStore;
  /**
   * More places where a recipient may already have appeared (addendum D34):
   * the owner's own messages, their contacts on the Mac. The tool asks the
   * mailboxes from `accounts` itself. Order = order in the preview's sentence.
   */
  recipientSources?: readonly RecipientSource[];
  /** What the mail trigger classified (D33); without it there is no `mail_open_items`. */
  items?: MailItemReader;
  /** Files the owner sent via iMessage; without a shelf `mail_send` takes no attachments. */
  files?: FileShelf;
  /** Sandbox and image model for `mail_attachment` (addendum D31 of 2026-10-12); without them attachments stay closed. */
  opener?: AttachmentOpener;
  /** Ids of sent mails (addendum D33 of 2026-10-13): the mail trigger always reports a reply to them. */
  sent?: SentMailStore;
}

const email = z.string().trim().toLowerCase().regex(/^[^\s@<>,;"']+@[^\s@<>,;"']+\.[a-z]{2,}$/, "not a mail address");

/**
 * The confirmed sender domain, if mail came from it already
 * `KNOWN_SENDER_MIN_AGE_DAYS` days ago (addendum D8.4 of 2026-10-12): a
 * phisher's freshly registered domain passes DMARC too. If the mailbox cannot
 * tell: null.
 */
async function knownSender(box: MailAccount, domain: string, at: Date): Promise<string | null> {
  return (await senderTrust(box, domain, at)) === "known" ? domain : null;
}

/**
 * The id of a sent mail for the mail trigger. If that fails, the mail is still
 * out and the tool succeeded; only Serain does not report the reply to it on
 * its own. That is in the audit log, not silently in the journal.
 */
async function rememberSent(store: SentMailStore | undefined, accountId: string, messageId: string): Promise<void> {
  const id = normalizeMessageId(messageId);
  if (!store) return;
  if (!id) return void (await audit("mail_sent_unrecorded", { account: accountId, reason: "no_message_id" }));
  try {
    await store.record(accountId, id, new Date());
  } catch (error) {
    log.warn(`Sent mail in ${accountId} not recorded:`, (error as Error).message);
    await audit("mail_sent_unrecorded", { account: accountId, reason: (error as Error).message });
  }
}

function failure(error: unknown): ToolResult {
  if (error instanceof MailError) return { ok: false, text: `${error.message} Tell ${owner.name} instead of guessing.` };
  throw error;
}

function summaryLine(mail: MailSummary): string {
  return [
    `- [${mail.id}] ${formatWallTime(new Date(mail.date))} | ${mail.folder} | ${mail.from || "(no sender)"}`,
    `  ${maskCodes(mail.subject, { subject: mail.subject, from: mail.from }) || "(no subject)"}${mail.bulk ? " (newsletter/bulk mail)" : ""}`,
    mail.snippet ? `  ${maskCodes(mail.snippet, { subject: mail.subject, from: mail.from })}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The owner wants names, not addresses (decision of 2026-10-13: what spam
 * mails are called does not matter). The code builds the names from the
 * address (`senderLabel`).
 */
const SENDER_NAMES_NOTE = `When talking to ${owner.name}, call senders by the name before the parentheses, never with the address; only the tools need the address.`;

/** Who writes, for the preview: from Serain's mailbox with a name, otherwise only the owner's address. */
function sender(box: MailAccount): string {
  return box.serains ? `${SERAIN_SENDER_NAME} <${box.address}>` : box.address;
}

export function mailTools(deps: MailToolDeps): ToolDefinition[] {
  // The default is always one of the owner's mailboxes (the first connected): only an explicit choice writes as Serain (addendum D31 of 2026-10-08).
  const primary = deps.accounts.find((entry) => !entry.serains) ?? deps.accounts[0];
  if (!primary) throw new Error("mailTools without a mailbox");
  const own = deps.accounts.find((entry) => entry.serains);
  const now = deps.now ?? (() => new Date());
  const ids = deps.accounts.map((account) => account.id);
  const label = (entry: MailAccount) => `${entry.id} (${entry.address}${entry.serains ? ", your own address" : ""})`;
  const account = z
    .enum(ids as [string, ...string[]])
    .optional()
    .describe(`Mailbox: ${deps.accounts.map(label).join(", ")}. Default ${primary.id}.`);
  const pick = (id: string | undefined): MailAccount => deps.accounts.find((entry) => entry.id === id) ?? primary;
  /**
   * The first line of a mail preview. The sender only appears if it is not the
   * owner's main mailbox: that is the default.
   */
  const previewHead = (
    id: string | undefined,
    forms: { plain: () => string; as: (from: string) => string; from: (from: string) => string },
  ): string => {
    const box = pick(id);
    return box === primary ? forms.plain() : box.serains ? forms.as(sender(box)) : forms.from(box.address);
  };
  const which = deps.accounts.length > 1 ? ` Mailboxes: ${ids.join(", ")}.` : "";
  const ownNote = own
    ? ` ${own.id} is your own mailbox (${own.address}), not ${owner.name}'s: replies to mails you sent as Serain land there.`
    : "";
  const mailbox = mailboxSource(deps.accounts);
  const recipientSources = [...(mailbox ? [mailbox] : []), ...(deps.recipientSources ?? [])];

  /**
   * The files for the ids, from the shelf (addendum D34 of 2026-10-08). If one
   * is missing, the mail does not go out without it: then this throws, in the
   * preview as after the 👍.
   */
  const attachments = (ids: readonly string[]): ShelvedFile[] => {
    const files = [...new Set(ids)].map((id) => {
      const file = deps.files?.get(id);
      if (!file) {
        throw new MailError(
          `The file ${id} is no longer with you: files only stay until a restart, at most one day. ` +
            `If it came from the vault, fetch it again with vault_file; otherwise ${owner.name} has to send it again. Not sent.`,
        );
      }
      return file;
    });
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAIL_SEND_MAX_FILE_BYTES) {
      throw new MailError(`The attachments add up to ${formatSize(total)}, more than ${formatSize(MAIL_SEND_MAX_FILE_BYTES)} doesn't fit in a mail. Not sent.`);
    }
    return files;
  };

  const tools: ToolDefinition[] = [];
  const opener = deps.opener;
  const openable = opener !== undefined && deps.accounts.some((entry) => entry.attachment);
  const mailId = z.string().trim().regex(/^[a-z][a-z0-9_]{1,30}:[A-Za-z0-9_-]{1,64}$/, "id from mail_search");
  const items = deps.items;
  if (items) {
    tools.push(
      defineTool({
        name: "mail_open_items",
        description:
          `What is open in ${owner.name}'s mailbox: who is waiting for a reaction, which appointments and deadlines are coming up, what ` +
          "changed about them. Only reads what the mail trigger already classified on arrival (summary, promise, " +
          "due date), without mail text and without searching the mailbox again. For \"what's open?\", \"who's waiting " +
          "for me?\", \"what's on this week?\". Newsletters and bulk mail are missing; for a specific mail use mail_search.",
        level: "read",
        repeatable: true,
        returnsUntrusted: true,
        privateResult: true,
        schema: {
          days: z
            .number()
            .int()
            .min(1)
            .max(MAIL_OPEN_MAX_DAYS)
            .optional()
            .describe(`This many days back, default ${MAIL_OPEN_DEFAULT_DAYS}, at most ${MAIL_OPEN_MAX_DAYS}.`),
        },
        async run(args) {
          const days = args.days ?? MAIL_OPEN_DEFAULT_DAYS;
          const at = now();
          const rows = await items.recent(new Date(at.getTime() - days * 86_400_000), MAIL_OPEN_MAX_ITEMS);
          const open = selectOpen(rows);
          // Whoever already has a reply from the owner is no longer waiting (addendum D33 of 2026-10-10). Only the newest,
          // an IMAP mailbox checks one thread after the other.
          const checked = open.waiting.slice(0, MAIL_OPEN_REPLY_CHECKS);
          const replied = await answeredOf(deps.accounts, checked);
          return {
            ok: true,
            // Summaries come from a model that read the mails: as untrusted as the mails (D33).
            source: `${owner.name}'s inbox`,
            text: describeOpen(
              { ...open, waiting: open.waiting.map((item) => (replied.has(item) ? { ...item, replied: true } : checked.includes(item) ? { ...item, replied: false } : item)) },
              { days, now: at, accounts: deps.accounts.length },
            ),
          };
        },
      }),
    );
  }

  return [
    ...tools,
    defineTool({
      name: "mail_search",
      description:
        `Searches all folders of ${owner.name}'s mailbox (inbox, sent, trash, spam, own folders) and returns ` +
        "at most ten mails with folder, sender, subject and snippet. folder narrows to one folder, " +
        "e.g. inbox for \"what came in\". Always narrow: one sender or one keyword and a short period. Only " +
        "reads, nothing is marked as read." +
        which +
        ownNote,
      level: "read",
      repeatable: true,
      returnsUntrusted: true,
      privateResult: true,
      schema: {
        account,
        text: z.string().trim().min(2).max(80).optional().describe("Keyword in subject or text."),
        from: z.string().trim().min(2).max(80).optional().describe("Sender, name or address or part of it."),
        days: z.number().int().min(1).max(MAIL_SEARCH_MAX_DAYS).default(14).describe("This many days back."),
        limit: z.number().int().min(1).max(MAIL_SEARCH_MAX_RESULTS).default(5),
        folder: z.enum(["all", "inbox", "sent", "trash", "spam"]).default("all"),
      },
      async run(args) {
        // Without a filter only the last days: "what came in today" yes, the whole mailbox no (W3).
        if (!args.text && !args.from && args.days > 7) {
          return { ok: false, text: "Without a sender or keyword, at most 7 days." };
        }
        const box = pick(args.account);
        try {
          const found = await box.search({
            ...(args.text ? { text: args.text } : {}),
            ...(args.from ? { from: args.from } : {}),
            sinceDays: args.days,
            limit: args.limit,
            folder: args.folder === "spam" ? "junk" : args.folder,
          });
          return {
            ok: true,
            source: `mailbox ${box.address}`,
            text: found.length > 0 ? found.map(summaryLine).join("\n") : "No mail found.",
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    defineTool({
      name: "mail_read",
      description:
        "Reads exactly one mail whose id comes from mail_search. Codes and login links are hidden, " +
        (openable ? "attachments numbered with file names, open them with mail_attachment. " : "attachments only as file names. ") +
        `If it says "sender verified: <domain>", you may send ${owner.name} the home page of that domain as a link, without a path.`,
      level: "read",
      repeatable: true,
      returnsUntrusted: true,
      privateResult: true,
      vouchesSender: true,
      schema: { id: mailId },
      async run(args) {
        const [accountId = "", providerId = ""] = args.id.split(":");
        const box = deps.accounts.find((entry) => entry.id === accountId);
        if (!box) return { ok: false, text: `The mailbox "${accountId}" is not connected.` };
        try {
          const mail = await box.read(providerId);
          if (!mail) return { ok: false, text: "This mail does not exist (anymore)." };
          // Codes go to the model neither from the body nor from the subject (W17); `mail_code` hands out only the code itself.
          const hints = { subject: mail.subject, from: mail.from };
          const body = maskCodes(mail.text, hints);
          const sender = mail.senderDomain ? await knownSender(box, mail.senderDomain, now()) : null;
          return {
            ok: true,
            source: `mail from ${mail.from || "unknown"}`,
            ...(sender ? { senderDomain: sender } : {}),
            text: [
              // From the code (addendum D8.4 of 2026-10-12): confirmed and known for a while, the home page may go to the owner as a link.
              `From: ${mail.from}${sender ? ` (sender verified: ${sender})` : ""}`,
              `To: ${mail.to}`,
              `Date: ${formatWallTime(new Date(mail.date))}`,
              `Folder: ${mail.folder}`,
              `Subject: ${maskCodes(mail.subject, hints)}`,
              mail.attachments.length === 0
                ? ""
                : openable && box.attachment
                  ? `Attachments (open with mail_attachment): ${mail.attachments.map((name, index) => `[${index + 1}] ${name}`).join(", ")}`
                  : `Attachments (not opened): ${mail.attachments.join(", ")}`,
              "",
              body.slice(0, MAIL_READ_MAX_CHARS),
              body.length > MAIL_READ_MAX_CHARS ? "(shortened)" : "",
            ]
              .filter((line, index) => line !== "" || index === 6)
              .join("\n"),
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    ...(openable && opener
      ? [
          defineTool({
            name: "mail_attachment",
            description:
              "Opens an attachment of a mail: a PDF as text (a scan is transcribed), an image as a " +
              "description with all readable text. id as for mail_read, number is the attachment's number from " +
              "mail_read. For invoices, reminders, letters, tickets: if the important part is in the attachment, you open it " +
              `instead of having ${owner.name} look. No other file types.`,
            level: "read",
            repeatable: true,
            returnsUntrusted: true,
            privateResult: true,
            timeoutMs: MAIL_ATTACHMENT_TOOL_TIMEOUT_MS,
            schema: {
              id: mailId,
              number: z.number().int().min(1).max(50).describe("Number of the attachment from mail_read, starting at 1."),
            },
            async run(args, turn) {
              const [accountId = "", providerId = ""] = args.id.split(":");
              const box = deps.accounts.find((entry) => entry.id === accountId);
              if (!box) return { ok: false, text: `The mailbox "${accountId}" is not connected.` };
              if (!box.attachment) return { ok: false, text: `I can't fetch attachments from ${box.address}.` };
              try {
                const file = await box.attachment(providerId, args.number, MAIL_ATTACHMENT_MAX_BYTES);
                if (!file) return { ok: false, text: "This mail or this attachment does not exist (anymore). The number is in mail_read." };
                const opened = await openMailAttachment(file, opener, turn.untilStopped);
                if (!opened.ok) return { ok: false, text: opened.reason };
                const what = opened.kind === "image" ? "image" : opened.kind === "scan" ? "scan, transcribed" : "PDF";
                return {
                  ok: true,
                  source: `attachment of a mail from ${box.address}`,
                  text: [`Attachment ${args.number}: ${file.name} (${what}, ${formatSize(file.body.length)})`, "", maskCodes(opened.text), opened.truncated ? "(shortened)" : ""]
                    .filter((line, index) => line !== "" || index === 1)
                    .join("\n"),
                };
              } catch (error) {
                return failure(error);
              }
            },
          }),
        ]
      : []),

    defineTool({
      name: "mail_code",
      description:
        `Fetches a one-time code (login, confirmation) from a mail of the last 15 minutes. Only if ${owner.name} explicitly asks ` +
        "for it in this message. Returns only the string, never the mail text.",
      level: "read",
      repeatable: true,
      // Its own level (W17): the code is an authentication factor. The
      // justification is the owner's direct instruction, and after untrusted
      // content it can no longer be proven that it came from them.
      ownerOriginOnly: true,
      cleanTurnOnly: true,
      privateResult: true,
      schema: {
        account,
        from: z.string().trim().min(2).max(80).describe("Sender the code comes from, e.g. the name of the service."),
      },
      async run(args) {
        const box = pick(args.account);
        try {
          const cutoff = now().getTime() - MAIL_CODE_MAX_AGE_MS;
          // Everywhere, spam included: some providers like to sort login mails there.
          const recent = (await box.search({ from: args.from, sinceDays: 1, limit: 3, folder: "all" })).filter(
            (mail) => new Date(mail.date).getTime() >= cutoff,
          );
          for (const summary of recent) {
            const mail = await box.read(summary.id.slice(summary.id.indexOf(":") + 1));
            const codes = mail ? extractCodes(`${mail.subject}\n${mail.text}`, { subject: mail.subject, from: mail.from }) : [];
            // Only the pattern itself goes back: digits and capital letters cannot carry an instruction.
            if (codes.length > 0) return { ok: true, text: `Code from ${formatWallTime(new Date(summary.date))}: ${codes.slice(0, 2).join(" or ")}` };
          }
          return { ok: false, text: "No mail with a code came from this sender in the last 15 minutes." };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    defineTool({
      name: "mail_send",
      description:
        `Sends a mail from ${owner.name}'s address. Does not run right away: ${owner.name} gets a preview with recipient, subject, ` +
        `the whole text and every attachment and approves or not. Write the mail the way ${owner.name} would write it themselves, ` +
        "as plain text. reply_to_id makes it a reply to a mail from mail_search. files attaches files " +
        `that ${owner.name} sent you via iMessage or that you fetched from their vault with vault_file, with the id from ` +
        `the note [file from ${owner.name}: …] or [file from the vault: …]; there are no other files.` +
        which +
        (own
          ? ` With account ${own.id} you write as yourself from ${own.address}, sender "${SERAIN_SENDER_NAME}": in the ` +
            `first person as ${owner.name}'s assistant, about ${owner.name} in the third, signed Serain. reply_to_id may then ` +
            `also be a mail from ${owner.name}'s mailbox.`
          : ""),
      level: "irreversible",
      schema: {
        account,
        to: z.array(email).min(1).max(MAIL_MAX_RECIPIENTS),
        cc: z.array(email).max(MAIL_MAX_RECIPIENTS).default([]),
        subject: z.string().trim().min(1).max(200),
        text: z.string().trim().min(1).max(MAIL_SEND_MAX_CHARS),
        reply_to_id: z
          .string()
          .trim()
          .regex(/^[a-z][a-z0-9_]{1,30}:[A-Za-z0-9_-]{1,64}$/)
          .optional(),
        files: z.array(z.string().trim().regex(FILE_ID)).max(MAIL_SEND_MAX_FILES).default([]),
      },
      confirm: {
        async preview(args) {
          const files = attachments(args.files);
          const lang = textLanguage(messages.mailAsk);
          const to = args.to.join(", ");
          const body = [
            previewHead(args.account, {
              plain: () => t(messages.mailTo, { to }, lang),
              as: (from) => t(messages.mailToAs, { to, from }, lang),
              from: (from) => t(messages.mailToFrom, { to, from }, lang),
            }),
            ...(args.cc.length > 0 ? [t(messages.mailCc, { cc: args.cc.join(", ") }, lang)] : []),
            t(messages.mailSubject, { subject: args.subject }, lang),
            ...files.map((file) => t(messages.mailAttachment, { name: file.name, size: formatSize(file.size, currentLocale(lang)) }, lang)),
            "",
            args.text,
            "",
            t(messages.mailAsk, undefined, lang),
          ].join("\n");
          // Before anything else: whether a recipient has not appeared anywhere yet (addendum D34). Every source has a
          // time limit, so a hanging mailbox or a sleeping Mac does not hold up the preview.
          // Without a single source there is nothing to check and nothing to say.
          const checks =
            recipientSources.length > 0
              ? await checkRecipients([...args.to, ...args.cc], recipientSources, deps.accounts.map((entry) => entry.address))
              : [];
          return [...describeRecipientWarnings(checks), body].join("\n");
        },
        undo: () => t(messages.mailUndo),
        // Every attachment goes into the thread under the preview: the owner sees the document, not just the name.
        files: (args) => attachments(args.files).map((file) => ({ name: file.name, mimeType: file.mimeType, body: file.body })),
        // A standing approval only for exactly one recipient without cc: "yes always" means
        // "mails to this person", not "mails". With a standing approval there is no
        // preview and so no note about a new recipient either. That is acceptable: it
        // only covers exactly the one recipient the owner already saw in a preview and
        // confirmed with "yes always". An attachment never falls under it: which of
        // their files goes out, they see every time.
        // As Serain is its own approval: "yes always" for mails in the owner's name does not cover mails in Serain's.
        grantKey: (args) =>
          args.to.length === 1 && args.cc.length === 0 && args.files.length === 0
            ? { kind: pick(args.account).serains ? "mail_to_as_serain" : "mail_to", to: args.to[0]! }
            : null,
        // "yes, but tomorrow at 8" (addendum D14 of 2026-10-08). What is recorded is which address the
        // preview spoke of: if `account` is missing and the main mailbox is a different one by then, nothing runs.
        later: {
          pin: (args) => {
            const box = pick(args.account);
            return { account: box.id, address: box.address };
          },
          // The shelf only keeps files until the restart, at most one day (addendum D34).
          refuse: (args) =>
            args.files.length > 0 ? { reason: "files", text: t(messages.mailLaterFiles, { yes: primaryWord("yes"), no: primaryWord("no") }) } : null,
        },
      },
      async run(args) {
        const box = pick(args.account);
        try {
          const files = attachments(args.files);
          let inReplyTo: { messageId: string; references: string[] } | undefined;
          if (args.reply_to_id) {
            const [accountId = "", providerId = ""] = args.reply_to_id.split(":");
            // From one of the owner's mailboxes only that mailbox replies; Serain may reply to mails from any (it then writes as itself).
            const from = accountId === box.id ? box : box.serains ? deps.accounts.find((entry) => entry.id === accountId) : undefined;
            const original = from ? await from.read(providerId) : null;
            if (!original?.messageId) return { ok: false, text: "The mail to reply to does not exist (anymore). Not sent." };
            inReplyTo = { messageId: original.messageId, references: original.references };
          }
          const sent = await box.send({
            to: args.to,
            cc: args.cc,
            subject: args.subject,
            text: args.text,
            ...(inReplyTo ? { inReplyTo } : {}),
            ...(files.length > 0 ? { attachments: files.map((file) => ({ name: file.name, mimeType: file.mimeType, body: file.body })) } : {}),
          });
          await rememberSent(deps.sent, box.id, sent.messageId);
          const attached = files.length > 0 ? `, attachment: ${files.map((file) => file.name).join(", ")}` : "";
          return { ok: true, text: `Mail to ${args.to.join(", ")} is out (subject: ${args.subject}${attached}).` };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    defineTool({
      name: "mail_send_each",
      description:
        `Sends several separate mails from ${owner.name}'s address, each to exactly one recipient with its own text: the same request ` +
        `to many places (access or erasure under GDPR, cancellations, declines), at most ${MAIL_BATCH_MAX}. Does not run ` +
        `right away: ${owner.name} gets a preview, the first mail in full and every further one as a difference from it. For a single mail ` +
        "or several recipients of the same mail use mail_send. No attachments." +
        which,
      level: "irreversible",
      schema: {
        account,
        mails: z
          .array(z.object({ to: email, subject: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(MAIL_SEND_MAX_CHARS) }).strict())
          .min(2)
          .max(MAIL_BATCH_MAX)
          .refine((mails) => new Set(mails.map((mail) => mail.to)).size === mails.length, "Two mails go to the same address; combine them."),
      },
      confirm: {
        async preview(args) {
          const recipients = args.mails.map((mail) => mail.to);
          const checks =
            recipientSources.length > 0 ? await checkRecipients(recipients, recipientSources, deps.accounts.map((entry) => entry.address)) : [];
          const lang = textLanguage(messages.mailBatchAsk);
          const count = args.mails.length;
          const head = previewHead(args.account, {
            plain: () => t(messages.mailBatchHead, { count }, lang),
            as: (from) => t(messages.mailBatchHeadAs, { count, from }, lang),
            from: (from) => t(messages.mailBatchHeadFrom, { count, from }, lang),
          });
          return [...describeRecipientWarnings(checks), head, "", describeBatch(args.mails), "", t(messages.mailBatchAsk, undefined, lang)].join("\n");
        },
        undo: () => t(messages.mailBatchUndo),
      },
      async run(args) {
        const box = pick(args.account);
        const sent: string[] = [];
        const failed: string[] = [];
        // One after another: a failing mail does not hold up the others, and the owner learns exactly which are out.
        for (const mail of args.mails) {
          try {
            const result = await box.send({ to: [mail.to], cc: [], subject: mail.subject, text: mail.text });
            await rememberSent(deps.sent, box.id, result.messageId);
            sent.push(mail.to);
          } catch (error) {
            if (!(error instanceof MailError)) throw error;
            failed.push(`${mail.to} (${error.message})`);
          }
        }
        const text = [
          sent.length > 0 ? `Out: ${sent.join(", ")}.` : "No mail is out.",
          ...(failed.length > 0 ? [`Not sent: ${failed.join("; ")}. Tell ${owner.name}; trying again only works with a new preview.`] : []),
        ].join(" ");
        return { ok: failed.length === 0, text };
      },
    }),

    ...cleanupTools(deps),
  ];
}

/** At most this many headers does a scan of this mailbox read. */
const scanMax = (cleanup: MailCleanup): number => cleanup.scanMax ?? MAIL_CLEANUP_SCAN_MAX;

/**
 * Cleaning up (D37). Its own function, because the tools only know mailboxes
 * that can move mail: if there is none, there are no tools.
 */
function cleanupTools(deps: MailToolDeps): ToolDefinition[] {
  const boxes = deps.accounts.flatMap((entry) => (entry.cleanup ? [{ box: entry, cleanup: entry.cleanup }] : []));
  const [first] = boxes;
  if (!first) return [];
  const keep = deps.keep;
  if (!keep) throw new Error("mailTools: cleaning up needs the keep list (deps.keep).");
  const ids = boxes.map((entry) => entry.box.id);
  const account = z
    .enum(ids as [string, ...string[]])
    .optional()
    .describe(`Mailbox: ${boxes.map((entry) => `${entry.box.id} (${entry.box.address})`).join(", ")}. Default ${first.box.id}.`);
  const pick = (id: string | undefined): { box: MailAccount; cleanup: MailCleanup } => boxes.find((entry) => entry.box.id === id) ?? first;
  /** Which mailbox, only if there is more than one to clean up. */
  const where = (box: MailAccount): string[] => (boxes.length > 1 ? [t(messages.mailbox, { address: box.address })] : []);
  const days = z.number().int().min(1).max(MAIL_CLEANUP_MAX_DAYS).default(90).describe("This many days back.");
  /** Unsubscribe pages only exist with a browser on the server (addendum D37 of 2026-10-03). */
  const pages = Boolean(deps.cleanup?.openPage);

  const plan = async (args: { account?: string | undefined; days: number; senders: Array<{ address: string; action: CleanupStep["action"] }> }) => {
    const { box, cleanup } = pick(args.account);
    if (args.senders.filter((sender) => sender.action === "spam").length > MAIL_CLEANUP_MAX_SPAM) {
      throw new MailError(`At most ${MAIL_CLEANUP_MAX_SPAM} senders per call with spam: that hits all mails of an address, not just ads.`);
    }
    const kept = await loadKeep(keep);
    // Nobody cleans away the owner's own address, no matter who asks. And what they want to keep is not up for choice.
    const own = args.senders.filter((sender) => sender.address !== box.address.toLowerCase());
    const requests = own.filter((sender) => !isKept(sender.address, kept));
    // Only the named senders: with Gmail the whole inbox costs minutes (addendum D37 of 2026-10-13).
    const inbox = planCleanup(await cleanup.scan("inbox", args.days, scanMax(cleanup), requests.map((request) => request.address)), requests);
    const steps = await findRoutes(cleanup, inbox, { sinceDays: args.days, max: scanMax(cleanup), maxPages: pages ? MAIL_UNSUBSCRIBE_PAGES_MAX : 0 });
    return { box, cleanup, steps, keptCount: own.length - requests.length };
  };
  const nothingToDo = (steps: readonly CleanupStep[]) => steps.every((step) => step.ids.length === 0 && !step.route);

  return [
    defineTool({
      name: "mail_senders",
      description:
        `Shows which senders fill ${owner.name}'s inbox with newsletters and ads: address, count, last ` +
        "subject and whether the sender allows unsubscribing. With folder spam the same for the spam folder, which the " +
        "provider fills: there every sender separately, so you see what is in there wrongly. Only reads " +
        `headers, no mail text. The first step when ${owner.name} wants to clean up their mailbox.`,
      // Reads or cleans the whole mailbox: needs longer than a single call.
      timeoutMs: MAIL_BULK_TOOL_TIMEOUT_MS,
      level: "read",
      repeatable: true,
      returnsUntrusted: true,
      privateResult: true,
      schema: {
        account,
        days,
        folder: z.enum(["inbox", "spam"]).default("inbox"),
        include_others: z
          .boolean()
          .default(false)
          .describe("Also show senders without a newsletter marker from two mails on: for spam that does not identify itself as bulk mail."),
      },
      async run(args) {
        const { box, cleanup } = pick(args.account);
        try {
          const spam = args.folder === "spam";
          const kept = await loadKeep(keep);
          const mark = (address: string) => (isKept(address, kept) ? ` | on ${owner.name}'s keep list, stays` : "");
          const headers = await cleanup.scan(spam ? "junk" : "inbox", args.days, scanMax(cleanup));
          // Two lists with their own room. Live finding 2026-09-21: in one shared list over 365 days
          // ordinary frequent writers pushed out almost all newsletters, and Serain proposed only six senders.
          const allBulk = spam ? [] : senderOverview(headers, Number.MAX_SAFE_INTEGER);
          const others =
            !spam && args.include_others
              ? senderOverview(headers, Number.MAX_SAFE_INTEGER, true).filter((sender) => sender.bulkCount === 0).slice(0, MAIL_CLEANUP_LIST_OTHERS)
              : [];
          const senders = spam ? senderOverview(headers, MAIL_CLEANUP_LIST_SPAM, true, 1) : [...allBulk.slice(0, MAIL_CLEANUP_LIST_SENDERS), ...others];
          if (spam) {
            // Whoever has already corresponded with the owner is almost always wrongly in spam (addendum D37 of 2026-10-10).
            // Only a hint for the model: only what it names in rescue and the owner sees in the preview is brought back.
            // Senders in spam can be forged, hence no automatism.
            const known = new Set<string>();
            if (box.hasCorresponded) {
              for (const sender of senders.slice(0, MAIL_SPAM_CORRESPONDENCE_CHECKS)) {
                if (await box.hasCorresponded(sender.address).catch(() => false)) known.add(sender.address);
              }
            }
            return {
              ok: true,
              source: `spam folder of ${box.address}`,
              text: [
                `${headers.length} mails in the spam folder, ${senders.length} senders${senders.length >= MAIL_CLEANUP_LIST_SPAM ? " (I don't show more)" : ""}. Unsubscribing never happens here.`,
                ...senders.map(
                  (sender) =>
                    `- ${named(sender)} | ${sender.bulkCount + sender.otherCount}x | ${maskCodes(sender.lastSubject, { subject: sender.lastSubject, from: sender.address }) || "(no subject)"}${mark(sender.address)}` +
                    (known.has(sender.address) ? ` | ${owner.name} has corresponded with this address` : ""),
                ),
                ...(known.size > 0
                  ? [`Addresses ${owner.name} has corresponded with almost always belong in rescue, unless the subject is clearly spam (senders can be forged).`]
                  : []),
                // Live finding 2026-10-13: on "unsubscribe me wherever possible" Serain stopped here, offered nothing
                // and suggested a new address. That is why the next steps are in the result.
                `What is here the filter already caught; it needs nothing more than clearing away. Clearing away works with mail_spam_folder (${owner.name} sees a preview first). Only bulk mail in the inbox can be unsubscribed: mail_senders with folder inbox.`,
                SENDER_NAMES_NOTE,
              ].join("\n"),
            };
          }
          const routes = {
            one_click: "unsubscribe works",
            mailto: "unsubscribe works (by mail)",
            page: pages ? "unsubscribe works (via the page)" : "offers no unsubscribe",
            none: pages ? "no unsubscribe header, unsubscribing may work via the link in the mail" : "offers no unsubscribe",
          };
          const counts = (sender: (typeof senders)[number]) =>
            sender.bulkCount === 0
              ? `${sender.otherCount}x, not bulk mail per header`
              : `${sender.bulkCount}x bulk mail${args.include_others && sender.otherCount > 0 ? `, ${sender.otherCount}x other` : ""}`;
          return {
            ok: true,
            source: `mailbox ${box.address}`,
            text: [
              `Went through ${headers.length} mails of the last ${args.days} days${headers.length >= scanMax(cleanup) ? " (I can't see more at once)" : ""}.`,
              allBulk.length > MAIL_CLEANUP_LIST_SENDERS
                ? `${allBulk.length} senders of bulk mail, here the ${MAIL_CLEANUP_LIST_SENDERS} most frequent. After cleaning up, the next call shows the next ones.`
                : allBulk.length > 0
                  ? `${allBulk.length} senders of bulk mail:`
                  : "No bulk mail found.",
              ...senders.map(
                (sender) =>
                  `- ${named(sender)} | ${counts(sender)}, last ${formatWallTime(new Date(sender.lastDate))} | ${sender.bulkCount > 0 ? routes[sender.route] : "only spam possible"} | ${maskCodes(sender.lastSubject, { subject: sender.lastSubject, from: sender.address }) || "(no subject)"}${mark(sender.address)}`,
              ),
              ...(senders.length > 0 ? [SENDER_NAMES_NOTE] : []),
            ].join("\n"),
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    defineTool({
      name: "mail_keep_add",
      description:
        `Remembers senders whose mails ${owner.name} wants to keep: an address or a domain (also covers subdomains). ` +
        `mail_cleanup never touches them afterwards, no matter who asks. Call it as soon as ${owner.name} says something ` +
        "should stay (\"except ycombinator\"), before you clean up again.",
      level: "write_reversible",
      schema: { entries: z.array(z.string().trim().min(3).max(120)).min(1).max(20) },
      async run(args) {
        try {
          const result = await addKeep(keep, args.entries);
          return {
            ok: result.added.length > 0 || result.invalid.length === 0,
            text: [
              result.added.length > 0 ? `On the keep list: ${result.added.join(", ")}.` : "Everything was already on it.",
              result.invalid.length > 0 ? `Not an address or domain: ${result.invalid.join(", ")}.` : "",
              `${result.total} entries in total.`,
            ]
              .filter(Boolean)
              .join(" "),
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    defineTool({
      name: "mail_keep_remove",
      description: `Takes senders off ${owner.name}'s keep list again. Only if ${owner.name} explicitly asks for it in this message.`,
      level: "write_reversible",
      // The list protects. Taking something off it is the direction a prepared mail would push.
      ownerOriginOnly: true,
      cleanTurnOnly: true,
      schema: { entries: z.array(z.string().trim().min(3).max(120)).min(1).max(20) },
      async run(args) {
        try {
          const result = await removeKeep(keep, args.entries);
          return { ok: result.removed.length > 0, text: result.removed.length > 0 ? `Taken off the keep list: ${result.removed.join(", ")}.` : "None of these were on the list." };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    defineTool({
      name: "mail_spam_folder",
      description:
        `Empties ${owner.name}'s spam folder into the trash. rescue names senders the filter caught wrongly ` +
        "(a login mail, an invoice, a person): their mails go back to the inbox. Look at the " +
        `folder first with mail_senders and folder spam. Does not run right away: ${owner.name} gets a preview with the ` +
        "counted mails. Nothing in the spam folder is ever unsubscribed, that would only confirm the address is alive.",
      // Reads or cleans the whole mailbox: needs longer than a single call.
      timeoutMs: MAIL_BULK_TOOL_TIMEOUT_MS,
      level: "irreversible",
      schema: { account, rescue: z.array(email).max(MAIL_SPAM_MAX_RESCUE).default([]) },
      confirm: {
        async preview(args) {
          const { box, cleanup } = pick(args.account);
          const headers = await cleanup.scan("junk", MAIL_CLEANUP_MAX_DAYS, scanMax(cleanup));
          if (headers.length === 0) throw new MailError("The spam folder is empty.");
          return [...describeSpamFolder(planSpamFolder(headers, args.rescue)), ...where(box)].join("\n");
        },
        undo: () => t(messages.spamFolderUndo),
      },
      async run(args) {
        const { box, cleanup } = pick(args.account);
        try {
          const headers = await cleanup.scan("junk", MAIL_CLEANUP_MAX_DAYS, scanMax(cleanup));
          if (headers.length === 0) return { ok: false, text: "The spam folder is already empty." };
          const spamPlan = planSpamFolder(headers, args.rescue);
          const lines = await runSpamFolder(cleanup, spamPlan);
          // What the owner brings back from spam they want to keep: the next cleanup does not unsubscribe them there.
          // Live finding 2026-09-21: one round after bringing it back, the same sender was up for unsubscribing.
          await addKeep(keep, spamPlan.rescued.filter((entry) => entry.ids.length > 0).map((entry) => entry.address));
          return { ok: true, text: [`Spam folder of ${box.address}:`, ...lines].join("\n") };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    defineTool({
      name: "mail_cleanup",
      description:
        `Cleans up ${owner.name}'s inbox, per sender with the exact address: unsubscribe unsubscribes via the mail's unsubscribe header ` +
        "and puts the sender's bulk mails in the trash, trash only puts the bulk mails in the " +
        "trash, spam moves all of the sender's mails to the spam folder (for real spam and senders without " +
        "unsubscribe). Unsubscribing also works when the sender's mails are only in the trash or another " +
        "folder" +
        (pages
          ? ", and without an unsubscribe header via the unsubscribe link in the mail: the code finds it, a " +
            `secured browser opens the page, at most ${MAIL_UNSUBSCRIBE_PAGES_MAX} pages per call. `
          : ". ") +
        `If ${owner.name} names the senders in their message themselves (up to three, only unsubscribe or trash), it runs without a ` +
        "preview, and afterwards you tell them in one sentence what happened. " +
        `Put all senders that are clearly ads into one single call: ${owner.name} wants to approve once, ` +
        `not in rounds. Otherwise it does not run right away: ${owner.name} gets a preview with the counted mails, from thirteen ` +
        "senders on as a summary. Other links in mails are never clicked. Addresses come from mail_senders or " +
        "mail_search.",
      // Reads or cleans the whole mailbox: needs longer than a single call.
      timeoutMs: MAIL_BULK_TOOL_TIMEOUT_MS,
      level: "irreversible",
      schema: {
        account,
        days,
        senders: z
          .array(z.object({ address: email, action: z.enum(["unsubscribe", "trash", "spam"]) }).strict())
          .min(1)
          .max(MAIL_CLEANUP_MAX_SENDERS),
      },
      confirm: {
        async preview(args) {
          const { box, steps, keptCount } = await plan(args);
          if (nothingToDo(steps)) throw new MailError("Nothing from these senders is in the inbox, and none of them can be unsubscribed.");
          return [...describePlan(steps, keptCount, args.days), ...where(box)].join("\n");
        },
        undo: (args) => cleanupUndo(args.senders.map((entry) => entry.action)),
        // If the owner named the senders themselves ("unsubscribe me from the kelvo newsletter"), the preview would only
        // ask about what they just wrote (addendum D8 of 2026-10-03). Proven by the code, see `ownerNamedSenders`.
        namedByOwner: (args, ownerWords) => ownerNamedSenders(args.senders, ownerWords),
      },
      async run(args) {
        try {
          const { box, cleanup, steps } = await plan(args);
          if (nothingToDo(steps)) return { ok: false, text: "Nothing left to do: nothing from these senders is in the inbox." };
          const all = await runCleanup(box, cleanup, steps, deps.cleanup);
          // For a whole mailbox what went wrong counts; the rest is a number. The outcome is data from
          // `runCleanup`, never read back from its wording.
          const problems = all.filter((line) => line.outcome === "failed").map((line) => line.text);
          const unconfirmed = all.filter((line) => line.outcome === "unconfirmed").map((line) => line.text);
          const lines =
            all.length > 12
              ? [`${all.length - problems.length} of ${all.length} senders done, ${steps.reduce((sum, step) => sum + step.ids.length, 0)} mails found.`, ...problems, ...unconfirmed]
              : all.map((line) => line.text);
          // The code counts what is left. Live finding 2026-09-21: after six of 85 senders Serain wrote
          // "mailbox is done now", because nobody had told it what was still there.
          // With Gmail that costs a whole inbox, minutes (addendum D37 of 2026-10-13). There only for a
          // cleanup, not when the owner names up to three senders: mail_senders ran before, the adapter knows the headers.
          const counted = !cleanup.slowScan || steps.length > NAMED_SENDERS_MAX;
          const rest = counted ? senderOverview(await cleanup.scan("inbox", args.days, scanMax(cleanup)), Number.MAX_SAFE_INTEGER).length : 0;
          const remaining = !counted
            ? []
            : rest > 0
              ? [`Not finished: the inbox still has bulk mail from ${rest} more senders (last ${args.days} days). mail_senders shows them.`]
              : [`The inbox has no bulk mail of the last ${args.days} days left.`];
          return { ok: true, text: [`Mailbox ${box.address} cleaned up:`, ...lines, ...remaining].join("\n") };
        } catch (error) {
          return failure(error);
        }
      },
    }),
  ];
}
