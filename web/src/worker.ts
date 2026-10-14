import { fromBase64Url, keyId, SEALED_BYTES_OVERHEAD, sealedBytesFor } from "../../src/vault/sealbox.js";
import { hostAllowed, SITE_NAME } from "../../src/vault/entry.js";
import { sealedSizeBounds, VAULT_FILE_MAX_BYTES, VAULT_FILE_NAME } from "../../src/vault/file.js";
import { FILE_NAME_FORBIDDEN, MIME_TYPE } from "../../src/files/name.js";
import { connectorInfo } from "../../src/connectors/catalog.js";
import { formatAudit, type AuditRow } from "./audit-format.js";
import { KnownPasskeyFailure, REAUTH_SECONDS, loadSession, loginOptions, logout, registrationOptions, verifyLogin, verifyRegistration, type Session } from "./auth.js";
import { accessGate } from "./access.js";
import { connect, databaseUrl, textArray, type Sql } from "./db.js";
import { HttpError, harden, json, readJson, requireSameOrigin, sha256Hex, type Env } from "./http.js";

/**
 * The web interface (D49): audit, memory, vault (logins and files). One user, passkey only.
 *
 * The worker knows no secret key and no private key. It talks to Postgres as
 * `serain_web` and passes the vault through sealed only; sealing happens in the
 * browser (src/vault/sealbox.ts), opening only on the server.
 */

const CATEGORIES = new Set(["action", "access", "memory", "security", "system", "feedback"]);
const HOST = /^([a-z0-9-]+\.)+[a-z]{2,}$/;

function requireSession(session: Session | null): Session {
  if (!session) throw new HttpError(401, "Not signed in.");
  return session;
}

/** Vault changes only with a fresh confirmation by passkey. */
function requireFresh(session: Session | null): Session {
  const s = requireSession(session);
  if (s.verifiedAgo > REAUTH_SECONDS) throw new HttpError(401, "Please confirm with your passkey.", { reauth: true });
  return s;
}

async function auditLog(sql: Sql, event: "web_login" | "web_logout" | "web_login_failed", detail: Record<string, unknown>): Promise<void> {
  await sql`select public.web_audit_append(${event}, ${sql.json(detail as never)})`;
}

