import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cause of the missing embeddings (addendum to D13): `scripts/push-memory.ts`
 * wrote facts without the `embedding` column, because the seed path predates
 * Memory v1 and was never updated. This test checks the fix at the source
 * (an `--apply` run writes embeddings too, and a dry run neither spends money
 * nor touches anything) against fakes, never against the real database. All
 * facts here are synthetic, no real data.
 */

interface UpsertCall {
  table: string;
  op: "upsert";
  rows: Array<Record<string, unknown>>;
}
interface InsertCall {
  table: string;
  op: "insert";
  row: Record<string, unknown>;
}
interface UpdateCall {
  table: string;
  op: "update";
  id: string;
  payload: Record<string, unknown>;
}

let dbCalls: Array<UpsertCall | UpdateCall | InsertCall> = [];

function makeBuilder(table: string): Record<string, unknown> {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: null, error: null }),
    insert: (row: Record<string, unknown>) => {
      dbCalls.push({ table, op: "insert", row });
      return {
        select: () => ({
          single: async () => ({ data: { id: "um-1", created_at: "2026-10-02T00:00:00Z", diff: {}, facts_cursor: null, ...row }, error: null }),
        }),
      };
    },
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
    upsert: (rows: Array<Record<string, unknown>>) => {
      dbCalls.push({ table, op: "upsert", rows });
      return Promise.resolve({ data: null, error: null });
    },
    update: (payload: Record<string, unknown>) => ({
      eq: (_column: string, id: string) => {
        dbCalls.push({ table, op: "update", id, payload });
        return Promise.resolve({ data: null, error: null });
      },
    }),
  };
  return builder;
}

vi.mock("../src/db/client.js", () => ({
  db: { from: (table: string) => makeBuilder(table) },
}));

// Without a key the script pushes nothing: it could not recognize forgotten items (D40).
vi.mock("../src/config/env.js", () => ({ env: { integrationKey: "test-integration-key" } }));

const auditMock = vi.fn(async () => undefined);
vi.mock("../src/db/audit.js", () => ({
  audit: (...args: unknown[]) => auditMock(...(args as [])),
}));

const embedBestEffortMock = vi.fn(
  async (texts: readonly string[]): Promise<Array<number[] | null>> => texts.map((_, i) => [i, i, i]),
);
vi.mock("../src/memory/embeddings.js", () => ({
  embedBestEffort: (...args: unknown[]) => embedBestEffortMock(...(args as [readonly string[]])),
}));

const SYNTHETIC_FACTS = [
  { category: "test", content: "Synthetic test fact one, no real data.", confidence: 0.9 },
  { category: "test", content: "Synthetic test fact two, no real data.", confidence: 0.8 },
];
const SYNTHETIC_USER_MODEL = "# Test model\n\nSynthetic content, no real data.\n";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (path: unknown) => {
    const p = String(path);
    if (p.endsWith("user-model.md")) return SYNTHETIC_USER_MODEL;
    if (p.endsWith("facts.json")) return JSON.stringify(SYNTHETIC_FACTS);
    throw new Error(`unexpected path in test: ${p}`);
  }),
}));

/** Fresh module import with argv set: `APPLY` is read once on import. */
async function loadPushMemory(extraArgv: string[]): Promise<{ main: () => Promise<void> }> {
  vi.resetModules();
  const original = process.argv;
  process.argv = [...original.slice(0, 2), ...extraArgv];
  try {
    return (await import("../scripts/push-memory.js")) as { main: () => Promise<void> };
  } finally {
    process.argv = original;
  }
}

beforeEach(() => {
  dbCalls = [];
  auditMock.mockClear();
  embedBestEffortMock.mockClear();
  embedBestEffortMock.mockImplementation(async (texts: readonly string[]) => texts.map((_, i) => [i, i, i]));
});

describe("push-memory · dry run (without --apply)", () => {
  it("does not call embedBestEffort and writes nothing", async () => {
    const pushMemory = await loadPushMemory([]);
    await pushMemory.main();

    expect(embedBestEffortMock).not.toHaveBeenCalled();
    expect(dbCalls.filter((call) => call.table === "facts")).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("push-memory · --apply", () => {
  it("upserts the facts without the embedding column and writes vectors separately", async () => {
    const pushMemory = await loadPushMemory(["--apply"]);
    await pushMemory.main();

    expect(embedBestEffortMock).toHaveBeenCalledTimes(1);
    expect(embedBestEffortMock.mock.calls[0]?.[0]).toEqual(SYNTHETIC_FACTS.map((f) => f.content));

    const upsertCall = dbCalls.find(
      (call): call is UpsertCall => call.table === "facts" && call.op === "upsert",
    );
    expect(upsertCall).toBeDefined();
    expect(upsertCall?.rows).toHaveLength(2);
    for (const row of upsertCall?.rows ?? []) {
      expect(row).not.toHaveProperty("embedding");
    }

    const updateCalls = dbCalls.filter(
      (call): call is UpdateCall => call.table === "facts" && call.op === "update",
    );
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls.map((call) => call.payload["embedding"])).toEqual([[0, 0, 0], [1, 1, 1]]);

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [event, detail] = auditMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(event).toBe("memory_seed");
    expect(detail["missing_embeddings"]).toBe(0);
  });

  it("still stores a fact when its embedding fails", async () => {
    embedBestEffortMock.mockImplementation(async (texts: readonly string[]) =>
      texts.map((_, i) => (i === 1 ? null : [7, 7, 7])),
    );

    const pushMemory = await loadPushMemory(["--apply"]);
    await pushMemory.main();

    const upsertCall = dbCalls.find(
      (call): call is UpsertCall => call.table === "facts" && call.op === "upsert",
    );
    // Both facts are still written: an embedding failure must not cost a
    // fact (addendum to D13).
    expect(upsertCall?.rows).toHaveLength(2);

    const updateCalls = dbCalls.filter(
      (call): call is UpdateCall => call.table === "facts" && call.op === "update",
    );
    expect(updateCalls).toHaveLength(1); // only the fact with a vector gets an update

    const [, detail] = auditMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(detail["missing_embeddings"]).toBe(1);
  });

  it("never overwrites existing embeddings with null (no upsert of the embedding column)", async () => {
    // Even if embedBestEffort fails for all facts, the content upsert must not
    // touch the column at all; otherwise a transient error would reset an
    // existing good embedding row to null.
    embedBestEffortMock.mockImplementation(async (texts: readonly string[]) => texts.map(() => null));

    const pushMemory = await loadPushMemory(["--apply"]);
    await pushMemory.main();

    const upsertCall = dbCalls.find(
      (call): call is UpsertCall => call.table === "facts" && call.op === "upsert",
    );
    for (const row of upsertCall?.rows ?? []) {
      expect(row).not.toHaveProperty("embedding");
    }
    const updateCalls = dbCalls.filter((call) => call.table === "facts" && call.op === "update");
    expect(updateCalls).toHaveLength(0);
  });
});
