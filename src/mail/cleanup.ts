import type { PageUnsubscribe } from "../browser/unsubscribe.js";
import { t } from "../i18n/catalog.js";
import { currentLanguage, currentLocale } from "../i18n/language.js";
import { mail as text } from "../i18n/messages/mail.js";
import { bulleted } from "../text/list.js";
import { senderLabel } from "./brand.js";
import type { MailAccount, MailCleanup, MailHeader } from "./types.js";
import { postOneClick, ROUTE_RANK, unsubscribeRoute, type UnsubscribeRoute } from "./unsubscribe.js";

/**
 * Cleaning up, provider-neutral and without I/O apart from `findRoutes` and
 * `runCleanup` (D37). The headers of the inbox make a plan; the same plan
 * builds the preview and is carried out after the owner approves. So what
 * they read was counted by the code in the mailbox, not claimed by the model.
 *
 * Three actions per sender, always on the exact address, never on a
 * substring:
 * - `unsubscribe`: unsubscribe via the header or the unsubscribe page, plus their bulk mails to the trash.
 * - `trash`: only their bulk mails to the trash.
 * - `spam`: all their mails to the spam folder. For senders without an
 *   unsubscribe header; the provider learns from it.
 *
 * `unsubscribe` and `trash` only touch mails that the header marks as bulk
 * mail: the order confirmation from the same sender stays where it is.
 */

export type CleanupAction = "unsubscribe" | "trash" | "spam";

export interface CleanupRequest {
  address: string;
  action: CleanupAction;
}

export interface CleanupStep extends CleanupRequest {
  /** How the owner calls the sender (`senderLabel`): "Amazon". */
  label: string;
  ids: string[];
  route: UnsubscribeRoute | null;
  /** Would go through an unsubscribe page, but one call opens no more pages than `MAIL_UNSUBSCRIBE_PAGES_MAX`. */
  deferred?: boolean;
}

export interface SenderInfo {
  address: string;
  /** How the owner calls the sender (`senderLabel`). */
  label: string;
  /** Bulk mails recognised by the header, and all other mails of the same address. */
  bulkCount: number;
  otherCount: number;
  lastDate: string;
  lastSubject: string;
  route: UnsubscribeRoute["kind"] | "none";
}

const newestFirst = (a: MailHeader, b: MailHeader) => b.date.localeCompare(a.date);

/** The best way across all mails: one-click before mail before page, on a tie from the newest mail. */
function routeOf(mails: readonly MailHeader[]): UnsubscribeRoute | null {
  let best: UnsubscribeRoute | null = null;
  for (const mail of [...mails].sort(newestFirst)) {
    const route = unsubscribeRoute(mail.listUnsubscribe, mail.listUnsubscribePost);
    if (route && (!best || ROUTE_RANK[route.kind] < ROUTE_RANK[best.kind])) best = route;
  }
  return best;
}

/**
 * Who fills the inbox? Without `includeOthers` only senders of bulk mail, most
 * frequent first. With it: also senders without list headers from two mails
 * on, for spam that does not identify itself as bulk mail.
 */
export function senderOverview(headers: readonly MailHeader[], limit: number, includeOthers = false, minOthers = 2): SenderInfo[] {
  const bySender = new Map<string, MailHeader[]>();
  for (const mail of headers) {
    if (!mail.fromAddress) continue;
    bySender.set(mail.fromAddress, [...(bySender.get(mail.fromAddress) ?? []), mail]);
  }
  return [...bySender.entries()]
    .map(([address, all]) => {
      const bulk = all.filter((mail) => mail.bulk);
      const newest = [...(bulk.length > 0 ? bulk : all)].sort(newestFirst)[0] as MailHeader;
      return {
        address,
        label: senderLabel(address, newest.fromName),
        bulkCount: bulk.length,
        otherCount: all.length - bulk.length,
        lastDate: newest.date,
        lastSubject: newest.subject,
        route: routeOf(bulk)?.kind ?? ("none" as const),
      };
    })
    .filter((sender) => sender.bulkCount > 0 || (includeOthers && sender.otherCount >= minOthers))
    .sort((a, b) => b.bulkCount + (includeOthers ? b.otherCount : 0) - (a.bulkCount + (includeOthers ? a.otherCount : 0)) || b.lastDate.localeCompare(a.lastDate))
    .slice(0, limit);
}

