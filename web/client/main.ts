import "./zod-jitless.js";
import { startRegistration } from "@simplewebauthn/browser";
import { api, forget, isSignedOut, message, passkeyLogin } from "./api.js";
import { auditPage, prefetchAudit } from "./audit.js";
import { h, icon, type IconName } from "./dom.js";
import { memoryPage, prefetchMemory } from "./memory.js";
import { connectorsPage, prefetchConnectors } from "./connectors.js";
import { busy, button, empty, toast } from "./ui.js";
import { prefetchVault, vaultPage } from "./vault.js";

/**
 * The client of the web interface: frame, router, sign-in. The pages live in
 * audit.ts, memory.ts, vault.ts and connectors.ts. Between pages only the
 * content is swapped; whatever was loaded before shows at once (api.ts).
 */

export interface Page {
  title: string;
  /** Builds the page in `main`. `signal` ends as soon as the owner moves on: observers and listeners hang on it. */
  render(main: HTMLElement, signal: AbortSignal): Promise<void> | void;
}

const ROUTES: Array<{ base: string; label: string; icon: IconName; page: Page; prefetch: () => void }> = [
  { base: "/audit", label: "Audit", icon: "audit", page: auditPage, prefetch: prefetchAudit },
  { base: "/memory", label: "Memory", icon: "memory", page: memoryPage, prefetch: prefetchMemory },
  { base: "/vault", label: "Vault", icon: "vault", page: vaultPage, prefetch: prefetchVault },
  { base: "/connections", label: "Connections", icon: "plug", page: connectorsPage, prefetch: prefetchConnectors },
];

const routeFor = (path: string) => ROUTES.find((route) => path === route.base || path.startsWith(`${route.base}/`));

const root = document.getElementById("root")!;
history.scrollRestoration = "manual";

/* ---------- Sign-in ---------- */

function gateLayout(subtitle: string | null, ...content: HTMLElement[]): HTMLElement {
  return h(
    "main",
    { class: "gate" },
    h("div", { class: "gate-card" }, h("h1", { class: "logo" }, "Serain"), subtitle ? h("p", { class: "gate-sub" }, subtitle) : null, ...content),
  );
}

function gate(): void {
  shell = null;
  scope?.abort();
  forget();
  document.title = "Serain";
  const note = h("p", { class: "gate-note", role: "alert" });
  const login = button("Sign in with passkey", { variant: "primary", class: "large" });
  login.addEventListener("click", () => {
    note.replaceChildren();
    void busy(login, "Waiting for passkey …", passkeyLogin)
      .then(() => render())
      .catch((error: unknown) => note.replaceChildren(message(error)));
  });
  root.replaceChildren(gateLayout(null, login, note));
  login.focus();
}

function enroll(token: string): void {
  const note = h("p", { class: "gate-note", role: "alert" });
  const label = h("input", { type: "text", id: "device", maxlength: "60", placeholder: "e.g. MacBook, iPhone", autocomplete: "off" });
  const submit = h("button", { type: "submit", class: "btn primary large" }, "Set up passkey");
  const form = h("form", { class: "gate-form" }, h("div", { class: "field" }, h("label", { for: "device" }, "Device name"), label), submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    note.replaceChildren();
    void busy(submit, "Waiting for passkey …", async () => {
      const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("/api/enroll/options", { method: "POST", body: { token } });
      const response = await startRegistration({ optionsJSON: options });
      await api("/api/enroll/verify", { method: "POST", body: { token, challengeId, response, label: label.value } });
    })
      .then(() => {
        sessionStorage.removeItem("serain-enroll");
        history.replaceState(null, "", "/audit");
        toast("Passkey set up.");
        render();
      })
      .catch((error: unknown) => note.replaceChildren(message(error)));
  });
  root.replaceChildren(gateLayout("Set up a new passkey for this device.", form, note));
  label.focus();
}

/* ---------- Frame and router ---------- */

