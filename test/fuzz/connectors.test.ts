import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANARY, FUZZ_TIMEOUT_MS, argsFor, frameIsIntact, params } from "./helpers.js";
import { fakeUpstream, reply, storedCredentials, testBankConfig } from "./upstream.js";

/**
 * Connections (D51), generic over the catalog: every service `connectorDrivers`
 * delivers, each of its tools, along the same path as in production
 * (ConnectorService → guard → registry), fed with arbitrary provider responses.
 * A new service in the catalog runs along here without new test code; if the
 * harness does not reach it, the first test fails.
 *
 * Invariants per call: the registry never throws and returns in bounded time,
 * the result is framed exactly once and bounded, the turn is marked, and
 * nothing of the response's content is in the audit log.
 */

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
vi.mock("../../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown>) => void audits.push({ event, detail }),
}));
// Untrusted responses end up in error messages; the test does not need the journal.
vi.mock("../../src/log.js", async (original) => ({
  ...(await original<typeof import("../../src/log.js")>()),
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
}));

// A provider that never answers fittingly (wrong ID, empty stack) costs the MCP call's time limit;
// short in the test so the cases stay fast. What is checked is that it applies.
vi.mock("../../src/config/limits.js", async (original) => ({
  ...(await original<typeof import("../../src/config/limits.js")>()),
  CONNECTOR_TOOL_TIMEOUT_MS: 250,
}));

const { CONNECTORS } = await import("../../src/connectors/catalog.js");
const { connectorDrivers } = await import("../../src/connectors/drivers/index.js");
const { ConnectorService } = await import("../../src/connectors/service.js");
const { ToolRegistry } = await import("../../src/agent/tools/registry.js");
const { TurnState } = await import("../../src/agent/tools/types.js");
const { seal } = await import("../../src/integrations/seal.js");
const { toTransaction } = await import("../../src/connectors/drivers/enable-banking.js");
const { CONNECTOR_RESULT_MAX_CHARS, CONNECTOR_TOOL_TIMEOUT_MS } = await import("../../src/config/limits.js");
type ConnectorRow = import("../../src/connectors/service.js").ConnectorRow;
type ConnectorStore = import("../../src/connectors/service.js").ConnectorStore;

const SEAL_KEY = randomBytes(32);
const BANK = testBankConfig();
const upstream = fakeUpstream();
const clients = { get: async () => null, put: async () => undefined };

/** All services of the catalog connected, as the runtime loads them from the database after a restart. */
async function connectAll() {
  const registry = new ToolRegistry();
  const rows: ConnectorRow[] = CONNECTORS.map((info) => ({
    id: info.id,
    status: "connected",
    origin: "http://localhost:8787",
    stateHash: null,
    pending: null,
    callback: null,
    sealed: seal(SEAL_KEY, storedCredentials()),
    requestedAt: new Date(),
    expiresAt: null,
  }));
  const store: ConnectorStore = {
    work: async () => [],
    connected: async () => rows,
    status: async () => "connected",
    authorizing: async () => false,
    connect: async () => false,
    fail: async () => false,
    saveCredentials: async () => true,
    saveTools: async () => true,
    remove: async () => undefined,
    client: async () => null,
    saveClient: async () => undefined,
  };
  const service = new ConnectorService({
    store,
    sealKey: SEAL_KEY,
    vaultKey: async () => {
      throw new Error("no vault in fuzzing");
    },
    drivers: (registryOfClients) => connectorDrivers({ clients: registryOfClients, enableBanking: BANK, fetch: upstream.fetch }),
    tools: { add: (defs) => void registry.registerAll(defs), remove: (names) => registry.unregister(names) },
    onChange: () => undefined,
    audit: async () => undefined,
  });
  await service.start();
  return { service, registry };
}

const turn = () => new TurnState({ origin: "owner_message", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [] });

afterEach(() => {
  audits.length = 0;
  upstream.reset();
});

describe("connections: the harness reaches the whole catalog", () => {
  it("builds a driver for every service in the catalog and registers every tool", async () => {
    const drivers = connectorDrivers({ clients, enableBanking: BANK, fetch: upstream.fetch });
    expect(drivers.map((driver) => driver.id).sort()).toEqual(CONNECTORS.map((info) => info.id).sort());
    const { service, registry } = await connectAll();
    try {
      for (const info of CONNECTORS) {
        for (const tool of info.tools) {
          const def = registry.get(tool.name);
          expect(def, `${info.id}: ${tool.name} is missing in the registry`).toBeDefined();
          // What holds for mail holds for everything from a connected service (D51).
          expect(def?.returnsUntrusted && def.privateResult, `${tool.name} is not untrusted and private`).toBe(true);
        }
      }
    } finally {
      await service.stop();
    }
  });
});

