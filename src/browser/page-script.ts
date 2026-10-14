/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { PageSnapshot } from "./pilot.js";

/**
 * Runs in the page, not in node (Playwright serialises the functions). Hence a
 * file of its own with DOM types, without runtime imports and without access to
 * anything outside its arguments.
 *
 * It collects what a person currently sees and could operate: in the visible
 * viewport, not covered, with name, role, value and state, numbered via an
 * attribute. One pass, one `evaluate` (pattern: browser-use/jev-ultrafast; there
 * the number of browser calls per task fell from 1,092 to 101 with it).
 *
 * Texts this file adds to what the model reads ("(selected)", "[Rest of the page]",
 * the numbering of fields with the same label) are English like every text to the
 * model; the page's own text stays in the page's language.
 */

export interface CollectInput {
  attribute: string;
  maxElements: number;
  /** Text of the whole page, for the report to the executor. */
  maxChars: number;
  /** Text of the visible viewport, for the pilot. */
  maxViewChars: number;
  maxOptions: number;
  startId: number;
  /** Source of `PAYMENT_FIELD` (`src/forms/classify.ts`): fields whose label, name or `autocomplete` look like payment data. */
  payment?: string;
}

export function collectPage(input: CollectInput): PageSnapshot {
  type Kind = PageSnapshot["elements"][number]["kind"];
  // Soft hyphens and zero-width characters (a weather service: "Wet\u00adter") split words the model orients itself by.
  const plain = (value: string) => value.replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "").replace(/\s+/g, " ").trim();
  const clean = (value: string | null | undefined, max = 80) => plain(value ?? "").slice(0, max);
  const ROLES = ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton", "treeitem"];
  const SELECTOR = `a[href], button, input, textarea, select, summary, [contenteditable="true"], [contenteditable=""], ${ROLES.map((role) => `[role="${role}"]`).join(", ")}`;
  const TEXT_TYPES = ["", "text", "search", "email", "tel", "url", "number", "date", "time", "datetime-local", "month", "week"];

  // Through open shadow roots too: cookie dialogs (bahn.de) and many web components live there,
  // and `querySelectorAll` does not see them from the document. Playwright's CSS selectors find them later.
  const roots: Array<Document | ShadowRoot> = [];
  const findRoots = (root: Document | ShadowRoot) => {
    roots.push(root);
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) findRoots(host.shadowRoot);
  };
  findRoots(document);
  const deep = (selector: string): Element[] => roots.flatMap((root) => [...root.querySelectorAll(selector)]);
  for (const old of deep(`[${input.attribute}]`)) old.removeAttribute(input.attribute);

  const parentOf = (node: Node): Node | null => node.parentNode ?? (node as ShadowRoot).host ?? null;
  /** `contains` across shadow boundaries. */
  const holds = (outer: Element, inner: Node | null) => {
    for (let node = inner; node; node = parentOf(node)) if (node === outer) return true;
    return false;
  };
  const rendered = (element: Element) =>
    !element.closest('[aria-hidden="true"], [inert]') &&
    (typeof element.checkVisibility !== "function" || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  const inView = (box: DOMRect) =>
    box.width > 1 &&
    box.height > 1 &&
    box.bottom > 0 &&
    box.top < innerHeight &&
    // Sideways too: collapsed menus lie outside to the left or right and can never be clicked
    // (live test 2026-09-20, a transit site: "element is outside of the viewport").
    box.right > 0 &&
    box.left < innerWidth;
  const topAt = (x: number, y: number): Element | null => {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  /**
   * Is something on top (dialog, cookie banner, open menu)? Then the element is not a choice: live, every
   * click on a covered element ran three seconds into the timeout (pattern: browser-use `paint_order.py`,
   * jev-ultrafast checks the same way before every click). Fields still count as reachable when their own
   * floating label lies on top of them.
   */
  const reachable = (element: Element, box: DOMRect, field: boolean) => {
    const x = Math.min(Math.max(box.left + box.width / 2, 1), innerWidth - 2);
    const y = Math.min(Math.max(box.top + box.height / 2, 1), innerHeight - 2);
    const hit = topAt(x, y);
    if (!hit) return false;
    if (holds(element, hit) || holds(hit, element)) return true;
    if ((hit.closest("label") as HTMLLabelElement | null)?.control === element) return true;
    const near = element.parentElement?.parentElement ?? element.parentElement;
    return field && !!near && holds(near, hit);
  };

  const name = (element: Element | null, seen = new Set<Element>()): string => {
    if (!element || seen.has(element)) return "";
    seen.add(element);
    const root = element.getRootNode() as Document | ShadowRoot;
    const referenced = (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => name(root.getElementById?.(id) ?? document.getElementById(id), seen))
      .filter(Boolean)
      .join(" ");
    if (referenced) return referenced;
    const aria = element.getAttribute("aria-label");
    if (aria?.trim()) return aria;
    const control = element as HTMLInputElement;
    // Without the field itself: a label that wraps its select list would otherwise be named like all its entries.
    const labelText = (node: Node): string =>
      node.nodeType === Node.TEXT_NODE
        ? (node.textContent ?? "")
        : node.nodeType === Node.ELEMENT_NODE && !["SELECT", "TEXTAREA", "INPUT", "DATALIST"].includes((node as Element).tagName)
          ? [...node.childNodes].map(labelText).join(" ")
          : "";
    const labels = [...(control.labels ?? [])].map(labelText).join(" ").trim();
    if (labels) return labels;
    const tag = element.tagName;
    if (tag === "INPUT" && ["button", "submit", "reset"].includes(control.type)) return control.value || control.type;
    const own = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" ? "" : (element as HTMLElement).innerText || element.textContent || "";
    return (
      own.trim() ||
      element.getAttribute("alt") ||
      element.querySelector("img[alt]")?.getAttribute("alt") ||
      element.querySelector("svg title")?.textContent ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      element.getAttribute("name") ||
      ""
    );
  };

  const memory = window as unknown as { __serainSeen?: WeakSet<Element> };
  const before = memory.__serainSeen;
  const seenNow = new WeakSet<Element>();

  const elements: PageSnapshot["elements"] = [];
  const taken = new Set<Element>();
  const links = new Set<string>();

  const add = (element: Element, target: Element, kind: Kind, role: string, box: DOMRect) => {
    if (elements.length >= input.maxElements || taken.has(target)) return;
    const label = clean(name(element));
    if (!label && kind !== "input" && kind !== "select") return;
    const control = element as HTMLInputElement;
    const tag = element.tagName;
    let host: string | undefined;
    if (kind === "link") {
      try {
        const href = new URL((element as HTMLAnchorElement).href, location.href);
        if (href.protocol === "mailto:" || href.protocol === "tel:") return;
        // The same link several times (image, title, "more") is one option, not three.
        const same = `${href.href} ${label}`;
        if (links.has(same)) return;
        links.add(same);
        if (href.host !== location.host) host = href.host;
      } catch {
        // No resolvable target: then without host.
      }
    }
    const states: string[] = [];
    const checked = control.type === "checkbox" || control.type === "radio" ? String(control.checked) : element.getAttribute("aria-checked");
    if (checked === "true") states.push("checked");
    if (checked === "false") states.push("unchecked");
    const expanded = element.getAttribute("aria-expanded");
    if (expanded === "true") states.push("expanded");
    if (expanded === "false") states.push("collapsed");
    if (element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-pressed") === "true" || element.getAttribute("aria-current")) states.push("selected");
    const value =
      kind === "input"
        ? clean("value" in control ? String(control.value) : (element as HTMLElement).innerText)
        : kind === "select"
          ? clean((element as HTMLSelectElement).selectedOptions[0]?.text)
          : "";
    const options = kind === "select" ? [...(element as HTMLSelectElement).options].slice(0, input.maxOptions).map((option) => clean(option.text)) : undefined;
    // Does the field's form have a visible submit button? Otherwise only Enter is left.
    const submit =
      kind === "input" && control.form
        ? [...control.form.querySelectorAll('button:not([type="button"]):not([type="reset"]), input[type="submit"], input[type="image"]')].some((button) => rendered(button) && button.getBoundingClientRect().width > 1)
        : undefined;
    // Language-neutral signals for `classifyButton` (`src/forms/classify.ts`): does it submit a form in HTML terms,
    // and where does it lead or send to (path and query; the host is in `host`).
    const submits =
      (tag === "INPUT" && ["submit", "image"].includes(control.type)) ||
      (tag === "BUTTON" && !["button", "reset"].includes((element.getAttribute("type") ?? "submit").toLowerCase()) && Boolean((element as HTMLButtonElement).form));
    let goes: string | undefined;
    try {
      const raw = kind === "link" ? (element as HTMLAnchorElement).href : submits ? ((element as HTMLButtonElement).formAction || (element as HTMLButtonElement).form?.action || "") : "";
      if (raw) {
        const url = new URL(raw, location.href);
        goes = url.protocol === "javascript:" ? "javascript:" : `${url.pathname}${url.search}`.slice(0, 300);
      }
    } catch {
      // No resolvable target: then without one.
    }
    const id = input.startId + elements.length;
    target.setAttribute(input.attribute, String(id));
    taken.add(target);
    seenNow.add(target);
    elements.push({
      id,
      kind,
      label,
      ...(role ? { role } : {}),
      ...(value ? { value } : {}),
      ...(states.length > 0 ? { state: states.join(", ") } : {}),
      ...(host ? { host } : {}),
      ...(options ? { options } : {}),
      ...(before && !before.has(target) ? { fresh: true } : {}),
      ...(submit !== undefined ? { formHasSubmit: submit } : {}),
      ...(submits ? { submits: true } : {}),
      ...(goes ? { target: goes } : {}),
      box: { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) },
    });
  };

  // With suggestion lists, menus and calendar cells: many forms (bahn.de) only accept a typed value once a
  // suggestion from the list is chosen.
  for (const element of deep(SELECTOR)) {
    if (elements.length >= input.maxElements) break;
    const control = element as HTMLInputElement;
    if (control.disabled || element.closest('[aria-disabled="true"]')) continue;
    const tag = element.tagName.toLowerCase();
    const type = tag === "input" ? (element.getAttribute("type") ?? "").toLowerCase() : "";
    // The pilot never operates password fields, hidden fields and uploads.
    if (tag === "input" && ["password", "hidden", "file", "range", "color"].includes(type)) continue;
    const explicit = element.getAttribute("role") ?? "";
    const editable = (element as HTMLElement).isContentEditable || tag === "textarea" || (tag === "input" && TEXT_TYPES.includes(type));
    let kind: Kind;
    let role = ROLES.includes(explicit) && explicit !== "button" && explicit !== "link" ? explicit : "";
    if (tag === "select") kind = "select";
    else if (editable && !control.readOnly && element.getAttribute("aria-readonly") !== "true") kind = "input";
    else if (tag === "a" || explicit === "link") kind = "link";
    else kind = "button";
    // A field that cannot be written to opens something on click: usually a calendar.
    if (editable && kind === "button") role = "readonly field, opens a picker";
    if (tag === "input" && (type === "checkbox" || type === "radio")) role = type;
    if (kind === "input" && type && type !== "text") role = role || type;

    let target = element;
    let box = element.getBoundingClientRect();
    if ((!rendered(element) || box.width <= 1) && (type === "checkbox" || type === "radio")) {
      // Styled boxes: the real field is invisible, its label is what gets clicked.
      const label = [...(control.labels ?? [])].find((entry) => rendered(entry));
      if (!label) continue;
      target = label;
      box = label.getBoundingClientRect();
    } else if (!rendered(element)) continue;
    if (!inView(box) || !reachable(target, box, kind === "input" || kind === "select")) continue;
    add(element, target, kind, role, box);
  }

  // What is clickable only by script (`div` with a click handler): the mouse cursor gives it away. Only the topmost
  // element with a pointer, and only when it neither lies in a found element nor contains one
  // (pattern: browser-use `clickable_elements.py`, the last of ten heuristics there).
  if (elements.length < input.maxElements) {
    for (const root of roots) {
      for (const element of (root === document ? (document.body ?? document) : root).querySelectorAll<HTMLElement>("*")) {
        if (elements.length >= input.maxElements) break;
        if (taken.has(element) || element.closest(SELECTOR) || element.closest("label")) continue;
        const box = element.getBoundingClientRect();
        if (box.width < 8 || box.height < 8 || box.width * box.height > innerWidth * innerHeight * 0.5 || !inView(box)) continue;
        const pointer = getComputedStyle(element).cursor === "pointer" || element.hasAttribute("onclick");
        if (!pointer) continue;
        const parent = element.parentElement;
        if (parent && getComputedStyle(parent).cursor === "pointer" && !parent.closest(SELECTOR)) continue;
        if (element.querySelector(SELECTOR) || !rendered(element) || !reachable(element, box, false)) continue;
        add(element, element, "button", "", box);
      }
    }
  }
  memory.__serainSeen = seenNow;

  // Make fields with the same label distinguishable (a transit site: origin and destination are both called
  // "Haltestelle / Adresse"): otherwise every value lands in the first. The order on the page is the information.
  const byLabel = new Map<string, number[]>();
  elements.forEach((element, index) => {
    if (element.kind === "input" || element.kind === "select") byLabel.set(element.label, [...(byLabel.get(element.label) ?? []), index]);
  });
  for (const indexes of byLabel.values()) {
    if (indexes.length < 2) continue;
    indexes.forEach((index, position) => {
      const element = elements[index];
      if (element) element.label = `${element.label || "Field"} (${position + 1} of ${indexes.length} fields with the same label)`;
    });
  }

  // Text: one walk through the tree, through shadow roots too (`innerText` does not see them and instead returns
  // the entries of every select list; live, the state on Amazon consisted of skip links and categories).
  // Two results: the visible viewport for the pilot, the whole page with the content part first for the report.
  const INLINE = new Set(["A", "ABBR", "B", "BDI", "BDO", "CITE", "CODE", "DATA", "EM", "FONT", "I", "KBD", "LABEL", "MARK", "Q", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "VAR"]);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SELECT", "OPTION", "DATALIST", "SVG", "svg", "IFRAME", "CANVAS", "VIDEO", "AUDIO", "HEAD"]);
  const main = deep("main, [role=main], article, #content, #main").sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0))[0] ?? null;
  const lines = { main: [] as string[], rest: [] as string[], view: [] as string[] };
  const lastBlock = { main: null as Node | null, rest: null as Node | null, view: null as Node | null };
  let total = 0;
  let viewTotal = 0;
  const range = document.createRange();
  const push = (bucket: "main" | "rest" | "view", block: Node | null, text: string) => {
    const list = lines[bucket];
    if (lastBlock[bucket] === block && list.length > 0) list[list.length - 1] += ` ${text}`;
    else list.push(text);
    lastBlock[bucket] = block;
  };
  const emit = (from: Node | null, text: string, inMain: boolean, box: () => DOMRect) => {
    let block = from;
    while (block && block.nodeType === Node.ELEMENT_NODE && INLINE.has((block as Element).tagName)) block = block.parentNode;
    push(inMain ? "main" : "rest", block, text);
    total += text.length;
    if (viewTotal < input.maxViewChars && inView(box())) {
      push("view", block, text);
      viewTotal += text.length;
    }
  };
  const words = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  /**
   * A control whose name says more than its visible text reads with its name. Live 2026-10-09 on a booking
   * site: the days in the calendar show "Sa 24" and a dot, but are named "Sa, 24.10. — Termine frei"; without
   * the name the executor reported one free day instead of five. Only when the name contains every visible
   * word: otherwise it says something else, and what is read is what a person sees. If it is selected (the day
   * the times below belong to), that is noted. Like `spokenRegion` in `shotRegions`.
   */
  const spoken = (element: Element): string | null => {
    const aria = plain(element.getAttribute("aria-label") ?? "").slice(0, 200);
    if (!aria || !element.matches(SELECTOR)) return null;
    const shown = words((element as HTMLElement).innerText ?? "");
    const said = words(aria);
    if (shown.length === 0 || said.length <= shown.length || !shown.every((word) => said.includes(word))) return null;
    const current = element.getAttribute("aria-current");
    const picked = element.getAttribute("aria-pressed") === "true" || element.getAttribute("aria-selected") === "true" || (!!current && current !== "false");
    return picked ? `${aria} (selected)` : aria;
  };
  const walk = (node: Node, inMain: boolean) => {
    if (total > input.maxChars * 2) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = plain(node.textContent ?? "");
      if (!text) return;
      emit(node.parentNode, text, inMain, () => (range.selectNodeContents(node), range.getBoundingClientRect()));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    // `aria-hidden` does not count here: bahn.de shows the departure times visibly but hidden from screen readers, and
    // gives those an invisible text. What is read is what a person sees.
    if (SKIP.has(element.tagName)) return;
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ checkVisibilityCSS: true }) && getComputedStyle(element).display !== "contents") return;
    const named = spoken(element);
    if (named) {
      emit(element, named, inMain || element === main, () => element.getBoundingClientRect());
      return;
    }
    const within = inMain || element === main;
    if (element.shadowRoot) for (const child of element.shadowRoot.childNodes) walk(child, within);
    const slotted = element.tagName === "SLOT" ? (element as HTMLSlotElement).assignedNodes() : [];
    for (const child of slotted.length > 0 ? slotted : element.childNodes) walk(child, within);
  };
  if (document.body) walk(document.body, false);
  const mainText = lines.main.join("\n");
  const restText = lines.rest.join("\n");
  const text = mainText.length >= 200 && restText ? `${mainText}\n\n[Rest of the page]\n${restText}` : mainText || restText;

  // Payment fields anywhere on the page (also hidden ones of a later step): `autocomplete=cc-*` in any language, else the pattern.
  const paymentPattern = input.payment ? new RegExp(input.payment, "i") : null;
  const payment = deep("input, select").some((field) => {
    const autocomplete = (field.getAttribute("autocomplete") ?? "").toLowerCase();
    if (autocomplete.split(/\s+/).some((token) => token.startsWith("cc-"))) return true;
    if (!paymentPattern) return false;
    const labelled = [...((field as HTMLInputElement).labels ?? [])].map((label) => label.textContent ?? "").join(" ");
    return paymentPattern.test(`${labelled} ${field.getAttribute("name") ?? ""} ${field.id} ${field.getAttribute("aria-label") ?? ""} ${field.getAttribute("placeholder") ?? ""}`);
  });
  const lang = (document.documentElement.getAttribute("lang") ?? "").trim().slice(0, 35);

  const height = document.documentElement.scrollHeight;
  return {
    url: location.href,
    title: document.title,
    ...(lang ? { lang } : {}),
    ...(payment ? { payment: true } : {}),
    text: text.slice(0, input.maxChars),
    view: lines.view.join("\n").slice(0, input.maxViewChars),
    elements,
    scroll: { up: scrollY > 2, down: scrollY + innerHeight < height - 2 },
  };
}

