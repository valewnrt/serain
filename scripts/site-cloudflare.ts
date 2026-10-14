import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { instance } from "../src/config/owner.js";
import { INDEXNOW_KEY, SITE_ORIGIN } from "../site/content/site.js";
import { accessApps, type Cloudflare, cloudflare, coversDomain } from "./cloudflare.js";
import { ROOT } from "./dev-vars.js";

/**
 * serain.si, the project's public website (D65), on Cloudflare. For the
 * maintainer; an owner's own Serain never needs it.
 *
 *   pnpm site:check    only the checks below, changes nothing
 *   pnpm site:deploy   checks, builds, deploys, then checks from outside
 *   pnpm site:stats    what was counted in the last days (default 7)
 *
 * The site is public and must never take the place of a web interface (D49):
 * it refuses while `SERAIN_WEB_ORIGIN` points to its domain or an Access
 * application still stands in front of it (then the web interface has not
 * moved yet: `pnpm web:setup` with the new `SERAIN_WEB_ORIGIN`, then
 * `pnpm web:deploy`). After deploying it checks that the site answers without
 * Access and that the web interface still does not, and names the pages whose
 * content changed to IndexNow.
 */

const DOMAIN = new URL(SITE_ORIGIN).hostname;
const PAGES = ["/", "/de/", "/connectors/", "/de/connectors/"];
/** The Analytics Engine dataset of `site/wrangler.toml`. */
const DATASET = "serain_site";

function routeDomain(): string {
  const toml = readFileSync(join(ROOT, "site", "wrangler.toml"), "utf8");
  return /^routes = \[\{ pattern = "(.*)", custom_domain = true \}\]$/m.exec(toml)?.[1] ?? "";
}

function uncommitted(): string {
  try {
    return execFileSync("git", ["status", "--porcelain", "--", "site", "src/connectors/catalog.ts", ".github/ISSUE_TEMPLATE", "web/client/favicon.svg"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

async function preflight(): Promise<void> {
  if (routeDomain() !== DOMAIN) throw new Error(`site/wrangler.toml routes to ${routeDomain() || "nothing"}, SITE_ORIGIN in site/content/site.ts is ${SITE_ORIGIN}.`);
  const app = instance.webOrigin ? new URL(instance.webOrigin).hostname : null;
  if (app === DOMAIN) {
    throw new Error(`SERAIN_WEB_ORIGIN is ${instance.webOrigin}, the site's own domain. The web interface needs its own host (e.g. https://app.${DOMAIN}): change it in .dev.vars and /etc/serain/serain.env, then pnpm web:setup and pnpm web:deploy.`);
  }
  const blocking = (await accessApps(cloudflare())).filter((entry) => coversDomain(entry, DOMAIN));
  if (blocking.length > 0) {
    throw new Error(`Access application ${blocking.map((entry) => entry.name).join(", ")} still stands in front of ${DOMAIN}. Move the web interface first: pnpm web:setup with the new SERAIN_WEB_ORIGIN, then pnpm web:deploy.`);
  }
}

async function get(url: string): Promise<Response | null> {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => null);
}

async function verifyLive(): Promise<void> {
  for (const path of PAGES) {
    let response: Response | null = null;
    // After the first deploy the custom domain needs a minute or two for its certificate.
    for (let attempt = 0; attempt < 24; attempt += 1) {
      response = await get(`${SITE_ORIGIN}${path}`);
      if (response?.status === 200 && (response.headers.get("content-security-policy") ?? "").startsWith("default-src 'none'")) break;
      await new Promise((wait) => setTimeout(wait, 5_000));
    }
    if (response?.status !== 200) throw new Error(`${SITE_ORIGIN}${path} answers with ${response?.status ?? "nothing"}.`);
    if (!(response.headers.get("content-security-policy") ?? "").startsWith("default-src 'none'")) throw new Error(`${SITE_ORIGIN}${path} comes without the site's CSP: is another Worker still on ${DOMAIN}?`);
  }
  console.log(`Checked: ${SITE_ORIGIN} answers on ${PAGES.join(", ")} with the site's headers.`);
  if (!instance.webOrigin) return;
  for (const path of ["/", "/api/session"]) {
    const response = await get(`${instance.webOrigin}${path}`);
    const location = response?.headers.get("location") ?? "";
    if (!response || response.status < 300 || response.status >= 400 || !location.includes(".cloudflareaccess.com")) {
      throw new Error(`${instance.webOrigin}${path} answers without Access with ${response?.status ?? "nothing"}. Check immediately.`);
    }
  }
  console.log(`Checked: ${instance.webOrigin} still redirects to Access without login.`);
}

/** Each page of a sitemap with its lastmod. */
function lastmods(xml: string): Map<string, string> {
  return new Map([...xml.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)].map((match) => [match[1]!, match[2]!]));
}

/**
 * Tells IndexNow which pages are new or changed, compared with the sitemap
 * that was live before the deploy. A failure only costs a faster recrawl, so
 * it is reported, never thrown.
 */
async function announce(before: Map<string, string>): Promise<void> {
  const after = lastmods(readFileSync(join(ROOT, "site", "dist", "sitemap.xml"), "utf8"));
  const urlList = [...after].filter(([url, date]) => before.get(url) !== date).map(([url]) => url);
  if (urlList.length === 0) return void console.log("IndexNow: no page changed.");
  const response = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: DOMAIN, key: INDEXNOW_KEY, keyLocation: `${SITE_ORIGIN}/${INDEXNOW_KEY}.txt`, urlList }),
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => error as Error);
  if (response instanceof Error || !response.ok) {
    return void console.log(`IndexNow: not accepted (${response instanceof Error ? response.message : response.status}); search engines find the changes through the sitemap.`);
  }
  console.log(`IndexNow: ${urlList.length} changed page${urlList.length === 1 ? "" : "s"} announced.`);
}