export function planCleanup(headers: readonly MailHeader[], requests: readonly CleanupRequest[]): CleanupStep[] {
  const seen = new Set<string>();
  const steps: CleanupStep[] = [];
  for (const request of requests) {
    const address = request.address.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    const from = headers.filter((mail) => mail.fromAddress === address);
    const touched = request.action === "spam" ? from : from.filter((mail) => mail.bulk);
    steps.push({
      address,
      action: request.action,
      label: senderLabel(address, from[0]?.fromName ?? ""),
      ids: touched.map((mail) => mail.providerId),
      route: request.action === "unsubscribe" ? routeOf(from.filter((mail) => mail.bulk)) : null,
    });
  }
  return steps;
}

/**
 * The way to unsubscribe for everyone the inbox cannot unsubscribe without a
 * page (addenda D37 of 2026-10-03). First the headers in the other folders
 * except spam: the owner throws newsletters away or files them. Then, when a
 * page is allowed (`maxPages` > 0), the unsubscribe link in the mail text.
 * Nothing is moved in the other folders, `ids` stay those from the inbox.
 */
export async function findRoutes(
  cleanup: MailCleanup,
  steps: readonly CleanupStep[],
  options: { sinceDays: number; max: number; maxPages: number },
): Promise<CleanupStep[]> {
  const better = (step: CleanupStep) => step.action === "unsubscribe" && (!step.route || step.route.kind === "page");
  let result = [...steps];
  const headerless = result.filter(better).map((step) => step.address);
  if (headerless.length > 0) {
    const elsewhere = (await cleanup.headersFrom(headerless, options.sinceDays, options.max)).filter((mail) => mail.bulk);
    result = result.map((step) => {
      if (!better(step)) return step;
      const found = routeOf(elsewhere.filter((mail) => mail.fromAddress === step.address));
      return found && (!step.route || ROUTE_RANK[found.kind] < ROUTE_RANK[step.route.kind]) ? { ...step, route: found } : step;
    });
  }
  if (options.maxPages > 0) {
    const linkless = result.filter((step) => step.action === "unsubscribe" && !step.route).map((step) => step.address);
    const links = linkless.length > 0 ? await cleanup.linksFrom(linkless, options.sinceDays) : new Map();
    result = result.map((step) => {
      const link = step.action === "unsubscribe" && !step.route ? links.get(step.address) : undefined;
      return link ? { ...step, route: { kind: "page" as const, url: link.url, host: link.host } } : step;
    });
  }
  // Without a browser there is no page; with it at most `maxPages` per call, so the owner does not wait an hour for the result.
  let pages = 0;
  return result.map((step) => {
    if (step.route?.kind !== "page") return step;
    pages += 1;
    if (pages <= options.maxPages) return step;
    return { ...step, route: null, ...(options.maxPages > 0 ? { deferred: true } : {}) };
  });
}

/** This many senders the owner may name at once for it to run without a preview. More is a cleanup. */
export const NAMED_SENDERS_MAX = 3;

/** Languages with a built-in list of common words. In every other language there is always the preview. */
const WORD_LISTS: readonly string[] = ["en", "de"];

/**
 * Words that stand in almost every sender address or unsubscribe request, in
 * English and German, and so prove nothing: "melde mich von den news ab",
 * "unsubscribe me from the newsletters" name no sender.
 */
const GENERIC_WORDS = new Set(
  (
    "newsletter newslettern newsletters news mail mails email emails e-mail info noreply no-reply reply bitte melde melden " +
    "abmelden abbestellen austragen unsubscribe werbung spam alle allen allem alles mich dich diesem diesen dieser davon " +
    "immer mehr keine kein nicht bekomme kriege schicken schickt sendet update updates service support team hello hallo " +
    "marketing shop store online mailing list liste post kontakt contact notification notifications benachrichtigung " +
    "benachrichtigungen papierkorb postfach ordner " +
    "please remove stop sending send sends sent want anymore every them these this that those from with more longer " +
    "junk promo promos promotion promotions deals offers offer sale sales digest weekly daily alert alerts account " +
    "accounts trash inbox folder their there anything nothing dont mailings subscription subscriptions"
  ).split(" "),
);