/**
 * Before an action: from now on count what the page attaches. Whoever starts watching only after the click
 * misses the fast reaction and cannot tell the slow one from "none".
 */
export function armMutations(): void {
  const memory = window as unknown as { __serainWatch?: { count: number; last: number; observer: MutationObserver } };
  memory.__serainWatch?.observer.disconnect();
  const watch = {
    count: 0,
    last: performance.now(),
    observer: new MutationObserver(() => {
      watch.count += 1;
      watch.last = performance.now();
    }),
  };
  // Only new nodes and changed text: carousels and animations change attributes and would otherwise keep every page restless forever.
  watch.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  memory.__serainWatch = watch;
}

/**
 * Waits until the page attaches nothing new. Instead of network idle: that never happens on pages with ads and
 * constant polling (measured 2026-09-20: amazon.de and bahn.de ran into the full wait every time, 2.5 s per
 * action). If nothing at all has happened since the action, it waits `graceMs` for the first reaction:
 * github.com first loads the search code after the click and shows it after half a second.
 */
export function waitForQuiet(input: { quietMs: number; graceMs: number; maxMs: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const memory = window as unknown as { __serainWatch?: { count: number; last: number; observer: MutationObserver } };
    const started = performance.now();
    let watch = memory.__serainWatch;
    if (!watch) {
      // A new document: the action took effect, only the quiet counts now.
      const fresh = { count: 1, last: started, observer: new MutationObserver(() => void (fresh.last = performance.now())) };
      fresh.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      memory.__serainWatch = watch = fresh;
    }
    const current = watch;
    const tick = () => {
      const now = performance.now();
      const quiet = current.count > 0 ? now - current.last >= input.quietMs : now - started >= input.graceMs;
      if (quiet || now - started >= input.maxMs) resolve(quiet);
      else setTimeout(tick, 40);
    };
    setTimeout(tick, 40);
  });
}

