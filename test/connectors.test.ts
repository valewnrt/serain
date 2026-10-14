import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FAKE_ORIGIN, fakeProvider, type FakeProvider } from "./connectors.fake.js";

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
vi.mock("../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown>) => void audits.push({ event, detail }),
}));

// The core's own catalog; an instance's services run through the fuzz harness (test/fuzz/connectors.test.ts).
vi.mock("@instance/catalog.js", () => ({ connectors: [] }));
vi.mock("@instance/server.js", () => ({ server: {} }));

/**
 * A made-up service over MCP with OAuth that can also write: no service in the
 * real catalog does, but the rules for it (clean turn only, on instruction
 * only) still apply and are checked here.
 */
vi.mock("../src/connectors/catalog.js", async (original) => {
  const real = await original<typeof import("../src/connectors/catalog.js")>();
  const tagebuch = {
    id: "tagebuch",
    name: "Tagebuch",
    summary: "Ein Ernährungstagebuch zum Testen.",
    tools: [
      { name: "tagebuch_day", label: "Ein Tag", level: "read" },
      { name: "tagebuch_weight_history", label: "Gewichtsverlauf", level: "read" },
      { name: "tagebuch_log_meal", label: "Mahlzeit eintragen", level: "write_reversible" },
    ],
  } as const;
  const all = [...real.CONNECTORS, tagebuch];
  return { ...real, connectorInfo: (id: string) => all.find((info) => info.id === id) };
});

