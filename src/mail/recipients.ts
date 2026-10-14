import { RECIPIENT_CHECK_TIMEOUT_MS } from "../config/limits.js";
import type { Companion } from "../companion/client.js";
import { t, textLanguage, type Message } from "../i18n/catalog.js";
import { currentLanguage, currentLocale } from "../i18n/language.js";
import { mail as text } from "../i18n/messages/mail.js";
import type { MailAccount } from "./types.js";

/**
 * Recipient check for the preview of `mail_send` (addendum D34, V6 from the
 * audit of 2026-10-02). The preview shows every address, but the owner has to
 * spot a mistake themselves. An invented recipient, a typo in the domain or
 * an address from a prepared page is easier to notice when the code says in
 * the first line: this address appeared nowhere yet.
 *
 * Deterministic, no model as a guard (D12): a model watching the model would
 * have the same attack surface. A source only says "I know it", "I don't know
 * it" or "I couldn't check". What it could not check never counts as unknown:
 * otherwise the preview would claim something nobody looked up.
 */

/** Where an address is looked up: the owner's mailboxes, their contacts on the Mac, their chat with Serain. */
export type RecipientSourceKind = "mails" | "contacts" | "chat";

export interface RecipientSource {
  /** Names the place in the sentence of the preview ("in your contacts"), from the catalog. */
  kind: RecipientSourceKind;
  /** Sees the owner's sent folder: only then is "you've never written to …" true. */
  seesSent?: boolean;
  /**
   * Only ask when no other source knows the address. For the Mac: it has a
   * call quota (D28), and most mails go to people the owner has written with
   * before.
   */
  fallback?: boolean;
  /** `true` knows the address, `false` does not, `null` cannot check right now. An error counts as `null`. */
  has(address: string): Promise<boolean | null>;
}

export type RecipientVerdict = "known" | "unknown" | "unchecked";

export interface RecipientCheck {
  address: string;
  verdict: RecipientVerdict;
  /** Sources that answered, in the order of the list. */
  checked: RecipientSource[];
  /** Sources that were asked and could not answer. */
  failed: RecipientSource[];
}

/** All mail addresses in a text, lowercased. Exact instead of substring: `anna@` is also in `hanna@`. */
export function addressesIn(text: string): string[] {
  // Split instead of `/[^…]+@[^…]+/g`: in a long word without `@` the regex
  // tries every start up to the end, quadratic in the length of a foreign
  // header (fuzzing 2026-10-04). A word counts as there exactly when an `@`
  // with at least one character before and after it stands in it.
  return text
    .split(/[\s<>,;:"'()[\]]+/)
    .filter((token) => token.slice(1, -1).includes("@"))
    .map((token) => withoutTrailingPunctuation(token).toLowerCase());
}

/** Like `replace(/[.!?]+$/, "")`, but without the regex that scans a long run of dots in mid-word quadratically. */
function withoutTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && ".!?".includes(token.charAt(end - 1))) end -= 1;
  return token.slice(0, end);
}