/**
 * After typing: is there a suggestion list, and does an entry match the typed value? Then it is clicked right
 * away. Many forms (bahn.de, flixbus.de, transit sites) only accept a value once it is chosen from the list,
 * and the choice is a text comparison, not a judgement.
 */
export function findSuggestion(input: { attribute: string; id: number; typed: string }): {
  options: number;
  text?: string;
  exact?: boolean;
  x?: number;
  y?: number;
  /** All entries of the list in page order (at most 15), with position; `all`: contains all typed words. */
  rows?: Array<{ text: string; all: boolean; x: number; y: number }>;
} {
  const roots: Array<Document | ShadowRoot> = [];
  const findRoots = (root: Document | ShadowRoot) => {
    roots.push(root);
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) findRoots(host.shadowRoot);
  };
  findRoots(document);
  const field = roots.map((root) => root.querySelector(`[${input.attribute}="${input.id}"]`)).find(Boolean);
  if (!field) return { options: 0 };
  const anchor = field.getBoundingClientRect();
  const seen = (window as unknown as { __serainSeen?: WeakSet<Element> }).__serainSeen;
  const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const wanted = norm(input.typed);
  const tokens = wanted.split(" ").filter(Boolean);
  if (tokens.length === 0) return { options: 0 };
  let options = 0;

  const owned = [field.getAttribute("aria-controls"), field.getAttribute("aria-owns"), field.getAttribute("list")].filter(Boolean) as string[];
  // The page's order is the ranking: the first entry that contains all typed words, unless a later one is exactly
  // what was typed. Flixbus lists "Frankfurt (alle Haltestellen)" before "Frankfurt Hbf", and that is what is meant.
  let best: { element: Element; score: number; text: string } | null = null;
  const counted = new Set<Element>();
  // The position, not the element: lists rebuild on every keystroke, and a marked element is already replaced
  // by the time of the click (a classifieds site, 2026-09-20). The entry at the same spot is the same one.
  const spot = (element: Element) => {
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 20) };
  };
  const rows: Array<{ text: string; all: boolean; x: number; y: number }> = [];
  for (const root of roots) {
    for (const found of root.querySelectorAll<HTMLElement>('[role="option"], [role="listbox"] li, [role="menuitem"], li, [class*="suggest" i], [class*="autocomplete" i] *, [class*="result" i]')) {
      // Always the whole row, never a piece of highlighting inside it.
      const element = found.closest<HTMLElement>('[role="option"]') ?? found;
      if (counted.has(element) || element === field || element.contains(field)) continue;
      const isOption = element.getAttribute("role") === "option" || owned.some((id) => element.closest(`#${CSS.escape(id)}`));
      // Without a role, only what is new below the field after typing and looks clickable counts.
      if (!isOption && (seen?.has(element) || getComputedStyle(element).cursor !== "pointer")) continue;
      if (typeof element.checkVisibility === "function" && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const box = element.getBoundingClientRect();
      if (box.width < 8 || box.height < 8 || box.bottom < 0 || box.top > innerHeight) continue;
      if (!isOption && (box.top < anchor.bottom - 8 || box.top > anchor.bottom + 500 || box.right < anchor.left - 250 || box.left > anchor.right + 250)) continue;
      const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      const have = norm(text);
      if (!have || have.length > 160) continue;
      counted.add(element);
      options += 1;
      const all = tokens.every((token) => have.includes(token));
      // Nested lists (an `li` inside an `li`) count once: the outer row is enough.
      if (rows.length < 15 && !rows.some((row) => row.text === text.slice(0, 80))) rows.push({ text: text.slice(0, 80), all, ...spot(element) });
      if (!all) continue;
      const score = have === wanted ? 2 : 1;
      if (!best || score > best.score) best = { element, score, text };
    }
  }
  if (!best) return { options, rows };
  return { options, text: best.text.slice(0, 80), exact: best.score >= 2, ...spot(best.element), rows };
}

