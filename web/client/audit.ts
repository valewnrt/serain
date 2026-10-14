import { api, cached, isFresh, load } from "./api.js";
import { h, icon } from "./dom.js";
import type { Page } from "./main.js";
import { button, dayKey, dayLabel, empty, skeleton, timeFmt } from "./ui.js";

interface AuditItem {
  id: string;
  at: string;
  category: string;
  title: string;
  lines: Array<{ label: string | null; text: string }>;
  status: "ok" | "failed" | "pending" | null;
}

interface AuditPage {
  items: AuditItem[];
  next: string | null;
}

/** Filters as they appear in the address (`/audit?only=security`), and what the server expects for them. */
const FILTERS = [
  { slug: "", category: "", label: "All" },
  { slug: "actions", category: "action", label: "Actions" },
  { slug: "access", category: "access", label: "Access" },
  { slug: "memory", category: "memory", label: "Memory" },
  { slug: "security", category: "security", label: "Security" },
  { slug: "system", category: "system", label: "System" },
  { slug: "feedback", category: "feedback", label: "Feedback" },
];

const STATUS = {
  failed: { icon: "failed", label: "Failed or blocked" },
  pending: { icon: "pending", label: "Awaiting confirmation" },
} as const;

const url = (category: string, before?: string | null) => {
  const params = new URLSearchParams();
  if (before) params.set("before", before);
  if (category) params.set("category", category);
  return `/api/audit?${params}`;
};

/** What was already loaded, per filter, older pages too: back in the audit everything is there again. */
const loaded = new Map<string, AuditPage>();

export function prefetchAudit(): void {
  const filter = FILTERS.find((f) => f.slug === (new URLSearchParams(location.search).get("only") ?? "")) ?? FILTERS[0]!;
  if (!loaded.has(filter.category)) void load<AuditPage>(url(filter.category)).catch(() => undefined);
}

/** Identical entries right after each other ("Watcher ended" four times in a minute) become one line with a count. */
function collapse(items: AuditItem[]): Array<{ item: AuditItem; times: number }> {
  const out: Array<{ item: AuditItem; times: number; key: string }> = [];
  for (const item of items) {
    // Only what one sees counts: "ok" and "no status" look the same.
    const visible = item.status === "failed" || item.status === "pending" ? item.status : null;
    const key = JSON.stringify([item.title, item.lines, visible, item.at.slice(0, 16)]);
    const last = out[out.length - 1];
    if (last && last.key === key) last.times += 1;
    else out.push({ item, times: 1, key });
  }
  return out;
}

function row(item: AuditItem, times: number): HTMLElement {
  const at = new Date(item.at);
  const status = item.status === "failed" || item.status === "pending" ? STATUS[item.status] : null;
  return h(
    "li",
    { class: `entry${item.status ? ` is-${item.status}` : ""}` },
    h("time", { datetime: item.at }, timeFmt.format(at)),
    h("span", { class: "entry-status", title: status?.label }, status ? icon(status.icon) : null, status ? h("span", { class: "sr-only" }, status.label) : null),
    h(
      "div",
      { class: "entry-body" },
      h("p", { class: "entry-title" }, item.title, times > 1 ? h("span", { class: "count", title: `${times} identical entries` }, `${times}×`) : null),
      item.lines.length > 0
        ? h("div", { class: "entry-lines" }, ...item.lines.map((line) => h("p", { class: "entry-line" }, line.label ? h("span", { class: "entry-label" }, line.label) : null, line.text)))
        : null,
    ),
  );
}

