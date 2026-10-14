import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FUZZ_TIMEOUT_MS, params } from "./helpers.js";
import { discoverTools } from "./tools.js";
import { storedCredentials, testBankConfig } from "./upstream.js";

/**
 * Link previews (addendum D48 of 2026-10-08): Photon's Mac fetches every preview
 * itself, so one may only point to a page that a tool with `opensPages` opened
 * successfully in this task (or the watcher poller for its hit, addendum D48 of
 * 2026-10-10), only `https`, only public, without tracking parameters, at most
 * two per turn. Never a link from mail, calendar, connections or a logged-in
 * session.
 *
 * Generic over every tool in the code and every service in the catalog (D53):
 * each gets its real declaration and a handler that delivers an address as
 * source. The oracle knows the variants the addresses are built from, not the
 * rule in the code.
 */

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
vi.mock("../../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown>) => void audits.push({ event, detail }),
}));
vi.mock("../../src/log.js", async (original) => ({
  ...(await original<typeof import("../../src/log.js")>()),
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
}));

const { ToolRegistry } = await import("../../src/agent/tools/registry.js");
const { TurnState } = await import("../../src/agent/tools/types.js");
const { messagingTools } = await import("../../src/agent/tools/messaging.js");
const { connectorDrivers } = await import("../../src/connectors/drivers/index.js");
const { MAX_LINK_PREVIEWS_PER_TURN } = await import("../../src/config/limits.js");
const { executorTools } = await import("../../src/executor/tools.js");
const { mediaWatcher } = await import("../../src/media/watch.js");
type ToolDefinition = import("../../src/agent/tools/types.js").ToolDefinition;
type ConfirmationGate = import("../../src/agent/tools/registry.js").ConfirmationGate;

async function everyTool(): Promise<ToolDefinition[]> {
  const { defs } = await discoverTools();
  const drivers = connectorDrivers({ clients: { get: async () => null, put: async () => undefined }, enableBanking: testBankConfig() });
  for (const driver of drivers) defs.push(...driver.open({ get: () => storedCredentials(), save: async () => undefined }).tools);
  return defs;
}

const ALL = await everyTool();
const UNTRUSTED = ALL.filter((def) => def.returnsUntrusted);
/** The only tools that open a page themselves. A new one only belongs here after it has been classified. */
const PAGE_OPENERS = ["mac_browser", "media_watch", "web_browse", "web_fetch"];

const approvingGate: ConfirmationGate = {
  covered: async () => true,
  request: async () => ({ ok: true, text: "Preview sent." }),
};

/** A page: host, path, query, scheme. Only `https` on a public host may ever go out as a preview. */
interface Base {
  scheme: "https" | "http";
  host: string;
  path: string;
  query: string;
}

const BASES: Base[] = [
  { scheme: "https", host: "shop.example", path: "/p/1", query: "?v=2" },
  { scheme: "https", host: "news.example", path: "/artikel/zug", query: "" },
  { scheme: "https", host: "www.bahn.example", path: "/auskunft", query: "?von=FRA&nach=BER" },
  { scheme: "http", host: "alt.example", path: "/seite", query: "" },
  { scheme: "https", host: "localhost", path: "/admin", query: "" },
  { scheme: "https", host: "10.0.0.7", path: "/intern", query: "" },
  { scheme: "https", host: "phish.example", path: "/login", query: "?next=%2Fkonto" },
];

const publicHttps = (base: Base) => base.scheme === "https" && base.host !== "localhost" && !/^\d+\.\d+\.\d+\.\d+$/.test(base.host);
const canonical = (base: Base) => `${base.scheme}://${base.host}${base.path}${base.query}`;
const withTracking = (base: Base) => `${canonical(base)}${base.query ? "&" : "?"}utm_source=mail&fbclid=abc`;

/**
 * How the model can write an address. `match`: points to the same page and is backed per the
 * link evidence (addendum D8.4) if the source was opened without tracking.
 */
const VARIANTS = {
  exact: { match: true, make: (b: Base) => canonical(b) },
  slash: { match: true, make: (b: Base) => `${b.scheme}://${b.host}${b.path}/${b.query}` },
  fragment: { match: true, make: (b: Base) => `${canonical(b)}#oben` },
  www: { match: true, make: (b: Base) => `${b.scheme}://${b.host.startsWith("www.") ? b.host.slice(4) : `www.${b.host}`}${b.path}${b.query}` },
  http: { match: true, make: (b: Base) => `http://${b.host}${b.path}${b.query}` },
  otherQuery: { match: false, make: (b: Base) => `${b.scheme}://${b.host}${b.path}?seite=99` },
  otherPath: { match: false, make: (b: Base) => `${b.scheme}://${b.host}${b.path}/anders${b.query}` },
  otherHost: { match: false, make: (b: Base) => `${b.scheme}://x-${b.host}${b.path}${b.query}` },
} as const;
type Variant = keyof typeof VARIANTS;