const ALL_TOOLS = CONNECTORS.flatMap((info) => info.tools.map((tool) => ({ connector: info.id, tool: tool.name })));

describe.each(ALL_TOOLS)("connections: $connector/$tool with arbitrary responses", ({ tool }) => {
  it(
    "never throws, frames exactly once, bounds the result and keeps the audit log clean",
    async () => {
      // The schema comes from the tool itself, not from the test.
      const { service: probe, registry: probeRegistry } = await connectAll();
      const schema = probeRegistry.get(tool)!.schema;
      await probe.stop();

      let reached = 0;
      await fc.assert(
        fc.asyncProperty(argsFor(schema), fc.array(reply, { minLength: 1, maxLength: 5 }), async (args, replies) => {
          upstream.reset();
          audits.length = 0;
          upstream.script(replies);
          // Freshly connected per case: no intermediate state (bank cache, block, open MCP session) from the previous one.
          const { service, registry } = await connectAll();
          try {
            const state = turn();
            const started = performance.now();
            const result = await registry.execute(tool, args, state);
            // Two attempts of one time limit each, reconnecting in between: a provider may not cost more.
            expect(performance.now() - started).toBeLessThan(2 * CONNECTOR_TOOL_TIMEOUT_MS + 3_000);
            if (upstream.requests > 0) reached += 1;

            expect(typeof result.text).toBe("string");
            expect(frameIsIntact(result.text), result.text.slice(0, 300)).toBe(true);
            expect(result.text.length).toBeLessThanOrEqual(CONNECTOR_RESULT_MAX_CHARS + 1_000);
            expect(state.tainted).toBe(true);

            const calls = audits.filter((entry) => entry.event === "tool_call" && entry.detail["tool"] === tool);
            expect(calls).toHaveLength(1);
            expect(String(calls[0]?.detail["result"])).toMatch(/^\[not logged, \d+ chars\]$/);
            expect(JSON.stringify(audits)).not.toContain(CANARY);
          } finally {
            await service.stop();
          }
        }),
        params(12, { heavy: true }),
      );
      // A tool whose provider the harness never reaches is not fuzzed, only called.
      expect(reached, `${tool}: the provider was never reached`).toBeGreaterThan(0);
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe("connections: regressions from fuzzing", () => {
  it("reads broken amounts, currencies and days as unreadable instead of 0.00 EUR", () => {
    for (const amount of ["0x10", "1,50", "1e400", "", "abc", null, {}]) {
      expect(toTransaction({ transaction_amount: { amount, currency: "EUR" } }).amount, String(amount)).toBeNull();
    }
    expect(toTransaction({ transaction_amount: { amount: "12.34", currency: "EUR" }, credit_debit_indicator: "DBIT" }).amount).toBe(-12.34);
    expect(toTransaction({ transaction_amount: { amount: "1.00", currency: "€€€" } }).currency).toBe("(currency unreadable)");
    expect(toTransaction({ booking_date: "x".repeat(100_000) }).date).toBe("");
  });

  it("shows an unreadable balance as unreadable and survives broken entries in the transaction list", async () => {
    upstream.script([
      { kind: "json", status: 200, body: { balances: [null, { balance_type: "ITAV", balance_amount: { amount: "abc", currency: "EUR" } }] } },
      { kind: "json", status: 200, body: { transactions: [null, 7, "x", { booking_date: "2026-10-02", transaction_amount: { amount: "4.20", currency: "EUR" }, credit_debit_indicator: "DBIT", creditor: { name: "Bäckerei" } }] } },
    ]);
    const { service, registry } = await connectAll();
    try {
      const balance = await registry.execute("bank_balance", {}, turn());
      expect(balance.text).toContain("amount unreadable");
      expect(balance.text).not.toContain("0.00");
      const listing = await registry.execute("bank_transactions", {}, turn());
      expect(listing.text).toContain("Bäckerei");
    } finally {
      await service.stop();
    }
  });

  it("does not pass on an MCP server's error message as its own", async () => {
    upstream.script([{ kind: "rpc_error", code: -32000, message: `${CANARY} `.repeat(20_000) }]);
    const { service, registry } = await connectAll();
    try {
      const result = await registry.execute("coros_recovery", {}, turn());
      expect(result.ok).toBe(false);
      expect(result.text).not.toContain(CANARY);
      expect(result.text.length).toBeLessThan(1_000);
    } finally {
      await service.stop();
    }
  });
});
