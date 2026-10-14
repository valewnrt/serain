import { randomBytes } from "node:crypto";
import type { Frame, Locator, Page } from "playwright-core";
import { bounded, inPage } from "../browser/in-page.js";
import { z } from "zod";
import type { PageSnapshot, PilotAction } from "../browser/pilot.js";
import { FORM_FIELDS_MAX, FORM_RESULT_MAX_CHARS, FORM_SETTLE_MS, FORM_VALUE_MAX_CHARS } from "../config/limits.js";
import { maskSecrets, screenshotBlocker, shotBlockText, type Launched } from "../sites/session.js";
import { classifyButton, pageIsForeign, PAYMENT_FIELD } from "./classify.js";
import { maskProfile, PROFILE_LABELS, resolvePlaceholders } from "./profile.js";
import { owner } from "../config/owner.js";
import { t } from "../i18n/catalog.js";
import { forms } from "../i18n/messages/forms.js";

/**
 * Filling in a form without submitting it (D63, part C). Driven by the
 * executor (our model, never Jev: the owner's data does not go to a provider
 * without ZDR, D35), by numbers as in logged-in sessions.
 *
 * - **The code types the owner's data.** The executor writes placeholders
 *   (`{{name}}`); they are filled in when typing, and every snapshot shows the
 *   placeholder again.
 * - **Submitting only through `hold`.** A click on a submit button (also
 *   "next") or on anything that sounds like submitting is refused, Enter never
 *   submits, money never. On a page in a language without word lists every
 *   element that may act counts as submitting (fail closed, `classify.ts`).
 *   `hold` marks the button, reads the form's fields from the page and hands
 *   the session over to holding; it is submitted only after the owner's 👍
 *   (`submitHeld`), and only if the fields still stand exactly as they did.
 * - **Pinned.** Public forms to the website where it started, logged in to the
 *   hosts of the vault entry; enforced in the browser.
 */

export class FormFailure extends Error {
  constructor(
    readonly code: "bad_request" | "blocked" | "failed" | "changed",
    message: string,
  ) {
    super(message);
    this.name = "FormFailure";
  }
}

const elementId = z.number().int().min(1).max(500);

/** What the executor can do in the form. No Enter, no submitting. */
export const formActionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("click"), id: elementId }).strict(),
  z.object({ op: z.literal("type"), id: elementId, text: z.string().max(1_500) }).strict(),
  z.object({ op: z.literal("select"), id: elementId, option: z.number().int().min(0).max(80) }).strict(),
  z.object({ op: z.literal("scroll") }).strict(),
  z.object({ op: z.literal("back") }).strict(),
]);
export type FormAction = z.infer<typeof formActionSchema>;

/**
 * One field as the page holds it. `value` only means something with `state: "text"` (also a select's chosen
 * entries); a checkbox is `checked` or `unchecked`, a chosen radio button `selected` (others are left out), a
 * password `password` with an empty value: it is never read. Structured, so a preview renders it in the owner's
 * language and nothing reads its own text back.
 */
export interface FormField {
  /** As the page labels it; a field the page filled but does not show carries `forms.fieldHidden`. Empty without a label. */
  label: string;
  value: string;
  state: "text" | "checked" | "unchecked" | "selected" | "password";
}

/** A filled form waiting for the owner's 👍. The code read everything here from the page. */
export interface HeldForm {
  token: string;
  /** The vault entry for a logged-in session, else null (a public page, see `host`). */
  site: string | null;
  host: string;
  title: string;
  button: string;
  fields: FormField[];
  /** The visible part with the form, when it can be shown. */
  image: Buffer | null;
  /** Why there is no image: a reason from `screenshotBlocker`, already in the owner's language, or a failed capture. */
  imageMissing: { blocker: string } | "failed" | null;
}

export interface FormSessionOptions {
  /** What is a secret in the owner's account (password, TOTP, code); empty on public pages. */
  secrets: () => readonly string[];
  /** The values for the placeholders. */
  values: Readonly<Record<string, string>>;
  hostAllowed: (hostname: string) => boolean;
  /** For logged-in sessions the name of the vault entry. */
  site?: string;
  close: () => Promise<void>;
}

/** A field as read in the page, before the owner-facing marks. */
interface ReadField extends FormField {
  hidden: boolean;
}

