import { getDomain } from "tldts";
import { KNOWN_SENDER_MIN_AGE_DAYS } from "../config/limits.js";
import { addressesIn } from "./recipients.js";
import { MailError, type MailAccount } from "./types.js";

/**
 * Which domain a mail demonstrably comes from (addendum D8.4 of 2026-10-12).
 *
 * The basis is solely the verdict of the owner's own provider: the header
 * `Authentication-Results` (RFC 8601) that its incoming server puts on the
 * mail on receipt. If the mail passes DMARC there and `header.from` names
 * exactly the domain in the `From`, the sender is not forged. If the domain
 * publishes no DMARC policy (`dmarc=none` or no record at all; quite a few
 * universities), the same check applies that DMARC itself does: SPF or DKIM
 * passed, for the same organisational domain as in the `From` (RFC 7489, 3.1,
 * relaxed alignment). `dmarc=fail` and every other verdict block. That is all
 * it says: a phisher's freshly registered domain passes too. Whether the owner
 * has known the domain for a while is therefore checked by `mail_read` as well
 * (`MailAccount.knewDomainBefore`), and only the home page goes out as a link
 * (`src/security/links.ts`).
 *
 * **Where the verdict must stand.** Any sender can send header lines with the
 * provider's name themselves, `Received` too. But everything they send stands
 * below the `Received` line that the incoming server puts above on receipt.
 * Therefore only a verdict above this line counts (the first `Received` from
 * the top whose `by` is the incoming server; above it only internal lines of
 * the provider), with its identifier (authserv-id). GMX puts
 * `Authentication-Results` there, Gmail its `ARC-Authentication-Results`
 * (checked on real mails on 2026-10-12). If anything does not fit the
 * picture: no confirmation.
 *
 * **Read like the provider.** Part of the verdict comes from the sender, such
 * as the envelope address in `smtp.mailfrom`. In quotes it may contain `;`
 * and `dmarc=pass`; therefore it is read with quotes and comments (RFC 5322),
 * and duplicate DMARC or SPF verdicts block.
 */

/** How a mailbox recognises the verdict of its own incoming server. */
export interface ProviderTrust {
  /** authserv-id the incoming server signs with. */
  authserv: string;
  /** `by` host of the `Received` line the incoming server sets on receipt. */
  inbound: RegExp;
  /** `by` hosts of the provider's internal lines that may stand above it. */
  internal?: RegExp;
}

/** A header line as it stands in the mail; lists are top first. */
export interface HeaderField {
  name: string;
  value: string;
}

/** Gmail: `Received … by mx.google.com`, above it only internal hops with an IP as host. */
export const GMAIL_TRUST: ProviderTrust = {
  authserv: "mx.google.com",
  inbound: /^mx\.google\.com$/,
  internal: /^[0-9a-f]*:[0-9a-f:]+$|^\d{1,3}(\.\d{1,3}){3}$/,
};

/** Per IMAP host, read off real mails in the respective mailbox. A host missing here: no confirmation. */
const IMAP_TRUST: Readonly<Record<string, ProviderTrust>> = {
  // GMX (checked 2026-10-12): `Authentication-Results: gmx.net` above `Received … by mx-ha.gmx.net`.
  "imap.gmx.net": { authserv: "gmx.net", inbound: /^mx[a-z0-9-]*\.gmx\.net$/ },
};

export function imapTrust(imapHost: string): ProviderTrust | null {
  return IMAP_TRUST[imapHost.trim().toLowerCase()] ?? null;
}

/**
 * Comments in parentheses (also nested) removed, quotes stay; in a
 * quoted-string `(` and `;` are just characters. Null if anything stays open.
 */
function withoutComments(value: string): string | null {
  let out = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      if (depth === 0) out += char;
      escaped = false;
    } else if (char === "\\" && (quoted || depth > 0)) {
      if (depth === 0) out += char;
      escaped = true;
    } else if (quoted) {
      out += char;
      if (char === '"') quoted = false;
    } else if (depth > 0) {
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
    } else if (char === "(") depth = 1;
    else {
      if (char === '"') quoted = true;
      out += char;
    }
  }
  return depth === 0 && !quoted && !escaped ? out : null;
}

/** Splits at `separator` outside quotes (the value is already without comments and closed). */
function splitUnquoted(value: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) escaped = false;
    else if (quoted && char === "\\") escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && separator.test(char)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

const unfold = (value: string) => value.replace(/\r?\n[ \t]+/g, " ");

