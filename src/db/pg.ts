import { readFileSync } from "node:fs";
import postgres, { type PendingQuery, type Row, type Sql } from "postgres";
import { DB_QUERY_TIMEOUT_MS } from "../config/limits.js";
import { env } from "../config/env.js";

/**
 * Direct connection to Postgres for the server's tick (0030, addendum D50 of
 * 2026-10-11). Via PostgREST every query cost about 1 KB of egress and 2 KB of
 * logs at Supabase; while idle that was around 40,000 a day and thus more than
 * the free quota. Over an open connection to the pooler (session mode) a query
 * costs only its result.
 *
 * As the role `serain_server`, which may only do what the tick needs.
 * Everything else stays with the secret key via `db` (`client.ts`).
 *
 * TLS is verified against the Supabase CA (`web/supabase-ca-2021.crt`, as in
 * the web interface, D49), never merely required: `ssl: "require"` does not
 * verify the certificate in postgres.js.
 */

const CA = new URL("../../web/supabase-ca-2021.crt", import.meta.url);

let client: Sql | null = null;

function connect(): Sql {
  client ??= postgres(env.dbUrl, {
    max: 2,
    // The tick queries every few seconds; when a command-line tool sits idle, the connection closes by itself.
    idle_timeout: 120,
    connect_timeout: 10,
    ssl: { ca: readFileSync(CA), rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connection: { application_name: "serain" },
    onnotice: () => undefined,
  });
  return client;
}

/**
 * Runs a query and returns the rows the way PostgREST returns them: as JSON
 * (timestamps as ISO text, `jsonb` as an object). The stores' converters
 * (`toRow`) thus stay the same. Also works with `update … returning`. An error
 * carries `failure` in front, like the messages of the PostgREST stores.
 */
export async function pgRows<T = Record<string, unknown>>(failure: string, build: (sql: Sql) => PendingQuery<Row[]>): Promise<T[]> {
  const sql = connect();
  try {
    const query = sql<Array<{ rows: T[] }>>`with q as (${build(sql)}) select coalesce(json_agg(q), '[]'::json) as rows from q`;
    const result = await withTimeout(sql, query);
    return result[0]?.rows ?? [];
  } catch (error) {
    throw new Error(`${failure}: ${(error as Error).message}`);
  }
}

/** A store's column list (`"id, status, …"`) as escaped identifiers. */
export function columns(sql: Sql, list: string) {
  return sql(list.split(/,\s*/));
}

/** A statement without a result (upsert, update). */
export async function pgRun(failure: string, build: (sql: Sql) => PendingQuery<Row[]>): Promise<void> {
  const sql = connect();
  try {
    await withTimeout(sql, build(sql));
  } catch (error) {
    throw new Error(`${failure}: ${(error as Error).message}`);
  }
}

async function withTimeout<T>(sql: Sql, query: PendingQuery<T & Row[]>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // If the pooler hangs, the connection hangs: drop it, the next query reconnects.
      if (client === sql) client = null;
      void sql.end({ timeout: 0 }).catch(() => undefined);
      reject(new Error(`Database not responding (${DB_QUERY_TIMEOUT_MS / 1000} s).`));
    }, DB_QUERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([query as unknown as Promise<T>, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** On shutdown and at the end of short processes (watchdog, command line). */
export async function closePg(): Promise<void> {
  const sql = client;
  client = null;
  await sql?.end({ timeout: 5 });
}