const { ConnectorService } = await import("../src/connectors/service.js");
const { mcpOAuthDriver } = await import("../src/connectors/drivers/mcp-oauth.js");
const { remoteTool } = await import("../src/connectors/tools.js");
const { COROS_TOOLS, corosDriver } = await import("../src/connectors/drivers/coros.js");
const { BANK_TOOLS, enableBankingDriver } = await import("../src/connectors/drivers/enable-banking.js");
const { CONNECTORS, webOrigins, callbackUrl } = await import("../src/connectors/catalog.js");
const { discover, OAuthError } = await import("../src/connectors/oauth.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { generateVaultKeyPair, loadVaultKey, sealTo } = await import("../src/vault/sealbox.js");
const { open } = await import("../src/integrations/seal.js");
const { DataSources } = await import("../src/datasets/sources.js");
import type { ConnectorDriver } from "../src/connectors/types.js";
type ConnectorRow = import("../src/connectors/service.js").ConnectorRow;
type ConnectorStore = import("../src/connectors/service.js").ConnectorStore;
type TurnOrigin = import("../src/agent/tools/types.js").TurnOrigin;

const SEAL_KEY = randomBytes(32);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** `connectors` in memory, with the same transitions as src/db/connectors.ts. */
function memoryStore() {
  const rows = new Map<string, ConnectorRow & { account?: string; tools?: unknown; authorizeUrl?: string | null }>();
  const clients = new Map<string, string>();
  const move = (id: string, from: ConnectorRow["status"], values: Partial<ConnectorRow> & Record<string, unknown>) => {
    const row = rows.get(id);
    if (!row || row.status !== from) return false;
    rows.set(id, { ...row, ...values });
    return true;
  };
  const store: ConnectorStore = {
    work: async (cutoff) => [...rows.values()].filter((row) => ["starting", "finishing", "disconnecting"].includes(row.status) || (row.status === "authorizing" && row.requestedAt < cutoff)),
    connected: async () => [...rows.values()].filter((row) => row.status === "connected"),
    status: async (id) => rows.get(id)?.status ?? null,
    authorizing: async (id, input) => move(id, "starting", { status: "authorizing", authorizeUrl: input.authorizeUrl, stateHash: input.stateHash, pending: input.pending }),
    connect: async (id, input) => move(id, "finishing", { status: "connected", sealed: input.sealed, account: input.account, tools: input.tools, expiresAt: input.expiresAt, pending: null, callback: null }),
    fail: async (id, from, message) => move(id, from, { status: "failed", error: message }),
    saveCredentials: async (id, sealed) => move(id, "connected", { sealed }),
    saveTools: async (id, tools) => move(id, "connected", { tools }),
    remove: async (id) => void (rows.get(id)?.status === "disconnecting" && rows.delete(id)),
    client: async (issuer, redirect) => clients.get(`${issuer} ${redirect}`) ?? null,
    saveClient: async (issuer, redirect, sealed) => void clients.set(`${issuer} ${redirect}`, sealed),
  };
  const request = (id: string, origin = "http://localhost:8787") =>
    rows.set(id, { id, status: "starting", origin, stateHash: null, pending: null, callback: null, sealed: null, requestedAt: new Date(), expiresAt: null });
  return { rows, clients, store, request };
}

const TAGEBUCH_TOOLS = [
  remoteTool({ name: "tagebuch_day", remote: "get_day", description: "A day in the diary.", schema: { date: z.string() } }),
  remoteTool({ name: "tagebuch_weight_history", remote: "get_weight_history", description: "Weight history.", schema: {} }),
  remoteTool({
    name: "tagebuch_log_meal",
    remote: "log_meal",
    description: "Log a meal.",
    schema: { description: z.string(), date: z.string(), meal_type: z.string() },
  }),
];

const tagebuchDriver = (clients: Parameters<typeof mcpOAuthDriver>[1]["clients"], fetcher: typeof fetch) =>
  mcpOAuthDriver({ id: "tagebuch", url: `${FAKE_ORIGIN}/mcp`, issuer: FAKE_ORIGIN, scope: "", tools: TAGEBUCH_TOOLS, promptLine: "tagebuch" }, { clients, fetch: fetcher });

const turn = (origin: TurnOrigin = "owner_message") => new TurnState({ origin, triggerExternalId: "", triggerMessageId: "", reactableIds: [] });

describe("catalog and drivers (D51)", () => {
  it("know the same tools, with levels from the catalog", () => {
    const clients = { get: async () => null, put: async () => undefined };
    expect(() => corosDriver({ clients })).not.toThrow();
    expect(() => enableBankingDriver(null, { id: "bank" })).not.toThrow();
    const specs: Record<string, readonly { name: string }[]> = { coros: COROS_TOOLS, bank: BANK_TOOLS };
    expect(CONNECTORS.map((info) => info.id).sort()).toEqual(Object.keys(specs).sort());
    for (const info of CONNECTORS) expect(info.tools.map((tool) => tool.name).sort(), info.id).toEqual(specs[info.id]!.map((spec) => spec.name).sort());
  });

  it("let nothing delete and COROS and the bank only read", () => {
    const levels = CONNECTORS.flatMap((info) => info.tools.map((tool) => [info.id, tool.name, tool.level] as const));
    expect(levels.filter(([, , level]) => level !== "read")).toEqual([]);
  });

  it("send Alex back only to origins from the list", () => {
    const origins = webOrigins("https://serain.example.com");
    expect(callbackUrl("http://localhost:8787", origins)).toBe("http://localhost:8787/connections/callback");
    expect(callbackUrl("https://serain.example.com", origins)).toBe("https://serain.example.com/connections/callback");
    expect(() => callbackUrl("https://evil.example", origins)).toThrow();
    expect(webOrigins(null)).toEqual(["http://localhost:8787"]);
    expect(() => callbackUrl("https://serain.example.com", webOrigins(null))).toThrow();
  });

  it("refuse a service or a tool of the instance that is already in the catalog", async () => {
    const { withInstance } = await import("../src/connectors/catalog.js");
    const own = { id: "diary", name: "Diary", summary: "x", tools: [{ name: "diary_day", label: "Day", level: "read" as const }] };
    expect(withInstance(CONNECTORS, [own]).map((info) => info.id)).toEqual([...CONNECTORS.map((info) => info.id), "diary"]);
    expect(() => withInstance(CONNECTORS, [{ ...own, id: "coros" }])).toThrow(/coros/);
    expect(() => withInstance(CONNECTORS, [{ ...own, tools: [{ name: "bank_balance", label: "x", level: "read" }] }])).toThrow(/bank_balance/);
  });

  it("have only the bank with a fixed redirect address and no address in the catalog", () => {
    expect(CONNECTORS.filter((info) => info.fixedRedirect).map((info) => info.id)).toEqual(["bank"]);
    expect(JSON.stringify(CONNECTORS)).not.toMatch(/https:\/\/(?!mcp)/);
  });
});

describe("OAuth: the issuer is fixed", () => {
  let provider: FakeProvider;
  beforeEach(async () => {
    provider = await fakeProvider();
  });
  afterEach(() => provider.close());

  it("finds the endpoints through the MCP server", async () => {
    const server = await discover(provider.fetch, `${FAKE_ORIGIN}/mcp`, FAKE_ORIGIN);
    expect(server.tokenEndpoint).toBe(`${FAKE_ORIGIN}/token`);
    expect(server.revocationEndpoint).toBe(`${FAKE_ORIGIN}/revoke`);
  });

  it("aborts when the MCP server or the metadata names a different issuer", async () => {
    await expect(discover(provider.fetch, `${FAKE_ORIGIN}/mcp`, "https://anderer.test")).rejects.toThrow(OAuthError);
    provider.impersonate("https://boese.test");
    await expect(discover(provider.fetch, `${FAKE_ORIGIN}/mcp`, FAKE_ORIGIN)).rejects.toThrow(/different issuer/);
  });

  it("does not speak http", async () => {
    await expect(discover(provider.fetch, `http://127.0.0.1:${provider.port}/mcp`, `http://127.0.0.1:${provider.port}`)).rejects.toThrow();
  });
});

describe("connect, use, disconnect", () => {
  let provider: FakeProvider;
  let mem: ReturnType<typeof memoryStore>;
  let registry: InstanceType<typeof ToolRegistry>;
  let service: InstanceType<typeof ConnectorService>;
  let keys: { publicKey: string; privateKey: string };
  let changes = 0;

  let data: InstanceType<typeof DataSources>;

  /** A driver that additionally offers data for analyze_data (D63). */
  function withDataset(driver: ConnectorDriver): ConnectorDriver {
    return {
      ...driver,
      open: (credentials) => ({
        ...driver.open(credentials),
        datasets: [{ name: "tagebuch_tasks", fields: "tasks", load: async () => ({ rows: [{ title: "a" }], truncated: false }) }],
      }),
    };
  }

  beforeEach(async () => {
    audits.length = 0;
    changes = 0;
    data = new DataSources();
    provider = await fakeProvider();
    mem = memoryStore();
    registry = new ToolRegistry();
    keys = await generateVaultKeyPair();
    service = new ConnectorService({
      store: mem.store,
      sealKey: SEAL_KEY,
      vaultKey: () => loadVaultKey(keys.privateKey),
      drivers: (clients) => [withDataset(tagebuchDriver(clients, provider.fetch))],
      tools: { add: (defs) => void registry.registerAll(defs), remove: (names) => registry.unregister(names) },
      data,
      onChange: () => void (changes += 1),
    });
  });
  afterEach(async () => {
    await service.stop();
    await provider.close();
  });

  /** What browser and database function do on the callback. */
  async function returnFromProvider(id: string, override?: { state?: string }) {
    const row = mem.rows.get(id)!;
    const back = provider.authorize(row.authorizeUrl!);
    const state = override?.state ?? back.state;
    expect(sha256(back.state)).toBe(row.stateHash);
    mem.rows.set(id, { ...row, status: "finishing", callback: await sealTo(keys.publicKey, `connector:${id}`, { code: back.code, state }) });
    return back;
  }

  async function connectTagebuch() {
    mem.request("tagebuch");
    await service.tick();
    expect(mem.rows.get("tagebuch")?.status).toBe("authorizing");
    const back = await returnFromProvider("tagebuch");
    await service.tick();
    return back;
  }

  it("connects with PKCE, sees only our tools and seals the tokens", async () => {
    const back = await connectTagebuch();
    expect(back.redirect).toBe("http://localhost:8787/connections/callback");
    const row = mem.rows.get("tagebuch")!;
    expect(row.status).toBe("connected");
    expect(provider.seen.registrations).toHaveLength(1);
    expect(provider.seen.registrations[0]).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: [back.redirect] });
    expect(provider.seen.tokenRequests[0]).toMatchObject({ grant_type: "authorization_code", resource: `${FAKE_ORIGIN}/mcp` });
    expect(row.sealed).toMatch(/^v1\./);
    expect(row.sealed).not.toContain("at-");
    expect((open(SEAL_KEY, row.sealed!) as { accessToken: string }).accessToken).toMatch(/^at-/);
    const snapshot = row.tools as { tools: Array<{ name: string; available: boolean }>; unlisted: string[] };
    expect(snapshot.tools.filter((tool) => tool.available).map((tool) => tool.name).sort()).toEqual(["tagebuch_day", "tagebuch_log_meal"]);
    expect(snapshot.unlisted).toEqual(["secret_admin_tool"]);
    expect(registry.get("tagebuch_day")).toBeDefined();
    expect(registry.list().map((def) => def.name)).not.toContain("secret_admin_tool");
    expect(service.promptLines()).toEqual(["tagebuch"]);
    expect(changes).toBe(1);
    expect(audits.map((entry) => entry.event)).toContain("connector_connected");
    expect(JSON.stringify(audits)).not.toMatch(/at-|rt-|code-/);
  });

  it("registers only once for the same redirect address", async () => {
    await connectTagebuch();
    mem.rows.set("tagebuch", { ...mem.rows.get("tagebuch")!, status: "starting", requestedAt: new Date() });
    await service.tick();
    expect(provider.seen.registrations).toHaveLength(1);
  });

  it("delivers results as untrusted content without writing them to the audit, and renews expired tokens", async () => {
    await connectTagebuch();
    const t = turn();
    const result = await registry.execute("tagebuch_day", { date: "2026-10-03" }, t);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('<untrusted source="Tagebuch">');
    expect(t.tainted).toBe(true);
    const call = audits.find((entry) => entry.event === "tool_call");
    expect(JSON.stringify(call)).not.toContain("1800 kcal");

    const before = mem.rows.get("tagebuch")!.sealed;
    provider.expireAccessTokens();
    const again = await registry.execute("tagebuch_day", { date: "2026-10-02" }, turn());
    expect(again.ok).toBe(true);
    expect(provider.seen.tokenRequests.map((form) => form.grant_type)).toEqual(["authorization_code", "refresh_token"]);
    expect(mem.rows.get("tagebuch")!.sealed).not.toBe(before);
  });

  it("writes only on Alex's instruction in a clean turn", async () => {
    await connectTagebuch();
    const args = { description: "zwei Eier", date: "2026-10-03", meal_type: "breakfast" };
    const tainted = turn();
    await registry.execute("tagebuch_day", { date: "2026-10-03" }, tainted);
    expect((await registry.execute("tagebuch_log_meal", args, tainted)).ok).toBe(false);
    expect((await registry.execute("tagebuch_log_meal", args, turn("heartbeat"))).ok).toBe(false);
    expect((await registry.execute("tagebuch_log_meal", args, turn("task"))).ok).toBe(false);
    const clean = await registry.execute("tagebuch_log_meal", args, turn());
    expect(clean.ok).toBe(true);
    expect(clean.text).toContain("Eingetragen: zwei Eier");
  });

  it("reports a tool the provider no longer has as an error instead of guessing", async () => {
    await connectTagebuch();
    const result = await registry.execute("tagebuch_weight_history", {}, turn());
    expect(result.ok).toBe(false);
  });

  it("disconnects immediately: no more calls, revocation at the provider, everything deleted", async () => {
    await connectTagebuch();
    const refreshToken = (open(SEAL_KEY, mem.rows.get("tagebuch")!.sealed!) as { refreshToken: string }).refreshToken;
    mem.rows.set("tagebuch", { ...mem.rows.get("tagebuch")!, status: "disconnecting" });
    const blocked = await registry.execute("tagebuch_day", { date: "2026-10-03" }, turn());
    expect(blocked.ok).toBe(false);
    expect(blocked.text).toContain("disconnected");
    expect(registry.get("tagebuch_day")).toBeUndefined();
    await service.tick();
    expect(mem.rows.has("tagebuch")).toBe(false);
    expect(provider.seen.revoked).toEqual([refreshToken]);
    expect(audits.find((entry) => entry.event === "connector_disconnected")?.detail).toMatchObject({ id: "tagebuch", revoked: true });
  });

  it("gives data only while connected, like the tools (D63)", async () => {
    await connectTagebuch();
    const source = data.get("tagebuch_tasks")!;
    const range = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-02T00:00:00Z") };
    expect((await source.load(range)).rows).toEqual([{ title: "a" }]);
    mem.rows.set("tagebuch", { ...mem.rows.get("tagebuch")!, status: "disconnecting" });
    await expect(source.load(range)).rejects.toThrow(/disconnected/);
    expect(data.get("tagebuch_tasks")).toBeUndefined();
    expect(registry.get("tagebuch_day")).toBeUndefined();
  });

  it("refuses a callback with a foreign state", async () => {
    mem.request("tagebuch");
    await service.tick();
    await returnFromProvider("tagebuch", { state: "x".repeat(43) });
    await service.tick();
    expect(mem.rows.get("tagebuch")).toMatchObject({ status: "failed", error: "The callback does not match this authorization." });
    expect(provider.seen.tokenRequests).toHaveLength(0);
  });

  it("does not start when the web interface comes from a foreign origin", async () => {
    mem.request("tagebuch", "https://evil.example");
    await service.tick();
    expect(mem.rows.get("tagebuch")).toMatchObject({ status: "failed" });
    expect(provider.seen.registrations).toHaveLength(0);
  });

  it("expires an authorization after 15 minutes", async () => {
    mem.request("tagebuch");
    await service.tick();
    mem.rows.set("tagebuch", { ...mem.rows.get("tagebuch")!, requestedAt: new Date(Date.now() - 16 * 60_000) });
    await service.tick();
    expect(mem.rows.get("tagebuch")?.status).toBe("failed");
  });

  it("returns tokens that still arrived after disconnecting", async () => {
    mem.request("tagebuch");
    await service.tick();
    await returnFromProvider("tagebuch");
    const store = mem.store;
    const connect = store.connect;
    store.connect = async (id, input) => {
      mem.rows.set(id, { ...mem.rows.get(id)!, status: "disconnecting" });
      return connect(id, input);
    };
    await service.tick();
    expect(provider.seen.revoked).toHaveLength(1);
    expect(registry.get("tagebuch_day")).toBeUndefined();
  });

  it("loads existing connections at startup", async () => {
    await connectTagebuch();
    const sealed = mem.rows.get("tagebuch")!.sealed;
    await service.stop();
    expect(registry.get("tagebuch_day")).toBeUndefined();
    const next = new ConnectorService({
      store: mem.store,
      sealKey: SEAL_KEY,
      vaultKey: () => loadVaultKey(keys.privateKey),
      drivers: (clients) => [tagebuchDriver(clients, provider.fetch)],
      tools: { add: (defs) => void registry.registerAll(defs), remove: (names) => registry.unregister(names) },
      onChange: () => undefined,
    });
    await next.start();
    expect(mem.rows.get("tagebuch")!.sealed).toBe(sealed);
    expect((await registry.execute("tagebuch_day", { date: "2026-10-03" }, turn())).ok).toBe(true);
    await next.stop();
  });
});

