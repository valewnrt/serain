import { execFileSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { instance, owner } from "../src/config/owner.js";
import { readVar, ROOT, ROOT_VARS, setting, WEB_VARS } from "./dev-vars.js";
import { accessApps, cloudflare, coversDomain, type AccessApp as App, type Cloudflare, type Policy } from "./cloudflare.js";
import { ensureWrangler, HYPERDRIVE_PLACEHOLDER, productionValues, setProductionBindings, setWranglerVars } from "./wrangler-config.js";

/**
 * The web interface on Cloudflare (D49), under the domain from
 * `SERAIN_WEB_ORIGIN`. Runs on the owner's machine, never on the server.
 *
 *   pnpm web:setup    Supabase CA, Hyperdrive, Access application with its policy, web/wrangler.toml
 *                     (from web/wrangler.toml.example if it is missing); idempotent, can be repeated any time
 *   pnpm web:deploy   checks Access, builds, deploys and then checks that the domain shows nothing without Access
 *   pnpm web:check    only the pre-deploy check, changes nothing
 *
 * Needs in `.dev.vars`: `SERAIN_WEB_ORIGIN` (e.g. https://serain.example.com,
 * the zone must be on Cloudflare), `CLOUDFLARE_API_TOKEN`,
 * `CLOUDFLARE_ACCOUNT_ID` and `WEB_ACCESS_EMAIL` (the one address Access lets
 * through). The password of the role `serain_web` comes from `web/.dev.vars`
 * (`pnpm web db-password`) and goes only to Hyperdrive; `pnpm web vault-key`
 * fills in the vault key beforehand.
 *
 * Access is mandatory before going live (D49): `deploy` does not deploy while
 * the application is missing or its policy allows more than exactly this address.
 */

const CA_FILE = join(ROOT, "web", "supabase-ca-2021.crt");

const ORIGIN = webOrigin();
const DOMAIN = new URL(ORIGIN).hostname;
const CA_NAME = "supabase-root-2021";
const HYPERDRIVE_NAME = "serain-db";
/** Smallest value Hyperdrive accepts; a soft limit, the role `serain_web` allows 10. */
const HYPERDRIVE_CONNECTIONS = 5;
const APP_NAME = "Serain";
const POLICY_NAME = "Owner only";
/** Session mode of the pooler: Hyperdrive pools by itself and needs prepared statements, which transaction mode (6543) does not provide. */
const POOLER_SESSION_PORT = 5432;
const SESSION = "24h";

function webOrigin(): string {
  if (!instance.webOrigin) throw new Error("SERAIN_WEB_ORIGIN is missing in .dev.vars (e.g. https://serain.example.com, a domain in your Cloudflare account).");
  return instance.webOrigin;
}

function required(file: string, name: string, hint: string): string {
  const value = file === ROOT_VARS ? setting(name) : readVar(file, name);
  if (!value) throw new Error(`${name} is missing in ${file.replace(`${ROOT}/`, "")}. ${hint}`);
  return value;
}

/** Exactly one allow policy that includes exactly the owner's address, and nothing that lets anyone past it. */
function policyProblem(app: App, email: string): string | null {
  const policies = app.policies ?? [];
  if (policies.length !== 1) return `${policies.length} policies instead of exactly one`;
  const [policy] = policies as [Policy];
  if (policy.decision !== "allow") return `policy "${policy.name}" is ${policy.decision}, not allow`;
  const emails = policy.include.map((rule) => (rule["email"] as { email?: string } | undefined)?.email?.toLowerCase());
  if (policy.include.length !== 1 || emails[0] !== email.toLowerCase()) return `policy "${policy.name}" lets through more or other than ${email}`;
  return null;
}

async function teamDomain(cf: Cloudflare): Promise<string> {
  const org = await cf.call<{ auth_domain?: string }>("GET", "/accounts/{account}/access/organizations").catch(() => ({ auth_domain: "" }));
  if (!org.auth_domain) throw new Error("Zero Trust is not set up in the account: dash.cloudflare.com > Zero Trust, Free plan, choose a team name.");
  return org.auth_domain;
}

async function findApp(cf: Cloudflare): Promise<App | null> {
  const matches = (await accessApps(cf)).filter((app) => coversDomain(app, DOMAIN));
  if (matches.length > 1) throw new Error(`More than one Access application for ${DOMAIN}: ${matches.map((app) => app.name).join(", ")}. Please clean up in the dashboard.`);
  return matches[0] ?? null;
}

/**
 * When `SERAIN_WEB_ORIGIN` moves to another domain (say from the bare domain
 * to `app.` because a public site takes over the bare one, D65), the one
 * application named like ours moves with it. A second application would leave
 * the old one behind, in front of a domain nobody checks anymore or in front
 * of the public site. Between the move and the next deploy the old domain
 * still reaches the Worker, which then refuses everything: its Access check
 * (web/src/access.ts) finds no token for its AUD.
 */
async function appToMove(cf: Cloudflare): Promise<App | null> {
  const named = (await accessApps(cf)).filter((app) => app.name === APP_NAME);
  if (named.length > 1) throw new Error(`More than one Access application named ${APP_NAME}: ${named.map((app) => app.domain).join(", ")}. Please clean up in the dashboard.`);
  return named[0] ?? null;
}

async function setup(): Promise<void> {
  const cf = cloudflare();
  const email = required(ROOT_VARS, "WEB_ACCESS_EMAIL", "The address Access sends the one-time code to.").toLowerCase();
  const database = new URL(required(WEB_VARS, "DATABASE_URL", "Run pnpm web db-password first."));
  const [poolerHost] = required(WEB_VARS, "DATABASE_UPSTREAM", "Run pnpm web db-password first.").split(":");
  if (!poolerHost) throw new Error("DATABASE_UPSTREAM in web/.dev.vars is not host:port.");
  if (ensureWrangler()) console.log("Created web/wrangler.toml from web/wrangler.toml.example.");
  if (!productionValues().vaultKey) throw new Error("VAULT_PUBLIC_KEY in web/wrangler.toml is empty. Run pnpm web vault-key first.");

  // 1. The Supabase CA that Hyperdrive verifies against (D49: the Workers runtime itself does not trust it).
  const certificates = await cf.call<Array<{ id: string; name: string; ca: boolean }>>("GET", "/accounts/{account}/mtls_certificates");
  const ca =
    certificates.find((entry) => entry.name === CA_NAME && entry.ca) ??
    (await cf.call<{ id: string }>("POST", "/accounts/{account}/mtls_certificates", { name: CA_NAME, ca: true, certificates: readFileSync(CA_FILE, "utf8") }));
  console.log(`Supabase CA at Cloudflare: ${CA_NAME}.`);

  // 2. Hyperdrive. On every run with the current password, so `pnpm web db-password` breaks nothing.
  // No cache: sessions, passkeys and the audit must be fresh; a result from 60 s ago would mean, e.g.,
  // that an ended session is still valid.
  const origin = {
    scheme: "postgres",
    host: poolerHost,
    port: POOLER_SESSION_PORT,
    database: database.pathname.slice(1) || "postgres",
    user: decodeURIComponent(database.username),
    password: decodeURIComponent(database.password),
  };
  // Below the role's limit (`0023_web_connections.sql`): otherwise the sixth connection fails at the role limit.
  const hyperdriveBody = {
    name: HYPERDRIVE_NAME,
    origin,
    origin_connection_limit: HYPERDRIVE_CONNECTIONS,
    caching: { disabled: true },
    mtls: { ca_certificate_id: ca.id, sslmode: "verify-full" },
  };
  const configs = await cf.call<Array<{ id: string; name: string }>>("GET", "/accounts/{account}/hyperdrive/configs");
  const existing = configs.find((entry) => entry.name === HYPERDRIVE_NAME);
  const hyperdrive = existing
    ? await cf.call<{ id: string }>("PUT", `/accounts/{account}/hyperdrive/configs/${existing.id}`, hyperdriveBody)
    : await cf.call<{ id: string }>("POST", "/accounts/{account}/hyperdrive/configs", hyperdriveBody);
  console.log(`Hyperdrive ${existing ? "updated" : "created"}: ${HYPERDRIVE_NAME} → ${poolerHost}:${POOLER_SESSION_PORT}, verify-full, no cache.`);

  // 3. Access: one-time code by mail as the only login, one policy for exactly the owner's address.
  const team = await teamDomain(cf);
  const providers = await cf.call<Array<{ id: string; type: string }>>("GET", "/accounts/{account}/access/identity_providers");
  const otp =
    providers.find((entry) => entry.type === "onetimepin") ??
    (await cf.call<{ id: string }>("POST", "/accounts/{account}/access/identity_providers", { name: "One-time code by mail", type: "onetimepin", config: {} }));
  const policyBody = { name: POLICY_NAME, decision: "allow", include: [{ email: { email } }], exclude: [], require: [], session_duration: SESSION };
  const policies = await cf.call<Policy[]>("GET", "/accounts/{account}/access/policies");
  const known = policies.find((entry) => entry.name === POLICY_NAME);
  const policy = known
    ? await cf.call<Policy>("PUT", `/accounts/{account}/access/policies/${known.id}`, policyBody)
    : await cf.call<Policy>("POST", "/accounts/{account}/access/policies", policyBody);
  const appBody = {
    name: APP_NAME,
    type: "self_hosted",
    domain: DOMAIN,
    // Exactly this host. Set explicitly, so a moved application keeps no destination of its old domain.
    destinations: [{ type: "public", uri: DOMAIN }],
    session_duration: SESSION,
    allowed_idps: [otp.id],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    http_only_cookie_attribute: true,
    // Lax, not Strict: the redirect back from a provider (D51, /connections/callback) is a cross-site navigation.
    same_site_cookie_attribute: "lax",
    enable_binding_cookie: false,
    policies: [{ id: policy.id, precedence: 1 }],
  };
  const current = (await findApp(cf)) ?? (await appToMove(cf));
  if (current && !coversDomain(current, DOMAIN)) console.log(`Access application ${APP_NAME} moves from ${current.domain} to ${DOMAIN}.`);
  const app = current
    ? await cf.call<App>("PUT", `/accounts/{account}/access/apps/${current.id}`, appBody)
    : await cf.call<App>("POST", "/accounts/{account}/access/apps", appBody);
  console.log(`Access ${current ? "updated" : "created"}: ${APP_NAME} in front of ${DOMAIN}, only ${email}, one-time code by mail, session ${SESSION}.`);

  // 4. web/wrangler.toml: domain, origin, Access and Hyperdrive for production.
  setProductionBindings({ domain: DOMAIN, hyperdrive: hyperdrive.id });
  setWranglerVars({ WEB_ORIGIN: ORIGIN, RP_ID: DOMAIN, OWNER_TIMEZONE: owner.timezone, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: app.aud }, "production");
  console.log(`web/wrangler.toml [env.production] holds ${DOMAIN}, team, AUD and Hyperdrive ID (no secrets, but per instance, hence gitignored).`);
  console.log("Next: pnpm web:deploy");
}

/** Before deploying: is Access set up as it should be, and does it match what the Worker checks? */
async function preflight(cf: Cloudflare): Promise<{ team: string }> {
  const email = required(ROOT_VARS, "WEB_ACCESS_EMAIL", "The address Access sends the one-time code to.");
  const values = productionValues();
  if (!values.team || !values.aud || !values.hyperdrive || values.hyperdrive === HYPERDRIVE_PLACEHOLDER || !values.timezone) {
    throw new Error("web/wrangler.toml [env.production] is incomplete. Run pnpm web:setup first.");
  }
  if (!values.vaultKey) throw new Error("VAULT_PUBLIC_KEY in web/wrangler.toml is empty. Run pnpm web vault-key first, then pnpm web:setup.");
  if (values.domain !== DOMAIN || values.origin !== ORIGIN || values.rpId !== DOMAIN) {
    throw new Error(`web/wrangler.toml [env.production] points to ${values.origin || "nothing"}, SERAIN_WEB_ORIGIN is ${ORIGIN}. pnpm web:setup.`);
  }
  const team = await teamDomain(cf);
  if (team !== values.team) throw new Error(`Team in wrangler.toml (${values.team}) is not the account's team (${team}). pnpm web:setup.`);
  const found = await findApp(cf);
  if (!found) throw new Error(`No Access application in front of ${DOMAIN}. Without it nothing is deployed (D49). pnpm web:setup.`);
  const app = await cf.call<App>("GET", `/accounts/{account}/access/apps/${found.id}`);
  if (app.aud !== values.aud) throw new Error("AUD in wrangler.toml does not match the Access application. pnpm web:setup.");
  const problem = policyProblem(app, email);
  if (problem) throw new Error(`Access policy not as intended: ${problem}. pnpm web:setup restores it.`);
  return { team };
}

/**
 * The nameservers of the zone the domain is in: for `serain.example.com`
 * those of `example.com`. Searched from left to right until a name has
 * NS records.
 */
async function zoneNameservers(resolver: Resolver): Promise<string[]> {
  const labels = DOMAIN.split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    const nameservers = await resolver.resolveNs(labels.slice(index).join(".")).catch(() => []);
    if (nameservers.length > 0) return nameservers;
  }
  throw new Error(`No nameservers found for ${DOMAIN}.`);
}

