import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { toBase64Url } from "../src/vault/sealbox.js";
import { projectRef, ROOT, ROOT_VARS, setting, writeVar } from "./dev-vars.js";
import { scramVerifier } from "./scram.js";

/**
 * The server's access to Postgres (0030, addendum to D50 of 2026-10-11). Runs on
 * the owner's machine, not on the server. Needs in `.dev.vars`:
 * `SUPABASE_URL`, `SUPABASE_DB_PASSWORD` (the project's database password),
 * `SUPABASE_POOLER_HOST` and `SERAIN_HOST`.
 *
 *   pnpm db:password   reset the password of the role serain_server
 *                      (→ SERAIN_DB_URL in .dev.vars and /etc/serain/serain.env)
 *
 * Only the SCRAM verifier goes to Supabase, never the password. Deploy afterwards
 * (`./deploy/deploy.sh`) so the service reads the new line.
 */

const SERVER_ENV = "/etc/serain/serain.env";

/**
 * Host of the session pooler (port 5432): holds the connection the clock keeps
 * open. Listed in the Supabase dashboard under Connect > Session pooler, e.g.
 * `aws-0-eu-central-1.pooler.supabase.com`; it depends on the project's region.
 */
function poolerHost(): string {
  const host = setting("SUPABASE_POOLER_HOST");
  if (!/^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(host)) {
    throw new Error("SUPABASE_POOLER_HOST is missing in .dev.vars (Supabase dashboard > Connect > Session pooler, host only, e.g. aws-0-eu-central-1.pooler.supabase.com).");
  }
  return host;
}

async function dbPassword(): Promise<void> {
  const admin = setting("SUPABASE_DB_PASSWORD");
  const host = setting("SERAIN_HOST");
  if (!admin) throw new Error("SUPABASE_DB_PASSWORD is missing in .dev.vars (database password of the Supabase project).");
  if (!/^[a-z_][a-z0-9_-]*@[A-Za-z0-9.:-]+$/.test(host)) throw new Error("SERAIN_HOST is missing in .dev.vars (root@<host>).");
  const ref = projectRef();
  const pooler = poolerHost();

  const password = toBase64Url(randomBytes(32));
  const sql = postgres({
    host: pooler,
    port: 5432,
    database: "postgres",
    username: `postgres.${ref}`,
    password: admin,
    ssl: { ca: readFileSync(join(ROOT, "web", "supabase-ca-2021.crt")), rejectUnauthorized: true },
    max: 1,
  });
  try {
    await sql.unsafe(`alter role serain_server with password '${scramVerifier(password)}'`);
  } finally {
    await sql.end();
  }

  const url = `postgresql://serain_server.${ref}:${password}@${pooler}:5432/postgres`;
  writeVar(ROOT_VARS, "SERAIN_DB_URL", url, "Server clock over Postgres as serain_server (0030). Gitignored.");
  // Same line on the server; the file belongs to root and is readable only by serain (deploy/README).
  execFileSync("ssh", ["-o", "BatchMode=yes", host, `sed -i '/^SERAIN_DB_URL=/d' ${SERVER_ENV} && cat >> ${SERVER_ENV}`], {
    input: `SERAIN_DB_URL=${url}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });
  console.log("Password for serain_server set (only as a SCRAM verifier to Supabase), SERAIN_DB_URL is in .dev.vars and on the server.");
  console.log("Now deploy (./deploy/deploy.sh) so the service reads it.");
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  if (command === "db-password") return dbPassword();
  console.log("pnpm db:password");
  process.exitCode = 1;
}

await main();