/** The domain of the one sender address in the `From`. Null for none or several. */
export function fromDomain(from: string): string | null {
  const addresses = addressesIn(unfold(from));
  const domain = addresses.length === 1 ? (addresses[0]?.split("@").pop() ?? "") : "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/** The verdict the incoming server set itself, without `i=N;` in front. Null if there is none. */
function providerVerdict(headers: readonly HeaderField[], trust: ProviderTrust): string | null {
  const inbound = headers.findIndex((header) => header.name.toLowerCase() === "received" && trust.inbound.test(receivedBy(header.value)));
  if (inbound < 0) return null;
  const above = headers.slice(0, inbound);
  // A Received line above it that is not from the provider: the picture is wrong.
  if (above.some((header) => header.name.toLowerCase() === "received" && !trust.internal?.test(receivedBy(header.value)))) return null;
  for (const header of above) {
    const name = header.name.toLowerCase();
    if (name !== "authentication-results" && name !== "arc-authentication-results") continue;
    const value = name === "arc-authentication-results" ? header.value.replace(/^\s*i\s*=\s*\d+\s*;/i, "") : header.value;
    if ((value.trim().split(/[\s;]/)[0] ?? "").toLowerCase() === trust.authserv) return value;
  }
  return null;
}

/** The host after `by` in a Received line, without comments. Empty if there is none. */
function receivedBy(value: string): string {
  return withoutComments(unfold(value))?.match(/(?:^|\s)by\s+([^\s;]+)/i)?.[1]?.toLowerCase() ?? "";
}

interface Verdict {
  method: string;
  result: string;
  props: Map<string, string>;
}

/** `spf=pass smtp.mailfrom=a@b.example` → method, result, properties (lowercase). */
function parseVerdict(entry: string): Verdict | null {
  const [head = "", ...props] = splitUnquoted(entry.trim().toLowerCase(), /\s/).filter(Boolean);
  const [method, result] = head.split("=");
  if (!method || !result) return null;
  const map = new Map<string, string>();
  for (const prop of props) {
    const at = prop.indexOf("=");
    if (at > 0) map.set(prop.slice(0, at), prop.slice(at + 1));
  }
  return { method, result, props: map };
}

/**
 * The sender's domain, if the owner's provider confirmed it (DMARC, or without
 * a policy aligned SPF or DKIM). `headers`: all header lines in their order,
 * top first. Null whenever in doubt.
 *
 * The `From` comes from the same header lines, raw, not from the adapter's
 * parser: with two `From` lines the provider might check one and the parser
 * show the other. Hence exactly one.
 */
export function verifiedSenderDomain(headers: readonly HeaderField[], trust: ProviderTrust | null): string | null {
  const froms = headers.filter((header) => header.name.toLowerCase() === "from");
  const domain = froms.length === 1 ? fromDomain(froms[0]?.value ?? "") : null;
  const verdict = trust ? providerVerdict(headers, trust) : null;
  if (domain === null || verdict === null) return null;
  const clean = withoutComments(unfold(verdict));
  if (clean === null) return null;
  const verdicts = splitUnquoted(clean, /;/)
    .slice(1)
    .map(parseVerdict)
    .filter((entry): entry is Verdict => entry !== null);
  const dmarc = verdicts.filter((entry) => entry.method === "dmarc");
  // A provider judges once; a second verdict comes from a value of the sender.
  if (dmarc.length > 1 || verdicts.filter((entry) => entry.method === "spf").length > 1) return null;
  const [policy] = dmarc;
  if (policy) {
    const headerFrom = policy.props.get("header.from");
    if (headerFrom !== undefined && headerFrom !== domain) return null;
    if (policy.result === "pass") return headerFrom === domain ? domain : null;
    if (policy.result !== "none") return null;
  }
  // No policy: SPF or DKIM for the same organisational domain, as DMARC itself would require.
  const organization = getDomain(domain);
  if (!organization) return null;
  const aligned = (value: string | undefined) =>
    value !== undefined && !value.includes('"') && getDomain(value.slice(value.lastIndexOf("@") + 1)) === organization;
  for (const entry of verdicts) {
    if (entry.result !== "pass") continue;
    if (entry.method === "spf" && aligned(entry.props.get("smtp.mailfrom"))) return domain;
    if (entry.method === "dkim" && (aligned(entry.props.get("header.d")) || aligned(entry.props.get("header.i")))) return domain;
  }
  return null;
}

/**
 * Domains under which anyone can create a mailbox. There DMARC only confirms
 * that the sender has an account with the provider, and mail from the domain
 * has almost always come before: it says nothing about the sender. What is
 * missing here counts like a company domain; the list covers what is common
 * in Germany.
 */
const SHARED_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com",
  "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "gmx.com", "web.de", "mail.com", "email.de",
  "t-online.de", "freenet.de", "arcor.de", "online.de", "mail.de", "posteo.de", "posteo.net", "mailbox.org",
  "outlook.com", "outlook.de", "hotmail.com", "hotmail.de", "live.com", "live.de", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "yahoo.com", "yahoo.de", "ymail.com", "aol.com", "aol.de",
  "proton.me", "protonmail.com", "pm.me", "tutanota.com", "tutanota.de", "tuta.io", "zoho.com", "yandex.com",
]);

/**
 * What Serain knows for certain about the sender of a mail (addendum D33 of
 * 2026-10-13): `known` if the owner's provider confirmed the domain
 * (`senderDomain`) and mail came from it already `KNOWN_SENDER_MIN_AGE_DAYS`
 * days before; `new` if confirmed, but never before; `unverified` if not
 * confirmed. Null if it cannot be said: the mailbox cannot do it (no readable
 * verdict of its incoming server, error), or the domain belongs to a general
 * provider.
 */
export type SenderTrust = "known" | "new" | "unverified";

export async function senderTrust(box: MailAccount, senderDomain: string | undefined, at: Date): Promise<SenderTrust | null> {
  if (!box.knewDomainBefore) return null;
  if (!senderDomain) return "unverified";
  if (SHARED_MAIL_DOMAINS.has(getDomain(senderDomain) ?? senderDomain)) return null;
  try {
    const before = new Date(at.getTime() - KNOWN_SENDER_MIN_AGE_DAYS * 86_400_000);
    return (await box.knewDomainBefore(senderDomain, before)) ? "known" : "new";
  } catch (error) {
    if (error instanceof MailError) return null;
    throw error;
  }
}