async function handleApi(request: Request, env: Env, sql: Sql, path: string): Promise<Response> {
  const method = request.method;
  if (method !== "GET") requireSameOrigin(request, env);
  const session = await loadSession(sql, request, env);

  if (path === "/api/session" && method === "GET") {
    return json({ authenticated: session !== null, fresh: session !== null && session.verifiedAgo <= REAUTH_SECONDS });
  }

  if (path === "/api/enroll/options" && method === "POST") {
    const body = (await readJson(request)) as Record<string, unknown>;
    return json(await registrationOptions(sql, env, body["token"]));
  }
  if (path === "/api/enroll/verify" && method === "POST") {
    const body = (await readJson(request)) as Record<string, unknown>;
    const cookie = await verifyRegistration(sql, env, body);
    await auditLog(sql, "web_login", { via: "enroll" });
    return json({ ok: true }, 200, { "set-cookie": cookie });
  }

  if (path === "/api/login/options" && method === "POST") return json(await loginOptions(sql, env));
  if (path === "/api/login/verify" && method === "POST") {
    const body = (await readJson(request)) as Record<string, unknown>;
    try {
      const { cookie } = await verifyLogin(sql, env, body, session);
      await auditLog(sql, "web_login", session ? { reauth: true } : {});
      return json({ ok: true }, 200, cookie ? { "set-cookie": cookie } : {});
    } catch (error) {
      if (error instanceof KnownPasskeyFailure) await auditLog(sql, "web_login_failed", { reason: error.message });
      throw error;
    }
  }
  if (path === "/api/logout" && method === "POST") {
    const cookie = await logout(sql, env, requireSession(session));
    await auditLog(sql, "web_logout", {});
    return json({ ok: true }, 200, { "set-cookie": cookie });
  }

  requireSession(session);

  if (path === "/api/audit" && method === "GET") {
    const url = new URL(request.url);
    const before = Number(url.searchParams.get("before") ?? "0");
    const category = url.searchParams.get("category") ?? "";
    if (category && !CATEGORIES.has(category)) throw new HttpError(400, "Unknown category.");
    const rows = await sql<AuditRow[]>`
      select id, at, event, category, detail, fact from public.web_audit
      where (${before} = 0 or id < ${before})
        and (${category} = '' or category = ${category})
      order by id desc
      limit 60
    `;
    const items = rows.map((row) => formatAudit(row, env.OWNER_TIMEZONE));
    return json({ items, next: rows.length === 60 ? String(rows[rows.length - 1]!.id) : null });
  }

  if (path === "/api/memory" && method === "GET") {
    // One after the other, not with Promise.all: several queries at once on the one connection
    // (pipelining) hang at Supabase's pooler in transaction mode; against PGlite in the E2E it works.
    const [model] = await sql`select base, learned, source, created_at from public.web_user_model`;
    const facts = await sql`
      select id, category, content, kind, valid_from, valid_until, created_at, updated_at
      from public.web_facts order by category, created_at
    `;
    const procedures = await sql`select id, title, trigger, body, created_at from public.web_procedures order by created_at`;
    return json({ userModel: model ?? null, facts, procedures });
  }

  if (path === "/api/vault" && method === "GET") {
    const entries = await sql`select site, username, to_jsonb(hosts) as hosts, login_url, totp, key_id, created_at, updated_at from public.web_vault order by site`;
    const files = await sql`select name, filename, mime_type, size, created_at, updated_at from public.web_vault_files order by name`;
    return json({ publicKey: env.VAULT_PUBLIC_KEY, keyId: await keyId(env.VAULT_PUBLIC_KEY), entries, files });
  }

  const fileMatch = /^\/api\/vault\/files\/([a-z][a-z0-9_-]{1,30})$/.exec(path);
  if (fileMatch && method === "PUT") {
    requireFresh(session);
    const name = fileMatch[1]!;
    // base64url turns 10 MB into a good 13.4; plus name, type, size.
    const body = (await readJson(request, Math.ceil((VAULT_FILE_MAX_BYTES + 2048) * 4 / 3) + 4096)) as Record<string, unknown>;
    const filename = typeof body["filename"] === "string" ? body["filename"] : "";
    const mimeType = typeof body["mimeType"] === "string" ? body["mimeType"] : "";
    const size = typeof body["size"] === "number" && Number.isInteger(body["size"]) ? body["size"] : 0;
    const expectedKey = await keyId(env.VAULT_PUBLIC_KEY);
    let sealed: Uint8Array;
    try {
      sealed = fromBase64Url(typeof body["sealed"] === "string" ? body["sealed"] : "");
    } catch {
      throw new HttpError(400, "Sealed data is not base64url.");
    }
    // File name, type and size are display only; they are checked anyway so the list does not lie.
    if (!VAULT_FILE_NAME.test(name)) throw new HttpError(400, "Invalid name.");
    if (filename.length < 1 || filename.length > 120 || FILE_NAME_FORBIDDEN.test(filename)) throw new HttpError(400, "Invalid file name.");
    if (!MIME_TYPE.test(mimeType)) throw new HttpError(400, "Unknown file type.");
    if (size < 1 || size > VAULT_FILE_MAX_BYTES) throw new HttpError(413, "At most 10 MB per file.");
    const bounds = sealedSizeBounds(size, SEALED_BYTES_OVERHEAD);
    if (!sealedBytesFor(sealed, expectedKey) || sealed.length < bounds.min || sealed.length > bounds.max) {
      throw new HttpError(400, "Not sealed for the server's key.");
    }
    const [row] = await sql<{ status: string }[]>`
      select public.web_vault_file_put(${name}, ${filename}, ${mimeType}, ${size}, ${expectedKey}, ${sealed}) as status
    `;
    if (row?.status === "too_many") throw new HttpError(409, "The vault already holds 25 files. Delete one first.");
    if (row?.status === "too_big") throw new HttpError(409, "At most 100 MB in total. Delete a file first.");
    if (row?.status !== "ok") throw new HttpError(500, "Not saved.");
    return json({ ok: true });
  }
  if (fileMatch && method === "DELETE") {
    requireFresh(session);
    const [row] = await sql<{ ok: boolean }[]>`select public.web_vault_file_delete(${fileMatch[1]!}) as ok`;
    if (!row?.ok) throw new HttpError(404, "Does not exist.");
    return json({ ok: true });
  }

  const vaultMatch = /^\/api\/vault\/([a-z][a-z0-9_-]{1,30})$/.exec(path);
  if (vaultMatch && method === "PUT") {
    requireFresh(session);
    const site = vaultMatch[1]!;
    const body = (await readJson(request)) as Record<string, unknown>;
    const expectedKey = await keyId(env.VAULT_PUBLIC_KEY);
    const hosts = Array.isArray(body["hosts"]) ? body["hosts"].map((host) => String(host).trim().toLowerCase()) : [];
    const username = typeof body["username"] === "string" ? body["username"] : "";
    const loginUrl = typeof body["loginUrl"] === "string" ? body["loginUrl"] : "";
    const sealed = typeof body["sealed"] === "string" ? body["sealed"] : "";
    // The plain-text fields are display only; they are checked anyway so the list does not lie after a typo.
    let loginHost = "";
    try {
      loginHost = new URL(loginUrl).hostname;
    } catch {
      throw new HttpError(400, "The login address is not a URL.");
    }
    if (!SITE_NAME.test(site)) throw new HttpError(400, "Invalid name.");
    if (hosts.length < 1 || hosts.length > 5 || !hosts.every((host) => HOST.test(host))) throw new HttpError(400, "Invalid hosts.");
    if (!loginUrl.startsWith("https://") || !hostAllowed({ hosts }, loginHost)) throw new HttpError(400, "The login address must use https and be on one of the hosts.");
    if (username.length < 1 || username.length > 200) throw new HttpError(400, "Username is missing.");
    if (!sealed.startsWith(`sv1.${expectedKey}.`) || sealed.length > 8000) throw new HttpError(400, "Not sealed for the server's key.");
    await sql`
      select public.web_vault_put(${site}, ${username}, ${textArray(sql, hosts)}, ${loginUrl}, ${body["totp"] === true}, ${expectedKey}, ${sealed})
    `;
    return json({ ok: true });
  }
  if (vaultMatch && method === "DELETE") {
    requireFresh(session);
    const [row] = await sql<{ ok: boolean }[]>`select public.web_vault_delete(${vaultMatch[1]!}) as ok`;
    if (!row?.ok) throw new HttpError(404, "Does not exist.");
    return json({ ok: true });
  }

  if (path === "/api/connectors" && method === "GET") {
    const rows = await sql`
      select id, status, account, tools, error, authorize_url, requested_at, connected_at, expires_at, updated_at
      from public.web_connectors order by id
    `;
    return json({ publicKey: env.VAULT_PUBLIC_KEY, keyId: await keyId(env.VAULT_PUBLIC_KEY), origin: env.WEB_ORIGIN, connections: rows });
  }

  const connectorMatch = /^\/api\/connectors\/([a-z][a-z0-9_]{1,30})\/(start|finish|disconnect)$/.exec(path);
  if (connectorMatch && method === "POST") {
    const [, id, action] = connectorMatch as unknown as [string, string, string];
    if (!connectorInfo(id)) throw new HttpError(404, "This service does not exist.");
    if (action === "start") {
      // Connecting gives Serain access to an account: as with the vault, only with a fresh confirmation.
      requireFresh(session);
      const [row] = await sql<{ ok: boolean }[]>`select public.web_connector_start(${id}, ${env.WEB_ORIGIN}) as ok`;
      if (!row?.ok) throw new HttpError(409, "The connection is already running or being disconnected.");
      return json({ ok: true });
    }
    if (action === "disconnect") {
      requireFresh(session);
      const [row] = await sql<{ ok: boolean }[]>`select public.web_connector_disconnect(${id}) as ok`;
      if (!row?.ok) throw new HttpError(404, "Does not exist.");
      return json({ ok: true });
    }
    // Callback from the provider. No fresh confirmation: the owner was at the provider, which can take a while;
    // what counts is the `state` that only the server issued.
    const body = (await readJson(request)) as Record<string, unknown>;
    const state = typeof body["state"] === "string" ? body["state"] : "";
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(state)) throw new HttpError(400, "Callback without a valid state.");
    const error = typeof body["error"] === "string" ? body["error"].replace(/[^A-Za-z0-9_ .-]/g, "").slice(0, 100) || "refused" : null;
    const sealed = typeof body["sealed"] === "string" ? body["sealed"] : "";
    if (!error && (!sealed.startsWith(`sv1.${await keyId(env.VAULT_PUBLIC_KEY)}.`) || sealed.length > 8000)) {
      throw new HttpError(400, "Not sealed for the server's key.");
    }
    const [row] = await sql<{ ok: boolean }[]>`
      select public.web_connector_finish(${id}, ${await sha256Hex(state)}, ${error ? null : sealed}, ${error}) as ok
    `;
    if (!row?.ok) throw new HttpError(409, "This callback matches no running authorization. Please connect again.");
    return json({ ok: true });
  }

  throw new HttpError(404, "Unknown path.");
}

