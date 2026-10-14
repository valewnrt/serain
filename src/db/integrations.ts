import type { IntegrationRow, IntegrationStore } from "../integrations/types.js";
import { db } from "./client.js";
import { pgRows, pgRun } from "./pg.js";

/** `integrations` against Supabase (D30). */
const COLUMNS = "id, kind, account, sealed, scopes, state";

function toRow(data: Record<string, unknown>): IntegrationRow {
  return {
    id: String(data["id"]),
    kind: data["kind"] as IntegrationRow["kind"],
    account: String(data["account"] ?? ""),
    sealed: String(data["sealed"] ?? ""),
    scopes: Array.isArray(data["scopes"]) ? (data["scopes"] as string[]) : [],
    state: (data["state"] ?? {}) as Record<string, unknown>,
  };
}

export const integrationStore: IntegrationStore = {
  async list() {
    const { data, error } = await db.from("integrations").select(COLUMNS).order("created_at", { ascending: true });
    if (error) throw new Error(`Integrations not readable: ${error.message}`);
    return (data ?? []).map((row) => toRow(row as Record<string, unknown>));
  },

  async has(id) {
    // Before every mailbox call, hence via Postgres (`pg.ts`); the role only sees the ID and the state.
    return (await pgRows("Integration not readable", (sql) => sql`select id from public.integrations where id = ${id}`)).length > 0;
  },

  async get(id) {
    const { data, error } = await db.from("integrations").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) throw new Error(`Integration not readable: ${error.message}`);
    return data ? toRow(data as Record<string, unknown>) : null;
  },

  async put(row) {
    const { error } = await db.from("integrations").upsert({ ...row, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Integration not saved: ${error.message}`);
  },

  async saveState(id, state) {
    await pgRun(
      "Integration state not saved",
      (sql) => sql`update public.integrations set state = ${sql.json(state as never)}, updated_at = now() where id = ${id}`,
    );
  },

  async remove(id) {
    // Counted before deleting, deleted via the foreign-key cascade (0006): the
    // number is for the audit log, the deletion does not depend on it.
    const { count, error: countError } = await db
      .from("mail_items")
      .select("id", { count: "exact", head: true })
      .eq("integration_id", id);
    if (countError) throw new Error(`Mail data not countable: ${countError.message}`);
    const { data, error } = await db.from("integrations").delete().eq("id", id).select("id");
    if (error) throw new Error(`Integration not deleted: ${error.message}`);
    if (!data || data.length === 0) return null;
    return { mailItems: count ?? 0 };
  },
};

/** A mailbox's state for the mail trigger (D33), without the sealed data; via Postgres (`pg.ts`). */
export async function integrationState(id: string): Promise<Record<string, unknown> | null> {
  const rows = await pgRows<{ state: Record<string, unknown> | null }>(
    "Integration state not readable",
    (sql) => sql`select state from public.integrations where id = ${id}`,
  );
  return rows[0] ? (rows[0].state ?? {}) : null;
}