/**
 * Before a screenshot (style round, addendum D23 of 2026-10-08): what is fixed on
 * top of the page and covers a large part of the viewport (ad interstitial,
 * newsletter window, dimmed background) becomes invisible. Live, a "switch to
 * Google Chrome" window covered the forecast on a weather site. Only
 * `position: fixed`: a sticky header is small, a sticky side column is content.
 * Marked via an attribute so `restoreOverlays` puts everything back afterwards.
 * Returns how many there were.
 */
export function hideOverlays(input: { attribute: string; minShare: number }): number {
  const width = window.innerWidth;
  const height = window.innerHeight;
  let hidden = 0;
  for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *, html > :not(head):not(body)"))) {
    if (element.closest(`[${input.attribute}]`)) continue;
    const style = getComputedStyle(element);
    if (style.position !== "fixed" || style.display === "none" || style.visibility === "hidden") continue;
    const rect = element.getBoundingClientRect();
    const visible = Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));
    if (visible / (width * height) < input.minShare) continue;
    element.setAttribute(input.attribute, element.style.getPropertyValue("visibility"));
    element.style.setProperty("visibility", "hidden", "important");
    hidden += 1;
  }
  return hidden;
}

/** Restores what `hideOverlays` hid: the session continues as before afterwards. */
export function restoreOverlays(input: { attribute: string }): void {
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(`[${input.attribute}]`))) {
    const before = element.getAttribute(input.attribute) ?? "";
    if (before) element.style.setProperty("visibility", before);
    else element.style.removeProperty("visibility");
    element.removeAttribute(input.attribute);
  }
}

/** A block of the page that a screenshot could show. */
export interface ShotRegion {
  id: number;
  /** Position relative to the visible viewport where the pilot stopped. */
  where: "above" | "in_view" | "below";
  width: number;
  height: number;
  /** Start and end of the text, for the choice. */
  text: string;
  /** Does it contain `focus` (case-insensitive)? */
  focus?: boolean;
  /** The nearest block to choose from that contains this one. */
  parent?: number;
  /** Position in its frame's document, for the question which blocks lie side by side. */
  x: number;
  y: number;
  /** Which frame (0: the page itself); set by `src/browser/shot.ts`. */
  frame?: number;
  /**
   * What the block shows, whole and with the names of the controls as in the pilot's snapshot ("Sa, 24.10. —
   * Termine frei"): it becomes the line in the history saying what was in the image. At most `contentChars` characters.
   */
  content?: string;
}

/**
 * Which blocks a screenshot could show (style round, 2026-10-09): boxes with
 * text, at least as large as a card in a result list, not taller than
 * `maxScreens` windows (`stageShot` cuts a long result list), not inside
 * something fixed (cookie wall, ad window). A wrapper with almost the same text
 * and almost the same area replaces its content, so that not every level of
 * nesting is a separate choice. Marked via an attribute, in page order,
 * numbered from `startId` (embedded frames keep counting).
 */