export const auditPage: Page = {
  title: "Audit",
  render(main, signal) {
    const params = new URLSearchParams(location.search);
    const filter = FILTERS.find((f) => f.slug === (params.get("only") ?? "")) ?? FILTERS[0]!;
    const list = h("div", { class: "timeline" });
    const sentinel = h("div", { class: "sentinel" });
    const more = button("Load older", { variant: "quiet", class: "more", hidden: true });

    const chips = h(
      "div",
      { class: "segmented", role: "group", "aria-label": "Filter" },
      ...FILTERS.map((f) => {
        const target = f.slug ? `/audit?only=${f.slug}` : "/audit";
        return h(
          "a",
          {
            href: target,
            class: "segment",
            "aria-current": f === filter ? "true" : undefined,
            "data-nav": "replace",
          },
          f.label,
        );
      }),
    );

    let state: AuditPage = { items: [], next: null };
    let loadingMore = false;

    const draw = () => {
      if (state.items.length === 0) {
        list.replaceChildren(
          filter.category
            ? empty(`Nothing under "${filter.label}".`, undefined, h("a", { href: "/audit", class: "btn ghost", "data-nav": "replace" }, "Show all"))
            : empty("Nothing has happened yet.", "As soon as Serain does something you do not see in the chat, it shows up here."),
        );
        more.hidden = true;
        return;
      }
      const days: HTMLElement[] = [];
      let current = "";
      let ul: HTMLElement | null = null;
      for (const { item, times } of collapse(state.items)) {
        const at = new Date(item.at);
        const key = dayKey(at);
        if (key !== current || !ul) {
          current = key;
          ul = h("ul", { class: "entries" });
          days.push(h("section", { class: "day", "aria-label": dayLabel(at) }, h("h2", { class: "day-label" }, dayLabel(at)), ul));
        }
        ul.append(row(item, times));
      }
      list.replaceChildren(...days);
      more.hidden = state.next === null;
    };

    const remember = () => loaded.set(filter.category, state);

    const loadMore = async () => {
      if (loadingMore || !state.next) return;
      loadingMore = true;
      more.textContent = "Loading …";
      try {
        const page = await api<AuditPage>(url(filter.category, state.next));
        if (signal.aborted) return;
        state = { items: [...state.items, ...page.items], next: page.next };
        remember();
        draw();
      } finally {
        loadingMore = false;
        more.textContent = "Load older";
      }
    };

    /** New entries that wait because the owner is reading further down; the pill at the top brings them in. */
    let pending: (() => AuditPage) | null = null;
    const pill = h("button", { type: "button", class: "fresh-pill" });
    const freshBar = h("div", { class: "fresh", hidden: true }, pill);
    const reading = () => window.scrollY > 120;

    const apply = (next: () => AuditPage) => {
      pending = null;
      freshBar.hidden = true;
      state = next();
      remember();
      draw();
    };

    /** Fetches the newest page and puts what is new on top; what was already loaded further down stays. */
    const refresh = async () => {
      const page = await load<AuditPage>(url(filter.category));
      if (signal.aborted) return;
      const newest = state.items[0]?.id;
      if (!newest) return apply(() => page);
      const fresh = page.items.filter((item) => BigInt(item.id) > BigInt(newest));
      if (fresh.length === 0) return;
      // More new entries than one page: start over. Built only when applied, in case the owner loaded older ones by then.
      const restart = fresh.length === page.items.length;
      const next = () => (restart ? page : { items: [...fresh, ...state.items], next: state.next });
      // At the top nothing is in the owner's way; further down the text would slide away under them.
      if (!reading()) return apply(next);
      pending = next;
      pill.textContent = restart ? "New entries" : fresh.length === 1 ? "1 new entry" : `${fresh.length} new entries`;
      freshBar.hidden = false;
    };

    pill.addEventListener("click", () => {
      if (pending) apply(pending);
      window.scrollTo(0, 0);
    });
    window.addEventListener("scroll", () => pending && !reading() && apply(pending), { signal, passive: true });

    more.addEventListener("click", () => void loadMore());
    // Load more before the end becomes visible; the button stays for the keyboard and as a fallback.
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && void loadMore(), { rootMargin: "800px 0px" });
    observer.observe(sentinel);
    signal.addEventListener("abort", () => observer.disconnect());
    // Back in the tab: what happened in the meantime is added at the top.
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void refresh().catch(() => undefined), { signal });

    main.replaceChildren(h("div", { class: "page" }, h("header", { class: "page-head" }, h("h1", {}, "Audit")), chips, freshBar, list, sentinel, more));

    const first = url(filter.category);
    const known = loaded.get(filter.category) ?? cached<AuditPage>(first);
    if (known) {
      state = known;
      draw();
      return isFresh(first) ? undefined : refresh();
    }
    list.replaceChildren(skeleton(8));
    return refresh();
  },
};