/** Fields of a form, read in the page; passwords never. Runs in the button's frame (self-contained, like `page-script.ts`). */
function readFieldsInPage(input: { selector: string; max: number; maxValue: number; payment: string }): { fields: ReadField[]; payment: boolean; overflow: boolean } | null {
  const button = document.querySelector(input.selector);
  if (!button) return null;
  const paymentPattern = new RegExp(input.payment, "i");
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const labelOf = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText ?? "")
        .join(" ")
        .trim();
      if (text) return text;
    }
    const aria = el.getAttribute("aria-label")?.trim();
    if (aria) return aria;
    const first = el.labels?.[0]?.innerText.trim();
    if (first) return first;
    const placeholder = el.getAttribute("placeholder")?.trim();
    if (placeholder) return placeholder;
    const title = el.getAttribute("title")?.trim();
    if (title) return title;
    return el.getAttribute("name") || el.id || "";
  };
  const form = (button as HTMLButtonElement).form ?? button.closest("form");
  const controls = form ? Array.from(form.elements) : Array.from(document.querySelectorAll("input, select, textarea"));
  const fields: ReadField[] = [];
  let payment = false;
  let overflow = false;
  for (const node of controls) {
    if (!(node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement)) continue;
    const type = (node.getAttribute("type") ?? "text").toLowerCase();
    if (node instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "image", "file"].includes(type)) continue;
    const label = labelOf(node).replace(/\s+/g, " ").slice(0, 160);
    const autocomplete = node.getAttribute("autocomplete") ?? "";
    if (paymentPattern.test(`${label} ${node.getAttribute("name") ?? ""} ${autocomplete}`) || autocomplete.split(/\s+/).some((token) => token.startsWith("cc-"))) payment = true;
    const checkable = node instanceof HTMLInputElement && (type === "checkbox" || type === "radio");
    // Invisible does not mean empty: a field filled a step earlier still stands in the form and goes out with it.
    const hidden = !checkable && !visible(node);
    if (hidden && !(node instanceof HTMLSelectElement) && node.value === "") continue;
    let value = "";
    let state: FormField["state"] = "text";
    if (node instanceof HTMLSelectElement) value = Array.from(node.selectedOptions, (option) => option.text.trim()).join(", ");
    else if (node instanceof HTMLTextAreaElement) value = node.value;
    else if (type === "password") state = "password";
    else if (type === "checkbox") state = node.checked ? "checked" : "unchecked";
    else if (type === "radio") {
      if (!node.checked) continue;
      state = "selected";
    } else value = node.value;
    if (value.length > input.maxValue || fields.length >= input.max) {
      overflow = true;
      break;
    }
    fields.push({ label, value, state, hidden });
  }
  return { fields, payment, overflow };
}

export interface FormSession {
  /** Where, for the executor (English): the host, or the owner's account at a vault entry. */
  readonly where: string;
  /** The placeholders that have a value in this session (only those the owner released). */
  readonly placeholders: readonly string[];
  look(): Promise<PageSnapshot>;
  act(action: FormAction): Promise<PageSnapshot>;
  /**
   * Prepares submitting through this button. From then on the session belongs
   * to holding (`submitHeld`, `close`); the executor can do nothing more.
   */
  hold(id: number): Promise<HeldForm>;
  /** Clicks the held button if the fields still stand exactly as they did, and returns what the page shows afterwards. */
  submitHeld(held: HeldForm): Promise<string>;
  close(): Promise<void>;
}

/** The element for a selector, in whichever frame it stands. */
async function elementFor(page: Page, selector: string): Promise<{ frame: Frame; locator: Locator } | null> {
  for (const frame of page.frames()) {
    const locator = frame.locator(selector);
    if ((await bounded(locator.count()).catch(() => 0)) > 0) return { frame, locator: locator.first() };
  }
  return null;
}

/**
 * Does the element submit a form, which labels does it carry (visible, `aria-label`, `title`, value), and where
 * does it lead or send to (link target or form action, path and query)?
 */
async function describeTarget(locator: Locator): Promise<{ submits: boolean; labels: string[]; target: string | null }> {
  return locator.evaluate((el) => {
    const submits =
      el.matches('input[type="submit"], input[type="image"]') ||
      (el.matches('button:not([type="button"]):not([type="reset"])') && Boolean((el as HTMLButtonElement).form));
    const labels = [
      (el as HTMLElement).innerText ?? "",
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("title") ?? "",
      el.getAttribute("value") ?? "",
      el.getAttribute("alt") ?? "",
    ].map((text) => text.replace(/\s+/g, " ").trim().slice(0, 200));
    let target: string | null = null;
    try {
      const link = el.closest("a[href]") as HTMLAnchorElement | null;
      const raw = link ? link.href : submits ? (el as HTMLButtonElement).formAction || (el as HTMLButtonElement).form?.action || "" : "";
      if (raw) {
        const url = new URL(raw, location.href);
        target = url.protocol === "javascript:" ? "javascript:" : `${url.pathname}${url.search}`.slice(0, 300);
      }
    } catch {
      target = null;
    }
    return { submits, labels, target };
  });
}