/**
 * Did the owner name these senders in their own message (addendum D8 of
 * 2026-10-03)? Then `mail_cleanup` runs without a preview. Proven by code,
 * not by the model: every address must contain a word from their own words
 * as one whole part (parts split at dot, hyphen, underscore, @), at least four
 * characters, not a common word. "fitly" proves
 * `no-reply_at_updates_fitly_health…@privaterelay.appleid.com`, "news" proves
 * nothing. An ending of up to two letters may be attached ("fitlys").
 *
 * Only English and German (`lang`, and every letter of the message from those
 * languages): the list of common words exists for them alone, in any other
 * language a common word would prove a sender (fail closed: the preview).
 *
 * Only `unsubscribe` and `trash`, at most three senders: `spam` hits every
 * mail of an address, and more senders are a cleanup that Serain chooses.
 * Returns the proving words, else null.
 */
export function ownerNamedSenders(requests: readonly CleanupRequest[], ownerWords: string, lang: string = currentLanguage()): string | null {
  if (!WORD_LISTS.includes(lang)) return null;
  if (requests.length === 0 || requests.length > NAMED_SENDERS_MAX) return null;
  if (requests.some((request) => request.action === "spam")) return null;
  const all = ownerWords.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (all.some((word) => !/^[a-z0-9äöüß]+$/.test(word))) return null;
  const words = [...new Set(all)].filter((word) => word.length >= 4 && !GENERIC_WORDS.has(word));
  const matched = new Set<string>();
  for (const request of requests) {
    const parts = request.address.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length >= 4 && !GENERIC_WORDS.has(part));
    const word = words.find((candidate) => parts.some((part) => candidate === part || (candidate.startsWith(part) && candidate.length - part.length <= 2)));
    if (!word) return null;
    matched.add(word);
  }
  return [...matched].join(", ");
}

/** "1 mail", "3 mails" for the model. */
const mails = (count: number) => (count === 1 ? "1 mail" : `${count} mails`);

/** This many names stand in one line, the rest as a number. */
const NAMES_MAX = 8;

/**
 * The senders of a group as names ("Amazon", not the address), each name
 * once, the ones with the most mails first. `max` Infinity for groups that
 * must stand complete (`spam`).
 */
function names(members: readonly CleanupStep[], max = NAMES_MAX): string[] {
  const counts = new Map<string, number>();
  for (const step of members) counts.set(step.label, (counts.get(step.label) ?? 0) + step.ids.length);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], currentLocale())).map(([label]) => label);
  return sorted.length <= max ? sorted : [...sorted.slice(0, max), t(text.namesMore, { count: sorted.length - max })];
}

/** "Amazon (no-reply@amazon.de)" for the model, the address alone if it already is the name. */
export const named = (sender: { label: string; address: string }): string => (sender.label === sender.address ? sender.address : `${sender.label} (${sender.address})`);

const count = (members: readonly CleanupStep[]) => members.reduce((sum, step) => sum + step.ids.length, 0);

/** Marks where the list goes in a rendered sentence. Never part of a text. */
const SLOT = "\u0000";

/**
 * A whole sentence from the catalog with a list in it (`bulleted`): one item
 * stays in the sentence, several stand below each other where the list is.
 * The sentence is translated as a whole, the items stay verbatim.
 */
function listSentence(render: (slot: string) => string, items: readonly string[]): string[] {
  const [lead = "", tail = ""] = render(SLOT).split(SLOT).map((part) => part.trim());
  if (items.length === 1 || lead) return bulleted(lead, items, tail);
  return [...items.map((item) => `• ${item}`), ...(tail ? [tail] : [])];
}

/**
 * Unsubscribe mails to these services reveal nothing and hit nobody: they
 * belong to the sender's mailing service. Every other target of an
 * unsubscribe mail stands in the preview, because the mail goes out in the
 * owner's name, and subject and text come from the sender's header (D34).
 */
