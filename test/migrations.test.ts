import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

/**
 * The migrations, actually executed once.
 *
 * `0001_core.sql` has run on Supabase since phase 0, but `0002` and `0003` had
 * never seen a Postgres until this point: they were read, not checked. CLAUDE.md
 * asks for "repro before applying", and a syntax error in a migration would
 * otherwise only show up on the one database there is.
 *
 * The run goes against PGlite (Postgres as WASM) with pgvector and pgcrypto. The
 * Supabase surroundings that the migrations assume are created as a minimal
 * stub in the setup: roles and schemas, nothing else. The migrations are **not**
 * bent for this: they must run exactly as they later run on Supabase.
 *
 * **What is not checked here** (and therefore has to be in the live test):
 * - RLS is only checked as a switch. The test runs as superuser, so it says
 *   nothing about what `anon` really sees through PostgREST.
 * - PostgREST itself: whether `search_facts` gets through `db.rpc` with an
 *   embedding as a JSON array depends on PostgREST's argument casting, not on
 *   the schema.
 * - `pg_cron`, the `auth` schema and the secret key path only exist here as
 *   empty shells.
 * - The Postgres version: PGlite ships 18.x, Supabase runs on 17.
 */

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../supabase/migrations");

/**
 * What Supabase brings along and a migration may assume. Deliberately the
 * minimum: the roles that `revoke` runs against, and the schemas that hold
 * extensions.
 */
const SUPABASE_STUBS = `
  create schema if not exists extensions;
  create schema if not exists auth;
  create role anon;
  create role authenticated;
  create role service_role;
`;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function migrationSql(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

/** One-hot vector in the width that `0001_core.sql` sets for the columns. */
function embedding(axis: number): string {
  return `[${Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
}

let db: PGlite;

async function freshDatabase(): Promise<PGlite> {
  const instance = new PGlite({ extensions: { vector, pgcrypto } });
  await instance.exec(SUPABASE_STUBS);
  return instance;
}

beforeAll(async () => {
  db = await freshDatabase();
  for (const name of migrationFiles()) {
    // Throws with the file name when a migration does not run through.
    try {
      await db.exec(migrationSql(name));
    } catch (error) {
      throw new Error(`Migration ${name} failed: ${(error as Error).message}`);
    }
  }
}, 60_000);

async function rows<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

describe("migrations run through in order", () => {
  it("finds the expected files", () => {
    expect(migrationFiles()).toEqual([
      "0001_core.sql",
      "0002_health.sql",
      "0003_memory.sql",
      "0004_approvals.sql",
      "0005_search_usage.sql",
      "0006_integrations.sql",
      "0007_audit_fn_grants.sql",
      "0008_message_taint.sql",
      "0009_fact_kinds.sql",
      "0010_user_model_versions.sql",
      "0011_history_search.sql",
      "0012_proposals.sql",
      "0013_watchers.sql",
      "0014_delivery_health.sql",
      "0015_search_procedures.sql",
      "0016_web.sql",
      "0017_connectors.sql",
      "0018_approval_waived.sql",
      "0019_recovery.sql",
      "0020_caldav.sql",
      "0021_approval_files.sql",
      "0022_vault_files.sql",
      "0023_web_connections.sql",
      "0024_overview_areas_feedback.sql",
      "0025_usage_sums.sql",
      "0026_approve_later_quotes.sql",
      "0027_mail_findings.sql",
      "0028_standing_facts.sql",
      "0029_approval_reissue.sql",
      "0030_server_role.sql",
      "0031_mail_sender_trust.sql",
      "0032_mail_sent.sql",
      "0033_missions.sql",
      "0034_mail_awaited.sql",
      "0035_search_any_language.sql",
      "0036_english_messages.sql",
      "0037_fact_areas_english.sql",
    ]);
  });

  it("creates all tables", async () => {
    const found = (
      await rows<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' order by tablename",
      )
    ).map((row) => row.tablename);
    expect(found).toEqual([
      "agent_state",
      "approval_grants",
      "approvals",
      "audit_log",
      "component_status",
      "connector_clients",
      "connectors",
      "facts",
      "forgotten_markers",
      "incidents",
      "integrations",
      "mail_items",
      "mail_sent",
      "memory_proposals",
      "messages",
      "mission_notes",
      "missions",
      "open_questions",
      "procedures",
      "schedules",
      "summaries",
      "tasks",
      "usage_log",
      "user_model_versions",
      "vault_entries",
      "vault_files",
      "watchers",
      "web_challenges",
      "web_enrollments",
      "web_passkeys",
      "web_sessions",
    ]);
  });

  it("creates the indexes from 0002 and 0003", async () => {
    const found = (
      await rows<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname = 'public'",
      )
    ).map((row) => row.indexname);
    for (const index of [
      "incidents_open_per_component_idx",
      "incidents_component_idx",
      "facts_content_tsv_idx",
      "facts_embedding_idx",
      "summaries_embedding_idx",
      "open_questions_pair_idx",
      "open_questions_open_idx",
    ]) {
      expect(found).toContain(index);
    }
  });

  it("has RLS on for every table", async () => {
    const open = await rows<{ relname: string }>(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
    `);
    expect(open).toEqual([]);
  });

  it("gives anon and authenticated no rights on the functions", async () => {
    // The pitfall: Postgres grants PUBLIC EXECUTE on every new function by
    // default. Without `revoke … from public`, anon could have run them despite
    // the revoke on the named roles.
    const granted = await rows(`
      select p.proname, r.rolname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated')) as r(rolname)
      where n.nspname = 'public'
        and p.proname in ('search_facts', 'forget_fact', 'search_messages', 'search_summaries', 'search_procedures',
                          'active_situations', 'area_facts')
        and has_function_privilege(r.rolname, p.oid, 'execute')
    `);
    expect(granted).toEqual([]);
  });

  it("still lets the server through with the secret key", async () => {
    const allowed = (
      await rows<{ proname: string }>(`
        select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('search_facts', 'forget_fact', 'search_messages', 'search_summaries', 'search_procedures',
                            'active_situations', 'area_facts')
          and has_function_privilege('service_role', p.oid, 'execute')
        order by p.proname
      `)
    ).map((row) => row.proname);
    expect(allowed).toEqual([
      "active_situations",
      "area_facts",
      "forget_fact",
      "search_facts",
      "search_messages",
      "search_procedures",
      "search_summaries",
    ]);
  });

  it("can be applied a second time without breaking", async () => {
    // Additive also means repeatable: a half-finished deploy must be able to
    // run again.
    const second = await freshDatabase();
    for (const name of migrationFiles()) await second.exec(migrationSql(name));
    for (const name of migrationFiles()) await second.exec(migrationSql(name));
    await second.close();
  }, 60_000);
});

describe("memory schema in operation (0003)", () => {
  let messageId: string;
  let messageAt: Date;

  beforeAll(async () => {
    const [message] = await rows<{ id: string; created_at: Date }>(
      `insert into public.messages (direction, peer, body, external_id)
       values ('inbound', '+490000000000', 'Mara wohnt in Cordheim.', 'm-1')
       returning id, created_at`,
    );
    messageId = message!.id;
    messageAt = message!.created_at;
  });

  async function addFact(category: string, content: string, axis: number): Promise<string> {
    const [fact] = await rows<{ id: string }>(
      `insert into public.facts (category, content, source_message_id, embedding)
       values ($1, $2, $3, $4) returning id`,
      [category, content, messageId, embedding(axis)],
    );
    return fact!.id;
  }

  it("finds a fact through similarity search", async () => {
    const id = await addFact("wohnort", "Mara wohnt in Cordheim.", 1);
    const hits = await rows<{ id: string; similarity: number; score: number }>(
      "select * from public.search_facts($1, $2, $3, $4)",
      ["owner", embedding(1), "", 5],
    );
    const hit = hits.find((row) => row.id === id);
    expect(hit).toBeDefined();
    expect(Number(hit!.similarity)).toBeCloseTo(1);
    expect(Number(hit!.score)).toBeGreaterThan(0);
  });

  it("finds a fact through full text, even without an embedding", async () => {
    const id = await addFact("arbeit", "Mara arbeitet bei Finkel.", 900);
    const hits = await rows<{ id: string }>(
      "select * from public.search_facts($1, $2, $3, $4)",
      ["owner", null, "Finkel", 5],
    );
    expect(hits.map((row) => row.id)).toContain(id);
  });

  it("searches only active facts", async () => {
    const alt = await addFact("hobby", "Mara segelt.", 500);
    const neu = await addFact("hobby", "Mara klettert.", 501);
    await db.query("update public.facts set superseded_by = $1 where id = $2", [neu, alt]);

    const hits = await rows<{ id: string }>(
      "select * from public.search_facts($1, $2, $3, $4)",
      ["owner", null, "segelt", 5],
    );
    expect(hits.map((row) => row.id)).not.toContain(alt);
  });

  it("records the same conflict only once", async () => {
    const a = await addFact("essen", "Mara isst gern Pho.", 600);
    const b = await addFact("essen", "Mara isst gern Ramen.", 601);
    await db.query(
      `insert into public.open_questions (question, fact_id, rival_fact_id, importance)
       values ('Pho oder Ramen?', $1, $2, 0.7)`,
      [b, a],
    );
    await expect(
      db.query(
        `insert into public.open_questions (question, fact_id, rival_fact_id, importance)
         values ('Pho oder Ramen?', $1, $2, 0.7)`,
        [b, a],
      ),
    ).rejects.toThrow(/open_questions_pair_idx|duplicate key/i);
  });

  it("deletes the whole replacement chain, the summary and the open question", async () => {
    const alt = await addFact("stadt", "Mara wohnte in Ahrenfeld.", 700);
    const neu = await addFact("stadt", "Mara wohnt jetzt in Cordheim.", 701);
    await db.query("update public.facts set superseded_by = $1 where id = $2", [neu, alt]);
    await db.query(
      `insert into public.open_questions (question, fact_id, rival_fact_id, importance)
       values ('Ahrenfeld oder Cordheim?', $1, $2, 0.9)`,
      [neu, alt],
    );
    await db.query(
      `insert into public.summaries (window_start, window_end, content, message_count)
       values ($1, $2, 'Mara ist umgezogen.', 3)`,
      [new Date(messageAt.getTime() - 1_000), new Date(messageAt.getTime() + 1_000)],
    );
    const [unrelated] = await rows<{ id: string }>(
      `insert into public.summaries (window_start, window_end, content, message_count)
       values ('2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z', 'Ganz was anderes.', 1)
       returning id`,
    );

    const [result] = await rows<{
      deleted_ids: string[];
      categories: string[];
      summaries_deleted: number;
    }>("select * from public.forget_fact($1)", [neu]);

    expect(result!.deleted_ids.sort()).toEqual([alt, neu].sort());
    expect(result!.categories).toEqual(["stadt", "stadt"]);
    expect(Number(result!.summaries_deleted)).toBe(1);

    const remaining = await rows<{ id: string }>("select id from public.facts where id = any($1)", [
      [alt, neu],
    ]);
    expect(remaining).toEqual([]);
    // The open question hangs on the fact via ON DELETE CASCADE.
    const questions = await rows("select id from public.open_questions where fact_id = $1", [neu]);
    expect(questions).toEqual([]);
    // Unrelated summaries stay.
    const summaries = await rows<{ id: string }>("select id from public.summaries");
    expect(summaries.map((row) => row.id)).toContain(unrelated!.id);
    // The honest limit (D13): the source message stays.
    const messages = await rows("select id from public.messages where id = $1", [messageId]);
    expect(messages).toHaveLength(1);
  });

  it("reports empty instead of throwing when the fact does not exist", async () => {
    const [result] = await rows<{ deleted_ids: string[]; summaries_deleted: number }>(
      "select * from public.forget_fact($1)",
      ["00000000-0000-0000-0000-000000000000"],
    );
    expect(result!.deleted_ids).toEqual([]);
    expect(Number(result!.summaries_deleted)).toBe(0);
  });
});