export function shotRegions(input: { attribute: string; max: number; excerptChars: number; contentChars: number; maxScreens: number; startId: number; focus?: string }): ShotRegion[] {
  const plain = (value: string) => value.replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "").replace(/\s+/g, " ").trim();
  const height = window.innerHeight;
  const width = window.innerWidth;
  const inline = new Set(["A", "B", "BUTTON", "EM", "I", "IFRAME", "IMG", "INPUT", "LABEL", "LI", "NOSCRIPT", "OPTION", "P", "SCRIPT", "SELECT", "SPAN", "STRONG", "STYLE", "SVG", "TD", "TEXTAREA", "TH", "TR"]);
  for (const old of Array.from(document.querySelectorAll(`[${input.attribute}]`))) old.removeAttribute(input.attribute);
  const all = Array.from(document.querySelectorAll<HTMLElement>("body *"));
  // Also what hangs next to `body`: Google's full-screen ad ("#google_vignette") sits directly under `html`.
  const fixed = Array.from(document.querySelectorAll<HTMLElement>("body *, html > :not(head):not(body)")).filter((element) => getComputedStyle(element).position === "fixed");
  // Only the element itself: a wrapper with "has-ad" in its name can carry the whole page.
  const advert = (element: Element) =>
    element.matches("ins.adsbygoogle, [id^='div-gpt-ad'], [id^='google_ads'], [data-ad-slot]") ||
    /(^|[\s_-])(ad|ads|adslot|adunit|advert|advertisement|werbung|anzeige|publicite|publicidad|publicidade|pubblicita|reclame|advertentie|reklam|reklama|sponsored|outbrain|taboola)([\s_-]|$)/i.test(`${element.id} ${element.getAttribute("class") ?? ""}`);
  const focus = input.focus ? plain(input.focus).toLowerCase() : "";
  const pageText = plain(document.body.innerText || "").length;
  const found: Array<{ element: HTMLElement; text: string; rect: DOMRect; area: number }> = [];
  for (const element of all) {
    if (inline.has(element.tagName.toUpperCase()) || /^H[1-6]$/i.test(element.tagName)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 140 || rect.height < 40 || rect.height > height * input.maxScreens || rect.width > width * 1.02) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== "visible" || Number(style.opacity) === 0) continue;
    if (fixed.some((overlay) => overlay.contains(element))) continue;
    // Ad slots by their name (as in `stageShot`): they disappear anyway and should not split a list.
    if (advert(element)) continue;
    const text = plain(element.innerText || "");
    // A wrapper around almost the whole page including header and menu shows nothing in particular.
    if (text.length < 15 || (text.length > pageText * 0.8 && element.querySelector("header, nav, [role='banner'], [role='navigation']"))) continue;
    found.push({ element, text, rect, area: rect.width * rect.height });
  }
  // Like `spoken` in `collectPage`: live 2026-10-09 on a booking site the calendar only said "Mo 19 … Sa 24", and Jev
  // chose the times without the day they belong to. In the excerpt for Jev only the name of the selected one: the names
  // of all days would burst it (`excerptChars`). `content` carries all of them.
  const words = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const INTERACTIVE = 'a[href], button, [role="button"], [role="link"], [role="gridcell"], [role="option"], [role="tab"], [role="radio"], [role="checkbox"]';
  const spokenRegion = (element: Element, all: boolean): string | null => {
    const aria = plain(element.getAttribute("aria-label") ?? "").slice(0, 200);
    if (!aria || !element.matches(INTERACTIVE)) return null;
    const shown = words((element as HTMLElement).innerText ?? "");
    const said = words(aria);
    if (shown.length === 0 || said.length <= shown.length || !shown.every((word) => said.includes(word))) return null;
    const current = element.getAttribute("aria-current");
    const picked = element.getAttribute("aria-pressed") === "true" || element.getAttribute("aria-selected") === "true" || (!!current && current !== "false");
    return picked ? `${aria} (selected)` : all ? aria : null;
  };
  /** `all`: every name that says more (for `content`); otherwise only that of the selected one (for the excerpt to Jev). */
  const readable = (node: Node, all: boolean): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node as HTMLElement;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "svg"].includes(element.tagName)) return "";
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return "";
    const named = spokenRegion(element, all);
    const inner = named ?? [...element.childNodes].map((child) => readable(child, all)).join("");
    return style.display.startsWith("inline") ? inner : ` ${inner} `;
  };
  const enriched = (element: HTMLElement, text: string, all: boolean): string =>
    [...element.querySelectorAll(INTERACTIVE)].some((inner) => spokenRegion(inner, all)) ? plain(readable(element, all)) : text;
  const known = new Map(found.map((entry) => [entry.element, entry] as const));
  const kept = found.filter((entry) => {
    let parent = entry.element.parentElement;
    while (parent && !known.has(parent)) parent = parent.parentElement;
    const outer = parent ? known.get(parent) : undefined;
    return !outer || entry.text.length < outer.text.length * 0.9 || outer.area > entry.area * 1.15;
  });
  // First what was in view, then below, then above: the pilot stopped where the answer was.
  const rank = (rect: DOMRect) => (rect.bottom > 0 && rect.top < height ? 0 : rect.top >= height ? 1 : 2);
  const chosen = kept
    .map((entry, order) => ({ ...entry, order }))
    .sort((a, b) => rank(a.rect) - rank(b.rect) || a.order - b.order)
    .slice(0, input.max)
    .sort((a, b) => a.order - b.order);
  const half = Math.floor(input.excerptChars / 2);
  const ids = new Map(chosen.map((entry, index) => [entry.element as Element, input.startId + index] as const));
  return chosen.map((entry, index) => {
    const id = input.startId + index;
    const text = enriched(entry.element, entry.text, false);
    entry.element.setAttribute(input.attribute, String(id));
    let parent = entry.element.parentElement;
    while (parent && !ids.has(parent)) parent = parent.parentElement;
    return {
      ...(parent ? { parent: ids.get(parent)! } : {}),
      id,
      where: entry.rect.bottom <= 0 ? "above" : entry.rect.top >= height ? "below" : "in_view",
      width: Math.round(entry.rect.width),
      height: Math.round(entry.rect.height),
      x: Math.round(entry.rect.left + window.scrollX),
      y: Math.round(entry.rect.top + window.scrollY),
      text: text.length > input.excerptChars ? `${text.slice(0, half)} … ${text.slice(-half)}` : text,
      ...(focus ? { focus: entry.text.toLowerCase().includes(focus) } : {}),
      content: enriched(entry.element, entry.text, true).slice(0, input.contentChars),
    };
  });
}

export interface ShotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What `stageShot` isolated, in page coordinates. */
export interface StagedShot {
  block: ShotRect;
  /** Where the heading's text is, when one comes along. */
  heading: ShotRect | null;
  /**
   * If the block is a long row of equal tiles (days of a forecast), the tiles from left to right: `frameShot`
   * wraps them into a grid that fits a phone.
   */
  tiles: ShotRect[] | null;
  /** Empty bands in the block (a hidden ad slot between two sections): `frameShot` leaves them out. */
  gaps: Array<{ y: number; height: number }>;
  pageWidth: number;
  pageHeight: number;
  /** How far the document is scrolled: in a frame this is needed to convert to the page above. */
  scroll: { x: number; y: number };
  /** Border and padding of the block: for an iframe, its document starts there. */
  inset: { x: number; y: number };
}

/**
 * Isolates the chosen blocks for the capture (`ids`: one, or a group side by
 * side like the connections of a timetable lookup): the smallest box containing
 * all of them stays visible, everything else becomes transparent (`opacity`,
 * which no child can undo), fixed things disappear, sticky things stay in
 * place, ads inside the block drop out; only what the blocks cover goes into
 * the image. The heading directly above stays as context ("Wetter Kassel 16
 * Tage Trend"). Whatever changes is remembered in the attribute `mark` with the
 * old `style`, so `unstageShot` puts everything back: a logged-in session
 * continues afterwards. A block over `maxHeight` is cut between two entries.
 * Returns the clip in page coordinates, plus the size of the page.
 */
