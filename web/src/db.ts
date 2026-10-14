import postgres from "postgres";

export type Sql = postgres.Sql;

/**
 * Arrays travel as JSON both ways: results with `to_jsonb(column)`,
 * parameters through `textArray`.
 *
 * A `text[]` as a parameter. Without `fetch_types` (one query less per
 * connection) postgres.js knows no array types; it always knows JSON.
 */
export function textArray(sql: Sql, values: readonly string[]) {
  return sql`array(select jsonb_array_elements_text(${sql.json([...values])}))`;
}

/** Locally only through the tunnel from web/dev.ts or the throwaway database in the E2E. */
const isLoopback = (url: string) => /@(localhost|127\.0\.0\.1)[:/]/.test(url);

/** Hyperdrive on Cloudflare, otherwise loopback only. An address on the network without Hyperdrive would only work with unverified TLS (D49). */
export function databaseUrl(env: { HYPERDRIVE?: { connectionString: string } | undefined; DATABASE_URL?: string | undefined }): string | null {
  if (env.HYPERDRIVE) return env.HYPERDRIVE.connectionString;
  return env.DATABASE_URL && isLoopback(env.DATABASE_URL) ? env.DATABASE_URL : null;
}

/**
 * One connection per request, as role `serain_web`. What this role may do is in
 * `supabase/migrations/0016_web.sql`. No TLS on this leg: it ends locally at the
 * tunnel and on Cloudflare at Hyperdrive, and both talk to Supabase with
 * verified TLS (D49). No prepared statements, because the pooler in
 * transaction mode can be behind it.
 */
export function connect(url: string): Sql {
  return postgres(url, {
    max: 1,
    prepare: false,
    fetch_types: false,
    connect_timeout: 10,
    idle_timeout: 5,
    ssl: false,
    // Supabase errors can quote values from the request; only a generic message goes to the browser.
    onnotice: () => undefined,
  });
}
