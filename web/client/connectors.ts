import { CALLBACK_PATH, CONNECTORS, callbackSealName, type ConnectorInfo } from "../../src/connectors/catalog.js";
import { sealTo } from "../../src/vault/sealbox.js";
import { api, cached, forget, isFresh, load, message, withReauth } from "./api.js";
import { h, icon } from "./dom.js";
import type { Page } from "./main.js";
import { busy, button, compactDate, confirmDialog, dialog, skeleton, toast } from "./ui.js";

/**
 * Connections (D51): services whose data Serain may read. The browser starts,
 * the server does the rest; the two only meet in the database. So this page
 * keeps asking while something is on its way.
 *
 * The callback from the provider (`/connections/callback?code=…&state=…`) is
 * sealed here in the browser to the server's public key; the code leaves the
 * address bar at once and never goes to the worker in plain text.
 */

interface ToolSnapshot {
  name: string;
  label: string;
  level: "read" | "write_reversible";
  available: boolean;
}

interface Connection {
  id: string;
  status: "starting" | "authorizing" | "finishing" | "connected" | "failed" | "disconnecting";
  account: string;
  tools: { tools?: ToolSnapshot[]; unlisted?: string[] };
  error: string | null;
  authorize_url: string | null;
  requested_at: string;
  connected_at: string | null;
  expires_at: string | null;
}

interface Connections {
  publicKey: string;
  keyId: string;
  origin: string;
  connections: Connection[];
}

/** Logos, stored by web/build.ts with a hash in the name: service → path. */
declare const __LOGOS__: Record<string, string>;

const PATH = "/api/connectors";
/** Which service is being authorized at the provider right now; the callback does not say so itself. */
const PENDING = "serain-connector";
const BUSY = new Set<Connection["status"]>(["starting", "finishing", "disconnecting"]);
/** How long the page waits for the server before saying it does not answer. */
const SERVER_PATIENCE_MS = 20_000;

export const prefetchConnectors = () => void load(PATH).catch(() => undefined);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fresh(): Promise<Connections> {
  forget(PATH);
  return load<Connections>(PATH);
}

/** Keeps asking until the connection leaves the state in which the server is working. */
async function settle(id: string, from: Connection["status"], timeoutMs = 45_000): Promise<Connection | undefined> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const row = (await fresh()).connections.find((entry) => entry.id === id);
    if (!row || row.status !== from || Date.now() > until) return row;
    await pause(1000);
  }
}

const expired = (row: Connection) => row.status === "connected" && row.expires_at !== null && Date.parse(row.expires_at) < Date.now();

function statusText(row: Connection | undefined): { text: string; tone: "ok" | "busy" | "bad" | "off" } {
  if (!row) return { text: "Not connected", tone: "off" };
  if (expired(row)) return { text: "Authorization expired", tone: "bad" };
  switch (row.status) {
    case "connected":
      return { text: "Connected", tone: "ok" };
    case "starting":
      return { text: "Serain is preparing the authorization …", tone: "busy" };
    case "authorizing":
      return { text: "Waiting for your approval at the provider", tone: "busy" };
    case "finishing":
      return { text: "Serain is redeeming the authorization …", tone: "busy" };
    case "disconnecting":
      return { text: "Disconnecting …", tone: "busy" };
    case "failed":
      return { text: "Not connected", tone: "bad" };
  }
}

async function finish(data: Connections, id: string, params: URLSearchParams): Promise<void> {
  const state = params.get("state") ?? "";
  const error = params.get("error");
  const code = params.get("code") ?? "";
  if (!state || (!error && !code)) throw new Error("The address is missing code and state.");
  const body = error
    ? { state, error: params.get("error_description") ?? error }
    : { state, sealed: await sealTo(data.publicKey, callbackSealName(id), { code, state }) };
  await api(`/api/connectors/${id}/finish`, { method: "POST", body });
  sessionStorage.removeItem(PENDING);
}