/**
 * Built files carry their content hash in the name (web/build.ts) and never
 * change: a year in the cache, without revalidation. The page itself
 * revalidates every time, so a new version arrives at once.
 */
function withCaching(path: string, response: Response): Response {
  if (!response.ok) return response;
  const out = new Response(response.body, response);
  out.headers.set("cache-control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // On https Access first (D49), even before static files: whoever did not get through Access sees nothing at all.
    const blocked = await accessGate(request, env);
    if (blocked) {
      console.error("access", blocked.reason);
      return harden(new Response(blocked.status === 503 ? "Access is not set up." : "No access.", { status: blocked.status }), env);
    }
    if (!url.pathname.startsWith("/api/")) {
      if (request.method !== "GET" && request.method !== "HEAD") return harden(new Response("Method not allowed.", { status: 405 }), env);
      return harden(withCaching(url.pathname, await env.ASSETS.fetch(request)), env);
    }
    const database = databaseUrl(env);
    if (!env.VAULT_PUBLIC_KEY || !env.OWNER_TIMEZONE || !database) {
      return harden(json({ error: "The web interface is not set up (VAULT_PUBLIC_KEY, OWNER_TIMEZONE, HYPERDRIVE or DATABASE_URL on loopback)." }, 503), env);
    }
    const sql = connect(database);
    try {
      return harden(await handleApi(request, env, sql, url.pathname), env);
    } catch (error) {
      if (error instanceof HttpError) return harden(json({ error: error.message, ...error.extra }, error.status), env);
      // Database errors can quote values from the request: only into the log, not to the browser.
      console.error("api", url.pathname, (error as Error).message);
      return harden(json({ error: "Internal error." }, 500), env);
    } finally {
      ctx.waitUntil(sql.end({ timeout: 2 }));
    }
  },
} satisfies ExportedHandler<Env>;
