import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./dev-vars.js";

/**
 * `web/wrangler.toml` belongs to each instance (domain, Access, Hyperdrive,
 * vault key) and is gitignored. The repo only holds the template
 * `web/wrangler.toml.example`; `pnpm web vault-key` and `pnpm web:setup` create
 * the file from it and fill in their values. Only individual lines are
 * changed; everything else stays as it is in the file.
 */

export const WRANGLER = join(ROOT, "web", "wrangler.toml");
export const WRANGLER_EXAMPLE = join(ROOT, "web", "wrangler.toml.example");
/** The template's placeholder for the Hyperdrive ID: if it is still there, `pnpm web:setup` has not run. */
export const HYPERDRIVE_PLACEHOLDER = "0".repeat(32);

const PRODUCTION = "[env.production]";
const ROUTE = /^routes = \[\{ pattern = "(.*)", custom_domain = true \}\]$/m;
const HYPERDRIVE = /(\[\[env\.production\.hyperdrive\]\]\nbinding = "HYPERDRIVE"\nid = )"(.*)"/;

/** Creates `web/wrangler.toml` from the template if it is missing. `true` if it is new. */
export function ensureWrangler(): boolean {
  if (existsSync(WRANGLER)) return false;
  copyFileSync(WRANGLER_EXAMPLE, WRANGLER);
  return true;
}

function read(): { toml: string; start: number } {
  if (!existsSync(WRANGLER)) throw new Error("web/wrangler.toml is missing. Run pnpm web vault-key first (creates it from web/wrangler.toml.example).");
  const toml = readFileSync(WRANGLER, "utf8");
  // The environment's header line, not a comment that mentions it.
  const start = /^\[env\.production\]$/m.exec(toml)?.index ?? -1;
  if (start < 0) throw new Error(`web/wrangler.toml has no environment ${PRODUCTION}. Compare with web/wrangler.toml.example.`);
  return { toml, start };
}

function replaceVar(section: string, name: string, value: string, where: string): string {
  const line = new RegExp(`^${name} = ".*"$`, "gm");
  if (!new RegExp(line.source, "m").test(section)) throw new Error(`web/wrangler.toml: ${name} is missing ${where}. Compare with web/wrangler.toml.example.`);
  return section.replace(line, `${name} = ${JSON.stringify(value)}`);
}

/**
 * Sets `NAME = "value"` in `[vars]` and `[env.production.vars]` (`scope: "all"`)
 * or only in production. Every name must already be there.
 */
export function setWranglerVars(vars: Record<string, string>, scope: "all" | "production" = "all"): void {
  const { toml, start } = read();
  let local = toml.slice(0, start);
  let production = toml.slice(start);
  for (const [name, value] of Object.entries(vars)) {
    if (scope === "all") local = replaceVar(local, name, value, "under [vars]");
    production = replaceVar(production, name, value, `under ${PRODUCTION}`);
  }
  writeFileSync(WRANGLER, local + production);
}

/** Production domain (`routes`) and Hyperdrive ID. */
export function setProductionBindings(values: { domain: string; hyperdrive: string }): void {
  const { toml, start } = read();
  let production = toml.slice(start);
  if (!ROUTE.test(production)) throw new Error(`web/wrangler.toml: ${PRODUCTION} has no line routes = [{ pattern = "…", custom_domain = true }].`);
  if (!HYPERDRIVE.test(production)) throw new Error("web/wrangler.toml: [[env.production.hyperdrive]] with binding and id is missing.");
  production = production
    .replace(ROUTE, `routes = [{ pattern = ${JSON.stringify(values.domain)}, custom_domain = true }]`)
    .replace(HYPERDRIVE, `$1${JSON.stringify(values.hyperdrive)}`);
  writeFileSync(WRANGLER, toml.slice(0, start) + production);
}

export interface ProductionValues {
  domain: string;
  origin: string;
  rpId: string;
  team: string;
  aud: string;
  hyperdrive: string;
  vaultKey: string;
  timezone: string;
}

export function productionValues(): ProductionValues {
  const { toml, start } = read();
  const production = toml.slice(start);
  const value = (name: string) => new RegExp(`^${name} = "(.*)"$`, "m").exec(production)?.[1] ?? "";
  return {
    domain: ROUTE.exec(production)?.[1] ?? "",
    origin: value("WEB_ORIGIN"),
    rpId: value("RP_ID"),
    team: value("ACCESS_TEAM_DOMAIN"),
    aud: value("ACCESS_AUD"),
    hyperdrive: HYPERDRIVE.exec(production)?.[2] ?? "",
    vaultKey: value("VAULT_PUBLIC_KEY"),
    timezone: value("OWNER_TIMEZONE"),
  };
}