describe("fixed redirect address (bank) and SERAIN_WEB_ORIGIN", () => {
  /** A bank driver without network that only records where the provider should send back to. */
  function recordingBank(seen: string[]): ConnectorDriver {
    return {
      id: "bank",
      promptLine: "bank",
      begin: async ({ redirectUri }) => {
        seen.push(redirectUri);
        return { authorizeUrl: "https://bank.test/auth", pending: {} };
      },
      complete: async () => {
        throw new Error("not needed");
      },
      open: () => ({ tools: [], snapshot: async () => ({ tools: [], unlisted: [] }), close: async () => undefined }),
      revoke: async () => null,
    };
  }

  function bankService(publicOrigin: string | null, seen: string[]) {
    const mem = memoryStore();
    const service = new ConnectorService({
      store: mem.store,
      sealKey: SEAL_KEY,
      vaultKey: async () => {
        throw new Error("not needed");
      },
      drivers: () => [recordingBank(seen)],
      tools: { add: () => undefined, remove: () => undefined },
      onChange: () => undefined,
      audit: async () => undefined,
      publicOrigin,
    });
    return { mem, service };
  }

  it("sends back to the public origin even from the local web interface", async () => {
    const seen: string[] = [];
    const { mem, service } = bankService("https://serain.example.com", seen);
    expect(service.unconnectedNames()).toEqual(["Bank"]);
    mem.request("bank");
    await service.tick();
    expect(mem.rows.get("bank")?.status).toBe("authorizing");
    expect(seen).toEqual(["https://serain.example.com/connections/callback"]);
  });

  it("does not offer the bank without a public origin and says what is missing", async () => {
    const seen: string[] = [];
    const { mem, service } = bankService(null, seen);
    expect(service.unconnectedNames()).toEqual([]);
    mem.request("bank");
    await service.tick();
    expect(mem.rows.get("bank")).toMatchObject({ status: "failed", error: expect.stringContaining("SERAIN_WEB_ORIGIN") });
    expect(seen).toEqual([]);
  });

  it("takes the origin from the configuration when none is given", async () => {
    const seen: string[] = [];
    const mem = memoryStore();
    const service = new ConnectorService({
      store: mem.store,
      sealKey: SEAL_KEY,
      vaultKey: async () => {
        throw new Error("not needed");
      },
      drivers: () => [recordingBank(seen)],
      tools: { add: () => undefined, remove: () => undefined },
      onChange: () => undefined,
      audit: async () => undefined,
    });
    mem.request("bank");
    await service.tick();
    expect(seen).toEqual(["https://serain.example.com/connections/callback"]);
  });
});

