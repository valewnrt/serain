import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { parseEnv } from "../src/config/dotenv.js";
import { projectRef, ROOT, ROOT_VARS } from "./dev-vars.js";

/**
 * `pnpm setup:check`: where a setup stands, step by step along docs/SETUP.md, and
 * what to do next. Runs on the owner's machine, changes nothing, and is built
 * for people and coding agents alike (`--json`, AGENTS.md).
 *
 *   pnpm setup:check             every check, readable
 *   pnpm setup:check --json      the same as JSON, for agents
 *   pnpm setup:check --offline   without SSH, database and network
 *
 * It never prints a value from `.dev.vars` or the server, only names and
 * states. It never connects to Photon (only one process may be connected at a
 * time, D38) and never calls a model. Exit code 1 while a required check fails.
 */

export type Status = "ok" | "warn" | "fail" | "skip";

export interface Check {
  /** Stable identifier, e.g. `server.env.local-only`. */
  id: string;
  /** Section of docs/SETUP.md, e.g. `A7`. */
  step: Step;
  status: Status;
  title: string;
  detail?: string;
  /** What to do, in one sentence; the guide section is `STEPS[step].anchor`. */
  fix?: string;
}

/** The sections of docs/SETUP.md the checks belong to; `test/setup-check.test.ts` checks that every anchor exists. */
export const STEPS = {
  A1: { title: "Prerequisites", anchor: "a1-prerequisites" },
  A2: { title: "Checkout and local configuration", anchor: "a2-checkout-and-local-configuration" },
  A3: { title: "Supabase", anchor: "a3-supabase" },
  A4: { title: "Photon (iMessage)", anchor: "a4-photon-imessage" },
  A5: { title: "Claude", anchor: "a5-claude" },
  A6: { title: "Server", anchor: "a6-server" },
  A7: { title: "Secrets to the server", anchor: "a7-secrets-to-the-server-and-pnpm-dbpassword" },
  A9: { title: "Deploy", anchor: "a9-deploy-and-first-message" },
  B: { title: "Optional features", anchor: "part-b-optional" },
} as const;

export type Step = keyof typeof STEPS;

// -----------------------------------------------------------------------------
// What .env.example declares
// -----------------------------------------------------------------------------

export interface VarSpec {
  name: string;
  /** Its comment block starts with "Required." */
  required: boolean;
  /** Title of the section it is in, e.g. "Owner (required unless marked optional)". */
  section: string;
}

/**
 * The variables of `.env.example`, the one place that declares them. A comment
 * block applies to every variable line right after it (Photon's ID and secret
 * share one); commented-out examples are not variables.
 */