let shell: { main: HTMLElement; links: Map<string, HTMLAnchorElement> } | null = null;
let scope: AbortController | null = null;
/** Path and search of the page shown; a mere jump to an #anchor rebuilds nothing. */
let shown = "";

function mountShell(): NonNullable<typeof shell> {
  const links = new Map<string, HTMLAnchorElement>();
  const nav = h(
    "nav",
    { class: "nav", "aria-label": "Sections" },
    ...ROUTES.map((route) => {
      const link = h("a", { href: route.base, class: "nav-link" }, icon(route.icon), h("span", {}, route.label));
      // Load ahead as soon as the pointer is on it: by the click it is usually there.
      link.addEventListener("pointerenter", route.prefetch);
      link.addEventListener("focus", route.prefetch);
      links.set(route.base, link);
      return link;
    }),
  );
  const logout = h("button", { type: "button", class: "nav-link logout" }, icon("logout"), h("span", {}, "Sign out"));
  logout.addEventListener("click", () => {
    void api("/api/logout", { method: "POST" })
      .catch(() => undefined)
      .then(() => {
        history.replaceState(null, "", "/audit");
        gate();
      });
  });
  const main = h("main", { class: "main", id: "main" });
  root.replaceChildren(h("div", { class: "shell" }, h("aside", { class: "sidebar" }, h("a", { href: "/audit", class: "logo", "aria-label": "Serain, go to the audit" }, "Serain"), nav, logout), main));
  return { main, links };
}

function render(): void {
  const route = routeFor(location.pathname);
  if (!route) {
    history.replaceState(null, "", "/audit");
    return render();
  }
  shell ??= mountShell();
  for (const [base, link] of shell.links) {
    if (base === route.base) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.title = `${route.label} · Serain`;
  shown = location.pathname + location.search;

  scope?.abort();
  scope = new AbortController();
  const { signal } = scope;
  const main = shell.main;
  const retry = () => render();
  Promise.resolve()
    .then(() => route.page.render(main, signal))
    .catch((error: unknown) => {
      if (signal.aborted) return;
      if (isSignedOut(error)) return gate();
      // If something was already shown (from the cache), it stays; only the refresh failed.
      if (!main.querySelector(".skeleton")) return toast(message(error));
      const again = button("Try again");
      again.addEventListener("click", retry);
      main.querySelector(".skeleton")!.replaceWith(empty("Could not load.", message(error), again));
    });
}

function navigate(href: string, mode: "push" | "replace"): void {
  if (mode === "push") {
    history.replaceState({ ...(history.state as object | null), scroll: window.scrollY }, "");
    history.pushState(null, "", href);
  } else history.replaceState(history.state, "", href);
  render();
  if (mode === "push") window.scrollTo(0, 0);
}

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest("a") : null;
  if (!link || link.target || link.hasAttribute("download")) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin || !routeFor(url.pathname)) return;
  if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
  event.preventDefault();
  if (url.pathname + url.search === location.pathname + location.search) return;
  navigate(url.pathname + url.search, link.dataset["nav"] === "replace" ? "replace" : "push");
});

window.addEventListener("popstate", () => {
  if (!shell || location.pathname + location.search === shown) return;
  render();
  window.scrollTo(0, (history.state as { scroll?: number } | null)?.scroll ?? 0);
});

/* ---------- Start ---------- */

function boot(): void {
  if (location.pathname === "/enroll") {
    const token = location.hash.slice(1);
    if (token) {
      // The code is only in the fragment: it never reaches a server log, and after reading it is gone from the address bar too.
      sessionStorage.setItem("serain-enroll", token);
      history.replaceState(null, "", "/enroll");
    }
    const stored = sessionStorage.getItem("serain-enroll");
    if (stored) return enroll(stored);
  }
  // No separate session check up front: the page loads its data right away, and a 401 there leads to the sign-in.
  render();
}

boot();