/** Waits at most `ms` for a source. Too slow or broken means "cannot check", never "unknown". */
async function ask(source: RecipientSource, address: string, ms: number): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([source.has(address).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkOne(address: string, sources: readonly RecipientSource[], ms: number): Promise<RecipientCheck> {
  const answers = new Map<RecipientSource, boolean | null>();
  const stage = async (group: readonly RecipientSource[]) => {
    const results = await Promise.all(group.map((source) => ask(source, address, ms)));
    group.forEach((source, index) => answers.set(source, results[index] ?? null));
  };
  await stage(sources.filter((source) => !source.fallback));
  if (![...answers.values()].includes(true)) await stage(sources.filter((source) => source.fallback));

  const asked = sources.filter((source) => answers.has(source));
  const checked = asked.filter((source) => answers.get(source) !== null);
  const failed = asked.filter((source) => answers.get(source) === null);
  const verdict: RecipientVerdict = [...answers.values()].includes(true) ? "known" : checked.length > 0 ? "unknown" : "unchecked";
  return { address, verdict, checked, failed };
}

/**
 * Checks every address once, all side by side. The owner's own addresses are
 * always known: a mail to oneself is no suspicion.
 */
export async function checkRecipients(
  addresses: readonly string[],
  sources: readonly RecipientSource[],
  own: readonly string[] = [],
  timeoutMs: number = RECIPIENT_CHECK_TIMEOUT_MS,
): Promise<RecipientCheck[]> {
  const mine = new Set(own.map((address) => address.toLowerCase()));
  const unique = [...new Set(addresses.map((address) => address.trim().toLowerCase()))];
  return Promise.all(
    unique.map((address) =>
      mine.has(address)
        ? Promise.resolve<RecipientCheck>({ address, verdict: "known", checked: [], failed: [] })
        : checkOne(address, sources, timeoutMs),
    ),
  );
}

const PLACE = { mails: text.placeMails, contacts: text.placeContacts, chat: text.placeChat } as const;
const SOURCE = { mails: text.sourceMails, contacts: text.sourceContacts, chat: text.sourceChat } as const;

/** One sentence per number of places, so every language can build "neither … nor …" its own way. */
const NEVER_WRITTEN = [text.newNeverWrittenOne, text.newNeverWrittenTwo, text.newNeverWrittenThree] as const;
const UNKNOWN = [text.newUnknownOne, text.newUnknownTwo, text.newUnknownThree] as const;

const capitalize = (value: string): string => value.charAt(0).toLocaleUpperCase() + value.slice(1);

/**
 * The lines that belong above the preview. Empty when the code knows every
 * address: a note on every mail would be noise, and noise is learned to be
 * overlooked.
 *
 * Only places named where these addresses really were looked up; what could
 * not be checked comes after. Addresses where other sources answered get their
 * own sentence. That is rare (a source usually fails for all addresses
 * alike), but then every sentence is true. The frame comes from the catalog,
 * the addresses stay verbatim.
 */
export function describeRecipientWarnings(checks: readonly RecipientCheck[], lang: string = currentLanguage()): string[] {
  // Every sentence in the language it really renders in (English until its translation is there), lists joined the same way.
  const render = (message: Message<string>, params: (used: string, list: (items: readonly string[]) => string) => Readonly<Record<string, string | number>>) => {
    const used = textLanguage(message, lang);
    const list = (items: readonly string[]) => new Intl.ListFormat(currentLocale(used), { type: "conjunction" }).format(items);
    return t(message, params(used, list), used);
  };
  const lines: string[] = [];
  const groups = new Map<string, RecipientCheck[]>();
  for (const check of checks.filter((entry) => entry.verdict === "unknown")) {
    const key = [...new Set(check.checked.map((source) => source.kind))].join("|");
    groups.set(key, [...(groups.get(key) ?? []), check]);
  }
  for (const group of groups.values()) {
    const checked = group[0]?.checked ?? [];
    const failed = [...new Set(group.flatMap((check) => check.failed.map((source) => source.kind)))];
    const kinds = [...new Set([...checked.filter((source) => source.seesSent), ...checked.filter((source) => !source.seesSent)].map((source) => source.kind))];
    const sentences = checked.some((source) => source.seesSent) ? NEVER_WRITTEN : UNKNOWN;
    const sentence = render(sentences[Math.min(kinds.length, 3) - 1]!, (used, list) => {
      const places = kinds.map((kind) => t(PLACE[kind], undefined, used));
      return { list: list(group.map((check) => check.address)), count: group.length, place: places[0] ?? "", place1: places[0] ?? "", place2: places[1] ?? "", place3: places[2] ?? "" };
    });
    const note = failed.length > 0 ? capitalize(render(text.notCheckable, (used, list) => ({ sources: list(failed.map((kind) => t(SOURCE[kind], undefined, used))) }))) : "";
    lines.push(note ? `${sentence} ${note}` : sentence);
  }
  const unchecked = checks.filter((check) => check.verdict === "unchecked");
  if (unchecked.length > 0) lines.push(render(text.unchecked, (_used, list) => ({ list: list(unchecked.map((check) => check.address)) })));
  return lines;
}

/**
 * The owner's mailboxes as one source. If one knows the address, that is
 * enough, even if another one still hangs. If all say no, it is unknown; if
 * one could not answer, it stays "cannot check": "doesn't appear in your
 * mails" would otherwise be only half looked up.
 */
export function mailboxSource(accounts: readonly MailAccount[]): RecipientSource | null {
  const lookups = accounts.flatMap((account) => {
    const lookup = account.hasCorresponded;
    return lookup ? [lookup.bind(account)] : [];
  });
  if (lookups.length === 0) return null;
  return {
    kind: "mails",
    seesSent: true,
    has: (address) =>
      new Promise((resolve) => {
        let pending = lookups.length;
        let failed = false;
        const settle = () => {
          pending -= 1;
          if (pending === 0) resolve(failed ? null : false);
        };
        for (const lookup of lookups) {
          lookup(address).then(
            (hit) => (hit ? resolve(true) : settle()),
            () => {
              failed = true;
              settle();
            },
          );
        }
      }),
  };
}

/**
 * The owner's contacts on the Mac (D28), only when a companion is set up. If
 * the Mac is closed or the tunnel gone, that is "cannot check". An older
 * helper on the Mac searches only by name and does not say what it searched
 * for: that too is "cannot check", not "isn't in there".
 */
export function contactsSource(companion: Companion): RecipientSource {
  return {
    kind: "contacts",
    fallback: true,
    async has(address) {
      const result = await companion.call("contacts_search", { query: address }, RECIPIENT_CHECK_TIMEOUT_MS);
      if (result.matchedBy !== "email") return null;
      return result.contacts.some((contact) => contact.emails.some((email) => email.trim().toLowerCase() === address));
    },
  };
}

/**
 * The owner's own messages to Serain. If they wrote the address themselves
 * ("write to anna@…"), it is no invention. The query comes from outside
 * (`ownerMentionedAddress` in `src/db/messages.ts`), so this module stays
 * testable without a database.
 */
export function ownMessagesSource(lookup: (address: string) => Promise<boolean>): RecipientSource {
  return { kind: "chat", has: lookup };
}
