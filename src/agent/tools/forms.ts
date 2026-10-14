import { getDomain } from "tldts";
import { z } from "zod";
import type { FormHolds } from "../../forms/holds.js";
import { inOwnerWords, PROFILE_FIELDS, PROFILE_LABELS, profileLabel, type OwnerProfile, type ProfileStore } from "../../forms/profile.js";
import { FormFailure, type FormField, type HeldForm } from "../../forms/session.js";
import { checkUrl } from "../../executor/netguard.js";
import { t, textLanguage } from "../../i18n/catalog.js";
import { tools } from "../../i18n/messages/tools.js";
import { ownerNamedSite } from "../../sites/named.js";
import { bulleted } from "../../text/list.js";
import type { ConfidentialGuard } from "../../security/confidential.js";
import { defineTool, type ToolDefinition, type ToolResult } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * Web forms (D63, building block C): objections, cancellations, contact forms,
 * applications, public or in an account from the vault. Two approvals, because
 * two things happen that cannot be taken back:
 *
 * - `web_form` gives a site the owner's details: what is typed, the site sees
 *   even before submitting. The preview names the site, the task and exactly
 *   the details that may be typed, with their values; the executor does not
 *   get any others. If the owner named the website in this message themselves,
 *   with its ending or as an address (or the login from the vault), the code
 *   proves that from their words and there is no first preview
 *   (`namedByOwner`, addendum D8 of 2026-10-03). Like `run_site_task` only
 *   clean on the owner's message: the task is text the executor follows.
 * - `web_submit` submits what the executor filled in and the code held. The
 *   code builds the preview from the page (every field with its value, the
 *   button, an image), and it is only submitted if the fields are still
 *   exactly like that. Any turn may start it, even the result turn with
 *   untrusted content: without the owner's 👍 on exactly this preview nothing
 *   happens.
 *
 * Money never works (phase 5): the code does not even hold buttons and pages
 * that look like buying, booking or payment details.
 */

export interface FormTaskPort {
  precondition(): Promise<string | null>;
  start(request: {
    task: string;
    form: { url?: string; site?: string; uses: string[] };
    triggerExternalId: string;
    triggerMessageId: string;
    guard: ConfidentialGuard;
  }): void;
}

export interface FormToolDeps {
  profile: ProfileStore;
  /** What the code knows without a profile: mail (main mailbox) and phone (`OWNER_PHONE`). */
  defaults(): { email?: string; telefon?: string };
  holds: FormHolds;
  tasks: FormTaskPort;
  sites: { list(): Promise<string[]> };
  confidential(): Promise<ConfidentialGuard>;
}

const USES = ["name", ...PROFILE_FIELDS] as const;

/**
 * The website of an address with its ending ("robinsonliste.de" from
 * "www.robinsonliste.de"), for the evidence in the owner's words. Private
 * endings count as their own (`robinsonliste.github.io` is not `github.io`).
 * Only the name without ending would be too little: "robinsonliste.xyz"
 * belongs to someone else (security review of 2026-10-13).
 */
function siteDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // If the host itself is an ending on the list (httpbin.org is listed as private), it is the website.
    return getDomain(host, { allowPrivateDomains: true }) ?? host;
  } catch {
    return null;
  }
}

/**
 * The fields in the preview before submitting: what goes along, one field
 * per line. Empty fields in one line, unchecked boxes not at all, they send
 * nothing (decision of 2026-10-13: nobody reads long previews). Labels and
 * typed values are the page's content and stay verbatim; the code only words
 * the states it read (`FormField.state`).
 */
export function describeFields(fields: readonly FormField[], lang?: string): string[] {
  const say = (message: (typeof tools)["fieldChecked"]) => (lang === undefined ? t(message) : t(message, undefined, lang));
  const name = (field: FormField) => field.label.replace(/[\s:]+$/, "") || say(tools.fieldUnlabeled);
  const shown = (field: FormField): string => {
    switch (field.state) {
      case "checked":
        return say(tools.fieldChecked);
      case "selected":
        return say(tools.fieldSelected);
      case "password":
        return say(tools.fieldPassword);
      case "unchecked":
      case "text":
        return field.value;
    }
  };
  const filled = fields.filter((field) => field.state !== "unchecked" && (field.state !== "text" || field.value !== ""));
  const empty = fields.filter((field) => field.state === "text" && field.value === "");
  return [...filled.map((field) => `• ${name(field)}: ${shown(field)}`), ...(empty.length > 0 ? bulleted(say(tools.fieldsEmpty), empty.map(name)) : [])];
}

