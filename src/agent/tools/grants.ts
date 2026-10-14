import { t } from "../../i18n/catalog.js";
import { currentLanguage } from "../../i18n/language.js";
import { tools } from "../../i18n/messages/tools.js";

/**
 * What a standing approval ("yes always", D8.3) covers, as data: a kind and its
 * parameters. Stored in `approval_grants.grant_key` as canonical JSON
 * (`encodeGrant`), matched as that exact string, and only turned into words
 * when the owner reads it (`describeGrant`), in the language of that moment. A
 * sentence stored in the language of the day would show up in that language
 * forever, and the same approval asked for in another language would not match.
 *
 * A new kind: one entry in `GrantScope`, one message in
 * `src/i18n/messages/tools.ts`, one case in `describeGrant`.
 */
export type GrantScope =
  /** Mails from one of the owner's mailboxes to exactly this one recipient. */
  | { kind: "mail_to"; to: string }
  /** Mails from Serain's own mailbox to exactly this one recipient (its own approval, addendum D31 of 2026-10-08). */
  | { kind: "mail_to_as_serain"; to: string }
  /** Test runs of the confirmation protocol (`confirm_selftest`). */
  | { kind: "confirm_selftest" };

/**
 * The stored form: JSON with `kind` first and the parameters in a fixed order,
 * so the same scope is always the same string (the unique index and
 * `hasGrant` compare strings).
 */
export function encodeGrant(scope: GrantScope): string {
  const { kind, ...params } = scope;
  const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ kind, ...sorted });
}

/** The scope of a stored key; null for anything that is not a key `encodeGrant` wrote (empty, legacy text). */
export function decodeGrant(key: string): GrantScope | null {
  if (!key.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(key);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  switch (record["kind"]) {
    case "mail_to":
    case "mail_to_as_serain":
      return typeof record["to"] === "string" && record["to"] !== "" ? { kind: record["kind"], to: record["to"] } : null;
    case "confirm_selftest":
      return { kind: "confirm_selftest" };
    default:
      return null;
  }
}

/**
 * What a stored key covers, in words for the owner ("mails to anna@example.com").
 * Keys from before the structured form were sentences already; they are shown
 * as stored. Values (addresses) go in verbatim.
 */
export function describeGrant(key: string, lang: string = currentLanguage()): string {
  const scope = decodeGrant(key);
  if (!scope) return key;
  switch (scope.kind) {
    case "mail_to":
      return t(tools.grantMailTo, { to: scope.to }, lang);
    case "mail_to_as_serain":
      return t(tools.grantMailToAsSerain, { to: scope.to }, lang);
    case "confirm_selftest":
      return t(tools.grantSelftest, undefined, lang);
  }
}