const LIST_PROCESSORS = new Set([
  "mcsv.net",
  "list-manage.com",
  "rsgsv.net",
  "sendgrid.net",
  "mailgun.org",
  "mailjet.com",
  "sparkpostmail.com",
  "amazonses.com",
  "createsend.com",
  "cmail19.com",
  "cmail20.com",
  "klaviyomail.com",
  "hubspotemail.net",
  "mktomail.com",
  "exacttarget.com",
  "emarsys.net",
  "cleverreach.com",
  "mailerlite.com",
]);

function processorDomain(address: string): boolean {
  const domain = address.split("@")[1] ?? "";
  return [...LIST_PROCESSORS].some((known) => domain === known || domain.endsWith(`.${known}`));
}

/**
 * The preview, as a question. The old version (one line per address with
 * unsubscribe route and target host) gave no overview; what is wanted is a
 * short list with names and a question (decision of 2026-10-13). Hence names
 * instead of addresses (`senderLabel`), routes and hosts only in the result
 * and the audit log. That loosens D14 ("every value that counts") like the
 * summary from thirteen senders on already did, and it holds for the same
 * reasons:
 *
 * - `unsubscribe` and `trash` only touch mails that the header marks as bulk
 *   mail, and put them in the trash, not away.
 * - `spam` can hit any address, also a person at a company. These senders
 *   always all stand there, with the full address.
 * - An unsubscribe mail to anyone other than a mailing service always stands
 *   there: it goes out in the owner's name, with subject and text from the
 *   header (D34).
 * - What is on the keep list does not get into the plan at all.
 * - The full list is in `approvals.args` and in the audit log.
 *
 * The frame comes from the catalog in the owner's language, names and
 * addresses stay verbatim.
 */
export function describePlan(steps: readonly CleanupStep[], keptCount: number, days: number): string[] {
  const unsubscribe = steps.filter((step) => step.action === "unsubscribe" && step.route);
  const noRoute = steps.filter((step) => step.action === "unsubscribe" && !step.route && !step.deferred);
  const deferred = steps.filter((step) => step.action === "unsubscribe" && step.deferred);
  const trash = steps.filter((step) => step.action === "trash");
  const spam = steps.filter((step) => step.action === "spam");

  const head: string[] = [];
  if (unsubscribe.length === steps.length) {
    const n = count(unsubscribe);
    head.push(
      ...listSentence((slot) => (n > 0 ? t(text.askUnsubscribeTrash, { names: slot, count: n, days }) : t(text.askUnsubscribe, { names: slot })), names(unsubscribe)),
    );
  } else if (trash.length === steps.length) {
    head.push(...listSentence((slot) => t(text.askTrash, { names: slot, count: count(trash), days }), names(trash)));
  } else {
    head.push(t(text.askMixed, { days }));
    if (unsubscribe.length > 0) {
      const n = count(unsubscribe);
      head.push(...listSentence((slot) => (n > 0 ? t(text.groupUnsubscribeTrash, { names: slot, count: n }) : t(text.groupUnsubscribe, { names: slot })), names(unsubscribe)));
    }
    if (noRoute.length > 0) {
      const n = count(noRoute);
      head.push(...listSentence((slot) => (n > 0 ? t(text.groupNoRouteTrash, { names: slot, count: n }) : t(text.groupNoRoute, { names: slot })), names(noRoute)));
    }
    if (deferred.length > 0) {
      const n = count(deferred);
      head.push(...listSentence((slot) => (n > 0 ? t(text.groupDeferredTrash, { names: slot, count: n }) : t(text.groupDeferred, { names: slot })), names(deferred)));
    }
    if (trash.length > 0) head.push(...listSentence((slot) => t(text.groupTrash, { names: slot, count: count(trash) }), names(trash)));
    // `spam` hits every mail of the address, also from a person: here the address stands, never only the company.
    if (spam.length > 0) head.push(...listSentence((slot) => t(text.groupSpam, { names: slot, count: count(spam) }), spam.map((step) => step.address)));
  }
  const mailto = unsubscribe.flatMap((step) => (step.route?.kind === "mailto" && !processorDomain(step.route.address) ? [step.route.address] : []));
  return [
    ...head,
    ...(mailto.length === 1
      ? [t(text.unsubscribeMailOne, { address: mailto[0]! })]
      : mailto.length > 1
        ? listSentence((slot) => t(text.unsubscribeMailMany, { addresses: slot }), mailto)
        : []),
    ...(keptCount > 0 ? [t(text.kept, { count: keptCount })] : []),
  ];
}