/** A tool that delivers one of these pages, with or without tracking, with success or without. */
const toolRun = fc.record({
  tool: fc.integer({ min: 0, max: UNTRUSTED.length - 1 }),
  base: fc.integer({ min: 0, max: BASES.length - 1 }),
  tracking: fc.boolean(),
  ok: fc.boolean(),
});

const previewCall = fc.array(
  fc.record({ base: fc.integer({ min: 0, max: BASES.length - 1 }), variant: fc.constantFrom(...(Object.keys(VARIANTS) as Variant[])) }),
  { minLength: 0, maxLength: 3 },
);

function hostile(def: ToolDefinition, result: { ok: boolean; source: string }): ToolDefinition {
  const { consequence: _consequence, ...rest } = def;
  return { ...rest, schema: {}, run: async () => ({ ok: result.ok, text: "Page content", source: result.source }) };
}

function harness() {
  const links: string[] = [];
  const texts: string[] = [];
  const port = {
    canReact: false,
    canReplyInThread: true,
    send: async (text: string) => (texts.push(text), true),
    react: async () => true,
    sendLink: async (url: string) => (links.push(url), true),
  };
  return { links, texts, tools: messagingTools(port) };
}

afterEach(() => {
  audits.length = 0;
});

describe("link preview: who opens pages", () => {
  it("only fetch, browser, Mac browser and videos, no mailbox, no calendar, no connection, no session", () => {
    expect([...new Set(ALL.filter((def) => def.opensPages).map((def) => def.name))].sort()).toEqual(PAGE_OPENERS);
    for (const def of ALL.filter((def) => def.opensPages)) expect(def.returnsUntrusted).toBe(true);
  });

  it.each(UNTRUSTED.map((def, index) => ({ def, key: `${def.name}#${index}` })))(
    "$key: an opened page carries a preview only if the tool opens pages",
    async ({ def }) => {
      const page = "https://shop.example/p/1?v=2";
      const registry = new ToolRegistry(approvingGate).register(hostile(def, { ok: true, source: page }));
      const { links, tools } = harness();
      registry.registerAll(tools);
      const origin = def.ownerOriginOnly ? "owner_message" : (def.origins?.[0] ?? "owner_message");
      const state = new TurnState({ origin, triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: ["m-1"] });
      await registry.execute(def.name, {}, state);
      const sent = await registry.execute("send_message", { text: "Here.", links: [page] }, state);
      expect(sent.ok).toBe(def.opensPages === true);
      expect(links).toEqual(def.opensPages ? [page] : []);
    },
  );
});

/**
 * `media_watch` in both states of the switch `SERAIN_MEDIA_DOWNLOAD`: with it, it opens all four platforms,
 * without it only YouTube, and a link it was not allowed to load never counts as opened. Real watcher, only
 * sandbox, fetch and video model are played.
 */
