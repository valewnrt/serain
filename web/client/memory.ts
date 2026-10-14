import { cached, isFresh, load } from "./api.js";
import { h, highlight, icon } from "./dom.js";
import type { Page } from "./main.js";
import { renderMarkdown } from "./markdown.js";
import { button, compactDate, empty, shortDate, skeleton } from "./ui.js";

interface Fact {
  id: string;
  category: string;
  content: string;
  kind: "identity" | "preference" | "situation" | "episode";
  valid_from: string | null;
  valid_until: string | null;
  created_at: string;
}

interface Memory {
  userModel: { base: string; learned: string; source: string; created_at: string } | null;
  facts: Fact[];
  procedures: Array<{ id: string; title: string; trigger: string; body: string }>;
}

const PATH = "/api/memory";

const KIND_LABEL: Record<Fact["kind"], string> = {
  identity: "Who you are",
  preference: "What you like",
  situation: "What applies now",
  episode: "What happened",
};

const VIEWS = [
  { slug: "", label: "Facts" },
  { slug: "user-model", label: "User model" },
  { slug: "procedures", label: "Procedures" },
] as const;

export const prefetchMemory = () => void load(PATH).catch(() => undefined);

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

/** When a fact applies, only when there is something to say; otherwise since when Serain knows it. */
function validity(fact: Fact, now: number): { text: string; expired: boolean } {
  const until = fact.valid_until ? new Date(fact.valid_until) : null;
  const from = fact.valid_from ? new Date(fact.valid_from) : null;
  if (until && until.getTime() < now) return { text: `expired ${compactDate(until)}`, expired: true };
  if (from && from.getTime() > now) return { text: `from ${compactDate(from)}`, expired: false };
  if (until) return { text: `until ${compactDate(until)}`, expired: false };
  return { text: compactDate(new Date(fact.created_at)), expired: false };
}

function factsView(data: Memory, signal: AbortSignal): HTMLElement {
  const input = h("input", {
    type: "search",
    class: "search-input",
    placeholder: "Search facts",
    "aria-label": "Search facts",
    autocomplete: "off",
    spellcheck: "false",
    enterkeyhint: "search",
  });
  const results = h("div", { class: "fact-groups" });
  const kinds = new Set(data.facts.map((fact) => fact.kind));

  const draw = () => {
    const query = input.value.trim();
    const needle = query.toLocaleLowerCase();
    const now = Date.now();
    const matching = needle ? data.facts.filter((fact) => `${fact.content} ${fact.category}`.toLocaleLowerCase().includes(needle)) : data.facts;
    if (data.facts.length === 0) {
      results.replaceChildren(empty("No facts yet.", "What Serain remembers in the chat shows up here."));
      return;
    }
    if (matching.length === 0) {
      const reset = button("Clear search");
      reset.addEventListener("click", () => {
        input.value = "";
        draw();
        input.focus();
      });
      results.replaceChildren(empty(`Nothing for "${query}".`, undefined, reset));
      return;
    }
    const groups = new Map<string, Fact[]>();
    for (const fact of matching) groups.set(fact.category, [...(groups.get(fact.category) ?? []), fact]);
    // Two columns only from two groups on; a single one would otherwise sit in half the width.
    results.classList.toggle("multi", groups.size > 1);
    results.replaceChildren(
      ...[...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, facts]) =>
          h(
            "section",
            { class: "fact-group" },
            h("h2", { class: "group-label" }, ...highlight(capitalize(category), query), h("span", { class: "count" }, String(facts.length))),
            h(
              "ul",
              { class: "facts" },
              ...facts.map((fact) => {
                const when = validity(fact, now);
                return h(
                  "li",
                  { class: `fact${when.expired ? " is-expired" : ""}` },
                  h("p", { class: "fact-text" }, ...highlight(fact.content, query)),
                  h("p", { class: "fact-meta" }, kinds.size > 1 ? `${KIND_LABEL[fact.kind]} · ` : "", h("time", { datetime: fact.valid_until ?? fact.valid_from ?? fact.created_at }, when.text)),
                );
              }),
            ),
          ),
        ),
    );
  };

  input.addEventListener("input", draw);
  // "/" jumps into the search, like almost everywhere on the web.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable], dialog")) return;
      event.preventDefault();
      input.focus();
    },
    { signal },
  );
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && input.value) {
      event.preventDefault();
      input.value = "";
      draw();
    }
  });
  draw();
  return h(
    "div",
    {},
    h("label", { class: "search" }, icon("search"), input, h("kbd", { "aria-hidden": "true" }, "/")),
    results,
  );
}