/** The way back (W4), matching what the plan does. */
export function cleanupUndo(actions: readonly CleanupAction[]): string {
  const unsubscribe = actions.includes("unsubscribe");
  if (actions.includes("spam")) return t(unsubscribe ? text.undoSpamNotUnsubscribe : text.undoSpam);
  return t(unsubscribe ? text.undoTrashNotUnsubscribe : text.undoTrash);
}

const UNSUBSCRIBE_PARALLEL = 6;
/** One Chrome each: two side by side fit on the VM next to Serain. */
const PAGES_PARALLEL = 2;

export interface CleanupDeps {
  postOneClick?: typeof postOneClick;
  /** The browser for unsubscribe pages. Without it `findRoutes` plans no page (`maxPages` 0). */
  openPage?: PageUnsubscribe;
}

/**
 * What happened to one sender, for the model. `outcome` is the structured
 * verdict: "failed" when any part failed (one-click, page, mail or moving),
 * "unconfirmed" when the sender did not confirm the unsubscribe, else "done".
 */
export interface CleanupLine {
  text: string;
  outcome: "done" | "unconfirmed" | "failed";
}

/**
 * Carries out the plan and reports per sender what really happened. First all
 * unsubscribes (one-click side by side, so eighty senders do not cost eighty
 * waits), then one move per target folder.
 */
export async function runCleanup(
  account: MailAccount,
  cleanup: MailCleanup,
  steps: readonly CleanupStep[],
  deps: CleanupDeps = {},
): Promise<CleanupLine[]> {
  const post = deps.postOneClick ?? postOneClick;
  const unsubscribed = new Map<CleanupStep, string>();
  // If the unsubscribe fails, the mails stay: in the trash the next attempt
  // would not find the unsubscribe header any more.
  const keep = new Set<CleanupStep>();
  const unconfirmed = new Set<CleanupStep>();

  const oneClick = steps.filter((step) => step.route?.kind === "one_click");
  for (let index = 0; index < oneClick.length; index += UNSUBSCRIBE_PARALLEL) {
    await Promise.all(
      oneClick.slice(index, index + UNSUBSCRIBE_PARALLEL).map(async (step) => {
        const posted = await post(step.route?.kind === "one_click" ? step.route.url : "");
        if (!posted.ok) keep.add(step);
        else if (posted.unconfirmed) unconfirmed.add(step);
        unsubscribed.set(
          step,
          !posted.ok
            ? `unsubscribe failed (${posted.reason}), mails stay`
            : posted.unconfirmed
              ? `unsubscribed, not confirmed by the sender (${posted.reason})`
              : "unsubscribed",
        );
      }),
    );
  }
  const pages = steps.filter((step) => step.route?.kind === "page");
  for (let index = 0; index < pages.length; index += PAGES_PARALLEL) {
    await Promise.all(
      pages.slice(index, index + PAGES_PARALLEL).map(async (step) => {
        const opened = deps.openPage && step.route?.kind === "page" ? await deps.openPage(step.route.url) : { ok: false, reason: "no browser" };
        if (!opened.ok) keep.add(step);
        unsubscribed.set(step, opened.ok ? "unsubscribed via the page" : `unsubscribe via the page failed (${opened.reason}), mails stay`);
      }),
    );
  }
  for (const step of steps) {
    if (step.action !== "unsubscribe") continue;
    if (!step.route) unsubscribed.set(step, step.deferred ? "not unsubscribed, too many unsubscribe pages at once" : "no unsubscribe possible");
    if (step.route?.kind !== "mailto") continue;
    try {
      await account.send({ to: [step.route.address], cc: [], subject: step.route.subject, text: step.route.body });
      unsubscribed.set(step, "unsubscribe mail is out");
    } catch (error) {
      keep.add(step);
      unsubscribed.set(step, `unsubscribe mail failed (${(error as Error).message}), mails stay`);
    }
  }

  const moveFailed = new Map<"trash" | "junk", string>();
  for (const target of ["trash", "junk"] as const) {
    const ids = steps.filter((step) => !keep.has(step) && (step.action === "spam") === (target === "junk")).flatMap((step) => step.ids);
    if (ids.length === 0) continue;
    try {
      await cleanup.move("inbox", ids, target);
    } catch (error) {
      moveFailed.set(target, (error as Error).message);
    }
  }

  return steps.map((step) => {
    const target = step.action === "spam" ? "junk" : "trash";
    const parts = [unsubscribed.get(step) ?? ""];
    let moveFailure: string | undefined;
    if (step.ids.length > 0 && !keep.has(step)) {
      moveFailure = moveFailed.get(target);
      parts.push(moveFailure ? `moving failed (${moveFailure})` : `${mails(step.ids.length)} ${target === "junk" ? "in the spam folder" : "in the trash"}`);
    }
    const said = parts.filter(Boolean);
    const outcome = keep.has(step) || moveFailure !== undefined ? "failed" : unconfirmed.has(step) ? "unconfirmed" : "done";
    return { text: `${named(step)}: ${said.length > 0 ? said.join(", ") : "nothing to do"}`, outcome };
  });
}