describe("link preview: media_watch with and without download", () => {
  const VIDEOS = [
    { platform: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    { platform: "tiktok", url: "https://www.tiktok.com/@a/video/1" },
    { platform: "instagram", url: "https://www.instagram.com/reel/ABCDE12345/" },
    { platform: "x", url: "https://x.com/a/status/1" },
  ] as const;

  function watcherTools(downloadsAllowed: boolean) {
    const jobs: string[] = [];
    const framed = (header: unknown, body: Buffer) => Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), body]);
    const sandbox = {
      run: async (request: { job: string }) => {
        jobs.push(request.job);
        const stdout = request.job === "media_fetch" ? framed({ ok: true, parts: [{ bytes: 3, kind: "image" }] }, Buffer.from("jpg")) : Buffer.from("jpg");
        return { exitCode: 0, timedOut: false, truncated: false, stdout, stderr: "" };
      },
    };
    const fetch = async (url: string) => ({ url, status: 200, contentType: "application/json", title: "", text: JSON.stringify({ title: "Title", author_name: "Channel" }), truncated: false });
    const media = mediaWatcher({
      downloads: sandbox,
      downloadsAllowed,
      fetch,
      watchVideo: async () => ({ text: "Something is visible.", truncated: false, model: "m", costUsd: 0 }),
    });
    const defs = executorTools({ guard: ConfidentialGuard.from([]), search: null, media, onFinish: () => undefined }).filter((def) => def.name === "media_watch");
    return { defs, jobs };
  }

  it(
    "there is a preview of a video only if media_watch was allowed to load it in this state",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.boolean(), fc.constantFrom(...VIDEOS), async (allowed, video) => {
          const { defs, jobs } = watcherTools(allowed);
          expect(defs.map((def) => def.opensPages)).toEqual([true]);
          const registry = new ToolRegistry(approvingGate).registerAll(defs);
          const { links, tools } = harness();
          registry.registerAll(tools);
          const state = new TurnState({ origin: "task", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [] });
          const watched = await registry.execute("media_watch", { url: video.url }, state);
          const loads = video.platform === "youtube" || allowed;
          expect(watched.ok, watched.text).toBe(loads);
          if (!loads) expect(watched.text).toContain("SERAIN_MEDIA_DOWNLOAD=1");
          // Without the switch no task reaches the sandbox, not even through the tool.
          if (!allowed) expect(jobs).toEqual([]);
          const sent = await registry.execute("send_message", { text: "Here.", links: [video.url] }, state);
          expect(sent.ok).toBe(loads);
          expect(links).toEqual(loads ? [video.url] : []);
        }),
        params(40),
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe("link preview: random tasks", () => {
  it(
    "sends only opened https pages on public hosts, without tracking, at most two per turn, and never half",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(toolRun, { maxLength: 6 }), fc.array(previewCall, { minLength: 1, maxLength: 4 }), async (runsInTurn, calls) => {
          audits.length = 0;
          const registry = new ToolRegistry(approvingGate);
          const used = new Set<number>();
          for (const run of runsInTurn) used.add(run.tool);
          const sources = new Map<number, typeof runsInTurn>();
          for (const run of runsInTurn) sources.set(run.tool, [...(sources.get(run.tool) ?? []), run]);
          // Every tool registered once; its handler delivers in order what this turn provides.
          for (const index of used) {
            const def = UNTRUSTED[index]!;
            const queue = [...sources.get(index)!];
            const { consequence: _consequence, ...rest } = def;
            registry.register({
              ...rest,
              name: `tool_${index}`,
              schema: {},
              run: async () => {
                const next = queue.shift()!;
                const base = BASES[next.base]!;
                return { ok: next.ok, text: "Content", source: next.tracking ? withTracking(base) : canonical(base) };
              },
            });
          }
          const { links, texts, tools } = harness();
          registry.registerAll(tools);
          // Generous limits: what is tested is the link rule, not the step count.
          const state = new TurnState({ origin: "task", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [], limits: { maxMessages: 20, maxReactions: 0, maxSteps: 100 } });
          for (const run of runsInTurn) await registry.execute(`tool_${run.tool}`, {}, state);

          // Oracle: which pages count as opened, and with which spelling of the source.
          const opened = new Map<number, { tracking: boolean }[]>();
          for (const run of runsInTurn) {
            if (run.ok && UNTRUSTED[run.tool]!.opensPages) opened.set(run.base, [...(opened.get(run.base) ?? []), { tracking: run.tracking }]);
          }
          let previews = 0;
          let expectedLinks: string[] = [];
          for (const call of calls) {
            const before = { links: links.length, texts: texts.length, audits: audits.length };
            const asked = call.map((entry) => VARIANTS[entry.variant].make(BASES[entry.base]!));
            const result = await registry.execute("send_message", { text: `Here ${texts.length}.`, links: asked }, state);
            const targets = call.map((entry) => {
              const base = BASES[entry.base]!;
              const sourced = opened.get(entry.base) ?? [];
              // Backed per D8.4: the page was opened, and the link carries no query that was never opened like that.
              const backed = VARIANTS[entry.variant].match && sourced.length > 0;
              return backed && publicHttps(base) ? canonical(base) : null;
            });
            const unique = [...new Set(targets)];
            const allowed = call.length <= MAX_LINK_PREVIEWS_PER_TURN && targets.every((target) => target !== null) && previews + unique.length <= MAX_LINK_PREVIEWS_PER_TURN;
            expect(result.ok, JSON.stringify({ call, opened: [...opened.keys()], previews, text: result.text })).toBe(allowed);
            if (allowed) {
              previews += unique.length;
              expectedLinks = [...expectedLinks, ...(unique as string[])];
              expect(texts.length).toBe(before.texts + 1);
            } else {
              // Refused means: nothing went out, neither text nor preview, and none of the addresses stands in the audit log.
              expect(texts.length).toBe(before.texts);
              expect(links.length).toBe(before.links);
              const logged = JSON.stringify(audits.slice(before.audits));
              for (const link of asked) expect(logged).not.toContain(link);
            }
          }
          expect(links).toEqual(expectedLinks);
          for (const link of links) expect(link).not.toMatch(/utm_|fbclid|#/);
        }),
        params(300),
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it("[regression] an address with tracking parameters goes out without them, the model's never", async () => {
    const registry = new ToolRegistry(approvingGate);
    const fetchPage = UNTRUSTED.find((def) => def.name === "web_fetch")!;
    registry.register(hostile(fetchPage, { ok: true, source: "https://shop.example/p/1?v=2&utm_source=x&gclid=1#a" }));
    const { links, tools } = harness();
    registry.registerAll(tools);
    const state = new TurnState({ origin: "task", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [] });
    await registry.execute("web_fetch", {}, state);
    expect((await registry.execute("send_message", { text: "There.", links: ["http://www.shop.example/p/1/?v=2"] }, state)).ok).toBe(true);
    expect(links).toEqual(["https://shop.example/p/1?v=2"]);
  });
});

/**
 * The watcher poller as an opener (addendum D48 of 2026-10-10): it is no tool, but hands the hit turn
 * the page it loaded for the hit (`fire`, then `TurnSetup.openedPages`). Exactly that one, after
 * redirects and without tracking, nothing else: not the address from the watcher if the fetch landed
 * elsewhere, nothing for a mail watcher, nothing without a successful fetch.
 */
const { WatchPoller, WATCH_TURN_TOOLS } = await import("../../src/watch/poller.js");
const { sectionHash } = await import("../../src/watch/extract.js");
const { ConfidentialGuard } = await import("../../src/security/confidential.js");
type WatcherRow = import("../../src/watch/types.js").WatcherRow;
type WatcherStore = import("../../src/watch/types.js").WatcherStore;

/** One watcher, one store: a round of the poller needs no more here. */
function oneWatcherStore(row: WatcherRow): WatcherStore {
  const update: WatcherStore["update"] = async (_id, patch) => {
    if (row.status !== "active") return false;
    if (patch.state !== undefined) row.state = structuredClone(patch.state);
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.nextCheckAt !== undefined) row.nextCheckAt = patch.nextCheckAt;
    if (patch.failures !== undefined) row.failures = patch.failures;
    return true;
  };
  return {
    insert: async () => row,
    active: async () => (row.status === "active" ? [structuredClone(row)] : []),
    countActive: async () => (row.status === "active" ? 1 : 0),
    due: async (now) => (row.status === "active" && row.nextCheckAt <= now ? [structuredClone(row)] : []),
    claim: async (_id, expected, lease) => {
      if (row.status !== "active" || row.nextCheckAt !== expected) return false;
      row.nextCheckAt = lease;
      return true;
    },
    update,
    cancel: async () => false,
  };
}