export function parseEnvExample(text: string): VarSpec[] {
  const specs: VarSpec[] = [];
  const lines = text.split("\n");
  let section = "";
  let block: string[] = [];
  let blockUsed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (/^# -{10,}$/.test(line)) {
      const title = lines[index + 1]?.trim() ?? "";
      if (title.startsWith("# ") && !/^# -{10,}$/.test(title)) section = title.slice(2);
      index += 2; // title and closing rule
      block = [];
      continue;
    }
    if (line.startsWith("#")) {
      if (blockUsed) {
        block = [];
        blockUsed = false;
      }
      block.push(line.replace(/^#\s?/, ""));
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) {
      specs.push({ name: match[1]!, required: /^Required\./.test(block[0] ?? ""), section });
      blockUsed = true;
      continue;
    }
    block = [];
    blockUsed = false;
  }
  return specs;
}

export const isLocalOnly = (spec: VarSpec): boolean => spec.section.startsWith("Local only");
/** Paths that are meant to differ between your machine and the server (on the server Chrome is /usr/local/bin/serain-chromium). */
const MACHINE_SPECIFIC = new Set(["SERAIN_CHROME_PATH"]);

/** Set by deploy/serain.service on the server, so not expected in its env file. */
export const isRuntime = (spec: VarSpec): boolean => spec.section.startsWith("Runtime");

/** Which step of the guide a required variable belongs to. */
export function stepOf(spec: VarSpec): Step {
  if (spec.name === "SERAIN_DB_URL") return "A7";
  if (spec.section.startsWith("Owner")) return "A2";
  if (spec.section.startsWith("Database")) return "A3";
  if (spec.section.startsWith("iMessage")) return "A4";
  if (spec.section.startsWith("Claude")) return "A5";
  return "B";
}

/** Owner settings are not secret; every other value is never shown, not even inside a message. */
const SHOWABLE = new Set(["OWNER_NAME", "OWNER_TIMEZONE", "OWNER_LANGUAGE", "OWNER_COUNTRY", "OWNER_REGION", "OWNER_CITY"]);

export function redactor(vars: Record<string, string>): (text: string) => string {
  const values = Object.entries(vars)
    .filter(([name, value]) => !SHOWABLE.has(name) && value.length >= 6)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  return (text) => values.reduce((result, value) => result.split(value).join("[redacted]"), text);
}

// -----------------------------------------------------------------------------
// Checks without input/output: configuration and server state as data
// -----------------------------------------------------------------------------

const set = (vars: Record<string, string>, name: string): boolean => Boolean(vars[name]);

/** `.dev.vars` against `.env.example`: what is missing or malformed, per step. */
export function configChecks(vars: Record<string, string>, specs: readonly VarSpec[]): Check[] {
  const checks: Check[] = [];
  const missingByStep = new Map<Step, string[]>();
  for (const spec of specs) {
    if (!spec.required || isLocalOnly(spec) || set(vars, spec.name)) continue;
    const step = stepOf(spec);
    missingByStep.set(step, [...(missingByStep.get(step) ?? []), spec.name]);
  }
  for (const step of ["A2", "A3", "A4", "A7", "B"] as const) {
    const missing = missingByStep.get(step);
    if (step === "A7") {
      checks.push(
        missing
          ? { id: "local.db-url", step, status: "fail", title: "SERAIN_DB_URL is not set", fix: "Run pnpm db:password once the server is provisioned (A6); it writes SERAIN_DB_URL here and on the server." }
          : { id: "local.db-url", step, status: "ok", title: "SERAIN_DB_URL is set" },
      );
      continue;
    }
    if (missing) {
      checks.push({ id: `local.required.${step}`, step, status: "fail", title: `Required in .dev.vars: ${missing.join(", ")}`, fix: `Fill in these values in .dev.vars as described in docs/SETUP.md ${step}.` });
    } else if (step !== "B") {
      checks.push({ id: `local.required.${step}`, step, status: "ok", title: "Required values are set" });
    }
  }

  if (set(vars, "SUPABASE_URL")) {
    try {
      projectRef(vars["SUPABASE_URL"]);
      checks.push({ id: "local.supabase-url", step: "A3", status: "ok", title: "SUPABASE_URL points to a Supabase project" });
    } catch {
      checks.push({ id: "local.supabase-url", step: "A3", status: "fail", title: "SUPABASE_URL is not https://<project-ref>.supabase.co", fix: "Copy the project URL from the Supabase dashboard." });
    }
  }
  if (set(vars, "SUPABASE_SECRET_KEY") && !vars["SUPABASE_SECRET_KEY"]!.startsWith("sb_secret_")) {
    checks.push({ id: "local.supabase-key", step: "A3", status: "fail", title: "SUPABASE_SECRET_KEY is not a secret key (sb_secret_...)", fix: "Use the secret key from Project Settings > API Keys, never the publishable or a legacy service key." });
  }
  if (!set(vars, "SERAIN_DB_URL")) {
    const needed = ["SUPABASE_DB_PASSWORD", "SUPABASE_POOLER_HOST", "SERAIN_HOST"].filter((name) => !set(vars, name));
    if (needed.length > 0) checks.push({ id: "local.db-password-inputs", step: "A7", status: "fail", title: `pnpm db:password needs: ${needed.join(", ")}`, fix: "Add them to .dev.vars (A3 for the Supabase values, A6 for SERAIN_HOST)." });
  }

  const apiKey = vars["ANTHROPIC_API_KEY"] ?? "";
  const token = vars["CLAUDE_CODE_OAUTH_TOKEN"] ?? "";
  if (apiKey) {
    checks.push(
      apiKey.startsWith("sk-ant-api")
        ? { id: "local.claude", step: "A5", status: "ok", title: "Claude through an API key" + (token ? " (the token is ignored while the key is set)" : "") }
        : { id: "local.claude", step: "A5", status: "fail", title: "ANTHROPIC_API_KEY is not an API key (sk-ant-api...)", fix: "Create a key in the Anthropic Console." },
    );
  } else if (token) {
    checks.push(
      token.startsWith("sk-ant-oat")
        ? { id: "local.claude", step: "A5", status: "ok", title: "Claude through your own subscription token (personal use only)" }
        : { id: "local.claude", step: "A5", status: "fail", title: "CLAUDE_CODE_OAUTH_TOKEN is not a subscription token (sk-ant-oat...)", fix: "Run claude setup-token." },
    );
  } else if (set(vars, "OPENROUTER_API_KEY")) {
    checks.push({ id: "local.claude", step: "A5", status: "warn", title: "No Claude access: every call goes through the OpenRouter fallback", fix: "Set ANTHROPIC_API_KEY; the prompts are tuned for Claude." });
  } else {
    checks.push({ id: "local.claude", step: "A5", status: "fail", title: "Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set", fix: "Create an API key in the Anthropic Console and set ANTHROPIC_API_KEY." });
  }

  if (set(vars, "SERAIN_HOST") && !/^[^@\s]+@[^@\s]+$/.test(vars["SERAIN_HOST"]!)) {
    checks.push({ id: "local.host", step: "A6", status: "fail", title: "SERAIN_HOST is not user@host", fix: "Set SERAIN_HOST=root@<server address>." });
  }
  return checks;
}

/** Optional features and whether they are configured. Never a failure. */
export function optionalChecks(vars: Record<string, string>): Check[] {
  const features: Array<[string, string, boolean]> = [
    ["integrations", "Mail and calendar (integration key, B1)", set(vars, "SERAIN_INTEGRATION_KEY")],
    ["openrouter", "OpenRouter fallback and videos (B6)", set(vars, "OPENROUTER_API_KEY")],
    ["search", "Web search (Tavily, B6)", set(vars, "TAVILY_API_KEY")],
    ["browser", "Browser pilot (Typesafe and Chrome, B6)", set(vars, "TYPESAFE_API_KEY") && set(vars, "SERAIN_CHROME_PATH")],
    ["web", "Web interface (B7)", set(vars, "SERAIN_WEB_ORIGIN") && set(vars, "SERAIN_VAULT_KEY")],
    ["bank", "Bank connection (B8)", set(vars, "ENABLE_BANKING_APP_ID") && set(vars, "ENABLE_BANKING_KEY") && set(vars, "ENABLE_BANKING_BANK")],
    ["companion", "Mac companion (B9)", set(vars, "SERAIN_COMPANION_PORT") && set(vars, "SERAIN_COMPANION_TOKEN")],
    ["healthchecks", "Outage alarm (Healthchecks.io, B10)", set(vars, "HEALTHCHECKS_PING_URL")],
  ];
  return features.map(([id, title, on]) => ({ id: `optional.${id}`, step: "B", status: on ? "ok" : "skip", title, ...(on ? {} : { detail: "not set up" }) }));
}

/** What the probe on the server reports: facts, and per variable of its env file only a hash of the value. */
export interface ServerState {
  facts: Record<string, string>;
  /** Name → SHA-256 of the value, as parseEnv reads it; empty values are left out. */
  env: Record<string, string> | null;
  duplicates: string[];
}

export const hashValue = (value: string): string => createHash("sha256").update(value).digest("hex");

export function serverChecks(state: ServerState, vars: Record<string, string>, specs: readonly VarSpec[], localHead: string): Check[] {
  const checks: Check[] = [];
  const facts = state.facts;
  const provisioned = facts["user"] !== "none" && /^v22\./.test(facts["node"] ?? "") && facts["docker"] === "yes";
  checks.push(
    provisioned
      ? { id: "server.provisioned", step: "A6", status: "ok", title: "Server is provisioned (user serain, Node 22, Docker)" }
      : {
          id: "server.provisioned",
          step: "A6",
          status: "fail",
          title: "Server is not provisioned",
          detail: [facts["user"] === "none" && "no user serain", !/^v22\./.test(facts["node"] ?? "") && `Node ${facts["node"] ?? "missing"}`, facts["docker"] !== "yes" && "no Docker"].filter(Boolean).join(", "),
          fix: "Copy deploy/provision.sh to the server and run it as root (A6).",
        },
  );

  if (!state.env) {
    checks.push({ id: "server.env", step: "A7", status: "fail", title: "/etc/serain/serain.env is missing", fix: "Copy .dev.vars without the local-only variables to the server as shown in A7." });
    return checks;
  }
  checks.push(
    facts["envfile"] === "root:serain 640"
      ? { id: "server.env", step: "A7", status: "ok", title: "/etc/serain/serain.env exists, root:serain 640" }
      : { id: "server.env", step: "A7", status: "warn", title: `/etc/serain/serain.env is ${facts["envfile"]}, expected root:serain 640`, fix: "chown root:serain and chmod 640 on the server." },
  );

  const serverNames = new Set(Object.keys(state.env));
  const localOnly = specs.filter(isLocalOnly).map((spec) => spec.name).filter((name) => serverNames.has(name));
  checks.push(
    localOnly.length > 0
      ? { id: "server.env.local-only", step: "A7", status: "fail", title: `Local-only variables on the server: ${localOnly.join(", ")}`, detail: "A compromised agent must not be able to manage its own infrastructure.", fix: "Delete these lines from /etc/serain/serain.env and restart the service." }
      : { id: "server.env.local-only", step: "A7", status: "ok", title: "No local-only variables on the server" },
  );

  const missing = specs.filter((spec) => spec.required && !isLocalOnly(spec) && !serverNames.has(spec.name)).map((spec) => spec.name);
  const hasClaude = serverNames.has("ANTHROPIC_API_KEY") || serverNames.has("CLAUDE_CODE_OAUTH_TOKEN") || serverNames.has("OPENROUTER_API_KEY");
  if (!hasClaude) missing.push("ANTHROPIC_API_KEY");
  checks.push(
    missing.length > 0
      ? { id: "server.env.required", step: "A7", status: "fail", title: `Required on the server: ${missing.join(", ")}`, fix: missing.includes("SERAIN_DB_URL") ? "Run pnpm db:password, then copy the other values as in A7." : "Add them to /etc/serain/serain.env (A7), then restart the service." }
      : { id: "server.env.required", step: "A7", status: "ok", title: "Required values are on the server" },
  );

  const comparable = specs.filter((spec) => !isLocalOnly(spec) && !isRuntime(spec) && !MACHINE_SPECIFIC.has(spec.name)).map((spec) => spec.name);
  const differ = comparable.filter((name) => set(vars, name) && serverNames.has(name) && hashValue(vars[name]!) !== state.env![name]);
  const onlyLocal = comparable.filter((name) => set(vars, name) && !serverNames.has(name) && !missing.includes(name));
  if (differ.length > 0) {
    checks.push({ id: "server.env.differs", step: "A7", status: "warn", title: `Differs between .dev.vars and the server: ${differ.join(", ")}`, fix: "Whenever you change a value, edit both files and restart the service." });
  }
  if (onlyLocal.length > 0) {
    checks.push({ id: "server.env.only-local", step: "A7", status: "warn", title: `In .dev.vars but not on the server: ${onlyLocal.join(", ")}`, fix: "Copy them to /etc/serain/serain.env if the server should use them, then restart." });
  }
  if (state.duplicates.length > 0) {
    checks.push({ id: "server.env.duplicates", step: "A7", status: "warn", title: `Set twice in /etc/serain/serain.env: ${state.duplicates.join(", ")}`, detail: "systemd uses the last line, Serain's own tools the first.", fix: "Keep one line per variable." });
  }

  const units = ["serain", "serain-sandbox.socket", "serain-watchdog.timer"];
  const inactive = units.filter((unit) => facts[`unit.${unit}`] !== "active");
  checks.push(
    inactive.length > 0
      ? { id: "server.units", step: "A9", status: "fail", title: `Not active: ${inactive.join(", ")}`, fix: facts["revision"] === "none" ? "Deploy with ./deploy/deploy.sh (A9)." : "Read journalctl -u serain -n 50 on the server; C3 lists common causes." }
      : { id: "server.units", step: "A9", status: "ok", title: "Serain, sandbox and watchdog are running" },
  );
  const revision = facts["revision"] ?? "none";
  if (revision === "none") {
    checks.push({ id: "server.revision", step: "A9", status: "fail", title: "Nothing deployed yet", fix: "Commit your changes, then ./deploy/deploy.sh (A9)." });
  } else {
    checks.push(
      revision === localHead
        ? { id: "server.revision", step: "A9", status: "ok", title: `Deployed commit ${revision.slice(0, 7)} is your HEAD` }
        : { id: "server.revision", step: "A9", status: "warn", title: `Deployed ${revision.slice(0, 7)}, your HEAD is ${localHead.slice(0, 7) || "unknown"}`, fix: "Deploy again if the new commits should go live." },
    );
  }
  return checks;
}

// -----------------------------------------------------------------------------
// Probes: tools, Serain's own startup check, server, database, Anthropic
// -----------------------------------------------------------------------------

const TIMEOUT_MS = 15_000;

function has(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function toolChecks(): Check[] {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(major === 22 ? { id: "tools.node", step: "A1", status: "ok", title: `Node.js ${process.versions.node}` } : { id: "tools.node", step: "A1", status: major > 22 ? "warn" : "fail", title: `Node.js ${process.versions.node}, Serain is built for 22`, fix: "Install Node.js 22." });
  const tools: Array<[string, string]> = [
    ["pnpm", "corepack enable && corepack prepare pnpm@10.32.1 --activate"],
    ["git", "Install git."],
    ["ssh", "Install an OpenSSH client."],
    ["rsync", "Install rsync."],
    ["psql", "macOS: brew install libpq && brew link --force libpq; Ubuntu: sudo apt install postgresql-client"],
    ["gitleaks", "macOS: brew install gitleaks; otherwise the gitleaks releases on GitHub"],
  ];
  const missing = tools.filter(([command]) => !has(command));
  checks.push(
    missing.length > 0
      ? { id: "tools.commands", step: "A1", status: "fail", title: `Missing: ${missing.map(([command]) => command).join(", ")}`, fix: missing.map(([command, fix]) => `${command}: ${fix}`).join(" | ") }
      : { id: "tools.commands", step: "A1", status: "ok", title: "pnpm, git, ssh, rsync, psql and gitleaks are installed" },
  );
  const hooks = spawnSync("git", ["config", "core.hooksPath"], { cwd: ROOT, encoding: "utf8" }).stdout?.trim();
  checks.push(hooks === ".githooks" ? { id: "tools.hooks", step: "A1", status: "ok", title: "Secret scan runs before every commit" } : { id: "tools.hooks", step: "A1", status: "warn", title: "The pre-commit secret scan is off", fix: "git config core.hooksPath .githooks" });
  return checks;
}

function fileChecks(): Check[] {
  if (!existsSync(ROOT_VARS)) return [{ id: "local.file", step: "A2", status: "fail", title: ".dev.vars is missing", fix: "cp .env.example .dev.vars && chmod 600 .dev.vars" }];
  const mode = statSync(ROOT_VARS).mode & 0o777;
  return [
    mode & 0o077
      ? { id: "local.file", step: "A2", status: "warn", title: `.dev.vars is readable by others (${mode.toString(8)})`, fix: "chmod 600 .dev.vars" }
      : { id: "local.file", step: "A2", status: "ok", title: ".dev.vars exists, readable only by you" },
  ];
}

/** The same configuration check the service runs when it starts (src/config/owner.ts, src/config/env.ts), in its own process. */
function startupCheck(): Check {
  const script = 'import("./src/config/owner.ts").then(() => import("./src/config/env.ts")).catch((error) => { console.error("Startup check: " + error.message); process.exit(1); });';
  const result = spawnSync("pnpm", ["exec", "tsx", "--eval", script], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  if (result.status === 0) return { id: "local.startup", step: "A2", status: "ok", title: "Serain's own startup check accepts the configuration" };
  const message = /^Startup check: (.*)$/m.exec(result.stderr ?? "")?.[1] ?? `the check did not run: ${(result.stderr || result.error?.message || "").trim().split("\n")[0]}`;
  return { id: "local.startup", step: "A2", status: "fail", title: "Serain would not start with this configuration", detail: message, fix: "Fix the value named in the message in .dev.vars." };
}

/**
 * Runs on the server as root, reads only: system facts, and per variable of
 * the env file the SHA-256 of its value with the rules of `parseEnv`
 * (src/config/dotenv.ts). Values never leave the server.
 */
const SERVER_PROBE = String.raw`
echo "user=$(id -u serain >/dev/null 2>&1 && echo yes || echo none)"
echo "node=$(node --version 2>/dev/null || echo none)"
echo "docker=$(command -v docker >/dev/null 2>&1 && echo yes || echo no)"
echo "envfile=$(stat -c '%U:%G %a' /etc/serain/serain.env 2>/dev/null || echo none)"
echo "revision=$(cat /opt/serain/REVISION 2>/dev/null || echo none)"
for unit in serain serain-sandbox.socket serain-watchdog.timer; do echo "unit.$unit=$(systemctl is-active "$unit" 2>/dev/null)"; done
if [ -r /etc/serain/serain.env ] && command -v node >/dev/null 2>&1; then
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const seen = new Set();
for (const line of readFileSync("/etc/serain/serain.env", "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 1) continue;
  const key = trimmed.slice(0, eq).trim();
  if (seen.has(key)) { console.log("dup " + key); continue; }
  seen.add(key);
  let value = trimmed.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (value) console.log("env " + key + " " + createHash("sha256").update(value).digest("hex"));
}
JS
fi
`;

export function parseServerProbe(output: string): ServerState {
  const facts: Record<string, string> = {};
  const env: Record<string, string> = {};
  const duplicates: string[] = [];
  let envSeen = false;
  for (const line of output.split("\n")) {
    const hashed = /^env ([A-Z][A-Z0-9_]*) ([0-9a-f]{64})$/.exec(line);
    if (hashed) {
      env[hashed[1]!] = hashed[2]!;
      envSeen = true;
      continue;
    }
    const duplicate = /^dup ([A-Z][A-Z0-9_]*)$/.exec(line);
    if (duplicate) {
      duplicates.push(duplicate[1]!);
      continue;
    }
    const fact = /^([a-z][a-z0-9.-]*)=(.*)$/.exec(line);
    if (fact) facts[fact[1]!] = fact[2]!;
  }
  return { facts, env: envSeen || (facts["envfile"] && facts["envfile"] !== "none") ? env : null, duplicates };
}

function probeServer(host: string): { state: ServerState } | { error: string } {
  const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "sh -s"], { input: SERVER_PROBE, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) return { error: (result.stderr || result.error?.message || "no answer").trim().split("\n").pop()! };
  return { state: parseServerProbe(result.stdout) };
}

async function databaseCheck(url: string): Promise<Check> {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 1,
    ssl: { ca: readFileSync(join(ROOT, "web", "supabase-ca-2021.crt")), rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connection: { application_name: "serain-setup-check" },
    onnotice: () => undefined,
  });
  try {
    const [row] = await Promise.race([
      sql<Array<{ user: string; messages: string | null }>>`select current_user as user, to_regclass('public.messages')::text as messages`,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer within 15 s")), TIMEOUT_MS)),
    ]);
    if (row?.user !== "serain_server") return { id: "db.login", step: "A7", status: "fail", title: `SERAIN_DB_URL logs in as ${row?.user}, not serain_server`, fix: "Run pnpm db:password; never put another role into SERAIN_DB_URL." };
    if (!row.messages) return { id: "db.login", step: "A3", status: "fail", title: "The database has no Serain tables", fix: "Apply supabase/migrations/ as described in A3." };
    return { id: "db.login", step: "A7", status: "ok", title: "Database reachable as serain_server, Serain's tables exist", detail: "Which migrations are applied is not recorded in the database; after an update apply the new files (C2)." };
  } catch (error) {
    return { id: "db.login", step: "A7", status: "fail", title: "Cannot log in with SERAIN_DB_URL", detail: (error as Error).message, fix: "Run pnpm db:password again; check SUPABASE_POOLER_HOST and that the project is not paused." };
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

/** Lists the models: costs nothing and proves the key. */
async function anthropicCheck(key: string): Promise<Check> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return { id: "net.anthropic", step: "A5", status: "ok", title: "Anthropic accepts the API key" };
    if (response.status === 401 || response.status === 403) return { id: "net.anthropic", step: "A5", status: "fail", title: "Anthropic rejects the API key", fix: "Create a new key in the Anthropic Console." };
    return { id: "net.anthropic", step: "A5", status: "warn", title: `Anthropic answered ${response.status}` };
  } catch (error) {
    return { id: "net.anthropic", step: "A5", status: "warn", title: "Anthropic not reachable", detail: (error as Error).message };
  }
}

// -----------------------------------------------------------------------------
// Running and output
// -----------------------------------------------------------------------------

export async function runChecks(options: { offline: boolean }): Promise<Check[]> {
  const specs = parseEnvExample(readFileSync(join(ROOT, ".env.example"), "utf8"));
  const vars = existsSync(ROOT_VARS) ? parseEnv(readFileSync(ROOT_VARS, "utf8")) : {};
  const checks = [...toolChecks(), ...fileChecks()];
  if (!existsSync(ROOT_VARS)) return checks;
  const config = configChecks(vars, specs);
  checks.push(...config);
  if (!config.some((check) => check.status === "fail" && check.step === "A2")) checks.push(startupCheck());

  const offline = (id: string, step: Step, title: string): Check => ({ id, step, status: "skip", title, detail: "--offline" });
  const apiKey = vars["ANTHROPIC_API_KEY"] ?? "";
  if (apiKey.startsWith("sk-ant-api")) checks.push(options.offline ? offline("net.anthropic", "A5", "API key not tried") : await anthropicCheck(apiKey));

  const host = vars["SERAIN_HOST"] ?? "";
  if (!host) {
    checks.push({ id: "server.reach", step: "A6", status: "fail", title: "SERAIN_HOST is not set", fix: "Create the server (A6) and set SERAIN_HOST=root@<address> in .dev.vars." });
  } else if (options.offline) {
    checks.push(offline("server.reach", "A6", "Server not checked"));
  } else {
    const probe = probeServer(host);
    if ("error" in probe) {
      checks.push({ id: "server.reach", step: "A6", status: "fail", title: "Server not reachable over SSH", detail: probe.error, fix: "Check SERAIN_HOST and that your SSH key is in root's authorized_keys (on Oracle see A6)." });
    } else {
      checks.push({ id: "server.reach", step: "A6", status: "ok", title: "Server reachable over SSH" });
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout?.trim() ?? "";
      checks.push(...serverChecks(probe.state, vars, specs, head));
    }
  }

  if (vars["SERAIN_DB_URL"]) checks.push(options.offline ? offline("db.login", "A7", "Database not checked") : await databaseCheck(vars["SERAIN_DB_URL"]));
  checks.push(...optionalChecks(vars));
  return checks.map((check) => ({ ...check, ...redacted(check, vars) }));
}

function redacted(check: Check, vars: Record<string, string>): Partial<Check> {
  const redact = redactor(vars);
  return { title: redact(check.title), ...(check.detail ? { detail: redact(check.detail) } : {}), ...(check.fix ? { fix: redact(check.fix) } : {}) };
}

const ORDER = Object.keys(STEPS) as Step[];
const MARK: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗", skip: "–" };

export function render(checks: readonly Check[]): string {
  const lines: string[] = [];
  for (const step of ORDER) {
    const inStep = checks.filter((check) => check.step === step);
    if (inStep.length === 0) continue;
    lines.push(`${step} ${STEPS[step].title}`);
    for (const check of inStep) {
      lines.push(`  ${MARK[check.status]} ${check.title}${check.detail ? ` (${check.detail})` : ""}`);
      if (check.fix && (check.status === "fail" || check.status === "warn")) lines.push(`    → ${check.fix}`);
    }
  }
  const next = nextStep(checks);
  lines.push("", next ? `Next: ${next.fix ?? next.title} (docs/SETUP.md#${STEPS[next.step].anchor})` : "Nothing required is missing.");
  return lines.join("\n");
}

/** The first failure in the order of the guide: what to do now. */
export function nextStep(checks: readonly Check[]): Check | undefined {
  return ORDER.flatMap((step) => checks.filter((check) => check.step === step && check.status === "fail"))[0];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--json" && arg !== "--offline");
  if (unknown.length > 0) {
    console.error(`Unknown argument ${unknown[0]}. Usage: pnpm setup:check [--json] [--offline]`);
    process.exit(2);
  }
  const checks = await runChecks({ offline: args.includes("--offline") });
  const failed = checks.some((check) => check.status === "fail");
  if (args.includes("--json")) {
    const next = nextStep(checks);
    console.log(JSON.stringify({ ok: !failed, next: next ? { ...next, guide: `docs/SETUP.md#${STEPS[next.step].anchor}` } : null, checks }, null, 2));
  } else {
    console.log(render(checks));
  }
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 2;
  });
}