/**
 * Providers with a fixed registered redirect address (`fixedRedirect`, bank)
 * always send back to the public origin (SERAIN_WEB_ORIGIN, the only one with
 * https). When the web interface runs locally, the owner lands there after
 * authorizing and brings the address back by hand.
 */
const pastesReturn = (info: ConnectorInfo) => info.fixedRedirect === true && location.protocol !== "https:";

function pasteDialog(info: ConnectorInfo, data: Connections, authorizeUrl: string, done: () => void): void {
  const input = h("input", { type: "url", id: "f-return", inputmode: "url", autocomplete: "off", spellcheck: "false", placeholder: `https://…${CALLBACK_PATH}?code=…` });
  const error = h("p", { class: "form-error", role: "alert" });
  const go = button([icon("external"), `Go to ${info.name}`], { variant: "ghost" });
  go.addEventListener("click", () => window.open(authorizeUrl, "_blank", "noopener,noreferrer"));
  const submit = h("button", { type: "submit", class: "btn primary" }, "Finish");
  const form = h(
    "form",
    { class: "form", novalidate: true },
    h(
      "ol",
      { class: "steps" },
      h("li", {}, `Approve at ${info.name}. Afterwards you land on the public address of the web interface; the page does not need to load.`),
      h("li", {}, "Copy the whole address from the address bar and paste it here."),
    ),
    h("div", { class: "field" }, h("label", { for: "f-return" }, "Address after approving"), input),
    h("div", { class: "dialog-foot" }, error, go, submit),
  );
  const { close } = dialog(`Connect ${info.name}`, [form], { onClose: done });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.replaceChildren();
    let params: URLSearchParams;
    try {
      params = new URL(input.value.trim()).searchParams;
    } catch {
      error.replaceChildren(icon("alert"), "That is not an address.");
      return;
    }
    void busy(submit, "Sealing …", () => finish(data, info.id, params))
      .then(close)
      .catch((err: unknown) => error.replaceChildren(icon("alert"), message(err)));
  });
  go.focus();
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** `open` remembers which lists the owner expanded; they stay open when redrawing. */
function toolList(info: ConnectorInfo, row: Connection | undefined, open: Set<string>): HTMLElement {
  const snapshot = row?.status === "connected" ? row.tools : {};
  const tools: ToolSnapshot[] = snapshot.tools ?? info.tools.map((tool) => ({ ...tool, available: true }));
  const unlisted = snapshot.unlisted ?? [];
  const missing = tools.filter((tool) => !tool.available).length;
  const writes = tools.filter((tool) => tool.level !== "read").length;
  const details = h(
    "details",
    { class: "conn-tools", open: open.has(info.id) },
    h(
      "summary",
      {},
      icon("chevron", "icon chevron"),
      h("span", {}, plural(tools.length, "tool", "tools")),
      h("span", { class: "conn-tally" }, writes > 0 ? `${tools.length - writes} read, ${writes} write` : "read only"),
    ),
    missing > 0 ? h("p", { class: "conn-note" }, `Struck through: ${info.name} does not offer it right now.`) : null,
    h(
      "ul",
      {},
      ...tools.map((tool) =>
        h(
          "li",
          tool.available ? {} : { class: "is-missing", title: "The service does not offer this right now" },
          h("span", {}, tool.label),
          h("span", { class: "chip", title: tool.level === "read" ? "Read only" : "Writes, only on your instruction" }, tool.level === "read" ? "reads" : "writes"),
          tool.available ? null : h("span", { class: "sr-only" }, "(the service does not offer this right now)"),
        ),
      ),
    ),
    unlisted.length > 0 ? h("p", { class: "conn-note" }, `Serain does not get ${plural(unlisted.length, "other tool", "other tools")} of the service.`) : null,
  );
  details.addEventListener("toggle", () => (details.open ? open.add(info.id) : open.delete(info.id)));
  return details;
}

function logo(info: ConnectorInfo): HTMLElement {
  const src = __LOGOS__[info.id];
  if (src) return h("img", { class: "conn-logo", src, alt: "", width: "44", height: "44", decoding: "async" });
  return h("span", { class: "conn-logo is-blank", "aria-hidden": "true" }, info.name.slice(0, 1));
}