export function stageShot(input: { attribute: string; mark: string; ids: number[]; headingGap: number; maxHeight: number; emptyEdge: number; inFrame: boolean }): StagedShot | null {
  const parts = input.ids.map((id) => document.querySelector<HTMLElement>(`[${input.attribute}="${id}"]`)).filter((element): element is HTMLElement => element !== null);
  if (parts.length === 0) return null;
  let block: HTMLElement = parts[0]!;
  while (!parts.every((part) => block.contains(part)) && block.parentElement) block = block.parentElement;
  const restyle = (element: HTMLElement, property: string, value: string) => {
    // As JSON, so "no style" (null) and "empty style" stay apart.
    if (!element.hasAttribute(input.mark)) element.setAttribute(input.mark, JSON.stringify(element.getAttribute("style")));
    element.style.setProperty(property, value, "important");
  };
  // Release first, then measure: a sticky column (the booking panel on a booking site) jumps to its place in the flow
  // after the change, and measured before, the clip live on 2026-10-09 showed blank white once the pilot had scrolled.
  for (const part of parts) for (let node: HTMLElement | null = part; node; node = node.parentElement) if (getComputedStyle(node).position === "sticky") restyle(node, "position", "static");
  const rects = parts.map((part) => part.getBoundingClientRect());
  const outer = { top: Math.min(...rects.map((rect) => rect.top)), left: Math.min(...rects.map((rect) => rect.left)), right: Math.max(...rects.map((rect) => rect.right)), bottom: Math.max(...rects.map((rect) => rect.bottom)) };
  const width = outer.right - outer.left;
  const height = outer.bottom - outer.top;
  const box = outer;
  let heading: HTMLElement | null = null;
  // If the block has a heading of its own, it needs none from outside ("Hello!" above a result list).
  const titled = parts.some((part) => Array.from(part.querySelectorAll<HTMLElement>("h1, h2, h3")).some((element) => element.getBoundingClientRect().height > 0));
  const floating = Array.from(document.querySelectorAll<HTMLElement>("body *, html > :not(head):not(body)")).filter((element) => getComputedStyle(element).position === "fixed");
  for (const candidate of titled ? [] : Array.from(document.querySelectorAll<HTMLElement>("h1, h2, h3"))) {
    const rect = candidate.getBoundingClientRect();
    if (rect.height === 0 || parts.some((part) => part.contains(candidate)) || candidate.contains(block)) continue;
    // Not the heading of a dialog ("Cookie settings"): the dialog would come into the image with it.
    if (!candidate.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || floating.some((element) => element.contains(candidate))) continue;
    if (rect.bottom <= box.top + 1 && box.top - rect.bottom <= input.headingGap && rect.left < box.right && rect.right > box.left) heading = candidate;
  }
  const shown = heading ? [block, heading] : [block];
  const path = new Set<Element>();
  for (const element of shown) for (let node: Element | null = element; node; node = node.parentElement) path.add(node);
  const inside = (element: Element) => shown.some((root) => root.contains(element));
  for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *, html > :not(head):not(body)"))) {
    if (path.has(element) || inside(element)) {
      const position = getComputedStyle(element).position;
      if (position === "sticky") restyle(element, "position", "static");
      continue;
    }
    // Only the outermost: what lies inside is gone with them.
    if (element.parentElement && !path.has(element.parentElement)) continue;
    restyle(element, "opacity", "0");
  }
  for (const root of shown) {
    // Ads by markup and by their label in several languages (the page's language, not the owner's). Cosmetic only.
    for (const element of Array.from(root.querySelectorAll<HTMLElement>("iframe, ins.adsbygoogle, [id^='div-gpt-ad'], [id^='google_ads'], [data-ad-slot], [aria-label='Advertisement' i], [aria-label='Anzeige' i], [aria-label='Publicité' i], [aria-label='Publicidad' i], [aria-label='Pubblicità' i], [aria-label='Advertentie' i], [aria-label='Reklam' i], [aria-label='Reklama' i]"))) restyle(element, "display", "none");
    // Ad slots by their name: the slot stays (the layout should not shift), its content becomes invisible, and what is
    // empty then is cut away by the edge trim below.
    for (const element of Array.from(root.querySelectorAll<HTMLElement>("[id], [class]"))) {
      const names = `${element.id} ${element.getAttribute("class") ?? ""}`;
      // With hardly any text: a wrapper with "has-ad" in its name is content.
      if (/(^|[\s_-])(ad|ads|adslot|adunit|advert|advertisement|werbung|anzeige|publicite|publicidad|publicidade|pubblicita|reclame|advertentie|reklam|reklama|sponsored|outbrain|taboola)([\s_-]|$)/i.test(names) && (element.innerText || "").trim().length < 40) restyle(element, "visibility", "hidden");
    }
    // What floats over the block: fixed buttons ("Feedback"), hint bubbles ("New: similar products").
    // A bubble floats (absolute or fixed); an icon that has a bubble ("lyr_tooltip" on a transit site) stays.
    for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const position = getComputedStyle(element).position;
      const bubble = /^(dialog|tooltip|alertdialog)$/.test(element.getAttribute("role") ?? "") || /(^|[-_ ])(tooltip|popover|coachmark)/i.test(element.getAttribute("class") ?? "");
      if (position === "fixed" || (bubble && position === "absolute")) restyle(element, "visibility", "hidden");
    }
  }
  const toPage = (rect: DOMRect): ShotRect => ({ x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height });
  let title: ShotRect | null = null;
  if (heading) {
    const range = document.createRange();
    range.selectNodeContents(heading);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) title = toPage(rect);
  }
  // A row: at least four visible siblings at one height, of similar size, that together fill almost the whole block.
  let tiles: ShotRect[] | null = null;
  if (parts.length === 1 && width / height >= 3) {
    const queue: Array<{ element: Element; depth: number }> = [{ element: parts[0]!, depth: 0 }];
    while (queue.length > 0 && !tiles) {
      const { element, depth } = queue.shift()!;
      const kids = Array.from(element.children)
        .map((child) => child.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
      if (kids.length >= 4) {
        const tall = median(kids.map((rect) => rect.height));
        const wide = median(kids.map((rect) => rect.width));
        const row =
          kids.every((rect, index) => Math.abs(rect.top - kids[0]!.top) <= 6 && Math.abs(rect.height - tall) <= tall * 0.25 && Math.abs(rect.width - wide) <= wide * 0.4 && (index === 0 || rect.left >= kids[index - 1]!.right - 1)) &&
          kids.reduce((sum, rect) => sum + rect.width, 0) >= width * 0.75 &&
          tall >= height * 0.7;
        if (row) tiles = kids.map(toPage);
      }
      if (depth < 4) for (const child of Array.from(element.children)) queue.push({ element: child, depth: depth + 1 });
    }
  }
  // Empty edges in the block (an ad slot that is empty now, a hidden column) drop out. Only what is wider than
  // `emptyEdge`: a box's own padding stays, so its border is not cut.
  const seen = (element: Element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  // What is content: visible text (not the screen-reader text that sits in a one-pixel box), images from 8 px,
  // controls and boxes with a background image (product photos are often set that way).
  const media = (element: Element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8 || !seen(element)) return null;
    return element.matches("img, svg, video, canvas, picture, input, select, textarea, button") || getComputedStyle(element).backgroundImage.startsWith("url(") ? rect : null;
  };
  const texts: Array<{ rect: DOMRect; parent: Element }> = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!node.textContent?.trim() || !parent || !seen(parent)) continue;
    const frame = parent.getBoundingClientRect();
    if (frame.width < 3 || frame.height < 3) continue;
    range.selectNodeContents(node);
    texts.push({ rect: range.getBoundingClientRect(), parent });
  }
  const pictures = Array.from(block.querySelectorAll("*")).map((element) => ({ element, rect: media(element) })).filter((entry): entry is { element: Element; rect: DOMRect } => entry.rect !== null);
  // Empty boxes (an ad slot with border and shadow, but without an ad) disappear entirely.
  for (const element of Array.from(block.querySelectorAll<HTMLElement>("*"))) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100 || !seen(element)) continue;
    const holds = texts.some((text) => element.contains(text.parent)) || pictures.some((picture) => element === picture.element || element.contains(picture.element));
    if (!holds) restyle(element, "visibility", "hidden");
  }
  const content = { top: Infinity, left: Infinity, right: -Infinity, bottom: -Infinity };
  for (const rect of [...texts.map((text) => text.rect), ...pictures.map((picture) => picture.rect)]) {
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= outer.top || rect.top >= outer.bottom || rect.right <= outer.left || rect.left >= outer.right) continue;
    content.top = Math.min(content.top, rect.top);
    content.left = Math.min(content.left, rect.left);
    content.right = Math.max(content.right, rect.right);
    content.bottom = Math.max(content.bottom, rect.bottom);
  }
  let area = { top: outer.top, left: outer.left, right: outer.right, bottom: outer.bottom };
  if (content.right > content.left) {
    const keep = input.emptyEdge / 3;
    if (content.top - area.top > input.emptyEdge) area.top = content.top - keep;
    if (content.left - area.left > input.emptyEdge) area.left = content.left - keep;
    if (area.right - content.right > input.emptyEdge) area.right = content.right + keep;
    if (area.bottom - content.bottom > input.emptyEdge) area.bottom = content.bottom + keep;
  }
  // What an ancestor with its own scrollbar hides is not drawn; in a frame, neither is what lies below its edge.
  let sideways = false;
  for (let node = parts[0]!.parentElement; node && node !== document.documentElement && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
      const rect = node.getBoundingClientRect();
      if (rect.left > area.left + 1 || rect.right < area.right - 1) sideways = true;
      area = { top: Math.max(area.top, rect.top), left: Math.max(area.left, rect.left), right: Math.min(area.right, rect.right), bottom: Math.min(area.bottom, rect.bottom) };
    }
  }
  if (input.inFrame) area = { top: Math.max(area.top, 0), left: Math.max(area.left, 0), right: Math.min(area.right, window.innerWidth), bottom: Math.min(area.bottom, window.innerHeight) };
  if (area.right <= area.left || area.bottom <= area.top) return null;
  // Too long (a result list) or cut off by the scroll area: shorten at the bottom so that no entry is cut through.
  // Also when a list scrolls inside the block itself and ends at its bottom (the connections on a transit site).
  let scrolled = Infinity;
  for (const element of Array.from(block.querySelectorAll<HTMLElement>("*"))) {
    if (element.scrollHeight <= element.clientHeight + 1 || !/(auto|scroll)/.test(getComputedStyle(element).overflowY)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom >= area.bottom - 80 && rect.bottom <= area.bottom + 1) scrolled = Math.min(scrolled, rect.bottom);
  }
  // Empty bands: where nothing stands across the full width, more than one and a half `emptyEdge` high. They do not count toward the length.
  const keepGap = input.emptyEdge / 3;
  const filled = [...texts.map((text) => text.rect), ...pictures.map((picture) => picture.rect)]
    .filter((rect) => rect.width > 0 && rect.height > 0 && rect.right > area.left && rect.left < area.right && rect.bottom > area.top && rect.top < area.bottom)
    .map((rect) => [Math.max(rect.top, area.top), Math.min(rect.bottom, area.bottom)] as const)
    .sort((a, b) => a[0] - b[0]);
  const bands: Array<{ top: number; bottom: number }> = [];
  let reach = filled[0]?.[1] ?? area.bottom;
  for (const [top, bottom] of filled) {
    if (top - reach > input.emptyEdge * 1.5) bands.push({ top: reach + keepGap, bottom: top - keepGap });
    reach = Math.max(reach, bottom);
  }
  let stretched = area.top + input.maxHeight;
  for (const band of bands) if (band.top < stretched) stretched += band.bottom - band.top;
  const limit = Math.min(area.bottom, stretched, scrolled);
  // What sticks out over the top or bottom edge (the start of a video below the last section) gets cut by the edge:
  // then up to the next clean transition.
  const pieces = Array.from(block.querySelectorAll("*"))
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.height >= 16 && rect.width > 0 && rect.right > area.left && rect.left < area.right);
  const crosses = (y: number) => pieces.some((rect) => rect.top < y - 1 && rect.bottom > y + 1 && rect.height < (area.bottom - area.top) * 0.5);
  if (crosses(area.top)) {
    const tops = [...new Set(pieces.map((rect) => Math.floor(rect.top)))].filter((y) => y > area.top && y <= area.top + (limit - area.top) * 0.3).sort((a, b) => a - b);
    area.top = tops.find((y) => !crosses(y)) ?? area.top;
  }
  if (limit < outer.bottom - 1 || scrolled < Infinity || crosses(limit)) {
    const span = limit - area.top;
    const items = pieces.filter((rect) => rect.height < span * 0.5 && rect.bottom > area.top && rect.top < limit);
    const cuts = [...new Set(items.map((rect) => Math.ceil(rect.bottom)))].filter((bottom) => bottom <= limit && bottom >= area.top + span * 0.4).sort((a, b) => b - a);
    const clean = cuts.find((cut) => !items.some((rect) => rect.top < cut - 1 && rect.bottom > cut + 1));
    area.bottom = clean ?? limit;
  }
  // Cut sideways by a carousel: up to the first whole card.
  if (sideways) {
    const span = area.right - area.left;
    const items = Array.from(block.querySelectorAll("*"))
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width >= 16 && rect.height > 0 && rect.width < span * 0.5 && rect.right > area.left && rect.left < area.right && rect.bottom > area.top && rect.top < area.bottom);
    const straddles = (x: number) => items.some((rect) => rect.left < x - 1 && rect.right > x + 1);
    const lefts = [...new Set(items.map((rect) => Math.floor(rect.left)))].filter((x) => x >= area.left && x <= area.left + span * 0.4).sort((a, b) => a - b);
    const rights = [...new Set(items.map((rect) => Math.ceil(rect.right)))].filter((x) => x <= area.right && x >= area.right - span * 0.4).sort((a, b) => b - a);
    area.left = lefts.find((x) => !straddles(x)) ?? area.left;
    area.right = rights.find((x) => !straddles(x)) ?? area.right;
  }
  const trimmed: ShotRect = { x: area.left + window.scrollX, y: area.top + window.scrollY, width: area.right - area.left, height: area.bottom - area.top };
  const page = document.documentElement;
  return {
    block: trimmed,
    heading: title,
    tiles,
    gaps: bands.filter((band) => band.bottom <= area.bottom && band.top >= area.top).map((band) => ({ y: band.top + window.scrollY, height: band.bottom - band.top })),
    pageWidth: Math.max(page.scrollWidth, document.body.scrollWidth),
    pageHeight: Math.max(page.scrollHeight, document.body.scrollHeight),
    scroll: { x: window.scrollX, y: window.scrollY },
    inset: { x: block.clientLeft + parseFloat(getComputedStyle(block).paddingLeft), y: block.clientTop + parseFloat(getComputedStyle(block).paddingTop) },
  };
}