/**
 * Asks the zone's nameservers directly, not the local machine's resolver:
 * after the first deploy it often keeps the old record for hours (such as a
 * registrar's parking page).
 */
async function zoneAddress(): Promise<string> {
  const system = new Resolver();
  const nameservers = await zoneNameservers(system);
  const ips = (await Promise.all(nameservers.map((host) => system.resolve4(host).catch(() => [])))).flat();
  if (ips.length === 0) throw new Error(`Nameservers of ${DOMAIN} cannot be resolved.`);
  const authoritative = new Resolver();
  authoritative.setServers(ips);
  const [address] = await authoritative.resolve4(DOMAIN);
  if (!address) throw new Error(`${DOMAIN} has no address at its own nameservers.`);
  return address;
}

/** One request to exactly this address, with certificate check against the name. Follows no redirect. */
function probe(address: string, path: string): Promise<{ status: number; location: string }> {
  return new Promise((done, fail) => {
    const request = httpsRequest(
      { host: address, servername: DOMAIN, headers: { host: DOMAIN }, path, method: "GET", timeout: 15_000 },
      (response) => {
        response.resume();
        done({ status: response.statusCode ?? 0, location: String(response.headers.location ?? "") });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Timeout")));
    request.on("error", fail);
    request.end();
  });
}

/** After deploying, from outside: without an Access login nobody reaches the page or the API. */
async function verifyLive(team: string): Promise<void> {
  const address = await zoneAddress();
  for (const path of ["/", "/api/session", "/api/audit"]) {
    let result: { status: number; location: string } | null = null;
    // After the first deploy the custom domain needs one to two minutes for its certificate.
    for (let attempt = 0; attempt < 24; attempt += 1) {
      result = await probe(address, path).catch(() => null);
      if (result && ![522, 525, 526].includes(result.status)) break;
      await new Promise((wait) => setTimeout(wait, 5_000));
    }
    if (!result) throw new Error(`${ORIGIN}${path} not reachable via ${address}.`);
    if (!(result.status >= 300 && result.status < 400 && result.location.includes(team))) {
      throw new Error(`${ORIGIN}${path} answers without Access with ${result.status}${result.location ? ` → ${result.location}` : ""}. Check immediately.`);
    }
  }
  console.log(`Checked: ${ORIGIN} (${address}) redirects to Access (${team}) without login, page and API.`);
}

/**
 * Only what is committed gets deployed. Without a git checkout (say from an
 * archive) there is nothing to compare; then only a notice.
 */
function uncommitted(): string {
  let dirty: string;
  try {
    dirty = execFileSync("git", ["status", "--porcelain", "--", "web", "src/vault", "src/files", "src/connectors/catalog.ts", "src/instance"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    console.log("No git checkout: not checking whether everything is committed.");
    return "";
  }
  // The instance's catalog and logos are part of the bundle (docs/INSTANCE.md); it lives in its own repository.
  const own = join(ROOT, "instance");
  if (!existsSync(own)) return dirty;
  try {
    const mine = execFileSync("git", ["status", "--porcelain", "--", "."], { cwd: realpathSync(own), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return [dirty, mine && `instance:\n${mine}`].filter(Boolean).join("\n");
  } catch {
    return [dirty, "instance/ is not in a Git repository"].filter(Boolean).join("\n");
  }
}

async function deploy(): Promise<void> {
  const cf = cloudflare();
  const { team } = await preflight(cf);
  console.log(`Access is in place: ${APP_NAME} in front of ${DOMAIN}, only ${setting("WEB_ACCESS_EMAIL")}.`);
  const dirty = uncommitted();
  if (dirty) throw new Error(`Uncommitted changes to the web interface, commit first:\n${dirty}`);
  execFileSync("pnpm", ["-s", "web:build"], { cwd: ROOT, stdio: "inherit" });
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "--env", "production", "-c", "web/wrangler.toml"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, CLOUDFLARE_API_TOKEN: cf.token, CLOUDFLARE_ACCOUNT_ID: cf.account },
  });
  await verifyLive(team);
  console.log(`Passkey for ${ORIGIN} (those from localhost do not work there): pnpm web enroll ${ORIGIN}`);
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  if (command === "setup") return setup();
  if (command === "deploy") return deploy();
  if (command === "check") {
    const { team } = await preflight(cloudflare());
    // If the domain is already live, also the check from outside.
    await verifyLive(team).catch((error: unknown) => console.log(`From outside: ${(error as Error).message}`));
    return void console.log(`Ready: Access in front of ${DOMAIN} only for ${setting("WEB_ACCESS_EMAIL")}, wrangler.toml matches the account.`);
  }
  console.log("pnpm web:setup | pnpm web:check | pnpm web:deploy");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