/** Stands for a secret of the owner while fields are compared; replaced by `forms.masked` in what the owner sees. */
const SECRET_MARK = "\u0000secret\u0000";

export function openFormSession(launched: Launched, options: FormSessionOptions): FormSession {
  const page = launched.page;
  const site = options.site ?? null;
  const where = site ? `${owner.name}'s account at ${site}` : (() => {
    try {
      return new URL(page.url()).hostname.replace(/^www\./, "");
    } catch {
      return "the page";
    }
  })();
  const mask = (snapshot: PageSnapshot): PageSnapshot => {
    const hidden = maskSecrets(snapshot, options.secrets());
    const clean = (text: string) => maskProfile(text, options.values);
    return {
      ...hidden,
      url: clean(hidden.url),
      title: clean(hidden.title),
      text: clean(hidden.text),
      view: clean(hidden.view),
      elements: hidden.elements.map((element) => ({
        ...element,
        label: clean(element.label),
        ...(element.value !== undefined ? { value: clean(element.value) } : {}),
      })),
    };
  };
  /** Secrets out, with a mark that does not depend on the language: held fields and fields at submit compare equal. */
  const hide = (text: string) =>
    options
      .secrets()
      .filter((secret) => secret.length >= 4)
      .reduce((out, secret) => out.split(secret).join(SECRET_MARK), text);
  const comparable = (fields: readonly ReadField[]) => JSON.stringify(fields.map((field) => ({ ...field, label: hide(field.label), value: hide(field.value) })));
  let last: PageSnapshot | null = null;
  let state: "open" | "held" | "closed" = "open";
  /** The fields as held, before rendering for the owner: what `submitHeld` compares against. */
  let heldFields: string | null = null;
  const requireOpen = () => {
    if (state !== "open") throw new FormFailure("bad_request", state === "held" ? `The form is already waiting for ${owner.name}.` : "The session is closed.");
  };
  const requireHost = () => {
    const host = new URL(page.url()).hostname;
    if (!options.hostAllowed(host)) throw new FormFailure("blocked", "The page is no longer on the website where it started.");
    return host;
  };
  const look = async () => {
    last = await launched.snapshot();
    return mask(last);
  };
  const target = (id: number) => {
    const element = last?.elements.find((entry) => entry.id === id);
    if (!element) throw new FormFailure("bad_request", "This element is not (or no longer) on the page. Look again first.");
    return element;
  };
  const readFields = async (frame: Frame, selector: string) => {
    const read = await inPage(frame, readFieldsInPage, { selector, max: FORM_FIELDS_MAX, maxValue: FORM_VALUE_MAX_CHARS, payment: PAYMENT_FIELD.source });
    if (!read) throw new FormFailure("changed", "The button is no longer on the page.");
    return read;
  };
  const foreignPage = () => (last ? pageIsForeign({ lang: last.lang ?? null, title: last.title, text: last.view || last.text }) : Promise.resolve(true));
  const moneyRefusal = (label: string) => new FormFailure("blocked", `"${label}" looks like money. That is not possible, ${owner.name} does that themselves.`);

  return {
    where,
    placeholders: Object.keys(options.values),
    look: async () => {
      requireOpen();
      return look();
    },

    act: async (action) => {
      requireOpen();
      requireHost();
      let pilot: PilotAction;
      let text: string | undefined;
      if (action.op === "click") {
        const element = target(action.id);
        const found = await elementFor(page, `[data-serain-id="${action.id}"]`);
        if (!found) throw new FormFailure("bad_request", "This element is not (or no longer) on the page. Look again first.");
        const { submits, labels, target: goes } = await bounded(describeTarget(found.locator));
        const foreign = await foreignPage();
        const kind = classifyButton([element.label, ...labels], {
          submits,
          target: goes,
          kind: element.kind,
          ...(element.role ? { role: element.role } : {}),
          ...(element.state ? { state: element.state } : {}),
          foreign,
          payment: last?.payment === true,
        });
        if (kind === "money") throw moneyRefusal(element.label);
        if (kind === "commit") {
          throw new FormFailure(
            "blocked",
            foreign && !submits
              ? `"${element.label}" may act, and on a page in this language the code cannot tell. Only through form_submit with this number, then ${owner.name} sees everything first.`
              : `"${element.label}" submits something. Only through form_submit with this number, then ${owner.name} sees everything first.`,
          );
        }
        pilot = { op: "click", id: action.id };
      } else if (action.op === "type") {
        target(action.id);
        const resolved = resolvePlaceholders(action.text, options.values);
        if (resolved.missing.length > 0) {
          throw new FormFailure(
            "bad_request",
            `There is no value for ${resolved.missing.map((key) => `{{${key}}}`).join(", ")}. Write in the report that ${owner.name} has to give ${resolved.missing.map((key) => PROFILE_LABELS[key as keyof typeof PROFILE_LABELS] ?? key).join(", ")} once.`,
          );
        }
        pilot = { op: "type", id: action.id, submit: false };
        text = resolved.text;
      } else if (action.op === "select") {
        target(action.id);
        pilot = { op: "select", id: action.id, option: action.option };
      } else {
        pilot = { op: action.op };
      }
      try {
        await launched.act(pilot, text);
      } catch (error) {
        throw new FormFailure("failed", `Action failed: ${(error as Error).message.split("\n")[0]}`);
      }
      return look();
    },

    hold: async (id) => {
      requireOpen();
      const host = requireHost();
      const element = target(id);
      const found = await elementFor(page, `[data-serain-id="${id}"]`);
      if (!found) throw new FormFailure("bad_request", "This element is not (or no longer) on the page. Look again first.");
      const { labels, target: goes } = await bounded(describeTarget(found.locator));
      const foreign = await foreignPage();
      if (classifyButton([element.label, ...labels], { submits: true, target: goes, kind: element.kind, foreign, payment: last?.payment === true }) === "money") {
        throw moneyRefusal(element.label);
      }
      const token = randomBytes(6).toString("hex");
      // Marked before reading: every snapshot hands out new numbers, the mark stays until the click.
      await bounded(found.locator.evaluate((el, value) => el.setAttribute("data-serain-hold", value), token));
      const read = await readFields(found.frame, `[data-serain-hold="${token}"]`);
      if (read.payment) throw new FormFailure("blocked", `The page has fields for payment data. That is not possible, ${owner.name} does that themselves.`);
      // The preview shows everything or there is none: a field that does not fit would go out unseen.
      if (read.overflow) {
        throw new FormFailure("blocked", `The form has more than ${FORM_FIELDS_MAX} fields or a value over ${FORM_VALUE_MAX_CHARS} characters. ${owner.name} would not see it completely, so it is not submitted.`);
      }
      await found.locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
      let image: Buffer | null = null;
      let imageMissing: HeldForm["imageMissing"] = null;
      const blocker = await screenshotBlocker(page, options.secrets());
      if (blocker) imageMissing = { blocker: shotBlockText(blocker) };
      else if (launched.screenshot) {
        try {
          image = (await launched.screenshot()).jpeg;
          // The page may have changed between the check and the capture.
          const after = await screenshotBlocker(page, options.secrets());
          if (after) {
            image = null;
            imageMissing = { blocker: shotBlockText(after) };
          }
        } catch {
          imageMissing = "failed";
        }
      }
      state = "held";
      heldFields = comparable(read.fields);
      const masked = t(forms.masked);
      const show = (text: string) => hide(text).split(SECRET_MARK).join(masked);
      return {
        token,
        site,
        host,
        title: show(await bounded(page.title()).catch(() => "")),
        button: element.label,
        fields: read.fields.map((field) => ({
          label: field.hidden ? t(forms.fieldHidden, { label: show(field.label) }) : show(field.label),
          value: show(field.value),
          state: field.state,
        })),
        image,
        imageMissing,
      };
    },

    submitHeld: async (held) => {
      if (state !== "held" || heldFields === null) throw new FormFailure("bad_request", "This form is not (or no longer) waiting.");
      requireHost();
      const found = await elementFor(page, `[data-serain-hold="${held.token}"]`);
      if (!found) throw new FormFailure("changed", "The button is no longer on the page. Nothing was submitted.");
      const button = found.locator;
      const now = await readFields(found.frame, `[data-serain-hold="${held.token}"]`);
      if (comparable(now.fields) !== heldFields || now.payment || now.overflow) {
        throw new FormFailure("changed", "The fields no longer stand as they did in the preview. Nothing was submitted.");
      }
      try {
        await button.click({ timeout: 10_000 });
      } catch (error) {
        throw new FormFailure("failed", `The click did not work: ${(error as Error).message.split("\n")[0]}. Whether the page received anything is unclear.`);
      }
      state = "closed";
      await page.waitForLoadState("networkidle", { timeout: FORM_SETTLE_MS }).catch(() => undefined);
      const after = mask(await launched.snapshot().catch(() => ({ url: page.url(), title: "", text: "", view: "", elements: [], scroll: { up: false, down: false } })));
      return [`Page afterwards: ${after.title || "(no title)"}`, (after.view || after.text).slice(0, FORM_RESULT_MAX_CHARS) || "(no readable text)"].join("\n");
    },

    close: async () => {
      state = "closed";
      await options.close();
    },
  };
}