function modelView(data: Memory): HTMLElement {
  const model = data.userModel;
  if (!model) return empty("No user model yet.");
  const base = renderMarkdown(model.base.trim(), "base");
  const learned = model.learned.trim() ? renderMarkdown(model.learned.trim(), "learned") : null;
  // The heading sits in the Markdown block so it looks like the other sections.
  learned?.body.prepend(h("h2", { id: "learned", class: "md-h2" }, "Learned since"));
  const sections = [...base.headings.filter((heading) => heading.level === 2), ...(learned ? [{ id: "learned", level: 2, text: "Learned since" }] : [])];
  const toc = sections.length > 2 ? h("nav", { class: "toc", "aria-label": "Sections" }, h("ul", {}, ...sections.map((section) => h("li", {}, h("a", { href: `#${section.id}` }, section.text))))) : null;
  return h(
    "div",
    { class: "model-layout" },
    h(
      "article",
      { class: "model" },
      h("p", { class: "model-meta" }, `As of ${shortDate.format(new Date(model.created_at))}`),
      base.body,
      learned ? h("section", { class: "learned" }, learned.body) : null,
    ),
    toc,
  );
}

function proceduresView(data: Memory): HTMLElement {
  if (data.procedures.length === 0) return empty("No approved procedures yet.", "When Serain notices that you always do something the same way, it suggests a procedure in the chat.");
  return h(
    "ul",
    { class: "procedures" },
    ...data.procedures.map((procedure) => h("li", { class: "procedure" }, h("p", { class: "procedure-title" }, procedure.title), h("p", { class: "procedure-trigger" }, `When: ${procedure.trigger}`), h("p", { class: "procedure-body" }, procedure.body))),
  );
}

export const memoryPage: Page = {
  title: "Memory",
  render(main, signal) {
    const slug = location.pathname.split("/")[2] ?? "";
    const view = VIEWS.find((v) => v.slug === slug) ?? VIEWS[0];
    const tabs = h("nav", { class: "tabs", "aria-label": "Memory" });
    const body = h("div", { class: "tab-body" });
    main.replaceChildren(h("div", { class: "page" }, h("header", { class: "page-head" }, h("h1", {}, "Memory")), tabs, body));

    // The tabs show at once, the counts come with the data.
    const drawTabs = (counts: Record<string, number | null>) =>
      tabs.replaceChildren(
        ...VIEWS.map((v) =>
          h(
            "a",
            { href: v.slug ? `/memory/${v.slug}` : "/memory", class: "tab", "aria-current": v === view ? "page" : undefined, "data-nav": "replace" },
            v.label,
            counts[v.slug] !== null && counts[v.slug] !== undefined ? h("span", { class: "count" }, String(counts[v.slug])) : null,
          ),
        ),
      );
    drawTabs({});

    let shown = "";
    let viewScope: AbortController | null = null;
    signal.addEventListener("abort", () => viewScope?.abort());
    const draw = (data: Memory) => {
      const json = JSON.stringify(data);
      if (json === shown) return;
      shown = json;
      drawTabs({ "": data.facts.length, "user-model": null, procedures: data.procedures.length });
      // Do not throw away the search the owner is typing into when refreshing.
      const typing = body.querySelector<HTMLInputElement>(".search-input");
      const query = typing?.value ?? "";
      const focused = typing !== null && document.activeElement === typing;
      viewScope?.abort();
      viewScope = new AbortController();
      body.replaceChildren(view.slug === "user-model" ? modelView(data) : view.slug === "procedures" ? proceduresView(data) : factsView(data, viewScope.signal));
      const input = body.querySelector<HTMLInputElement>(".search-input");
      if (input && query) {
        input.value = query;
        input.dispatchEvent(new Event("input"));
      }
      if (input && focused) input.focus();
    };

    const known = cached<Memory>(PATH);
    if (known) draw(known);
    else body.replaceChildren(skeleton(8));
    if (known && isFresh(PATH)) return;
    return load<Memory>(PATH).then((data) => {
      if (!signal.aborted) draw(data);
    });
  },
};