const watchRun = fc.record({
  kind: fc.constantFrom("url_value" as const, "status_changes" as const, "mail_arrives" as const),
  /** The address in the watcher, with or without tracking. */
  base: fc.integer({ min: 0, max: BASES.length - 1 }),
  tracking: fc.boolean(),
  /** Where the fetch ended up after redirects; null means: where it was meant to go. */
  landed: fc.option(fc.integer({ min: 0, max: BASES.length - 1 }), { nil: null }),
  landedTracking: fc.boolean(),
  outcome: fc.constantFrom("ok" as const, "404" as const, "503" as const, "anchor_missing" as const),
});

describe("link preview: the watcher poller opens only the page of its hit", () => {
  it(
    "a hit turn sends only the loaded page, without tracking, only https and public, and nothing for mail watchers",
    async () => {
      await fc.assert(
        fc.asyncProperty(watchRun, fc.array(previewCall, { minLength: 1, maxLength: 4 }), async (run, calls) => {
          audits.length = 0;
          const now = new Date("2026-10-02T12:00:00Z"); // 14:00 in Berlin, no quiet hours
          const base = BASES[run.base]!;
          const specUrl = run.tracking ? withTracking(base) : canonical(base);
          const landedBase = BASES[run.landed ?? run.base]!;
          const landedUrl = run.landedTracking ? withTracking(landedBase) : canonical(landedBase);
          const spec =
            run.kind === "url_value"
              ? { url: specUrl, anchor: "Preis", compare: "changes" }
              : run.kind === "status_changes"
                ? { url: specUrl, anchor: "Status" }
                : { from: "shop" };
          const row: WatcherRow = {
            id: "00000000-0000-4000-8000-000000000001",
            kind: run.kind,
            label: "Test",
            spec,
            state: run.kind === "url_value" ? { value: 129, display: "129,00 €" } : run.kind === "status_changes" ? { hash: "alt", candidateHash: sectionHash(": genehmigt") } : {},
            status: "active",
            nextCheckAt: now.toISOString(),
            lastCheckedAt: null,
            failures: 0,
            expiresAt: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
            createdAt: now.toISOString(),
          };
          const fired: Array<{ incoming: string; taint: string[]; opened: string[] }> = [];
          const poller = new WatchPoller({
            store: oneWatcherStore(row),
            state: { load: async () => ({ hitDay: null, hitCount: 0 }), save: async () => undefined },
            paused: async () => false,
            confidential: async () => ConfidentialGuard.from([]),
            fire: (incoming, taint, opened) => void fired.push({ incoming, taint, opened }),
            fetch: async () => ({
              url: landedUrl,
              status: run.outcome === "404" ? 404 : run.outcome === "503" ? 503 : 200,
              contentType: "text/html",
              title: "",
              text: run.outcome === "anchor_missing" ? "Nichts zu sehen" : "Preis: 89,00 € Status: genehmigt",
              truncated: false,
            }),
            now: () => now,
          });
          // A mail watcher loads no page; the link stands at most in the subject, and that is foreign content.
          if (run.kind === "mail_arrives") {
            await poller.onNewMail("gmx", { id: "gmx:1", from: "Shop <info@shop.example>", subject: `Neu: ${specUrl}`, date: now.toISOString() });
          }
          await poller.maybeRun();

          const loads = run.kind !== "mail_arrives";
          if (loads && run.outcome !== "ok") {
            expect(fired).toEqual([]);
            return;
          }
          expect(fired).toHaveLength(1);
          const hit = fired[0]!;
          // Oracle: opened is the page where the fetch landed, and only for page watchers.
          const openedBase = loads ? (run.landed ?? run.base) : null;
          expect(hit.opened).toEqual(openedBase === null ? [] : [canonical(BASES[openedBase]!)]);

          const { links, texts, tools } = harness();
          const registry = new ToolRegistry(approvingGate).registerAll(tools);
          const state = new TurnState({
            origin: "untrusted",
            triggerExternalId: "",
            triggerMessageId: "",
            reactableIds: [],
            taintSources: hit.taint,
            ...(hit.opened.length > 0 ? { openedPages: hit.opened } : {}),
            toolNames: WATCH_TURN_TOOLS,
            limits: { maxMessages: 20, maxReactions: 0, maxSteps: 100 },
          });
          let previews = 0;
          let expectedLinks: string[] = [];
          for (const call of calls) {
            const before = { links: links.length, texts: texts.length, audits: audits.length };
            const asked = call.map((entry) => VARIANTS[entry.variant].make(BASES[entry.base]!));
            const result = await registry.execute("send_message", { text: `Hit ${texts.length}.`, links: asked }, state);
            const targets = call.map((entry) => {
              const target = BASES[entry.base]!;
              return entry.base === openedBase && VARIANTS[entry.variant].match && publicHttps(target) ? canonical(target) : null;
            });
            const unique = [...new Set(targets)];
            const allowed = call.length <= MAX_LINK_PREVIEWS_PER_TURN && targets.every((target) => target !== null) && previews + unique.length <= MAX_LINK_PREVIEWS_PER_TURN;
            expect(result.ok, JSON.stringify({ run, call, previews, text: result.text })).toBe(allowed);
            if (allowed) {
              previews += unique.length;
              expectedLinks = [...expectedLinks, ...(unique as string[])];
            } else {
              expect(texts.length).toBe(before.texts);
              expect(links.length).toBe(before.links);
              const logged = JSON.stringify(audits.slice(before.audits));
              for (const link of asked) expect(logged).not.toContain(link);
            }
          }
          expect(links).toEqual(expectedLinks);
          for (const link of links) expect(link).not.toMatch(/utm_|fbclid|#/);
        }),
        params(300),
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});
