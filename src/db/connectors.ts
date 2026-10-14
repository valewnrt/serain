import type { ConnectorRow, ConnectorStore } from "../connectors/service.js";
import { db } from "./client.js";
import { columns, pgRows } from "./pg.js";

/** `connectors` and `connector_clients` against Supabase (D51). Every transition checks the state it comes from. */
const COLUMNS = "id, status, origin, state_hash, pending, callback, sealed, requested_at, expires_at";

function toRow(data: Record<string, unknown>): ConnectorRow {
  return {
    id: String(data["id"]),
    status: String(data["status"]) as ConnectorRow["status"],
    origin: String(data["origin"] ?? ""),
    stateHash: (data["state_hash"] as string | null) ?? null,
    pending: (data["pending"] as string | null) ?? null,
    callback: (data["callback"] as string | null) ?? null,
    sealed: (data["sealed"] as string | null) ?? null,
    requestedAt: new Date(String(data["requested_at"])),
    expiresAt: data["expires_at"] ? new Date(String(data["expires_at"])) : null,
  };
}

const now = () => new Date().toISOString();

async function transition(id: string, from: ConnectorRow["status"], values: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await db.from("connectors").update({ ...values, updated_at: now() }).eq("id", id).eq("status", from).select("id");
  if (error) throw new Error(`Connection ${id} not saved: ${error.message}`);
  return (data ?? []).length > 0;
}

export const connectorStore: ConnectorStore = {
  async work(authorizeCutoff) {
    // Every few seconds, hence via Postgres (`pg.ts`).
    const data = await pgRows(
      "Connections not readable",
      (sql) => sql`
        select ${columns(sql, COLUMNS)} from public.connectors
        where status in ('starting', 'authorizing', 'finishing', 'disconnecting')
        limit 20`,
    );
    return data
      .map((row) => toRow(row))
      .filter((row) => row.status !== "authorizing" || row.requestedAt < authorizeCutoff);
  },

  async connected() {
    const { data, error } = await db.from("connectors").select(COLUMNS).eq("status", "connected");
    if (error) throw new Error(`Connections not readable: ${error.message}`);
    return (data ?? []).map((row) => toRow(row as Record<string, unknown>));
  },

  async status(id) {
    const { data, error } = await db.from("connectors").select("status").eq("id", id).maybeSingle();
    if (error) throw new Error(`Connection ${id} not readable: ${error.message}`);
    return data ? (String(data.status) as ConnectorRow["status"]) : null;
  },

  authorizing: (id, input) =>
    transition(id, "starting", { status: "authorizing", authorize_url: input.authorizeUrl, state_hash: input.stateHash, pending: input.pending }),

  connect: (id, input) =>
    transition(id, "finishing", {
      status: "connected",
      sealed: input.sealed,
      account: input.account,
      tools: input.tools,
      expires_at: input.expiresAt?.toISOString() ?? null,
      connected_at: now(),
      pending: null,
      callback: null,
      state_hash: null,
      error: null,
    }),

  fail: (id, from, message) =>
    transition(id, from, { status: "failed", error: message.slice(0, 500), authorize_url: null, pending: null, callback: null, state_hash: null }),

  saveCredentials: (id, sealed) => transition(id, "connected", { sealed }),

  saveTools: (id, tools) => transition(id, "connected", { tools }),

  async remove(id) {
    const { error } = await db.from("connectors").delete().eq("id", id).eq("status", "disconnecting");
    if (error) throw new Error(`Connection ${id} not deleted: ${error.message}`);
  },

  async client(issuer, redirectUri) {
    const { data, error } = await db.from("connector_clients").select("sealed").eq("issuer", issuer).eq("redirect_uri", redirectUri).maybeSingle();
    if (error) throw new Error(`Client registration not readable: ${error.message}`);
    return data ? String(data.sealed) : null;
  },

  async saveClient(issuer, redirectUri, sealed) {
    const { error } = await db.from("connector_clients").upsert({ issuer, redirect_uri: redirectUri, sealed });
    if (error) throw new Error(`Client registration not saved: ${error.message}`);
  },
};