/** Restores what `stageShot` changed and removes the blocks' marks. */
export function unstageShot(input: { attribute: string; mark: string }): void {
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(`[${input.mark}]`))) {
    const before = JSON.parse(element.getAttribute(input.mark) ?? "null") as string | null;
    if (before === null) element.removeAttribute("style");
    else element.setAttribute("style", before);
    element.removeAttribute(input.mark);
  }
  for (const element of Array.from(document.querySelectorAll(`[${input.attribute}]`))) element.removeAttribute(input.attribute);
}

/** How `frameShot` sets the image: rectangles relative to the capture, in CSS pixels. */
export interface ShotLayout {
  block: ShotRect;
  heading: ShotRect | null;
  tiles: ShotRect[] | null;
  /** Empty bands in the block that drop out. */
  gaps: Array<{ y: number; height: number }>;
  /** Columns of the grid when `tiles` are wrapped. */
  columns: number;
}

/**
 * Assembles a capture into the finished image on a blank sheet (`about:blank` of
 * the same session, without network). If the capture's edge is a single colour,
 * the block stands with `pad` breathing room all around in that colour, the
 * heading just above, and a row of tiles becomes a grid with `columns` columns:
 * that way a weekly forecast fits a phone; empty bands (`gaps`) drop out.
 * Otherwise (image or gradient behind) the capture lies as it is, as a card with
 * round corners on a light background. Copied pixel by pixel, nothing is scaled
 * except a heading wider than the grid.
 */