export const connectorsPage: Page = {
  title: "Connections",
  async render(main, signal) {
    const body = h("div");
    const tally = h("p", { class: "page-tally" });
    main.replaceChildren(h("div", { class: "page" }, h("header", { class: "page-head" }, h("h1", {}, "Connections"), tally), body));

    /** The service from whose authorization the owner is just returning. */
    let returning: string | undefined;
    // Callback from the provider: code out of the address bar at once, then sealed to the server.
    if (location.pathname === CALLBACK_PATH) {
      const params = new URLSearchParams(location.search);
      history.replaceState(null, "", "/connections");
      body.replaceChildren(skeleton(3));
      const data = await fresh();
      const id = sessionStorage.getItem(PENDING) ?? data.connections.find((row) => row.status === "authorizing")?.id;
      returning = id;
      if (!id) toast("No authorization is running for this callback. Please connect again.");
      else await finish(data, id, params).catch((error: unknown) => toast(message(error)));
      // The state from before the callback no longer counts: now the server redeems.
      forget(PATH);
    }

    let polling = false;
    const poll = () => {
      if (polling || signal.aborted) return;
      polling = true;
      void pause(1500)
        .then(() => (signal.aborted ? null : fresh()))
        .then((data) => {
          polling = false;
          if (data && !signal.aborted) draw(data);
        })
        .catch(() => {
          polling = false;
        });
    };

    /*
     * While the server is working, the page asks every 1.5 s. Only what changed
     * is redrawn; expanded lists stay open, and a button that is running keeps
     * running even when another card changes.
     */
    const openTools = new Set<string>();
    const working = new Set<string>();
    const statuses = new Map<string, Connection["status"]>();
    let last: Connections | null = null;
    let shown = "";

    const draw = (data: Connections) => {
      last = data;
      const rows = new Map(data.connections.map((row) => [row.id, row]));
      const stale = data.connections.filter((row) => row.status === "starting" && Date.now() - Date.parse(row.requested_at) > SERVER_PATIENCE_MS).map((row) => row.id);
      const key = JSON.stringify([data, stale, [...working]]);
      if (key === shown) {
        if (data.connections.some((row) => BUSY.has(row.status))) poll();
        return;
      }
      shown = key;
      const before = new Map(statuses);
      statuses.clear();
      for (const row of data.connections) statuses.set(row.id, row.status);
      const live = CONNECTORS.filter((info) => rows.get(info.id)?.status === "connected").length;
      tally.textContent = `${live} of ${CONNECTORS.length} connected`;
      body.replaceChildren(
        h(
          "ul",
          { class: "conn-list" },
          ...CONNECTORS.map((info) => {
            const row = rows.get(info.id);
            const status = statusText(row);
            const actions = h("div", { class: "conn-actions" });
            const lines: Array<HTMLElement | null> = [];

            if (row?.status === "connected") {
              const facts = [row.account, row.connected_at ? `since ${compactDate(new Date(row.connected_at))}` : "", row.expires_at && !expired(row) ? `valid until ${compactDate(new Date(row.expires_at))}` : ""].filter(Boolean).join(" · ");
              lines.push(
                h(
                  "p",
                  { class: "conn-meta" },
                  facts,
                  info.manageUrl ? h("a", { href: info.manageUrl, target: "_blank", rel: "noopener noreferrer" }, `View at ${info.name}`) : null,
                ),
              );
            }
            if (row?.status === "failed" && row.error) lines.push(h("p", { class: "conn-error" }, icon("alert"), row.error));
            if (stale.includes(info.id)) {
              lines.push(h("p", { class: "conn-error" }, icon("alert"), "Serain does not answer. Is the server running, with SERAIN_VAULT_KEY and SERAIN_INTEGRATION_KEY?"));
            }

            const connect = button(row && (row.status === "failed" || expired(row)) ? "Reconnect" : "Connect", { variant: "primary", class: "small" });
            connect.addEventListener("click", () => {
              working.add(info.id);
              if (last) draw(last);
              void (async () => {
                await withReauth(() => api(`/api/connectors/${info.id}/start`, { method: "POST" }));
                sessionStorage.setItem(PENDING, info.id);
                const next = await settle(info.id, "starting");
                if (next?.status === "authorizing" && next.authorize_url) {
                  if (pastesReturn(info)) {
                    pasteDialog(info, data, next.authorize_url, () => void fresh().then(draw).catch(() => undefined));
                  } else location.assign(next.authorize_url);
                }
              })()
                .catch((error: unknown) => toast(message(error)))
                .finally(() => {
                  working.delete(info.id);
                  void fresh().then((d) => !signal.aborted && draw(d)).catch(() => undefined);
                });
            });

            const disconnect = button(row?.status === "connected" ? "Disconnect" : "Cancel", { variant: "quiet", class: "small" });
            disconnect.addEventListener("click", () =>
              confirmDialog({
                title: row?.status === "connected" ? `Disconnect ${info.name}?` : `Cancel connecting ${info.name}?`,
                text: row?.status === "connected" ? "Serain revokes the access at the provider and deletes what it stored for it. You can connect again at any time." : "The started authorization lapses.",
                confirm: row?.status === "connected" ? `Disconnect ${info.name}` : "Cancel connecting",
                run: async () => {
                  await withReauth(() => api(`/api/connectors/${info.id}/disconnect`, { method: "POST" }));
                  if (row?.status === "connected") await settle(info.id, "disconnecting", 20_000);
                  toast(row?.status === "connected" ? `${info.name} is disconnected.` : "Cancelled.");
                  draw(await fresh());
                },
              }),
            );

            if (working.has(info.id)) {
              actions.append(h("button", { type: "button", class: "btn primary small", disabled: true, "aria-busy": "true" }, h("span", { class: "spinner", "aria-hidden": "true" }), "One moment …"));
            } else if (!row || row.status === "failed" || expired(row)) actions.append(connect);
            if (row?.status === "authorizing" && row.authorize_url) {
              const resume = button("Continue to authorization", { variant: "primary", class: "small" });
              const url = row.authorize_url;
              resume.addEventListener("click", () => {
                sessionStorage.setItem(PENDING, info.id);
                if (pastesReturn(info)) pasteDialog(info, data, url, () => void fresh().then(draw).catch(() => undefined));
                else location.assign(url);
              });
              actions.append(resume);
            }
            if (!working.has(info.id) && row && (row.status === "connected" || row.status === "authorizing" || row.status === "starting")) actions.append(disconnect);
            // Just connected while the owner is watching (or just back from authorizing): the dot fills once.
            const was = before.get(info.id) ?? (info.id === returning ? "finishing" : undefined);
            const justConnected = row?.status === "connected" && !expired(row) && was !== undefined && was !== "connected";

            return h(
              "li",
              { class: `conn is-${status.tone}${justConnected ? " just-connected" : ""}` },
              h(
                "div",
                { class: "conn-head" },
                logo(info),
                h(
                  "div",
                  { class: "conn-title" },
                  h("h2", { class: "conn-name" }, info.name),
                  h("p", { class: "conn-status" }, status.tone === "busy" ? h("span", { class: "spinner", "aria-hidden": "true" }) : h("span", { class: "conn-dot", "aria-hidden": "true" }), status.text),
                ),
                actions,
              ),
              h("p", { class: "conn-summary" }, info.summary),
              ...lines,
              info.validity && row?.status !== "connected" ? h("p", { class: "conn-note" }, info.validity) : null,
              toolList(info, row, openTools),
            );
          }),
        ),
      );
      if (data.connections.some((row) => BUSY.has(row.status))) poll();
    };

    const known = cached<Connections>(PATH);
    if (known) draw(known);
    else if (!body.firstChild) body.replaceChildren(skeleton(3));
    if (known && isFresh(PATH)) return;
    const data = await load<Connections>(PATH);
    if (!signal.aborted) draw(data);
  },
};