describe("health schema in operation (0002)", () => {
  it("keeps exactly one row per component, by upsert", async () => {
    await db.query(
      `insert into public.component_status (component, status, last_ok_at)
       values ('process', 'ok', now())
       on conflict (component) do update set status = excluded.status, updated_at = now()`,
    );
    // Exactly the columns that `recordComponentStatus` writes.
    await db.query(
      `insert into public.component_status (component, status, detail)
       values ('process', 'degraded', $1::jsonb)
       on conflict (component) do update
         set status = excluded.status, detail = excluded.detail, updated_at = now()`,
      [JSON.stringify({ reason: "kein Heartbeat" })],
    );
    const found = await rows<{ status: string; detail: Record<string, unknown> }>(
      "select status, detail from public.component_status where component = 'process'",
    );
    expect(found).toEqual([{ status: "degraded", detail: { reason: "kein Heartbeat" } }]);
  });

  it("allows only known components and states", async () => {
    await expect(
      db.query("insert into public.component_status (component, status) values ('kaffee', 'ok')"),
    ).rejects.toThrow();
    await expect(
      db.query("insert into public.component_status (component, status) values ('db', 'meh')"),
    ).rejects.toThrow();
  });

  it("allows at most one open incident per component", async () => {
    // Columns as in src/health/incidents.ts: root_cause when opening, note and
    // ended_at when closing.
    await db.query(
      "insert into public.incidents (component, root_cause) values ('channel', 'WebSocket weg')",
    );
    await expect(
      db.query(
        "insert into public.incidents (component, root_cause) values ('channel', 'nochmal')",
      ),
    ).rejects.toThrow(/incidents_open_per_component_idx|duplicate key/i);

    // Closed is not open: after that the next one works again.
    await db.query(
      `update public.incidents
       set ended_at = now(), note = 'wieder verbunden', updated_at = now()
       where component = 'channel' and ended_at is null`,
    );
    await db.query(
      "insert into public.incidents (component, root_cause) values ('channel', 'schon wieder')",
    );
    const open = await rows(
      "select id from public.incidents where component = 'channel' and ended_at is null",
    );
    expect(open).toHaveLength(1);
  });
});

describe("approval schema in operation (0004)", () => {
  const insert = (preview: string, expires: string) =>
    db.query(
      `insert into public.approvals (tool, level, preview, token, preview_external_id, expires_at)
       values ('send_mail', 'irreversible', 'x', gen_random_uuid()::text, $1, now() + $2::interval)`,
      [preview, expires],
    );
  // The same conditional update that `src/db/approvals.ts` runs through PostgREST.
  const claim = (preview: string) =>
    rows<{ id: string }>(
      `update public.approvals set status = 'approved'
       where preview_external_id = '${preview}' and status = 'pending' and expires_at > now()
       returning id`,
    );

  it("lets a pending approval be claimed exactly once", async () => {
    await insert("pv-1", "30 minutes");
    expect(await claim("pv-1")).toHaveLength(1);
    expect(await claim("pv-1")).toHaveLength(0);
  });

  it("does not let an expired one be claimed at all", async () => {
    await insert("pv-2", "-1 minute");
    expect(await claim("pv-2")).toHaveLength(0);
  });

  it("knows the execution states and no others", async () => {
    await db.query("update public.approvals set status = 'executed' where preview_external_id = 'pv-1'");
    await expect(
      db.query("update public.approvals set status = 'vielleicht' where preview_external_id = 'pv-1'"),
    ).rejects.toThrow(/approvals_status_check/);
  });

  it("schedules an approval with a time, but never money and never without a time (0026)", async () => {
    await insert("pv-l", "30 minutes");
    const scheduled = await rows<{ status: string }>(
      `update public.approvals set status = 'scheduled', execute_at = now() + interval '1 hour', later_pin = '{"account": "gmx"}'::jsonb,
         taint_sources = array['Mail von x']
       where preview_external_id = 'pv-l' and status = 'pending' and expires_at > now() returning status`,
    );
    expect(scheduled).toEqual([{ status: "scheduled" }]);
    // Due: claimable exactly once, like `claimDue`.
    const due = () =>
      rows(`update public.approvals set status = 'approved' where preview_external_id = 'pv-l' and status = 'scheduled'
            and execute_at <= now() + interval '2 hours' returning id`);
    expect(await due()).toHaveLength(1);
    expect(await due()).toHaveLength(0);
    await db.query("update public.approvals set status = 'cancelled' where preview_external_id = 'pv-l'");

    await db.query(
      `insert into public.approvals (tool, level, preview, token, preview_external_id, expires_at)
       values ('pay', 'money', 'x', gen_random_uuid()::text, 'pv-m', now() + interval '30 minutes')`,
    );
    await expect(
      db.query("update public.approvals set status = 'scheduled', execute_at = now() + interval '1 hour' where preview_external_id = 'pv-m'"),
    ).rejects.toThrow(/approvals_later_check/);
    await insert("pv-n", "30 minutes");
    await expect(db.query("update public.approvals set status = 'scheduled' where preview_external_id = 'pv-n'")).rejects.toThrow(
      /approvals_scheduled_check/,
    );
  });

  it("knows quote watchers as a fourth kind and no other (0026)", async () => {
    await db.query(
      `insert into public.watchers (kind, label, spec, expires_at)
       values ('quote', 'Bitcoin unter 70.000 €', '{"asset": "crypto", "symbol": "BTC"}'::jsonb, now() + interval '14 days')`,
    );
    await expect(
      db.query(`insert into public.watchers (kind, label, spec, expires_at) values ('script', 'x', '{}'::jsonb, now() + interval '1 day')`),
    ).rejects.toThrow(/watchers_kind_check/);
  });

  it("allows only one pending approval per preview", async () => {
    await insert("pv-3", "30 minutes");
    await expect(insert("pv-3", "30 minutes")).rejects.toThrow(/approvals_preview_pending_idx/);
  });

  it("finds a pending approval through a file under the preview too (0021)", async () => {
    await db.query(
      `insert into public.approvals (tool, level, preview, token, preview_external_id, preview_file_external_ids, expires_at)
       values ('mail_send', 'irreversible', 'x', gen_random_uuid()::text, 'pv-f', array['file-1'], now() + interval '30 minutes')`,
    );
    const found = await rows<{ preview_external_id: string }>(
      "select preview_external_id from public.approvals where preview_file_external_ids @> array['file-1'] and status = 'pending'",
    );
    expect(found).toEqual([{ preview_external_id: "pv-f" }]);
    const fresh = await rows<{ ids: string[] }>("select preview_file_external_ids as ids from public.approvals where preview_external_id = 'pv-1'");
    expect(fresh[0]?.ids).toEqual([]);
  });

  it("rejects standing approvals for money in the schema already", async () => {
    await db.query(
      "insert into public.approval_grants (tool, grant_key, level) values ('send_mail', 'Mails an a', 'irreversible')",
    );
    await expect(
      db.query(
        "insert into public.approval_grants (tool, grant_key, level) values ('pay', 'alles', 'money')",
      ),
    ).rejects.toThrow(/approval_grants_level_check/);
  });

  it("keeps one active standing approval per tool and task type, a new one after revoking", async () => {
    const again =
      "insert into public.approval_grants (tool, grant_key, level) values ('send_mail', 'Mails an a', 'irreversible')";
    await expect(db.query(again)).rejects.toThrow(/approval_grants_active_idx/);
    await db.query("update public.approval_grants set revoked_at = now() where revoked_at is null");
    await db.query(again);
  });

  it("answers an expired preview exactly once and never reissues money (0029)", async () => {
    await insert("pv-x", "-1 minute");
    await db.query("update public.approvals set status = 'expired', decided_via = 'timeout' where preview_external_id = 'pv-x'");
    // The same conditional update as `claimExpired`: of two 👍 exactly one gets an answer.
    const answer = () =>
      rows<{ id: string }>(
        `update public.approvals set expired_answered_at = now() where preview_external_id = 'pv-x' and status = 'expired'
           and decided_via = 'timeout' and expired_answered_at is null returning id`,
      );
    const [old] = await answer();
    expect(old).toBeDefined();
    expect(await answer()).toHaveLength(0);
    await db.query(
      `insert into public.approvals (tool, level, preview, token, preview_external_id, expires_at, reissued_from)
       values ('send_mail', 'irreversible', 'x', gen_random_uuid()::text, 'pv-x2', now() + interval '30 minutes', $1)`,
      [old!.id],
    );
    await expect(
      db.query(
        `insert into public.approvals (tool, level, preview, token, preview_external_id, expires_at, reissued_from)
         values ('pay', 'money', 'x', gen_random_uuid()::text, 'pv-x3', now() + interval '30 minutes', $1)`,
        [old!.id],
      ),
    ).rejects.toThrow(/approvals_reissue_check/);
    await expect(db.query("update public.approvals set expired_answered_at = now() where preview_external_id = 'pv-x2'")).rejects.toThrow(
      /approvals_expired_answered_check/,
    );
  });
});