async function deploy(): Promise<void> {
  await preflight();
  const dirty = uncommitted();
  if (dirty) throw new Error(`Uncommitted changes to the site, commit first:\n${dirty}`);
  const live = await get(`${SITE_ORIGIN}/sitemap.xml`);
  const before = live?.ok ? lastmods(await live.text()) : new Map<string, string>();
  const cf = cloudflare();
  execFileSync("pnpm", ["-s", "site:build"], { cwd: ROOT, stdio: "inherit" });
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "-c", "site/wrangler.toml"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, CLOUDFLARE_API_TOKEN: cf.token, CLOUDFLARE_ACCOUNT_ID: cf.account },
  });
  await verifyLive();
  await announce(before);
}

/**
 * One question to the Analytics Engine SQL API. The columns are the blobs that
 * site/worker/analytics.ts writes: blob1 path, blob2 kind, blob3 language,
 * blob4 agent class, blob5 crawler name, blob6 referrer host, blob7 country.
 */
async function sql(cf: Cloudflare, query: string): Promise<Array<Record<string, string | number>>> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cf.account}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${cf.token}` },
    body: query,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? " The API token needs Account Analytics Read (web/README.md)." : "";
    throw new Error(`Analytics Engine answers with ${response.status}: ${text.slice(0, 300)}${hint}`);
  }
  return (JSON.parse(text) as { data: Array<Record<string, string | number>> }).data;
}

/** What the site's Worker counted in the last `days` days: views, never visitors. */
async function stats(days: number): Promise<void> {
  const cf = cloudflare();
  const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;
  const count = "SUM(_sample_interval) AS n";
  const sections: Array<[string, string]> = [
    ["By client and kind", `SELECT blob4 AS client, blob2 AS kind, ${count} FROM ${DATASET} WHERE ${since} GROUP BY client, kind ORDER BY n DESC`],
    ["Pages read in a browser", `SELECT blob1 AS page, ${count} FROM ${DATASET} WHERE ${since} AND blob4 = 'browser' AND blob2 = 'page' GROUP BY page ORDER BY n DESC LIMIT 25`],
    ["Crawlers, assistants and link previews", `SELECT blob4 AS client, blob5 AS name, ${count} FROM ${DATASET} WHERE ${since} AND blob5 != '' GROUP BY client, name ORDER BY n DESC LIMIT 25`],
    ["What assistants and crawlers read", `SELECT blob1 AS path, blob2 AS kind, ${count} FROM ${DATASET} WHERE ${since} AND blob4 IN ('ai-assistant', 'ai-crawler') GROUP BY path, kind ORDER BY n DESC LIMIT 25`],
    ["Referrers", `SELECT blob6 AS referrer, ${count} FROM ${DATASET} WHERE ${since} AND blob6 != '' GROUP BY referrer ORDER BY n DESC LIMIT 25`],
    ["Browsers by language and country", `SELECT blob3 AS lang, blob7 AS country, ${count} FROM ${DATASET} WHERE ${since} AND blob4 = 'browser' AND blob2 = 'page' GROUP BY lang, country ORDER BY n DESC LIMIT 25`],
  ];
  console.log(`serain.si, last ${days} day${days === 1 ? "" : "s"} (views, not visitors; kept for three months):`);
  for (const [title, query] of sections) {
    const rows = await sql(cf, query);
    console.log(`\n${title}`);
    if (rows.length === 0) console.log("  nothing yet");
    else console.table(rows.map((row) => ({ ...row, n: Number(row.n) })));
  }
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (command === "deploy") return deploy();
  if (command === "stats") {
    const days = argument === undefined ? 7 : Number(argument);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("pnpm site:stats [days], 1 to 90.");
    return stats(days);
  }
  if (command === "check") {
    await preflight();
    await verifyLive().catch((error: unknown) => console.log(`From outside: ${(error as Error).message}`));
    return void console.log(`Ready: ${DOMAIN} is free of Access and is not the web interface's domain.`);
  }
  console.log("pnpm site:check | pnpm site:deploy | pnpm site:stats [days]");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
