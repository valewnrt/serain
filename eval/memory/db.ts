import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite, type PGliteInterface } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { vector } from "@electric-sql/pglite-pgvector";

/**
 * The memory eval's database: PGlite (Postgres as WASM) with exactly the
 * migrations that also run on Supabase, so with the same SQL functions
 * `search_facts` and `forget_fact`. Nothing is replicated: what is measured
 * here is the production schema.
 *
 * One instance per case, cloned from a template migrated once.
 * Cases thus never share rows, and one case cannot affect another,
 * not even with `--concurrency`.
 *
 * Supabase brings roles and schemas that the migrations assume;
 * they stand here as a minimal stub, as in `test/migrations.test.ts`.
 */

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../supabase/migrations");

const SUPABASE_STUBS = `
  create schema if not exists extensions;
  create schema if not exists auth;
  create role anon;
  create role authenticated;
  create role service_role;
`;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/** A freshly migrated database. Serves as the template every case clones from. */
export async function migratedTemplate(): Promise<PGliteInterface> {
  const db = new PGlite({ extensions: { vector, pgcrypto } });
  await db.exec(SUPABASE_STUBS);
  for (const name of migrationFiles()) {
    try {
      await db.exec(readFileSync(resolve(MIGRATIONS_DIR, name), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${name} failed in PGlite: ${(error as Error).message}`);
    }
  }
  return db;
}

/** An independent copy of the template for exactly one case. */
export function caseDatabase(template: PGliteInterface): Promise<PGliteInterface> {
  return template.clone();
}