describe("facts for the context without reference to the message (0028)", () => {
  const NOW = "2026-10-12T10:00:00Z";
  async function fact(input: {
    content: string;
    kind?: string;
    area?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
    createdAt?: string;
    subject?: string;
    axis?: number;
  }): Promise<string> {
    const [row] = await rows<{ id: string }>(
      `insert into public.facts (subject, category, content, kind, area, valid_from, valid_until, created_at, embedding)
       values ($1, 'kontext', $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        input.subject ?? "ctx",
        input.content,
        input.kind ?? "identity",
        input.area ?? null,
        input.validFrom ?? null,
        input.validUntil ?? null,
        input.createdAt ?? "2026-10-10T10:00:00Z",
        input.axis === undefined ? null : embedding(input.axis),
      ],
    );
    return row!.id;
  }

  it("returns what applies right now: started or about to, not over yet, without an end only if recent", async () => {
    const trip = await fact({ content: "Alex ist bis Freitag in Lissabon.", kind: "situation", validUntil: "2026-10-16T22:00:00Z" });
    const soon = await fact({ content: "Alex ist ab morgen auf Messe.", kind: "situation", validFrom: "2026-10-12T22:00:00Z", validUntil: "2026-10-15T22:00:00Z", createdAt: "2026-10-11T18:00:00Z" });
    const sick = await fact({ content: "Alex ist erkältet.", kind: "situation", createdAt: "2026-10-09T08:00:00Z" });
    await fact({ content: "Alex war im Sommer in Prüfungsphase.", kind: "situation", validUntil: "2026-08-31T22:00:00Z" });
    await fact({ content: "Alex hat ein Projekt ohne Ende von vor Wochen.", kind: "situation", createdAt: "2026-08-01T08:00:00Z" });
    await fact({ content: "Alex zieht im Dezember um.", kind: "situation", validFrom: "2026-12-01T00:00:00Z" });
    await fact({ content: "Alex wohnt in Ahrenfeld.", kind: "identity" });
    await fact({ content: "Jemand anderes ist in Rom.", kind: "situation", subject: "andere" });
    const replaced = await fact({ content: "Alex ist bis Freitag in Lissabon.", kind: "situation", validUntil: "2026-10-16T22:00:00Z" });
    await rows("update public.facts set superseded_by = $1 where id = $2", [trip, replaced]);

    const hits = await rows<{ id: string; kind: string }>(
      "select * from public.active_situations('ctx', $1::timestamptz, $2::timestamptz, $3::timestamptz, 5)",
      [NOW, "2026-10-14T10:00:00Z", "2026-09-28T10:00:00Z"],
    );
    // Newest first.
    expect(hits.map((row) => row.id)).toEqual([soon, trip, sick]);
    const capped = await rows("select * from public.active_situations('ctx', $1::timestamptz, $1::timestamptz, $2::timestamptz, 1)", [NOW, "2026-09-28T10:00:00Z"]);
    expect(capped).toHaveLength(1);
  });

  it("fetches facts from areas, without an area by kind, ranked by keywords, then closeness", async () => {
    const card = await fact({ content: "Alex hat eine Bahncard 25.", kind: "preference", area: "praeferenzen", subject: "area", axis: 5 });
    const home = await fact({ content: "Alex wohnt in Ahrenfeld am Bahnhof.", kind: "identity", area: "orte", subject: "area", axis: 6 });
    const seat = await fact({ content: "Alex sitzt gern am Fenster.", kind: "preference", area: null, subject: "area", axis: 7 });
    await fact({ content: "Alex' Schwester heißt Mia.", kind: "identity", area: "personen", subject: "area", axis: 5 });
    await fact({ content: "Alex mochte früher Tee.", kind: "preference", area: "praeferenzen", subject: "area", validUntil: "2026-10-01T00:00:00Z" });

    const hits = await rows<{ id: string; shared_terms: number; similarity: number }>(
      "select * from public.area_facts('area', $1::text[], $2::text[], $3::extensions.vector, $4, $5::timestamptz, 10)",
      [["praeferenzen", "orte"], ["preference"], embedding(7), "Bahncard Bahnhof", NOW],
    );
    // Bahncard and Bahnhof each share one keyword and come first; the window seat
    // (no area, through its kind) is only close in the vector. People and expired facts are missing.
    expect(hits).toHaveLength(3);
    expect(hits.slice(0, 2).map((row) => row.id).sort()).toEqual([card, home].sort());
    expect(hits.slice(0, 2).every((row) => Number(row.shared_terms) === 1)).toBe(true);
    expect(hits[2]).toMatchObject({ id: seat, shared_terms: 0 });
    expect(Number(hits[2]!.similarity)).toBeCloseTo(1);
    // Without a vector and without keywords it is the same facts, the newest first.
    const plain = await rows<{ id: string }>(
      "select * from public.area_facts('area', $1::text[], $2::text[], null, '', $3::timestamptz, 10)",
      [["praeferenzen"], ["preference"], NOW],
    );
    expect(plain.map((row) => row.id).sort()).toEqual([card, seat].sort());
  });
});

describe("search quota in the budget guard (0005)", () => {
  it("books searches and still allows nothing unknown", async () => {
    await db.query("insert into public.usage_log (kind, provider, units) values ('search', 'tavily', 1)");
    await expect(
      db.query("insert into public.usage_log (kind, provider, units) values ('sonstiges', 'x', 1)"),
    ).rejects.toThrow(/usage_log_kind_check/);
  });

  it("sums the month in the database, over more than 1,000 rows (0025)", async () => {
    await db.query(
      `insert into public.usage_log (kind, provider, cost_usd, at)
         select 'model', 'openrouter', 0.001, '2026-07-15T12:00:00Z' from generate_series(1, 1500)`,
    );
    await db.query("insert into public.usage_log (kind, provider, cost_usd, at) values ('model', 'openrouter', 5, '2026-06-30T12:00:00Z')");
    const [model] = (await db.query<{ cost_usd: string; units: string }>("select * from public.usage_since('model', '2026-07-01T00:00:00Z')")).rows;
    expect(Number(model?.cost_usd)).toBeCloseTo(1.5);
    const [search] = (await db.query<{ units: string }>("select * from public.usage_since('search', '2000-01-01T00:00:00Z')")).rows;
    expect(Number(search?.units)).toBeGreaterThanOrEqual(1);
  });
});

describe("integrations (0006, W13)", () => {
  it("deletes everything remembered from its mails together with the account", async () => {
    await db.query(
      "insert into public.integrations (id, kind, account, sealed) values ('gmx', 'imap', 'a@example.org', 'v1.x.y.z')",
    );
    await db.query(
      `insert into public.mail_items (integration_id, external_id, received_at, category, summary, commitment)
       values ('gmx', '17', now(), 'new_commitment', 'Zahnarzt am Freitag', '{"what":"Zahnarzt","when":"Fr 10:00"}'::jsonb)`,
    );
    await expect(
      db.query(
        "insert into public.mail_items (integration_id, external_id, received_at, category) values ('gmx', '17', now(), 'none')",
      ),
    ).rejects.toThrow(/mail_items_integration_id_external_id_key/);
    await db.query("delete from public.integrations where id = 'gmx'");
    expect(await rows("select id from public.mail_items")).toEqual([]);
  });

  it("knows only the three kinds of account and only the four categories", async () => {
    await expect(
      db.query("insert into public.integrations (id, kind, account, sealed) values ('x1', 'composio', 'a', 'b')"),
    ).rejects.toThrow(/integrations_kind_check/);
    await db.query("insert into public.integrations (id, kind, account, sealed) values ('icloud', 'caldav', 'a', 'b')");
    await db.query("delete from public.integrations where id = 'icloud'");
    await db.query("insert into public.integrations (id, kind, account, sealed) values ('google', 'google', 'a', 'b')");
    await expect(
      db.query(
        "insert into public.mail_items (integration_id, external_id, received_at, category) values ('google', '1', now(), 'spam')",
      ),
    ).rejects.toThrow(/mail_items_category_check/);
  });

  it("accepts bookings and deadlines from the mail, with an event in the commitment (0027)", async () => {
    await db.query(
      `insert into public.mail_items (integration_id, external_id, received_at, category, commitment, notified_at)
       values ('google', 'b1', now(), 'booking', '{"what":"Zug nach Berlin","when":"Fr","due":null,"event":{"title":"Zug nach Berlin","start":"2026-10-16 07:12","end":"2026-10-16 11:20","place":"Hbf"}}'::jsonb, null),
              ('google', 'l1', now(), 'lapse', '{"what":"Paket abholen","when":"bis Do","due":"2026-10-15"}'::jsonb, now())`,
    );
    expect(await rows("select category from public.mail_items where integration_id = 'google' and notified_at is null")).toEqual([{ category: "booking" }]);
    await db.query("delete from public.integrations where id = 'google'");
  });

  it("records what the code knows about the sender, and nothing else (0031)", async () => {
    await db.query("insert into public.integrations (id, kind, account, sealed) values ('gmx', 'imap', 'a', 'b')");
    await db.query(
      `insert into public.mail_items (integration_id, external_id, received_at, category, sender_trust)
       values ('gmx', 's1', now(), 'urgent', 'known'), ('gmx', 's2', now(), 'urgent', null)`,
    );
    expect(await rows("select sender_trust from public.mail_items where external_id in ('s1', 's2') order by external_id")).toEqual([
      { sender_trust: "known" },
      { sender_trust: null },
    ]);
    await expect(
      db.query("insert into public.mail_items (integration_id, external_id, received_at, category, sender_trust) values ('gmx', 's3', now(), 'urgent', 'trusted')"),
    ).rejects.toThrow(/mail_items_sender_trust_check/);
    await db.query("delete from public.integrations where id = 'gmx'");
  });

  it("keeps only the id of sent mails and deletes it with the account (0032)", async () => {
    await db.query("insert into public.integrations (id, kind, account, sealed) values ('gmx', 'imap', 'a', 'b')");
    await db.query("insert into public.mail_sent (integration_id, message_id) values ('gmx', '<a@example.org>')");
    await expect(db.query("insert into public.mail_sent (integration_id, message_id) values ('gmx', '<a@example.org>')")).rejects.toThrow(/mail_sent_message_id_key/);
    expect((await rows<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'mail_sent' order by column_name")).map((row) => row.column_name)).toEqual([
      "id",
      "integration_id",
      "message_id",
      "sent_at",
    ]);
    await db.query("insert into public.mail_items (integration_id, external_id, received_at, category) values ('gmx', 'r1', now(), 'reply')");
    await db.query("delete from public.integrations where id = 'gmx'");
    expect(await rows("select id from public.mail_sent")).toEqual([]);
  });

  it("knows mails Alex is waiting for because Serain promised to get back (0034)", async () => {
    await db.query("insert into public.integrations (id, kind, account, sealed) values ('gmx', 'imap', 'a', 'b')");
    await db.query("insert into public.mail_items (integration_id, external_id, received_at, category) values ('gmx', 'w1', now(), 'awaited')");
    await expect(db.query("insert into public.mail_items (integration_id, external_id, received_at, category) values ('gmx', 'w2', now(), 'waiting')")).rejects.toThrow(
      /mail_items_category_check/,
    );
    await db.query("delete from public.integrations where id = 'gmx'");
  });
});

describe("missions (0033, D63)", () => {
  it("keeps goal and notes with provenance, checks lengths and deletes notes with the mission", async () => {
    const [mission] = await rows<{ id: string; status: string }>(
      "insert into public.missions (title, goal) values ('DSGVO', 'Auskunft bei drei Firmen anfragen') returning id, status",
    );
    expect(mission?.status).toBe("active");
    await db.query("insert into public.mission_notes (mission_id, text, taint_sources, origin) values ($1, 'Mails raus', '{}', 'owner_message')", [mission!.id]);
    await db.query("insert into public.mission_notes (mission_id, text, taint_sources, origin) values ($1, 'Antwort von A', '{Posteingang von Alex}', 'untrusted')", [mission!.id]);
    expect(await rows("select taint_sources from public.mission_notes order by id")).toEqual([{ taint_sources: [] }, { taint_sources: ["Posteingang von Alex"] }]);
    await expect(db.query("insert into public.missions (title, goal) values ('x', 'zu kurz')")).rejects.toThrow(/missions_title_check|missions_goal_check/);
    await expect(db.query("update public.missions set status = 'paused' where id = $1", [mission!.id])).rejects.toThrow(/missions_status_check/);
    await expect(db.query("insert into public.mission_notes (mission_id, text, origin) values ($1, '', 'x')", [mission!.id])).rejects.toThrow(/mission_notes_text_check/);
    await db.query("delete from public.missions where id = $1", [mission!.id]);
    expect(await rows("select id from public.mission_notes")).toEqual([]);
    const rls = await rows<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('missions', 'mission_notes') order by relname",
    );
    expect(rls).toEqual([
      { relname: "mission_notes", relrowsecurity: true },
      { relname: "missions", relrowsecurity: true },
    ]);
  });
});

describe("provenance of outgoing messages (0008, D8.4)", () => {
  it("gives every message an empty taint list unless someone says otherwise", async () => {
    const [row] = await rows<{ taint_sources: string[] }>(
      "insert into public.messages (direction, peer, body) values ('outbound', '+49', 'hallo') returning taint_sources",
    );
    expect(row?.taint_sources).toEqual([]);
    await expect(
      db.query("insert into public.messages (direction, peer, taint_sources) values ('outbound', '+49', null)"),
    ).rejects.toThrow(/null/);
  });

  it("backfills existing rows with what the audit log knows about provenance, and only that", async () => {
    const before = await freshDatabase();
    for (const name of migrationFiles().filter((file) => file < "0008")) await before.exec(migrationSql(name));
    const insert = async (direction: string, body: string, origin: string | null) => {
      const result = await before.query<{ id: string }>(
        "insert into public.messages (direction, peer, body) values ($1, '+49', $2) returning id",
        [direction, body],
      );
      const id = result.rows[0]?.id;
      if (origin !== null) {
        await before.query(
          "insert into public.audit_log (event, message_id, detail) values ('outbound', $1, jsonb_build_object('kind', 'reply', 'origin', $2::text))",
          [id, origin],
        );
      }
      return id;
    };
    const mail = await insert("outbound", "neue mail von der bank", "untrusted");
    const task = await insert("outbound", "der zug fährt 07:02", "task");
    const owner = await insert("outbound", "mach ich", "owner_message");
    const hello = await insert("outbound", "hi, ich bin serain", null);
    const inbound = await insert("inbound", "danke", null);

    // Twice: additive also means repeatable, and the backfill must not double.
    await before.exec(migrationSql("0008_message_taint.sql"));
    await before.exec(migrationSql("0008_message_taint.sql"));

    const taint = new Map(
      (await before.query<{ id: string; taint_sources: string[] }>("select id, taint_sources from public.messages")).rows.map(
        (row) => [row.id, row.taint_sources],
      ),
    );
    expect(taint.get(mail ?? "")).toEqual(["vor 0008: Turn der Herkunft untrusted"]);
    expect(taint.get(task ?? "")).toEqual(["vor 0008: Turn der Herkunft task"]);
    expect(taint.get(owner ?? "")).toEqual([]);
    expect(taint.get(hello ?? "")).toEqual([]);
    expect(taint.get(inbound ?? "")).toEqual([]);
    await before.close();
  }, 60_000);
});

describe("audit_log stays append-only (D8.6)", () => {
  it("accepts entries but does not let them be changed or deleted", async () => {
    await db.query("insert into public.audit_log (event, detail) values ('inbound', '{}'::jsonb)");
    await expect(db.query("update public.audit_log set event = 'gefälscht'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query("delete from public.audit_log")).rejects.toThrow(/append-only/);
    const entries = await rows<{ event: string }>("select event from public.audit_log");
    expect(entries).toEqual([{ event: "inbound" }]);
  });

  it("offers the trigger function to nobody as RPC (0007)", async () => {
    const [fn] = await rows<{ prosecdef: boolean; callers: string[] }>(`
      select p.prosecdef,
             array(
               select r.rolname
               from (values ('public'), ('anon'), ('authenticated'), ('service_role')) as r(rolname)
               where has_function_privilege(r.rolname, p.oid, 'execute')
             ) as callers
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'audit_log_append_only'
    `);
    expect(fn).toEqual({ prosecdef: false, callers: [] });
  });

  it("also applies to a role that may not execute the function (0007)", async () => {
    // The server writes as `service_role`. On Supabase the role bypasses RLS
    // and has table rights; the stub gets both here, otherwise the update would
    // hit no row because of RLS and the row trigger would never run.
    await db.exec(`
      alter role service_role bypassrls;
      grant usage on schema public to service_role;
      grant select, insert, update, delete on public.audit_log to service_role;
    `);
    await db.exec("set role service_role");
    try {
      await db.query("insert into public.audit_log (event) values ('tool_call')");
      await expect(db.query("update public.audit_log set event = 'gefälscht'")).rejects.toThrow(
        /append-only/,
      );
      await expect(db.query("delete from public.audit_log")).rejects.toThrow(/append-only/);
      await expect(db.query("select public.audit_log_append_only()")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await db.exec("reset role");
    }
    const entries = await rows<{ event: string }>("select event from public.audit_log order by id");
    expect(entries).toEqual([{ event: "inbound" }, { event: "tool_call" }]);
  });
});

describe("kind, validity, user model, history search (0009 to 0014)", () => {
  let fresh: PGlite;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await fresh.query<T>(sql, params)).rows;

  beforeAll(async () => {
    // Own database, so the move out of agent_state finds real existing data.
    fresh = await freshDatabase();
    for (const name of migrationFiles().filter((file) => file < "0010")) await fresh.exec(migrationSql(name));
    await fresh.query(
      "insert into public.agent_state (key, value) values ('user_model', $1)",
      [JSON.stringify({ text: "# Mara\nWohnt in Cordheim." })],
    );
    for (const name of migrationFiles().filter((file) => file >= "0010")) await fresh.exec(migrationSql(name));
  }, 60_000);

  it("moves the user model from agent_state into version 1, exactly once", async () => {
    expect(await q("select base, source from public.user_model_versions")).toEqual([
      { base: "# Mara\nWohnt in Cordheim.", source: "seed" },
    ]);
    expect(await q("select key from public.agent_state where key = 'user_model'")).toEqual([]);
    await fresh.exec(migrationSql("0010_user_model_versions.sql"));
    expect(await q("select count(*)::int as n from public.user_model_versions")).toEqual([{ n: 1 }]);
  });

  it("creates old facts as identity without expiry and checks kind and order", async () => {
    const [row] = await q<{ kind: string; valid_until: Date | null }>(
      "insert into public.facts (category, content) values ('x', 'Mara mag Tee.') returning kind, valid_until",
    );
    expect(row).toEqual({ kind: "identity", valid_until: null });
    await expect(
      fresh.query("insert into public.facts (category, content, kind) values ('x', 'y', 'laune')"),
    ).rejects.toThrow(/facts_kind_check/);
    await expect(
      fresh.query(
        "insert into public.facts (category, content, valid_from, valid_until) values ('x', 'y', '2026-10-02', '2026-10-01')",
      ),
    ).rejects.toThrow(/facts_validity_order/);
  });

  it("accepts only the six areas or none for facts (0024)", async () => {
    const [row] = await q<{ area: string | null }>("insert into public.facts (category, content) values ('x', 'Mara mag Kaffee.') returning area");
    expect(row).toEqual({ area: null });
    await fresh.query("insert into public.facts (category, content, area) values ('x', 'Maras Geburtstag ist am 3. Oktober.', 'jahrestage')");
    await expect(fresh.query("insert into public.facts (category, content, area) values ('x', 'y', 'hobbys')")).rejects.toThrow(/facts_area_check/);
  });

  it("leaves expired facts out of recall, except for forget_fact, and shows future ones with valid_from", async () => {
    await fresh.query(
      `insert into public.facts (category, content, kind, valid_from, valid_until) values
        ('studium', 'Mara hat Prüfungsphase bis Ende August.', 'situation', null, '2026-08-31T22:00:00Z'),
        ('ernaehrung', 'Mara isst ab November vegan.', 'preference', '2026-11-01T00:00:00Z', null)`,
    );
    const at = async (now: string, includeExpired = false) =>
      (
        await q<{ content: string; kind: string; valid_from: Date | null }>(
          "select content, kind, valid_from from public.search_facts('owner', null, 'Mara', 10, $1, $2)",
          [now, includeExpired],
        )
      ).map((row) => row.content);
    expect(await at("2026-08-20T10:00:00Z")).toContain("Mara hat Prüfungsphase bis Ende August.");
    expect(await at("2026-09-10T10:00:00Z")).not.toContain("Mara hat Prüfungsphase bis Ende August.");
    expect(await at("2026-09-10T10:00:00Z", true)).toContain("Mara hat Prüfungsphase bis Ende August.");
    expect(await at("2026-09-10T10:00:00Z")).toContain("Mara isst ab November vegan.");
    // Without a clock now() applies: the signature with four arguments stays callable.
    expect((await q("select * from public.search_facts('owner', null, 'Tee', 5)")).length).toBe(1);
  });

  it("searches Alex's history by full text, and only theirs", async () => {
    await fresh.query(
      `insert into public.messages (direction, peer, body, external_id, created_at) values
        ('inbound', '+490000000000', 'Der Vermieter will die Kaution erst im März zurückzahlen.', 'h-1', '2026-09-01T10:00:00Z'),
        ('outbound', '+490000000000', 'Dann setz ihm eine Frist.', 'h-2', '2026-09-01T10:01:00Z'),
        ('inbound', '+491111111111', 'Kaution von jemand anderem.', 'h-3', '2026-09-01T10:02:00Z')`,
    );
    const hits = await q<{ body: string }>(
      "select body from public.search_messages('+490000000000', null, 'Kaution', 5)",
    );
    expect(hits.map((row) => row.body)).toEqual(["Der Vermieter will die Kaution erst im März zurückzahlen."]);
    const window = await q(
      "select body from public.search_messages('+490000000000', null, 'Kaution', 5, '2026-09-02', null)",
    );
    expect(window).toEqual([]);
  });

  it("reports whether the full text matched", async () => {
    const hits = await q<{ content: string; text_hit: boolean }>(
      "select content, text_hit from public.search_facts('owner', null, 'Tee', 5)",
    );
    expect(hits).toEqual([{ content: "Mara mag Tee.", text_hit: true }]);
  });

  it("forgets summaries from the window of every version, not only the newest", async () => {
    const [first] = await q<{ id: string }>(
      "insert into public.messages (direction, peer, body, external_id, created_at) values ('inbound', '+490000000000', 'erste', 'f-1', '2026-05-01T10:00:00Z') returning id",
    );
    const [second] = await q<{ id: string }>(
      "insert into public.messages (direction, peer, body, external_id, created_at) values ('inbound', '+490000000000', 'zweite', 'f-2', '2026-06-01T10:00:00Z') returning id",
    );
    const [alt] = await q<{ id: string }>(
      "insert into public.facts (category, content, source_message_id) values ('x', 'Mara fährt Golf.', $1) returning id",
      [first!.id],
    );
    const [neu] = await q<{ id: string }>(
      "insert into public.facts (category, content, source_message_id) values ('x', 'Mara fährt ID.3.', $1) returning id",
      [second!.id],
    );
    await fresh.query("update public.facts set superseded_by = $1 where id = $2", [neu!.id, alt!.id]);
    await fresh.query(
      "insert into public.summaries (window_start, window_end, content) values ('2026-04-30', '2026-05-02', 'Mara hatte ein Auto.')",
    );
    const [result] = await q<{ summaries_deleted: number }>("select * from public.forget_fact($1)", [neu!.id]);
    expect(result?.summaries_deleted).toBe(1);
  });

  it("knows delivery as a component", async () => {
    await fresh.query("insert into public.component_status (component, status) values ('delivery', 'ok')");
    await expect(
      fresh.query("insert into public.component_status (component, status) values ('kanal', 'ok')"),
    ).rejects.toThrow(/component_status_component_check/);
  });
});

describe("proposals and procedures (0012, 0015, D42)", () => {
  let procedureId: string;

  beforeAll(async () => {
    const [proposal] = await rows<{ id: string }>(
      `insert into public.memory_proposals (kind, title, body, trigger, status, offer_external_id, offered_at)
       values ('procedure', 'Postfach aufräumen', '1. Spam-Ordner', 'Alex will sein Postfach aufräumen', 'offered', 'offer-1', now())
       returning id`,
    );
    const [procedure] = await rows<{ id: string }>(
      `insert into public.procedures (title, body, trigger, embedding, proposal_id)
       values ('Postfach aufräumen', '1. Spam-Ordner', 'Alex will sein Postfach aufräumen', $1, $2) returning id`,
      [embedding(3), proposal!.id],
    );
    procedureId = procedure!.id;
  });

  it("allows only known kinds and states", async () => {
    await expect(
      db.query("insert into public.memory_proposals (kind, body) values ('stil', 'x')"),
    ).rejects.toThrow(/memory_proposals_kind_check/);
    await expect(
      db.query("insert into public.memory_proposals (kind, body, status) values ('lesson', 'x', 'vielleicht')"),
    ).rejects.toThrow(/memory_proposals_status_check/);
  });

  it("returns similarity and shared terms as raw values, the code sets the threshold", async () => {
    const [byVector] = await rows<{ id: string; similarity: number; shared_terms: number }>(
      "select * from public.search_procedures($1, $2, $3)",
      [embedding(3), "", 5],
    );
    expect(byVector?.id).toBe(procedureId);
    expect(Number(byVector?.similarity)).toBeCloseTo(1);
    expect(byVector?.shared_terms).toBe(0);

    const [byText] = await rows<{ similarity: number; shared_terms: number }>(
      "select * from public.search_procedures(null, $1, 5)",
      ["kannst du mein Postfach aufräumen?"],
    );
    expect(Number(byText?.similarity)).toBe(0);
    expect(byText?.shared_terms).toBe(2);

    const [unrelated] = await rows<{ similarity: number; shared_terms: number }>(
      "select * from public.search_procedures($1, $2, 5)",
      [embedding(800), "wie wird das wetter morgen"],
    );
    expect(Number(unrelated?.similarity)).toBeCloseTo(0);
    expect(unrelated?.shared_terms).toBe(0);
  });

  it("sets the origin to null when the proposal disappears, the procedure stays", async () => {
    // `deleteProcedure` deletes both in code; the database alone only keeps the reference clean.
    const [procedure] = await rows<{ proposal_id: string }>("select proposal_id from public.procedures where id = $1", [procedureId]);
    await db.query("delete from public.memory_proposals where id = $1", [procedure!.proposal_id]);
    expect(await rows("select proposal_id from public.procedures where id = $1", [procedureId])).toEqual([{ proposal_id: null }]);
  });
});

describe("web interface and vault: the role serain_web (0016, D49)", () => {
  let fresh: PGlite;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await fresh.query<T>(sql, params)).rows;
  const asWeb = async <T>(fn: () => Promise<T>): Promise<T> => {
    await fresh.exec("set role serain_web");
    try {
      return await fn();
    } finally {
      await fresh.exec("reset role");
    }
  };
  const hash = (char: string) => char.repeat(64);

  beforeAll(async () => {
    fresh = await freshDatabase();
    for (const name of migrationFiles()) await fresh.exec(migrationSql(name));
    const [fact] = await q<{ id: string }>("insert into public.facts (category, content) values ('wohnen', 'Alex wohnt in Cordheim.') returning id");
    await fresh.exec(`
      insert into public.audit_log (event, detail) values
        ('inbound', '{"chars": 12}'),
        ('model_call', '{"model": "x"}'),
        ('tool_call', '{"tool": "send_message", "level": "write_reversible", "args": {"text": "geheimer Chattext"}, "ok": true}'),
        ('tool_call', '{"tool": "mail_send", "level": "irreversible", "args": {"to": ["a@b.de"]}, "ok": true, "result": "${"x".repeat(900)}"}'),
        ('tool_call', '{"tool": "mail_search", "level": "read", "args": {"from": "bahn"}, "ok": true}'),
        ('tool_call', '{"tool": "run_task", "level": "read", "args": {"task": "Wetter"}, "ok": true}'),
        ('tool_denied', '{"tool": "end_turn", "reason": "owner_unanswered"}'),
        ('inbound_rejected', '{"peer": "+4900"}'),
        ('heartbeat', '{"ran": false}'),
        ('memory_fact', '{"count": 0}'),
        ('memory_fact', '{"fact_id": "${fact!.id}", "decision": "new"}'),
        ('tool_call', '{"tool": "overview", "level": "read", "args": {}, "ok": true}'),
        ('tool_call', '{"tool": "give_feedback", "level": "write_reversible", "args": {"kind": "missing", "description": "x"}, "ok": true}'),
        ('feedback', '{"kind": "missing", "description": "Kann keine PDF-Formulare ausfüllen.", "tainted": false}'),
        ('reaction_feedback', '{"meaning": "correction", "emoji": "👎"}');
      insert into public.audit_log (event, actor, detail) values ('tool_call', 'eval', '{"tool": "mail_send", "level": "irreversible"}');
      insert into public.integrations (id, kind, account, sealed) values ('gmx', 'imap', 'alex@example.org', 'v1.geheim');
      insert into public.vault_entries (site, username, hosts, login_url, key_id, sealed)
        values ('bahn', 'alex', '{bahn.de}', 'https://www.bahn.de/login', 'AAAAAAAAAAA', 'sv1.geheim');
      insert into public.web_enrollments (token_hash, expires_at) values ('${hash("a")}', now() + interval '10 minutes');
      insert into public.web_enrollments (token_hash, expires_at) values ('${hash("b")}', now() - interval '1 minute');
    `);
  }, 60_000);

  it("reads nothing outside its views", async () => {
    for (const table of ["audit_log", "vault_entries", "integrations", "facts", "messages", "summaries", "approvals", "agent_state", "web_enrollments", "user_model_versions", "connectors", "connector_clients"]) {
      await expect(asWeb(() => q(`select * from public.${table}`)), table).rejects.toThrow(/permission denied/);
    }
  });

  it("sees the vault without the sealed data", async () => {
    const [entry] = await asWeb(() => q("select * from public.web_vault"));
    expect(entry).toMatchObject({ site: "bahn", username: "alex", hosts: ["bahn.de"] });
    expect(entry).not.toHaveProperty("sealed");
  });

  it("does not write directly, not to the audit log nor to passkeys", async () => {
    await expect(asWeb(() => q("insert into public.audit_log (event) values ('web_login')"))).rejects.toThrow(/permission denied/);
    await expect(asWeb(() => q("insert into public.vault_entries (site, username, hosts, login_url, key_id, sealed) values ('x1', 'u', '{x.de}', 'https://x.de', 'AAAAAAAAAAA', 'sv1.x')"))).rejects.toThrow(/permission denied/);
    await expect(asWeb(() => q("insert into public.web_passkeys (id, public_key) values ('AAAAAAAAAAAAAAAAAAAA', '\\x00')"))).rejects.toThrow(/permission denied/);
    await expect(asWeb(() => q("update public.web_passkeys set public_key = '\\x00'"))).rejects.toThrow(/permission denied/);
  });

  it("may execute only its own functions", async () => {
    const callable = (
      await q<{ proname: string }>(`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('serain_web', p.oid, 'execute')
        order by p.proname
      `)
    ).map((row) => row.proname);
    expect(callable).toEqual([
      "web_audit_append", "web_connector_disconnect", "web_connector_finish", "web_connector_start",
      "web_enrollment_valid", "web_register_passkey", "web_vault_delete", "web_vault_file_delete", "web_vault_file_put", "web_vault_put",
    ]);
  });

  it("registers a passkey only against a valid one-time code, and the code only once", async () => {
    const register = (token: string, id: string) =>
      asWeb(() => q<{ ok: boolean }>("select public.web_register_passkey($1, $2, '\\x0102', 0, '{internal}', 'Mac') as ok", [token, id]));
    expect(await asWeb(() => q("select public.web_enrollment_valid($1) as ok", [hash("a")]))).toEqual([{ ok: true }]);
    expect(await register(hash("b"), "BBBBBBBBBBBBBBBBBBBB")).toEqual([{ ok: false }]);
    expect(await register(hash("c"), "CCCCCCCCCCCCCCCCCCCC")).toEqual([{ ok: false }]);
    expect(await register(hash("a"), "AAAAAAAAAAAAAAAAAAAA")).toEqual([{ ok: true }]);
    expect(await register(hash("a"), "DDDDDDDDDDDDDDDDDDDD")).toEqual([{ ok: false }]);
    expect(await q("select id from public.web_passkeys")).toEqual([{ id: "AAAAAAAAAAAAAAAAAAAA" }]);
    expect(await q("select event, actor from public.audit_log where event = 'web_passkey_added'")).toEqual([{ event: "web_passkey_added", actor: "web" }]);
  });

  it("changes the vault only with an audit entry, without the sealed data in it", async () => {
    await asWeb(() => q("select public.web_vault_put('amazon', 'v@x.de', '{amazon.de}', 'https://www.amazon.de/ap/signin', true, 'AAAAAAAAAAA', 'sv1.a.b.c.d')"));
    await asWeb(() => q("select public.web_vault_put('amazon', 'v@y.de', '{amazon.de}', 'https://www.amazon.de/ap/signin', false, 'AAAAAAAAAAA', 'sv1.e.f.g.h')"));
    expect(await asWeb(() => q("select public.web_vault_delete('bahn') as ok"))).toEqual([{ ok: true }]);
    expect(await asWeb(() => q("select public.web_vault_delete('bahn') as ok"))).toEqual([{ ok: false }]);
    expect(await q("select site, username, sealed from public.vault_entries")).toEqual([{ site: "amazon", username: "v@y.de", sealed: "sv1.e.f.g.h" }]);
    const log = await q<{ event: string; detail: Record<string, unknown> }>("select event, detail from public.audit_log where event like 'vault_%' order by id");
    expect(log.map((row) => [row.event, row.detail["replaced"] ?? null])).toEqual([["vault_saved", false], ["vault_saved", true], ["vault_deleted", null]]);
    expect(JSON.stringify(log)).not.toContain("sv1");
    await expect(asWeb(() => q("select public.web_vault_put('Böse!', 'u', '{x.de}', 'https://x.de', false, 'AAAAAAAAAAA', 'sv1.x')"))).rejects.toThrow(/check constraint/);
    await expect(asWeb(() => q("select public.web_vault_put('evil', 'u', '{x.de}', 'http://x.de', false, 'AAAAAAAAAAA', 'sv1.x')"))).rejects.toThrow(/check constraint/);
  });

  it("writes only sign-in events through web_audit_append", async () => {
    await asWeb(() => q("select public.web_audit_append('web_login', '{\"passkey\": \"AAAA\"}')"));
    await expect(asWeb(() => q("select public.web_audit_append('kill_switch_release', '{}')"))).rejects.toThrow(/not allowed/);
    await expect(asWeb(() => q("select public.web_audit_append('vault_saved', '{}')"))).rejects.toThrow(/not allowed/);
  });

  it("shows only what matters in the audit, without chat text, without eval, with a shortened result", async () => {
    const shown = await asWeb(() =>
      q<{ event: string; category: string; detail: Record<string, unknown>; fact: string | null }>("select event, category, detail, fact from public.web_audit order by id"),
    );
    const tools = shown.filter((row) => row.event === "tool_call").map((row) => [row.detail["tool"], row.category]);
    expect(tools).toEqual([["mail_send", "action"], ["mail_search", "access"], ["run_task", "action"]]);
    expect(shown.map((row) => row.event)).not.toContain("inbound");
    expect(shown.map((row) => row.event)).not.toContain("model_call");
    expect(shown.map((row) => row.event)).not.toContain("heartbeat");
    expect(shown.map((row) => row.event)).not.toContain("tool_denied");
    expect(JSON.stringify(shown)).not.toContain("geheimer Chattext");
    expect(String(shown.find((row) => row.detail["tool"] === "mail_send")?.detail["result"]).length).toBe(500);
    expect(shown.find((row) => row.event === "inbound_rejected")?.category).toBe("security");
    expect(shown.filter((row) => row.event === "memory_fact")).toEqual([
      expect.objectContaining({ category: "memory", fact: "Alex wohnt in Cordheim." }),
    ]);
    expect(shown.filter((row) => row.event === "vault_saved")).toHaveLength(2);
    // Serain's feedback is its own category, the call for it does not appear again; Alex's 👎 does not appear.
    expect(shown.filter((row) => row.event === "feedback")).toEqual([
      expect.objectContaining({ category: "feedback", detail: expect.objectContaining({ description: "Kann keine PDF-Formulare ausfüllen." }) }),
    ]);
    expect(shown.map((row) => row.event)).not.toContain("reaction_feedback");
  });

  it("shows the memory: valid facts, newest user model, procedures", async () => {
    await fresh.exec(`
      insert into public.user_model_versions (base, source, created_at) values ('alt', 'seed', now() - interval '1 day'), ('neu', 'push', now());
      insert into public.facts (category, content, superseded_by) select 'wohnen', 'Alex wohnt in Altstadt.', id from public.facts limit 1;
      insert into public.procedures (title, body, trigger) values ('Bahn', 'Erst Sparpreis', 'Zugfahrt');
    `);
    expect(await asWeb(() => q("select base from public.web_user_model"))).toEqual([{ base: "neu" }]);
    expect((await asWeb(() => q<{ content: string }>("select content from public.web_facts"))).map((row) => row.content)).toEqual(["Alex wohnt in Cordheim."]);
    expect(await asWeb(() => q("select title from public.web_procedures"))).toEqual([{ title: "Bahn" }]);
  });

  it("manages sessions and challenges itself, passkeys only for the counter", async () => {
    await asWeb(async () => {
      await q("insert into public.web_challenges (challenge, purpose, expires_at) values ('abcdefghijklmnopqrst', 'login', now() + interval '5 minutes')");
      await q("insert into public.web_sessions (token_hash, passkey_id, expires_at) values ($1, 'AAAAAAAAAAAAAAAAAAAA', now() + interval '1 hour')", [hash("e")]);
      await q("update public.web_sessions set last_seen_at = now(), verified_at = now()");
      await q("update public.web_passkeys set counter = 5, last_used_at = now()");
      await q("delete from public.web_challenges");
    });
    await expect(asWeb(() => q("update public.web_sessions set passkey_id = 'x'"))).rejects.toThrow(/permission denied/);
    await q("delete from public.web_passkeys");
    expect(await q("select * from public.web_sessions")).toEqual([]);
  });
});

describe("connections from the web interface (0017, D51)", () => {
  let fresh: PGlite;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await fresh.query<T>(sql, params)).rows;
  const asWeb = async <T>(fn: () => Promise<T>): Promise<T> => {
    await fresh.exec("set role serain_web");
    try {
      return await fn();
    } finally {
      await fresh.exec("reset role");
    }
  };
  const start = (id: string) => asWeb(() => q<{ ok: boolean }>("select public.web_connector_start($1, 'http://localhost:8787') as ok", [id]));
  const finish = (id: string, state: string, callback: string | null, error: string | null) =>
    asWeb(() => q<{ ok: boolean }>("select public.web_connector_finish($1, $2, $3, $4) as ok", [id, state, callback, error]));
  const disconnect = (id: string) => asWeb(() => q<{ ok: boolean }>("select public.web_connector_disconnect($1) as ok", [id]));
  const status = async (id: string) => (await q<{ status: string }>("select status from public.connectors where id = $1", [id]))[0]?.status ?? null;
  const authorize = (id: string, stateHash: string) =>
    q("update public.connectors set status = 'authorizing', authorize_url = 'https://anbieter.example/authorize?x=1', state_hash = $2, pending = 'v1.p' where id = $1", [id, stateHash]);

  beforeAll(async () => {
    fresh = await freshDatabase();
    for (const name of migrationFiles()) await fresh.exec(migrationSql(name));
  }, 60_000);

  it("starts, hands out the authorize URL only during authorization and never the sealed columns", async () => {
    expect(await start("bank")).toEqual([{ ok: true }]);
    expect(await status("bank")).toBe("starting");
    await authorize("bank", "a".repeat(64));
    const [row] = await asWeb(() => q("select * from public.web_connectors where id = 'bank'"));
    expect(row).toMatchObject({ status: "authorizing", authorize_url: "https://anbieter.example/authorize?x=1" });
    for (const column of ["pending", "callback", "sealed", "state_hash", "origin"]) expect(row).not.toHaveProperty(column);
    await q("update public.connectors set status = 'connected', sealed = 'v1.s', authorize_url = 'https://alt.example' where id = 'bank'");
    const [connected] = await asWeb(() => q<{ authorize_url: string | null }>("select authorize_url from public.web_connectors where id = 'bank'"));
    expect(connected?.authorize_url).toBeNull();
  });

  it("does not overwrite an existing connection unless it has expired", async () => {
    expect(await start("bank")).toEqual([{ ok: false }]);
    expect(await status("bank")).toBe("connected");
    await q("update public.connectors set expires_at = now() - interval '1 day' where id = 'bank'");
    expect(await start("bank")).toEqual([{ ok: true }]);
    expect(await status("bank")).toBe("starting");
  });

  it("accepts the callback only with the right state and only once", async () => {
    await start("coros");
    await authorize("coros", "b".repeat(64));
    expect(await finish("coros", "c".repeat(64), "sv1.x", null)).toEqual([{ ok: false }]);
    expect(await finish("bank", "b".repeat(64), "sv1.x", null)).toEqual([{ ok: false }]);
    expect(await finish("coros", "b".repeat(64), "sv1.rueckweg", null)).toEqual([{ ok: true }]);
    expect(await finish("coros", "b".repeat(64), "sv1.nochmal", null)).toEqual([{ ok: false }]);
    expect(await q("select status, callback from public.connectors where id = 'coros'")).toEqual([{ status: "finishing", callback: "sv1.rueckweg" }]);
    await expect(finish("coros", "b".repeat(64), "kein-versiegeltes", null)).resolves.toEqual([{ ok: false }]);
  });

  it("lets an old callback lapse and records a refusal as an error", async () => {
    await start("konto");
    await authorize("konto", "d".repeat(64));
    await q("update public.connectors set requested_at = now() - interval '20 minutes' where id = 'konto'");
    expect(await finish("konto", "d".repeat(64), "sv1.x", null)).toEqual([{ ok: false }]);
    expect(await finish("konto", "d".repeat(64), null, "access_denied")).toEqual([{ ok: true }]);
    expect(await q("select status, error from public.connectors where id = 'konto'")).toEqual([{ status: "failed", error: "Not approved at the provider: access_denied" }]);
  });

  it("disconnects through the server and deletes a started one immediately, each with an audit entry", async () => {
    await q("update public.connectors set status = 'connected' where id = 'coros'");
    expect(await disconnect("coros")).toEqual([{ ok: true }]);
    expect(await status("coros")).toBe("disconnecting");
    expect(await disconnect("konto")).toEqual([{ ok: true }]);
    expect(await status("konto")).toBeNull();
    expect(await disconnect("gibtsnicht")).toEqual([{ ok: false }]);
    const log = await q<{ event: string; actor: string }>("select event, actor from public.audit_log where event like 'connector_%' order by id");
    expect(log.filter((row) => row.event === "connector_requested")).toHaveLength(4);
    expect(log.filter((row) => row.event === "connector_disconnect_requested")).toHaveLength(2);
    expect(log.every((row) => row.actor === "web")).toBe(true);
  });

  it("does not write to the tables directly and shows the new events in the audit", async () => {
    await expect(asWeb(() => q("update public.connectors set status = 'connected'"))).rejects.toThrow(/permission denied/);
    await expect(asWeb(() => q("insert into public.connector_clients (issuer, redirect_uri, sealed) values ('https://x', 'http://y', 'v1.z')"))).rejects.toThrow(/permission denied/);
    await q("insert into public.audit_log (event, detail) values ('connector_connected', '{\"id\": \"bank\"}')");
    const shown = await asWeb(() => q<{ event: string; category: string }>("select event, category from public.web_audit where event like 'connector_%'"));
    expect(shown.some((row) => row.event === "connector_connected" && row.category === "security")).toBe(true);
  });

  it("shows calls without a preview, because Alex named them, as a security event (0018)", async () => {
    await q("insert into public.audit_log (event, detail) values ('approval_waived', '{\"tool\": \"mail_cleanup\", \"named_by_owner\": \"kelvo\"}')");
    const shown = await asWeb(() => q<{ event: string; category: string }>("select event, category from public.web_audit where event = 'approval_waived'"));
    expect(shown).toEqual([{ event: "approval_waived", category: "security" }]);
  });

  it("shows scheduled, cancelled and missed approvals as security events (0026)", async () => {
    await q(
      "insert into public.audit_log (event, detail) values ('approval_scheduled', '{\"tool\": \"mail_send\"}'), ('approval_cancelled', '{}'), ('approval_missed', '{}'), ('approval_due', '{}'), ('approval_later_refused', '{}')",
    );
    const shown = await asWeb(() =>
      q<{ event: string; category: string }>(
        "select event, category from public.web_audit where event in ('approval_scheduled', 'approval_cancelled', 'approval_missed', 'approval_due', 'approval_later_refused') order by event",
      ),
    );
    expect(shown).toEqual([
      { event: "approval_cancelled", category: "security" },
      { event: "approval_due", category: "security" },
      { event: "approval_later_refused", category: "security" },
      { event: "approval_missed", category: "security" },
      { event: "approval_scheduled", category: "security" },
    ]);
  });

  it("shows reissued and refused reissues of previews as security events (0029)", async () => {
    await q("insert into public.audit_log (event, detail) values ('approval_reissued', '{\"tool\": \"calendar_offer\"}'), ('approval_reissue_refused', '{\"reason\": \"stale\"}')");
    const shown = await asWeb(() =>
      q<{ event: string; category: string }>("select event, category from public.web_audit where event like 'approval_reissue%' order by event"),
    );
    expect(shown).toEqual([
      { event: "approval_reissue_refused", category: "security" },
      { event: "approval_reissued", category: "security" },
    ]);
  });

  it("shows recovered and interrupted work as system events and keeps tasks away from the web interface (0019)", async () => {
    await q("insert into public.audit_log (event, detail) values ('turn_recovered', '{\"actions\": 0}'), ('task_interrupted', '{}'), ('approval_interrupted', '{\"tool\": \"mail_send\"}')");
    const shown = await asWeb(() =>
      q<{ event: string; category: string }>("select event, category from public.web_audit where event like '%_recovered' or event like '%_interrupted' order by event"),
    );
    expect(shown).toEqual([
      { event: "approval_interrupted", category: "security" },
      { event: "task_interrupted", category: "system" },
      { event: "turn_recovered", category: "system" },
    ]);
    await expect(asWeb(() => q("select task from public.tasks"))).rejects.toThrow(/permission denied/);
  });
});

describe("files in the vault (0022, addendum to D49)", () => {
  let fresh: PGlite;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await fresh.query<T>(sql, params)).rows;
  const asWeb = async <T>(fn: () => Promise<T>): Promise<T> => {
    await fresh.exec("set role serain_web");
    try {
      return await fn();
    } finally {
      await fresh.exec("reset role");
    }
  };
  /** Sealed as large as fits the size: 102 bytes of sealing, 4 for the length field, header, content. */
  const sealed = (size: number, head = 200) => new Uint8Array(size + 106 + head);
  const put = (name: string, size: number, blob = sealed(size)) =>
    asWeb(() => q<{ status: string }>("select public.web_vault_file_put($1, 'Ausweis.pdf', 'application/pdf', $2, 'AAAAAAAAAAA', $3) as status", [name, size, blob]));

  beforeAll(async () => {
    fresh = await freshDatabase();
    for (const name of migrationFiles()) await fresh.exec(migrationSql(name));
  }, 60_000);

  it("stores only through the function, with an audit entry, and never shows the sealed data", async () => {
    expect(await put("ausweis", 1000)).toEqual([{ status: "ok" }]);
    expect(await put("ausweis", 2000)).toEqual([{ status: "ok" }]);
    const [shown] = await asWeb(() => q("select * from public.web_vault_files"));
    expect(shown).toMatchObject({ name: "ausweis", filename: "Ausweis.pdf", size: 2000 });
    expect(shown).not.toHaveProperty("sealed");
    await expect(asWeb(() => q("select sealed from public.vault_files"))).rejects.toThrow(/permission denied/);
    await expect(asWeb(() => q("insert into public.vault_files (name, filename, mime_type, size, key_id, sealed) values ('x1', 'x', 'a/b', 1, 'AAAAAAAAAAA', '\\x00')"))).rejects.toThrow(/permission denied/);
    const log = await q<{ detail: { name: string; replaced: boolean } }>("select detail from public.audit_log where event = 'vault_file_saved' order by id");
    expect(log.map((row) => row.detail.replaced)).toEqual([false, true]);
    expect(await asWeb(() => q("select public.web_vault_file_delete('ausweis') as ok"))).toEqual([{ ok: true }]);
    expect(await asWeb(() => q("select public.web_vault_file_delete('ausweis') as ok"))).toEqual([{ ok: false }]);
  });

  it("does not let the shown size lie and lets no file name with control characters through", async () => {
    await expect(put("luege", 1000, sealed(10))).rejects.toThrow(/check/);
    await expect(put("luege", 1000, sealed(1000, 5000))).rejects.toThrow(/check/);
    await expect(put("riesig", 10 * 1024 * 1024 + 1)).rejects.toThrow(/check/);
    await expect(
      asWeb(() => q("select public.web_vault_file_put('x1', $1, 'application/pdf', 10, 'AAAAAAAAAAA', $2)", ["a\nb.pdf", sealed(10)])),
    ).rejects.toThrow(/check/);
  });

  it("keeps count and total size under the free quota", async () => {
    for (let i = 0; i < 25; i += 1) expect(await put(`datei${i}`, 10)).toEqual([{ status: "ok" }]);
    expect(await put("datei25", 10)).toEqual([{ status: "too_many" }]);
    // Replacing an existing one does not count as a new one.
    expect(await put("datei0", 20)).toEqual([{ status: "ok" }]);
    await q("delete from public.vault_files");
    // Exactly 100 MB still fit, one byte more does not.
    for (let i = 0; i < 10; i += 1) expect(await put(`gross${i}`, 10 * 1024 * 1024)).toEqual([{ status: "ok" }]);
    expect(await put("klein", 1)).toEqual([{ status: "too_big" }]);
    expect(await put("gross0", 10 * 1024 * 1024 - 1)).toEqual([{ status: "ok" }]);
    expect(await put("klein", 1)).toEqual([{ status: "ok" }]);
    // Over 100 MB through PGlite: about 11 s locally, 23 s and more on a shared CI runner.
  }, 120_000);

  it("shows storing, deleting and every opening by Serain in the audit under security, the listing not", async () => {
    await q(`insert into public.audit_log (event, detail) values
      ('tool_call', '{"tool": "vault_file", "level": "write_reversible", "args": {"name": "ausweis", "send_to_owner": true}, "ok": true}'),
      ('tool_call', '{"tool": "vault_files", "level": "read", "args": {}, "ok": true}')`);
    const shown = await asWeb(() => q<{ event: string; category: string; tool: string | null }>("select event, category, detail ->> 'tool' as tool from public.web_audit where event like 'vault_file%' or detail ->> 'tool' like 'vault_file%'"));
    expect(shown.filter((row) => row.tool === "vault_files")).toEqual([]);
    expect(shown.find((row) => row.tool === "vault_file")?.category).toBe("security");
    expect(shown.filter((row) => row.event === "vault_file_saved").every((row) => row.category === "security")).toBe(true);
    expect(shown.some((row) => row.event === "vault_file_deleted" && row.category === "security")).toBe(true);
    // What 0018 and 0019 added stays.
    await q("insert into public.audit_log (event, detail) values ('approval_waived', '{}'), ('turn_recovered', '{}')");
    expect(await asWeb(() => q("select event, category from public.web_audit where event in ('approval_waived', 'turn_recovered') order by event"))).toEqual([
      { event: "approval_waived", category: "security" },
      { event: "turn_recovered", category: "system" },
    ]);
  });
});

describe("turns and tasks survive a crash (0019, D52)", () => {
  it("leaves old messages without a status and knows only the three states", async () => {
    await rows("insert into public.messages (direction, peer, body) values ('inbound', '+49', 'alt')");
    const [old] = await rows<{ turn_status: string | null }>("select turn_status from public.messages where body = 'alt'");
    expect(old?.turn_status).toBeNull();
    await rows("insert into public.messages (direction, peer, body, turn_status) values ('inbound', '+49', 'neu', 'pending')");
    await expect(rows("insert into public.messages (direction, peer, body, turn_status) values ('inbound', '+49', 'x', 'running')")).rejects.toThrow(/check/);
  });

  it("creates a task as running and keeps the origin loose", async () => {
    const [message] = await rows<{ id: string }>("insert into public.messages (direction, peer, body) values ('inbound', '+49', 'recherchier') returning id");
    const [task] = await rows<{ id: string; status: string; acked: boolean }>(
      "insert into public.tasks (task, trigger_message_id) values ('Wetter', $1) returning id, status, acked",
      [message!.id],
    );
    expect(task).toMatchObject({ status: "running", acked: false });
    await expect(rows("update public.tasks set status = 'failed' where id = $1", [task!.id])).rejects.toThrow(/check/);
    await rows("delete from public.messages where id = $1", [message!.id]);
    const [after] = await rows<{ trigger_message_id: string | null }>("select trigger_message_id from public.tasks where id = $1", [task!.id]);
    expect(after?.trigger_message_id).toBeNull();
  });
});

describe("the server clock as role serain_server (0030, addendum to D50)", () => {
  let fresh: PGlite;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await fresh.query<T>(sql, params)).rows;
  const asServer = async <T>(fn: () => Promise<T>): Promise<T> => {
    await fresh.exec("set role serain_server");
    try {
      return await fn();
    } finally {
      await fresh.exec("reset role");
    }
  };

  beforeAll(async () => {
    fresh = await freshDatabase();
    for (const name of migrationFiles()) await fresh.exec(migrationSql(name));
    await fresh.exec(`
      insert into public.agent_state (key, value) values
        ('kill_switch', '{"engaged": false}'), ('proactive_heartbeat', '{"sentCount": 2}');
      insert into public.integrations (id, kind, account, sealed, state) values ('gmx', 'imap', 'a@example.org', 'v1.geheim', '{"cursor": {"uidNext": 4}}');
      insert into public.approvals (tool, level, preview, token, preview_external_id, expires_at) values
        ('mail_send', 'irreversible', 'abgelaufen', gen_random_uuid()::text, 'p1', now() - interval '1 minute'),
        ('mail_send', 'irreversible', 'offen', gen_random_uuid()::text, 'p2', now() + interval '1 day');
    `);
  });

  it("reads the kill switch but no other state, and writes only the mail trigger", async () => {
    await asServer(async () => {
      expect(await q("select key from public.agent_state order by key")).toEqual([{ key: "kill_switch" }]);
      await q(`insert into public.agent_state (key, value, updated_at) values ('mail_trigger', '{"lastPolledAt": null}', now())
               on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`);
      await expect(q(`update public.agent_state set value = '{"engaged": false}' where key = 'kill_switch' returning key`)).resolves.toEqual([]);
      await expect(q(`insert into public.agent_state (key, value) values ('kill_switch_2', '{}')`)).rejects.toThrow(/row-level security/);
    });
    expect(await q("select value from public.agent_state where key = 'mail_trigger'")).toEqual([{ value: { lastPolledAt: null } }]);
  });

  it("sees only id and cursor of the accounts, never the sealed data", async () => {
    await asServer(async () => {
      expect(await q("select id, state from public.integrations")).toEqual([{ id: "gmx", state: { cursor: { uidNext: 4 } } }]);
      await expect(q("select sealed from public.integrations")).rejects.toThrow(/permission denied/);
      await q(`update public.integrations set state = '{"cursor": {"uidNext": 9}}', updated_at = now() where id = 'gmx'`);
      await expect(q("update public.integrations set account = 'x' where id = 'gmx'")).rejects.toThrow(/permission denied/);
    });
  });

  it("only lets previews expire, never approves them", async () => {
    await asServer(async () => {
      const expired = await q<{ preview: string }>(
        `update public.approvals set status = 'expired', decided_at = now(), decided_via = 'timeout'
         where status = 'pending' and expires_at <= now() returning preview`,
      );
      expect(expired).toEqual([{ preview: "abgelaufen" }]);
      await expect(q("update public.approvals set status = 'approved' where preview = 'offen'")).rejects.toThrow(/row-level security/);
      await expect(q("update public.approvals set tool = 'x' where preview = 'offen'")).rejects.toThrow(/permission denied/);
    });
  });

  it("reads what is due and writes its own health, nothing else", async () => {
    await asServer(async () => {
      for (const table of ["schedules", "watchers", "connectors", "mail_items", "incidents"]) await q(`select count(*) from public.${table}`);
      await q(`insert into public.component_status (component, status, detail, updated_at, last_ok_at) values ('db', 'ok', '{}', now(), now())
               on conflict (component) do update set status = excluded.status, updated_at = excluded.updated_at`);
      for (const denied of [
        "select count(*) from public.audit_log",
        "select count(*) from public.messages",
        "select count(*) from public.facts",
        "insert into public.schedules (kind, next_run_at, prompt) values ('once', now(), 'x')",
        "insert into public.incidents (component, root_cause) values ('db', 'x')",
        "delete from public.connectors",
      ]) {
        await expect(q(denied), denied).rejects.toThrow(/permission denied/);
      }
    });
  });
});

describe("full-text search in any language (0035)", () => {
  let fresh: PGlite;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await fresh.query<T>(sql, params)).rows;
  const facts = async (query: string) =>
    (await q<{ content: string; text_hit: boolean }>("select content, text_hit from public.search_facts('lang', null, $1, 10)", [query]))
      .filter((row) => row.text_hit)
      .map((row) => row.content);

  beforeAll(async () => {
    fresh = await freshDatabase();
    for (const name of migrationFiles()) await fresh.exec(migrationSql(name));
    await fresh.exec(`
      insert into public.facts (subject, category, content) values
        ('lang', 'aile', 'Annemin doğum günü 14 Mart''ta.'),
        ('lang', 'aile', 'Kız kardeşimin adı Defne, İzmir''de oturuyor.'),
        ('lang', 'familie', 'Alex'' Schwester heißt Defne.'),
        ('lang', 'family', 'Alex''s sister is called Defne.');
      insert into public.messages (direction, peer, body, external_id) values
        ('inbound', '+490000000001', 'Ev sahibi depozitoyu Mart''ta geri ödeyecek.', 'l-1'),
        ('inbound', '+490000000001', 'Der Vermieter zahlt die Kaution im März zurück.', 'l-2');
      insert into public.procedures (title, body, trigger) values
        ('Gelen kutusunu temizle', '1. Spam klasörü', 'Alex gelen kutusunu temizlemek istiyor');
    `);
  }, 60_000);

  it("builds every full-text column and search function on serain_text, no German stemming left", async () => {
    const columns = await q<{ col: string; expr: string }>(`
      select a.attname as col, pg_get_expr(d.adbin, d.adrelid) as expr
      from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attname in ('content_tsv', 'body_tsv', 'search_tsv') and not a.attisdropped
      order by a.attname
    `);
    expect(columns.map((row) => row.col)).toEqual(["body_tsv", "content_tsv", "search_tsv"]);
    for (const row of columns) expect(row.expr).toContain("serain_text");
    const bodies = await q<{ proname: string; src: string }>(
      "select p.proname, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'",
    );
    expect(bodies.filter((row) => /german/i.test(row.src)).map((row) => row.proname)).toEqual([]);
    for (const index of ["facts_content_tsv_idx", "messages_body_tsv_idx", "procedures_search_tsv_idx"]) {
      expect(await q("select 1 from pg_indexes where indexname = $1", [index])).toHaveLength(1);
    }
  });

  it("finds a fact by a Turkish word, unstemmed and case-insensitive", async () => {
    expect(await facts("doğum")).toEqual(["Annemin doğum günü 14 Mart'ta."]);
    expect(await facts("Doğum günü")).toEqual(["Annemin doğum günü 14 Mart'ta."]);
    expect(await facts("kardeşimin")).toEqual(["Kız kardeşimin adı Defne, İzmir'de oturuyor."]);
    expect(await facts("14")).toEqual(["Annemin doğum günü 14 Mart'ta."]);
  });

  it("finds a fact by German and English words, dropping their stop words", async () => {
    // "von" and "of" are stop words: only "schwester"/"sister" and "mirella" have to match.
    expect(await facts("Schwester von Defne")).toEqual(["Alex' Schwester heißt Defne."]);
    expect(await facts("the sister of Defne")).toEqual(["Alex's sister is called Defne."]);
    expect((await facts("Defne")).sort()).toEqual(
      ["Alex' Schwester heißt Defne.", "Alex's sister is called Defne.", "Kız kardeşimin adı Defne, İzmir'de oturuyor."].sort(),
    );
  });

  it("searches the history in Turkish and German", async () => {
    const history = async (query: string) =>
      (await q<{ body: string }>("select body from public.search_messages('+490000000001', null, $1, 5)", [query])).map((row) => row.body);
    expect(await history("depozitoyu")).toEqual(["Ev sahibi depozitoyu Mart'ta geri ödeyecek."]);
    expect(await history("Kaution")).toEqual(["Der Vermieter zahlt die Kaution im März zurück."]);
  });

  it("counts shared words for procedures in Turkish, and none for an unrelated message", async () => {
    const [match] = await q<{ shared_terms: number }>("select shared_terms from public.search_procedures(null, $1, 5)", [
      "gelen kutusunu temizler misin?",
    ]);
    expect(match?.shared_terms).toBe(2);
    const [unrelated] = await q<{ shared_terms: number }>("select shared_terms from public.search_procedures(null, $1, 5)", [
      "yarın hava nasıl olacak",
    ]);
    expect(unrelated?.shared_terms).toBe(0);
  });

  it("does not rebuild the columns on a second run", async () => {
    await fresh.query("insert into public.facts (subject, category, content) values ('lang', 'x', 'Zweiter Lauf.')");
    const before = await q<{ attnum: number }>("select attnum from pg_attribute where attrelid = 'public.facts'::regclass and attname = 'content_tsv'");
    await fresh.exec(migrationSql("0035_search_any_language.sql"));
    const after = await q<{ attnum: number }>("select attnum from pg_attribute where attrelid = 'public.facts'::regclass and attname = 'content_tsv'");
    expect(after).toEqual(before);
    expect(await facts("Lauf")).toEqual(["Zweiter Lauf."]);
  });
});

describe("English memory areas (0037)", () => {
  let fresh: PGlite;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await fresh.query<T>(sql, params)).rows;

  beforeAll(async () => {
    fresh = await freshDatabase();
    for (const name of migrationFiles().filter((file) => file < "0037")) await fresh.exec(migrationSql(name));
    await fresh.exec(`
      insert into public.facts (subject, category, content, area) values
        ('owner', 'x', 'Alex lives in Musterstadt.', 'orte'),
        ('owner', 'x', 'Alex likes tea.', 'praeferenzen'),
        ('owner', 'x', 'Unassigned.', null);
    `);
    await fresh.exec(migrationSql("0037_fact_areas_english.sql"));
  }, 60_000);

  it("moves stored rows to the English keys and leaves unassigned ones alone", async () => {
    const rows = await q<{ content: string; area: string | null }>("select content, area from public.facts order by content");
    expect(rows).toEqual([
      { content: "Alex likes tea.", area: "preferences" },
      { content: "Alex lives in Musterstadt.", area: "places" },
      { content: "Unassigned.", area: null },
    ]);
  });

  it("accepts the English keys and still the old ones, nothing else", async () => {
    await fresh.query("insert into public.facts (subject, category, content, area) values ('owner', 'x', 'New.', 'anniversaries')");
    await fresh.query("insert into public.facts (subject, category, content, area) values ('owner', 'x', 'Old.', 'jahrestage')");
    await expect(fresh.query("insert into public.facts (subject, category, content, area) values ('owner', 'x', 'Bad.', 'misc')")).rejects.toThrow();
  });
});