describe("round cadence (2026-10-11)", () => {
  afterEach(() => void vi.useRealTimers());

  it("checks every 10 s when idle and every 2 s for the length of an authorization after work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let rounds = 0;
    let pending: ConnectorRow[] = [];
    const store = {
      connected: async () => [],
      work: async () => {
        rounds += 1;
        const rows = pending;
        pending = [];
        return rows;
      },
      remove: async () => undefined,
    } as unknown as ConnectorStore;
    const service = new ConnectorService({
      store,
      sealKey: SEAL_KEY,
      vaultKey: async () => {
        throw new Error("not needed");
      },
      drivers: () => [],
      tools: { add: () => undefined, remove: () => undefined },
      onChange: () => undefined,
      audit: async () => undefined,
    });
    await service.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(rounds).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(rounds).toBe(1);

    // The owner disconnects in the web interface: the next round finds work, then it continues densely.
    pending = [{ id: "coros", status: "disconnecting", origin: FAKE_ORIGIN, stateHash: null, pending: null, callback: null, sealed: null, requestedAt: new Date(), expiresAt: null }];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rounds).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rounds).toBe(3);

    // After 15 min without work, the idle cadence again.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const settled = rounds;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rounds - settled).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rounds - settled).toBeGreaterThanOrEqual(1);
    await service.stop();
    const stopped = rounds;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rounds).toBe(stopped);
  });
});