export async function frameShot(input: { src: string; scale: number; pad: number; layout: ShotLayout }): Promise<"plain" | "grid" | "card"> {
  const image = new Image();
  image.src = input.src;
  await image.decode();
  const source = document.createElement("canvas");
  source.width = image.naturalWidth;
  source.height = image.naturalHeight;
  const context = source.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(image, 0, 0);
  const ring = Math.max(1, Math.round(input.scale * 2));
  const samples: number[][] = [];
  const take = (x: number, y: number, width: number, height: number) => {
    const data = context.getImageData(x, y, width, height).data;
    // Every fourth pixel is enough for a colour.
    for (let index = 0; index < data.length; index += 16) samples.push([data[index]!, data[index + 1]!, data[index + 2]!]);
  };
  take(0, 0, source.width, ring);
  take(0, source.height - ring, source.width, ring);
  take(0, 0, ring, source.height);
  take(source.width - ring, 0, ring, source.height);
  const mean = [0, 1, 2].map((channel) => samples.reduce((sum, pixel) => sum + pixel[channel]!, 0) / samples.length);
  const near = samples.filter((pixel) => Math.hypot(pixel[0]! - mean[0]!, pixel[1]! - mean[1]!, pixel[2]! - mean[2]!) < 18).length / samples.length;
  const frame = document.createElement("div");
  frame.id = "shot";
  frame.style.display = "inline-block";
  document.body.style.margin = "0";
  const { block, heading, tiles, gaps } = input.layout;
  /** A rectangle without the empty bands, from top to bottom. */
  const slices = (from: ShotRect): ShotRect[] => {
    const out: ShotRect[] = [];
    let y = from.y;
    for (const gap of [...gaps].sort((a, b) => a.y - b.y)) {
      if (gap.y + gap.height <= from.y || gap.y >= from.y + from.height) continue;
      if (gap.y > y) out.push({ x: from.x, y, width: from.width, height: gap.y - y });
      y = Math.max(y, gap.y + gap.height);
    }
    if (from.y + from.height > y) out.push({ x: from.x, y, width: from.width, height: from.y + from.height - y });
    return out;
  };
  const tall = (pieces: ShotRect[]) => pieces.reduce((sum, piece) => sum + piece.height, 0);
  if (near < 0.94) {
    // The edge around the capture only served to look at the colour: block and heading go onto the card.
    const left = Math.min(block.x, heading?.x ?? block.x);
    const top = Math.min(block.y, heading?.y ?? block.y);
    const width = Math.max(block.x + block.width, heading ? heading.x + heading.width : 0) - left;
    const pieces = slices({ x: left, y: top, width, height: block.y + block.height - top });
    const height = tall(pieces);
    const card = document.createElement("canvas");
    card.width = Math.round(width * input.scale);
    card.height = Math.round(height * input.scale);
    let row = 0;
    for (const piece of pieces) {
      card.getContext("2d")!.drawImage(source, piece.x * input.scale, piece.y * input.scale, piece.width * input.scale, piece.height * input.scale, 0, row * input.scale, piece.width * input.scale, piece.height * input.scale);
      row += piece.height;
    }
    card.style.display = "block";
    card.style.width = `${width}px`;
    card.style.height = `${height}px`;
    card.style.borderRadius = "12px";
    card.style.boxShadow = "0 0 0 1px rgba(0, 0, 0, 0.06), 0 6px 20px rgba(0, 0, 0, 0.08)";
    frame.style.background = "#f2f2f4";
    frame.style.padding = `${input.pad}px`;
    frame.append(card);
    document.body.replaceChildren(frame);
    return "card";
  }
  const grid = tiles && tiles.length > 1 ? tiles : null;
  const columns = grid ? Math.max(1, Math.min(grid.length, input.layout.columns)) : 1;
  const cell = grid ? { width: Math.max(...grid.map((tile) => tile.width)), height: Math.max(...grid.map((tile) => tile.height)) } : null;
  const gap = grid ? Math.min(12, Math.max(4, grid[1]!.x - grid[0]!.x - grid[0]!.width)) : 0;
  const rows = grid ? Math.ceil(grid.length / columns) : 1;
  const pieces = slices(block);
  const body = grid && cell ? { width: columns * cell.width + (columns - 1) * gap, height: rows * cell.height + (rows - 1) * gap } : { width: block.width, height: tall(pieces) };
  const headingScale = heading && grid ? Math.min(1, body.width / heading.width) : 1;
  const headingGap = heading ? Math.min(20, Math.max(8, block.y - heading.y - heading.height)) : 0;
  const top = heading ? heading.height * headingScale + headingGap : 0;
  const width = Math.max(body.width, heading ? heading.width * headingScale : 0) + 2 * input.pad;
  const height = input.pad + top + body.height + input.pad;
  const output = document.createElement("canvas");
  output.width = Math.round(width * input.scale);
  output.height = Math.round(height * input.scale);
  output.style.display = "block";
  output.style.width = `${width}px`;
  output.style.height = `${height}px`;
  const draw = output.getContext("2d")!;
  draw.fillStyle = `rgb(${mean.map((value) => Math.round(value)).join(", ")})`;
  draw.fillRect(0, 0, output.width, output.height);
  draw.imageSmoothingQuality = "high";
  /**
   * If a piece sits on almost the same colour as the background, just not exactly (a gradient behind the heading),
   * it is shifted by the difference: otherwise it would stand out as a light box in the image.
   */
  const blend = (from: ShotRect): HTMLCanvasElement => {
    const x = Math.round(from.x * input.scale);
    const y = Math.round(from.y * input.scale);
    const piece = document.createElement("canvas");
    piece.width = Math.max(1, Math.round(from.width * input.scale));
    piece.height = Math.max(1, Math.round(from.height * input.scale));
    const target = piece.getContext("2d", { willReadFrequently: true })!;
    target.drawImage(source, x, y, piece.width, piece.height, 0, 0, piece.width, piece.height);
    const pixels = target.getImageData(0, 0, piece.width, piece.height);
    const data = pixels.data;
    const edge: number[][] = [];
    for (let row = 0; row < piece.height; row += 1) {
      for (let column = 0; column < piece.width; column += row < ring || row >= piece.height - ring ? 4 : Math.max(1, piece.width - 1)) {
        const index = (row * piece.width + column) * 4;
        edge.push([data[index]!, data[index + 1]!, data[index + 2]!]);
      }
    }
    const local = [0, 1, 2].map((channel) => edge.reduce((sum, pixel) => sum + pixel[channel]!, 0) / edge.length);
    const even = edge.filter((pixel) => Math.hypot(pixel[0]! - local[0]!, pixel[1]! - local[1]!, pixel[2]! - local[2]!) < 12).length / edge.length;
    const shift = mean.map((value, channel) => value - local[channel]!);
    const distance = Math.hypot(shift[0]!, shift[1]!, shift[2]!);
    if (even >= 0.9 && distance >= 1 && distance <= 40) {
      for (let index = 0; index < data.length; index += 4) {
        data[index] = data[index]! + shift[0]!;
        data[index + 1] = data[index + 1]! + shift[1]!;
        data[index + 2] = data[index + 2]! + shift[2]!;
      }
      target.putImageData(pixels, 0, 0);
    }
    return piece;
  };
  const copy = (from: ShotRect, x: number, y: number, scale = 1) =>
    draw.drawImage(source, from.x * input.scale, from.y * input.scale, from.width * input.scale, from.height * input.scale, x * input.scale, y * input.scale, from.width * scale * input.scale, from.height * scale * input.scale);
  const place = (from: ShotRect, x: number, y: number, scale = 1) => draw.drawImage(blend(from), x * input.scale, y * input.scale, from.width * scale * input.scale, from.height * scale * input.scale);
  if (heading) place(heading, input.pad, input.pad, headingScale);
  if (grid && cell) grid.forEach((tile, index) => copy(tile, input.pad + (index % columns) * (cell.width + gap), input.pad + top + Math.floor(index / columns) * (cell.height + gap)));
  else {
    let row = input.pad + top;
    for (const piece of pieces) {
      place(piece, input.pad, row);
      row += piece.height;
    }
  }
  frame.append(output);
  document.body.replaceChildren(frame);
  return grid ? "grid" : "plain";
}

/** Waits until the images in the blocks have loaded, at most `maxMs`: what lay below the fold often only loads now. */
export function settleImages(input: { attribute: string; ids: number[]; maxMs: number }): Promise<void> {
  const blocks = input.ids.map((id) => document.querySelector(`[${input.attribute}="${id}"]`)).filter((block) => block !== null);
  const pending = blocks.flatMap((block) => Array.from(block.querySelectorAll("img"))).filter((image) => !image.complete);
  const loaded = Promise.all(pending.map((image) => new Promise<void>((resolve) => { image.addEventListener("load", () => resolve(), { once: true }); image.addEventListener("error", () => resolve(), { once: true }); })));
  return Promise.race([loaded.then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, input.maxMs))]);
}
