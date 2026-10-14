import { server as instance } from "@instance/server.js";
import { owner } from "../config/owner.js";

/**
 * How the mail trigger recognises whether a mail concerns the owner (addendum
 * D33 of 2026-10-08). This is the question to `judge`, not the prompt for the
 * report to the owner; that one is in `mailTriggerPrompt`.
 *
 * The rules are the same for every owner. Exceptions of one owner (mails from
 * customers of their own company, a tax firm) come from the instance
 * (`mailRules` in `instance/server.ts`, docs/INSTANCE.md) and take precedence.
 *
 * A change here changes how often Serain gets in touch. Measure before and
 * after with `pnpm eval:mail`.
 */

/** Where a mail arrived. The main mailbox is the one connected first (`src/integrations/setup.ts`). */
export type Mailbox = "main" | "secondary" | "serain";

export const MAILBOX_LABEL: Record<Mailbox, string> = {
  main: "main mailbox",
  secondary: "secondary mailbox",
  serain: "Serain's own mailbox",
};

/** The owner's own rules as a block, or nothing. */
export function ownRules(rules: readonly string[]): string[] {
  const lines = rules.map((rule) => rule.trim()).filter(Boolean);
  return lines.length ? [`${owner.name}'s own rules take precedence over everything else:`, ...lines.map((rule) => `- ${rule}`), ""] : [];
}

export const MAIL_KIND_INSTRUCTIONS = [
  `Does \`mail\` concern ${owner.name} personally, and if so, how? \`mailbox\` says where it arrived.`,
  "",
  `A mail is only important if it wants something from ${owner.name} themselves (reply, decide, go somewhere, pay, sign, submit something) or sets them a real deadline whose passing costs them something.`,
  "",
  `Automatically sent mails are unimportant: notifications from platforms and apps, senders like noreply, codes, links and confirmations for sign-ups and registrations ${owner.name} is doing right now, links to reset a password, notices about a sign-in the service does not classify as suspicious, receipts, invoices and payment confirmations that ask for nothing more, shipping and status messages, likes, contact requests and other activity on social networks, error, build and test messages from development tools, reminders of renewals that run by themselves.`,
  "",
  `Exceptions, because doing nothing then really costs something: the service reports a suspicious or blocked sign-in attempt; an app password was created for an account, a third-party app or service was given access to account data, or the password or two-factor protection was changed, even if ${owner.name} probably did that themselves (a sign-in, even on a new device or in an app, does not count, nor do new credentials from an organisation); suspicion of fraud; a payment failed or was declined; an account or service is blocked, restricted or will be shut down because something is missing; a flight or train is changed or cancelled; a public office, an authority, a health insurer or a university sets a deadline.`,
  "",
  `Pressure from advertising does not count. "Today only", "last chance", "Action needed" or "your account will be deactivated" do not make a mail important if it wants to sell something, push towards an upgrade or win ${owner.name} back. The same applies to advertising that looks like a reply ("Re:"), and to unsolicited requests from strangers who want to sell something.`,
  "",
  `Mail to Serain's own mailbox counts like mail to ${owner.name}.`,
  "",
  ...ownRules(instance.mailRules ?? []),
  "`attachments` names the attachments, their content is missing. If there is little or nothing in the text, sender, subject and these names count: a calendar invitation from a person is a proposed appointment.",
  "",
  "When in doubt, a mail is unimportant. A missed mail stays in the mailbox, an unnecessary interruption disturbs every time.",
].join("\n");

export const KIND_OPTIONS = [
  { key: "change", criterion: "The mail moves, changes, reconfirms or cancels something that is in `known`." },
  {
    key: "new_commitment",
    criterion:
      `Important by the rules, and it is about an appointment or a deadline that is not in \`known\`: a person proposes an appointment to ${owner.name}, invites them or promises them something (also as a question, "does Friday at 10 work for you?"), or an organisation sets them a real deadline.`,
  },
  {
    key: "urgent",
    criterion:
      `Important by the rules, but without a new appointment and without a new deadline: someone is waiting for a reply, decision or action from ${owner.name}, or one of the exceptions with real costs has occurred.`,
  },
  { key: "none", criterion: "Unimportant by the rules." },
] as const;