/** The question above a held form: where it goes, in the owner's terms (the host without "www."). */
function submitAsk(held: HeldForm, lang: string): string {
  if (held.site !== null) {
    return held.title ? t(tools.submitAskAccountTitled, { site: held.site, title: held.title }, lang) : t(tools.submitAskAccount, { site: held.site }, lang);
  }
  const host = held.host.replace(/^www\./, "");
  return held.title ? t(tools.submitAskHostTitled, { host, title: held.title }, lang) : t(tools.submitAskHost, { host }, lang);
}

/** Why there is no image of the form, if there is none. */
function imageNote(held: HeldForm, lang: string): string[] {
  if (held.imageMissing === null) return [];
  return [held.imageMissing === "failed" ? t(tools.formNoImageFailed, undefined, lang) : t(tools.formNoImage, { reason: held.imageMissing.blocker }, lang)];
}

function failure(error: unknown): ToolResult {
  if (error instanceof FormFailure) return { ok: false, text: error.message };
  throw error;
}

export function formTaskTools(deps: FormToolDeps): ToolDefinition[] {
  /** The values for the requested details; if one is missing, it throws with the sentence for the model. */
  const valuesFor = async (uses: readonly string[]): Promise<Array<[string, string]>> => {
    const profile = await deps.profile.load();
    const pick = (key: string): string | undefined => {
      if (key === "name") return profile.vorname && profile.nachname ? `${profile.vorname} ${profile.nachname}` : undefined;
      const field = key as keyof OwnerProfile;
      const defaults = deps.defaults();
      return profile[field] || (key === "email" ? defaults.email : key === "telefon" ? defaults.telefon : undefined);
    };
    const missing = uses.filter((key) => !pick(key));
    if (missing.length > 0) {
      throw new FormFailure(
        "bad_request",
        `I don't know a value for ${missing.map((key) => PROFILE_LABELS[key as keyof typeof PROFILE_LABELS]).join(", ")} yet. ${owner.name} has to write it to you once, then you remember it with profile_set.`,
      );
    }
    return uses.map((key) => [key, pick(key)!]);
  };

  return [
    defineTool({
      name: "web_form",
      comesBack: true,
      description:
        `Fills in a web form for ${owner.name}: objection, cancellation, contact, application, entry in a list. The executor ` +
        "stops at the end before submitting; so do not write \"don't submit\" into the task. url for a " +
        `public page (the page with the form, from research or from ${owner.name}) or site for an account from the vault. ` +
        `uses names the details of ${owner.name} that may be typed, only the necessary ones. Does not run right away: ${owner.name} gets a ` +
        "preview, unless they just named the site themselves. It is only submitted after a second preview with the " +
        "finished page (web_submit). Never for purchases, bookings or payments.",
      level: "irreversible",
      ownerOriginOnly: true,
      cleanTurnOnly: true,
      schema: {
        url: z.string().trim().url().max(500).optional(),
        site: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{1,30}$/).optional().describe("Name of the login in the vault."),
        task: z.string().trim().min(10).max(800).describe("What should be in the form, as concrete as possible (concern, free text, customer or order number)."),
        uses: z.array(z.enum(USES)).max(USES.length).default([]).describe(`${owner.name}'s details the form needs.`),
      },
      confirm: {
        async preview(args) {
          if ((args.url === undefined) === (args.site === undefined)) throw new FormFailure("bad_request", "Exactly one of url and site.");
          const values = await valuesFor(args.uses);
          const lang = textLanguage(tools.formAskHost);
          return [
            args.site
              ? t(tools.formAskAccount, { site: args.site }, lang)
              : t(tools.formAskHost, { host: new URL(args.url!).hostname.replace(/^www\./, "") }, lang),
            args.task,
            ...(values.length > 0
              ? bulleted(t(tools.formValuesLead, undefined, lang), values.map(([key, value]) => `${profileLabel(key as keyof typeof PROFILE_LABELS, lang)} ${value}`))
              : [t(tools.formNoValues, undefined, lang)]),
          ].join("\n");
        },
        undo: () => t(tools.formUndo),
        namedByOwner: (args, ownerWords) => {
          const words = ownerWords.toLowerCase();
          // A login from the vault is the owner's own entry: its name as a whole word is enough.
          if (args.site) return ownerNamedSite(args.site, ownerWords);
          // A website they must have named with its ending (or as an address), exactly this one or a subdomain of it.
          const domain = args.url ? siteDomain(args.url) : null;
          if (!domain) return null;
          const named = words.match(/[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu) ?? [];
          return named.some((host) => host === domain || host.endsWith(`.${domain}`)) ? domain : null;
        },
      },
      async run(args, turn) {
        if ((args.url === undefined) === (args.site === undefined)) return { ok: false, text: "Exactly one of url and site." };
        if (args.url) {
          const verdict = checkUrl(args.url);
          if (!verdict.ok || verdict.url.protocol !== "https:") return { ok: false, text: "Only public https pages." };
        }
        if (args.site) {
          let sites: string[];
          try {
            sites = await deps.sites.list();
          } catch {
            return { ok: false, text: `The vault can't be read right now. Tell ${owner.name}.` };
          }
          if (!sites.includes(args.site)) return { ok: false, text: `"${args.site}" is not in the vault.${sites.length > 0 ? ` In there: ${sites.join(", ")}.` : ""}` };
        }
        try {
          await valuesFor(args.uses);
        } catch (error) {
          return failure(error);
        }
        const guard = await deps.confidential();
        // The task goes to the executor; the owner's data is only carried by the placeholders (D29).
        const leaks = guard.check(`${args.task} ${args.url ?? ""}`);
        if (leaks.length > 0) {
          return { ok: false, text: `The task contains something confidential (${leaks.join(", ")}). Leave it out; the code fills in ${owner.name}'s details via uses.` };
        }
        const blocker = await deps.tasks.precondition();
        if (blocker) return { ok: false, text: blocker };
        deps.tasks.start({
          task: args.task,
          form: { ...(args.url ? { url: args.url } : {}), ...(args.site ? { site: args.site } : {}), uses: [...args.uses] },
          triggerExternalId: turn.triggerExternalId,
          triggerMessageId: turn.triggerMessageId,
          guard,
        });
        return { ok: true, text: `The executor is filling in the form. The result comes back as an event; only tell ${owner.name} that you're on it.` };
      },
    }),

    defineTool({
      name: "web_submit",
      description:
        "Submits a form that the executor filled in and that is waiting (the id is in the result). Does not run " +
        `right away: ${owner.name} gets a preview with every field, the button and an image of the page, built from the page itself.`,
      level: "irreversible",
      returnsUntrusted: true,
      privateResult: true,
      timeoutMs: 60_000,
      schema: { id: z.string().trim().regex(/^[0-9a-f]{12}$/, "id from the result") },
      confirm: {
        preview(args) {
          const held = deps.holds.get(args.id);
          if (!held) throw new FormFailure("changed", "This form is no longer waiting (expired or after a restart). Nothing was submitted.");
          const lang = textLanguage(tools.submitAskHost);
          return [submitAsk(held, lang), ...describeFields(held.fields, lang), t(tools.submitButton, { button: held.button }, lang), ...imageNote(held, lang)].join("\n");
        },
        undo: () => t(tools.submitUndo),
        files: (args) => {
          const held = deps.holds.get(args.id);
          return held?.image ? [{ name: t(tools.formImageName), mimeType: "image/jpeg", body: held.image }] : [];
        },
        stale: (args) => deps.holds.get(args.id) === null,
      },
      async run(args) {
        try {
          const page = await deps.holds.submit(args.id);
          return { ok: true, text: `Submitted. ${page}`, source: "page after submitting" };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    defineTool({
      name: "profile_set",
      description:
        `Remembers ${owner.name}'s details for forms (name, address, date of birth, phone, mail), exactly as ${owner.name} writes them in ` +
        "this message; every value must appear verbatim in their message. An empty value deletes the detail.",
      level: "write_reversible",
      ownerOriginOnly: true,
      schema: Object.fromEntries(PROFILE_FIELDS.map((field) => [field, z.string().trim().max(120).optional()])) as Record<
        (typeof PROFILE_FIELDS)[number],
        z.ZodOptional<z.ZodString>
      >,
      async run(args, turn) {
        const given = PROFILE_FIELDS.filter((field) => args[field] !== undefined);
        if (given.length === 0) return { ok: false, text: "No detail given." };
        const invented = given.filter((field) => args[field] !== "" && !inOwnerWords(args[field]!, turn.ownerWords));
        if (invented.length > 0) {
          return { ok: false, text: `Not in ${owner.name}'s message: ${invented.map((field) => PROFILE_LABELS[field]).join(", ")}. Only what they write themselves is remembered.` };
        }
        const profile = await deps.profile.load();
        for (const field of given) {
          if (args[field] === "") delete profile[field];
          else profile[field] = args[field]!;
        }
        await deps.profile.save(profile);
        return { ok: true, text: `Remembered: ${given.map((field) => PROFILE_LABELS[field]).join(", ")}.` };
      },
    }),
  ];
}