/**
 * The spam folder the provider fills itself. There are no senders to work
 * with there: the addresses are forged or hijacked and change from mail to
 * mail (measured 2026-09-21: 91 mails, 55 senders, 40 of them exactly once).
 * Never unsubscribe there, because the answer only confirms that the address
 * is alive. So the whole folder goes to the trash, except what the filter
 * caught wrongly: that goes back to the inbox.
 */
export interface SpamFolderPlan {
  rescued: Array<{ address: string; label: string; ids: string[] }>;
  trashIds: string[];
}

export function planSpamFolder(headers: readonly MailHeader[], rescue: readonly string[]): SpamFolderPlan {
  const wanted = [...new Set(rescue.map((address) => address.toLowerCase()))];
  const rescued = wanted.map((address) => {
    const from = headers.filter((mail) => mail.fromAddress === address);
    return { address, label: senderLabel(address, from[0]?.fromName ?? ""), ids: from.map((mail) => mail.providerId) };
  });
  const kept = new Set(rescued.flatMap((entry) => entry.ids));
  return { rescued, trashIds: headers.filter((mail) => !kept.has(mail.providerId)).map((mail) => mail.providerId) };
}

/** The preview as a question, senders with names as in the cleanup (decision of 2026-10-13). */
export function describeSpamFolder(plan: SpamFolderPlan): string[] {
  const found = plan.rescued.filter((entry) => entry.ids.length > 0);
  const missing = plan.rescued.filter((entry) => entry.ids.length === 0);
  return [
    plan.trashIds.length > 0 ? t(text.spamEmpty, { count: plan.trashIds.length }) : t(text.spamRescueOnly),
    ...(found.length > 0
      ? listSentence(
          (slot) => t(text.spamRescued, { names: slot }),
          found.map((entry) => t(text.spamRescuedItem, { name: entry.label, count: entry.ids.length })),
        )
      : []),
    ...(missing.length > 0 ? listSentence((slot) => t(text.spamMissing, { names: slot }), missing.map((entry) => entry.label)) : []),
  ];
}

export async function runSpamFolder(cleanup: MailCleanup, plan: SpamFolderPlan): Promise<string[]> {
  const lines: string[] = [];
  // Rescue first, then empty. What is to be rescued never stands in `trashIds`:
  // if the rescue fails, the mail at least is still in the spam folder.
  for (const entry of plan.rescued) {
    if (entry.ids.length === 0) continue;
    try {
      lines.push(`${entry.address}: ${mails(await cleanup.move("junk", entry.ids, "inbox"))} back in the inbox`);
    } catch (error) {
      lines.push(`${entry.address}: getting it back failed (${(error as Error).message}), stays in the spam folder`);
    }
  }
  if (plan.trashIds.length > 0) {
    try {
      lines.unshift(`${mails(await cleanup.move("junk", plan.trashIds, "trash"))} in the trash`);
    } catch (error) {
      lines.unshift(`emptying failed (${(error as Error).message})`);
    }
  }
  return lines;
}
