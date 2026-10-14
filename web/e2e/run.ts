import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { chromium, type Page } from "playwright-core";
import { z } from "zod";
import "./env.js";
import { owner } from "../../src/config/owner.js";
import { generateVaultKeyPair } from "../../src/vault/sealbox.js";
import { serverVault } from "../../src/sites/vault.js";
import { SiteSessions } from "../../src/sites/session.js";
import { loadVaultKey } from "../../src/vault/sealbox.js";
import { FAKE_ORIGIN, fakeProvider } from "../../test/connectors.fake.js";
import { ConnectorService, type ConnectorRow, type ConnectorStore } from "../../src/connectors/service.js";
import { mcpOAuthDriver } from "../../src/connectors/drivers/mcp-oauth.js";
import { COROS_TOOLS } from "../../src/connectors/drivers/coros.js";
import { remoteTool } from "../../src/connectors/tools.js";
import { TurnState, type ToolDefinition } from "../../src/agent/tools/types.js";
import { ToolRegistry } from "../../src/agent/tools/registry.js";
import { vaultFileTools } from "../../src/agent/tools/vault.js";
import type { OutboundFile } from "../../src/channel/types.js";
import { FileShelf } from "../../src/files/shelf.js";
import { serverVaultFiles } from "../../src/files/vault.js";
import { serveSerially } from "./pg-server.js";

/**
 * End to end, locally (D49): the web interface in the real worker (`wrangler
 * dev`), real Chrome with a virtual passkey, Postgres as a throwaway database
 * from the same migrations. Afterwards the server part opens the vault entry
 * with its private key and signs in, in real Chrome, on a public demo login
 * page.
 *
 * It deliberately does not run against the real database: the audit log is
 * append-only, every test run would stay there forever.
 *
 *   pnpm web:e2e
 *
 * Needs neither `.dev.vars` nor Supabase: without its own configuration the
 * owner is called Alex (`./env.ts`), and the worker runs with a copy of
 * `web/wrangler.toml.example`. Only Chrome or Chromium has to exist
 * (`SERAIN_CHROME_PATH`, otherwise the usual places), and the demo login page
 * needs internet.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const PORT = 8788;
const DB_PORT = 54329;
const ORIGIN = `http://localhost:${PORT}`;
/** Public practice site by Sauce Labs; the credentials are printed on its login page. */
const DEMO = { loginUrl: "https://www.saucedemo.com/", host: "saucedemo.com", username: "standard_user", password: "secret_sauce" };

/** Where Chrome or Chromium usually lives when `SERAIN_CHROME_PATH` is not set. */
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/local/bin/serain-chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

const chromePath = (() => {
  // `SERAIN_CHROME_PATH` from the environment or from `.dev.vars`; ./env.ts already loaded the file if it exists.
  const path = process.env["SERAIN_CHROME_PATH"]?.trim() || CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("No Chrome found. Set SERAIN_CHROME_PATH (environment or .dev.vars).");
  return path;
})();

/**
 * A JPEG with EXIF, the way a phone writes it: the field ImageDescription holds
 * `marker`, standing in for place and device. The browser draws the image
 * itself (`base`); the EXIF segment goes right after SOI here.
 */
function jpegWithExif(base: Buffer, marker: string): Buffer {
  const text = Buffer.from(`${marker}\0`, "latin1");
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write("MM\0*", 0, "latin1");
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x010e, 10); // ImageDescription
  tiff.writeUInt16BE(2, 12); // ASCII
  tiff.writeUInt32BE(text.length, 14);
  tiff.writeUInt32BE(tiff.length, 18);
  tiff.writeUInt32BE(0, 22);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff, text]);
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return Buffer.concat([base.subarray(0, 2), segment, base.subarray(2)]);
}

/** With `SERAIN_E2E_SHOTS=<folder>` the run stores screenshots, for a look at the design. */
const SHOTS = process.env["SERAIN_E2E_SHOTS"] ?? "";
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

let failures = 0;
function check(condition: unknown, label: string): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}`);
  }
}

async function database(): Promise<PGlite> {
  const db = new PGlite({ extensions: { vector, pgcrypto } });
  await db.exec("create schema if not exists extensions; create schema if not exists auth; create role anon; create role authenticated; create role service_role;");
  const dir = join(ROOT, "supabase", "migrations");
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()) await db.exec(readFileSync(join(dir, name), "utf8"));
  const [fact] = (await db.query<{ id: string }>("insert into public.facts (category, content, kind) values ('wohnen', 'E2E: wohnt in Cordheim.', 'identity') returning id")).rows;
  await db.exec(`
    insert into public.user_model_versions (base, source) values ('E2E-Grundtext: ${owner.name.replaceAll("'", "''")} mag kurze Antworten.', 'push');
    insert into public.procedures (title, body, trigger) values ('E2E-Ablauf', 'Erst Sparpreis prüfen.', 'Zugfahrt buchen');
    insert into public.audit_log (event, detail) values
      ('tool_call', '{"tool": "send_message", "level": "write_reversible", "args": {"text": "E2E-CHATTEXT"}, "ok": true}'),
      ('tool_call', '{"tool": "mail_send", "level": "irreversible", "args": {"to": ["anna@example.org"], "subject": "E2E-Betreff"}, "ok": true}'),
      ('memory_fact', '{"fact_id": "${fact!.id}", "decision": "new"}'),
      ('feedback', '{"kind": "feature", "description": "E2E: kann keine PDF-Formulare ausfüllen.", "tainted": false}');
  `);
  return db;
}

/** `connectors` against the throwaway database, the same transitions as src/db/connectors.ts. */
function pgliteConnectors(db: PGlite): ConnectorStore {
  type Raw = { id: string; status: ConnectorRow["status"]; origin: string; state_hash: string | null; pending: string | null; callback: string | null; sealed: string | null; requested_at: string | Date; expires_at: string | Date | null };
  const row = (raw: Raw): ConnectorRow => ({
    id: raw.id,
    status: raw.status,
    origin: raw.origin,
    stateHash: raw.state_hash,
    pending: raw.pending,
    callback: raw.callback,
    sealed: raw.sealed,
    requestedAt: new Date(raw.requested_at),
    expiresAt: raw.expires_at ? new Date(raw.expires_at) : null,
  });
  const move = async (id: string, from: string, sets: string, params: unknown[]) =>
    (await db.query(`update public.connectors set ${sets}, updated_at = now() where id = $1 and status = $2 returning id`, [id, from, ...params])).rows.length > 0;
  return {
    work: async (cutoff) =>
      (await db.query<Raw>("select * from public.connectors where status in ('starting', 'finishing', 'disconnecting') or (status = 'authorizing' and requested_at < $1)", [cutoff.toISOString()])).rows.map(row),
    connected: async () => (await db.query<Raw>("select * from public.connectors where status = 'connected'")).rows.map(row),
    status: async (id) => (await db.query<{ status: ConnectorRow["status"] }>("select status from public.connectors where id = $1", [id])).rows[0]?.status ?? null,
    authorizing: (id, input) => move(id, "starting", "status = 'authorizing', authorize_url = $3, state_hash = $4, pending = $5", [input.authorizeUrl, input.stateHash, input.pending]),
    connect: (id, input) =>
      move(id, "finishing", "status = 'connected', sealed = $3, account = $4, tools = $5, expires_at = $6, connected_at = now(), pending = null, callback = null, state_hash = null, error = null", [
        input.sealed,
        input.account,
        JSON.stringify(input.tools),
        input.expiresAt?.toISOString() ?? null,
      ]),
    fail: (id, from, message) => move(id, from, "status = 'failed', error = $3, authorize_url = null, pending = null, callback = null, state_hash = null", [message]),
    saveCredentials: (id, sealed) => move(id, "connected", "sealed = $3", [sealed]),
    saveTools: (id, tools) => move(id, "connected", "tools = $3", [JSON.stringify(tools)]),
    remove: async (id) => void (await db.query("delete from public.connectors where id = $1 and status = 'disconnecting'", [id])),
    client: async (issuer, redirect) => (await db.query<{ sealed: string }>("select sealed from public.connector_clients where issuer = $1 and redirect_uri = $2", [issuer, redirect])).rows[0]?.sealed ?? null,
    saveClient: async (issuer, redirect, sealed) =>
      void (await db.query("insert into public.connector_clients (issuer, redirect_uri, sealed) values ($1, $2, $3) on conflict (issuer, redirect_uri) do update set sealed = excluded.sealed", [issuer, redirect, sealed])),
  };
}

let workerOutput = "";

/**
 * The worker runs with the template, never with the instance's own
 * `web/wrangler.toml`: so the run checks exactly what a fresh checkout has. The
 * copy sits next to the template because paths in it are relative to `web/`.
 */
const E2E_WRANGLER = join(ROOT, "web", "wrangler.e2e.toml");

async function startWorker(publicKey: string): Promise<ChildProcess> {
  const envFile = join(mkdtempSync(join(tmpdir(), "serain-e2e-")), "e2e.env");
  writeFileSync(envFile, `DATABASE_URL=postgresql://serain_web:x@127.0.0.1:${DB_PORT}/postgres\n`, { mode: 0o600 });
  copyFileSync(join(ROOT, "web", "wrangler.toml.example"), E2E_WRANGLER);
  // Even if the run fails earlier: the copy does not stay behind.
  process.on("exit", () => rmSync(E2E_WRANGLER, { force: true }));
  const child = spawn(
    "npx",
    [
      "wrangler", "dev", "--config", "web/wrangler.e2e.toml", "--port", String(PORT), "--env-file", envFile,
      "--var", `WEB_ORIGIN:${ORIGIN}`, "--var", "RP_ID:localhost", "--var", `VAULT_PUBLIC_KEY:${publicKey}`, "--var", `OWNER_TIMEZONE:${owner.timezone}`,
      "--show-interactive-dev-session=false",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  let output = "";
  const keep = (chunk: Buffer) => void (workerOutput += chunk.toString());
  child.stdout!.on("data", keep);
  child.stderr!.on("data", keep);
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler does not start:\n${output}`)), 60_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Ready on")) {
        clearTimeout(timer);
        resolveReady();
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (code) => reject(new Error(`wrangler exited (${code}):\n${output}`)));
  });
  return child;
}

async function waitFor(page: Page, text: string): Promise<void> {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ timeout: 15_000 });
  } catch (error) {
    console.log(`--- Page ---\n${await page.locator("body").innerText().catch(() => "")}\n--- Worker ---\n${workerOutput.split("\n").slice(-25).join("\n")}`);
    throw error;
  }
}

async function main(): Promise<void> {
  // Failed until the end is reached: if a promise stays open forever during cleanup, the event loop drains and Node exits silently with the code set here.
  process.exitCode = 1;
  console.log("Building the client …");
  await import("../build.js");
  const db = await database();
  const server = await serveSerially(db, { port: DB_PORT, host: "127.0.0.1" });
  const keys = await generateVaultKeyPair();
  const worker = await startWorker(keys.publicKey);
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    // Make sure the worker is attached to the throwaway database and not to Supabase.
    const token = randomBytes(32).toString("base64url");
    await db.query("insert into public.web_enrollments (token_hash, expires_at) values ($1, now() + interval '15 minutes')", [createHash("sha256").update(token).digest("hex")]);

    console.log("Without sign-in");
    const anon = await fetch(`${ORIGIN}/api/audit`);
    check(anon.status === 401, "audit without a session: 401");
    const index = await fetch(`${ORIGIN}/`);
    const headers = index.headers;
    check(headers.get("content-security-policy")?.includes("require-trusted-types-for 'script'"), "CSP with Trusted Types on the page");
    check(headers.get("x-frame-options") === "DENY", "no embedding");
    check(headers.get("cache-control") === "no-cache", "the page itself is revalidated every time");
    const script = /src="(\/assets\/app\.[0-9a-f]{10}\.js)"/.exec(await index.text())?.[1];
    const scriptResponse = script ? await fetch(`${ORIGIN}${script}`) : null;
    check(scriptResponse?.headers.get("cache-control")?.includes("immutable"), "built files with a hash in the name, a year in the cache");
    const scriptSize = (await scriptResponse?.arrayBuffer())?.byteLength ?? Infinity;
    check(scriptSize < 100_000, `client is small (${Math.round(scriptSize / 1024)} KB)`);
    const forged = await fetch(`${ORIGIN}/api/vault/demo`, { method: "PUT", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    check(forged.status === 403, "writing from a foreign origin: 403");

    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // A 401 is intended here: that is how the worker asks for a fresh confirmation before deleting.
    page.on("console", (msg) => void (msg.type() === "error" && !msg.text().includes("status of 401") && errors.push(`${msg.text()} (${msg.location().url})`)));
    // A 500 names the path and what the worker logged for it, otherwise only "status of 500" remains.
    page.on("response", (response) => void (response.status() >= 500 && errors.push(`${response.status()} ${new URL(response.url()).pathname}: ${workerOutput.split("\n").filter((l) => l.includes("api")).slice(-3).join(" | ")}`)));
    const apiCalls: string[] = [];
    page.on("request", (request) => void (request.url().includes("/api/") && apiCalls.push(new URL(request.url()).pathname)));
    const nav = (name: string) => page.locator("nav.nav").getByRole("link", { name });

    console.log("Set up passkey");
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(`${ORIGIN}/enroll#${token}`);
    await shot(page, "1-enroll");
    check(!page.url().includes(token), "one-time code disappears from the address bar");
    await page.getByPlaceholder("e.g. MacBook").fill("E2E-Chrome");
    await page.getByRole("button", { name: "Set up passkey" }).click();
    await waitFor(page, "Passkey added");
    check(page.url().endsWith("/audit"), "in the audit afterwards");
    const reuse = await fetch(`${ORIGIN}/api/enroll/options`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ token }) });
    check(reuse.status === 403, "one-time code is used up");

    console.log("Audit");
    await waitFor(page, "Mail sent");
    const auditText = await page.locator("main").innerText();
    check(auditText.includes("E2E-Betreff"), "mail to third parties is listed, with subject");
    check(auditText.includes("E2E: wohnt in Cordheim."), "remembered facts are listed, with content");
    check(!auditText.includes("E2E-CHATTEXT"), "chat messages are not listed");
    check(auditText.includes("Passkey added"), "the setup itself is listed");
    await shot(page, "2-audit");
    check(auditText.includes("Subject") && !auditText.includes("subject:"), "details with readable names");
    await page.getByRole("link", { name: "Security" }).click();
    await page.waitForTimeout(500);
    check(!(await page.locator("main").innerText()).includes("Mail sent"), "the security filter hides actions");
    check(page.url().endsWith("/audit?only=security"), "the filter is in the address");
    await page.reload();
    await waitFor(page, "Passkey added");
    check(!(await page.locator("main").innerText()).includes("Mail sent"), "the filter survives a reload");
    await page.getByRole("link", { name: "Feedback" }).click();
    await waitFor(page, "E2E: kann keine PDF-Formulare ausfüllen.");
    const feedbackText = await page.locator("main").innerText();
    check(feedbackText.includes("Feedback: missing") && !feedbackText.includes("Mail sent"), "feedback as its own list");
    check(page.url().endsWith("/audit?only=feedback"), "the feedback filter is in the address");
    await shot(page, "2b-feedback");
    check(!apiCalls.includes("/api/session"), "no separate session request before the data");

    console.log("Memory");
    await nav("Memory").click();
    await waitFor(page, "E2E: wohnt in Cordheim.");
    check((await page.locator("main").innerText()).includes("Wohnen"), "facts grouped by topic");
    await page.getByPlaceholder("Search facts").fill("Cordheim");
    check((await page.locator("main mark").first().innerText()) === "Cordheim", "the search marks the match");
    await page.getByPlaceholder("Search facts").fill("does not exist");
    await waitFor(page, 'Nothing for "does not exist"');
    await page.getByRole("button", { name: "Clear search" }).click();
    await waitFor(page, "E2E: wohnt in Cordheim.");
    await shot(page, "3-memory");
    await page.getByRole("link", { name: "User model" }).click();
    await waitFor(page, "E2E-Grundtext");
    await page.getByRole("link", { name: /Procedures/ }).click();
    await waitFor(page, "E2E-Ablauf");
    check(page.url().endsWith("/memory/procedures"), "tabs are in the address");

    console.log("Vault");
    await nav("Vault").click();
    await waitFor(page, "No logins yet");
    await page.getByRole("button", { name: "Add the first login" }).click();
    await page.locator('input[name="loginUrl"]').fill("saucedemo");
    await page.getByRole("button", { name: "Seal and save" }).click();
    // The text comes from the schema (src/vault/entry.ts); what counts here is that it shows at the field.
    await page.locator("#f-loginUrl-error").filter({ hasText: /\S/ }).waitFor({ timeout: 15_000 });
    check((await page.locator('input[name="loginUrl"]').getAttribute("aria-invalid")) === "true", "broken address: error at the field instead of a crash");
    await page.locator('input[name="loginUrl"]').fill(DEMO.loginUrl);
    check((await page.locator('input[name="hosts"]').inputValue()) === DEMO.host, "host prefilled from the login address");
    check((await page.locator('input[name="site"]').inputValue()) === "saucedemo", "name prefilled from the login address");
    await page.locator('input[name="site"]').fill("demo");
    await page.locator('input[name="username"]').fill(DEMO.username);
    await page.locator('input[name="password"]').fill(DEMO.password);
    await shot(page, "4-vault-form");
    const sent: string[] = [];
    page.on("request", (request) => void (request.method() === "PUT" && sent.push(request.postData() ?? "")));
    await page.getByRole("button", { name: "Seal and save" }).click();
    await waitFor(page, "demo is in the vault");
    check(sent.length === 1 && !sent[0]!.includes(DEMO.password), "the password leaves the browser only sealed");
    const [row] = (await db.query<{ sealed: string; username: string }>("select sealed, username from public.vault_entries where site = 'demo'")).rows;
    check(row && !row.sealed.includes(DEMO.password) && row.username === DEMO.username, "only sealed data in the database");
    const [audited] = (await db.query<{ detail: string }>("select detail::text from public.audit_log where event = 'vault_saved'")).rows;
    check(audited && !audited.detail.includes(DEMO.password) && !audited.detail.includes("sv1."), "audit entry without the secret");

    console.log("Server opens the vault and signs in");
    const vault = serverVault(
      {
        sites: async () => (await db.query<{ site: string }>("select site from public.vault_entries order by site")).rows.map((entry) => entry.site),
        row: async (site) => (await db.query<{ site: string; sealed: string }>("select site, sealed from public.vault_entries where site = $1", [site])).rows[0] ?? null,
      },
      keys.privateKey,
    );
    const entry = await vault.get("demo");
    check(entry?.password === DEMO.password && entry.hosts[0] === DEMO.host, "the private key opens the entry");
    const sessions = new SiteSessions({ vault, profilesDir: mkdtempSync(join(tmpdir(), "serain-e2e-profiles-")), chromePath });
    const session = await sessions.open("demo");
    check(session.login === "done", `sign-in on the demo site: ${session.login}`);
    check(session.page.url.includes("/inventory"), "signed-in area visible");
    check(!JSON.stringify(session.page).includes(DEMO.password), "password never in the snapshot");
    await session.close();

    console.log("Deleting requires a fresh confirmation");
    await waitFor(page, DEMO.username);
    check((await page.locator(".vault-item").innerText()).includes(DEMO.host), "entry in the list, without the password");
    await shot(page, "5-vault");
    if (SHOTS) {
      // Widths that matter for the layout: iPad landscape, MacBook, large monitor.
      for (const [width, height, name] of [[1180, 820, "ipad"], [1728, 1080, "macbook"], [2560, 1400, "monitor"]] as const) {
        await page.setViewportSize({ width, height });
        await shot(page, `w-${name}-vault`);
        await nav("Audit").click();
        await waitFor(page, "Mail sent");
        await shot(page, `w-${name}-audit`);
        await nav("Memory").click();
        await waitFor(page, "E2E: wohnt in Cordheim.");
        await shot(page, `w-${name}-memory`);
        await nav("Vault").click();
        await waitFor(page, DEMO.username);
      }
      await page.setViewportSize({ width: 1280, height: 820 });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "6-vault-phone");
    await nav("Audit").click();
    await waitFor(page, "Mail sent");
    await shot(page, "7-audit-phone");
    await nav("Memory").click();
    await waitFor(page, "E2E: wohnt in Cordheim.");
    await shot(page, "8-memory-phone");
    await nav("Vault").click();
    await waitFor(page, DEMO.username);
    await page.getByRole("button", { name: "Replace" }).click();
    await shot(page, "9-replace-phone");
    await page.getByRole("button", { name: "Cancel" }).click();
    check((await page.locator("dialog.closing").count()) === 1, "the sheet slides back when closing instead of vanishing");
    await page.locator("dialog").waitFor({ state: "detached" });
    await page.setViewportSize({ width: 1280, height: 820 });
    await db.exec("update public.web_sessions set verified_at = now() - interval '10 minutes'");
    await page.locator(".vault-item").hover();
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete demo" }).click();
    await waitFor(page, "demo is deleted");
    const [reauth] = (await db.query<{ count: number }>("select count(*)::int as count from public.audit_log where event = 'web_login' and detail->>'reauth' = 'true'")).rows;
    check(reauth?.count === 1, "the passkey was asked again before deleting");
    check((await db.query("select 1 from public.vault_entries")).rows.length === 0, "the entry is gone");

    console.log("Vault: files");
    await page.locator(".tabs").getByRole("link", { name: /Files/ }).click();
    await waitFor(page, "No files yet");
    check(page.url().endsWith("/vault/files"), "the files tab is in the address");
    const pdfMarker = `E2E-AUSWEIS-${randomBytes(6).toString("hex")}`;
    const pdf = Buffer.from(`%PDF-1.4\n% ${pdfMarker}\n${"x".repeat(50_000)}\n%%EOF\n`);
    await page.getByRole("button", { name: "Store the first file" }).click();
    await page.getByRole("button", { name: "Seal and store" }).click();
    await waitFor(page, "No file chosen");
    // Too large: the message shows at the field, nothing goes out.
    await page.locator('input[name="file"]').setInputFiles({ name: "Riesig.pdf", mimeType: "application/pdf", buffer: Buffer.concat([pdf, Buffer.alloc(11 * 1024 * 1024)]) });
    await page.getByRole("button", { name: "Seal and store" }).click();
    await waitFor(page, "is too large");
    // A format Chrome cannot read is not stored with its metadata but refused.
    await page.locator('input[name="file"]').setInputFiles({ name: "Ausweis.heic", mimeType: "image/heic", buffer: randomBytes(2_000) });
    await page.getByRole("button", { name: "Seal and store" }).click();
    await waitFor(page, "The browser cannot read this image");
    check((await db.query("select 1 from public.vault_files")).rows.length === 0, "refused files do not go out");
    await page.locator('input[name="file"]').setInputFiles({ name: "Personalausweis 2026.pdf", mimeType: "application/pdf", buffer: pdf });
    check((await page.locator('input[name="site"]').inputValue()) === "personalausweis-2026", "name prefilled from the file name");
    await page.locator('input[name="site"]').fill("ausweis");
    await shot(page, "14-file-form");
    const filePuts: string[] = [];
    page.on("request", (request) => void (request.method() === "PUT" && request.url().includes("/files/") && filePuts.push(request.postData() ?? "")));
    await page.getByRole("button", { name: "Seal and store" }).click();
    await waitFor(page, "ausweis is in the vault");
    check(filePuts.length === 1 && !filePuts[0]!.includes(pdfMarker) && !filePuts[0]!.includes(pdf.subarray(0, 300).toString("base64").slice(0, 40)), "the file leaves the browser only sealed");
    const [fileRow] = (await db.query<{ sealed: Uint8Array; size: number; filename: string }>("select sealed, size, filename from public.vault_files where name = 'ausweis'")).rows;
    check(fileRow && !Buffer.from(fileRow.sealed).includes(pdfMarker) && fileRow.size === pdf.length && fileRow.filename === "Personalausweis 2026.pdf", "only sealed data in the database, the size is right");
    const [fileAudit] = (await db.query<{ detail: string }>("select detail::text from public.audit_log where event = 'vault_file_saved'")).rows;
    check(fileAudit && !fileAudit.detail.includes(pdfMarker), "audit entry without content");

    // A photo with EXIF: place and device must never go along.
    const exifMarker = `E2E-ORT-${randomBytes(6).toString("hex")}`;
    const drawn = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 120;
      canvas.height = 80;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#336";
      context.fillRect(0, 0, 120, 80);
      return canvas.toDataURL("image/jpeg", 0.9).split(",")[1]!;
    });
    const photo = jpegWithExif(Buffer.from(drawn, "base64"), exifMarker);
    check(photo.includes(exifMarker), "the test photo carries EXIF");
    await page.getByRole("button", { name: "Store file" }).click();
    await page.locator('input[name="file"]').setInputFiles({ name: "IMG_4711.HEIC.jpeg", mimeType: "image/jpeg", buffer: photo });
    await page.locator('input[name="site"]').fill("ausweis");
    await page.getByRole("button", { name: "Seal and store" }).click();
    await waitFor(page, "already exists");
    await page.locator('input[name="site"]').fill("ausweis-foto");
    await page.getByRole("button", { name: "Seal and store" }).click();
    await waitFor(page, "ausweis-foto is in the vault");

    console.log("Server opens the files");
    const files = serverVaultFiles(
      {
        list: async () =>
          (await db.query<{ name: string; filename: string; mime_type: string; size: number; updated_at: Date }>("select name, filename, mime_type, size, updated_at from public.vault_files order by name")).rows.map((r) => ({
            name: r.name,
            filename: r.filename,
            mimeType: r.mime_type,
            size: r.size,
            updatedAt: new Date(r.updated_at),
          })),
        sealed: async (name) => (await db.query<{ sealed: Uint8Array }>("select sealed from public.vault_files where name = $1", [name])).rows[0]?.sealed ?? null,
      },
      keys.privateKey,
    );
    const openedPdf = await files.open("ausweis");
    check(openedPdf !== null && openedPdf.body.equals(pdf) && openedPdf.mimeType === "application/pdf" && openedPdf.filename === "Personalausweis 2026.pdf", "the private key opens the file, byte for byte");
    const openedPhoto = await files.open("ausweis-foto");
    check(openedPhoto !== null && openedPhoto.body[0] === 0xff && openedPhoto.body[1] === 0xd8 && openedPhoto.mimeType === "image/jpeg", "the photo is a JPEG");
    check(openedPhoto !== null && !openedPhoto.body.includes(exifMarker) && !openedPhoto.body.includes(Buffer.from("Exif\0\0", "latin1")), "photo without EXIF");
    check(openedPhoto?.filename === "IMG_4711.HEIC.jpg", "the file name matches the new format");
    const shelf = new FileShelf();
    const delivered: OutboundFile[] = [];
    const vaultTools = new ToolRegistry().registerAll(vaultFileTools({ files, shelf, port: { sendFile: async (file) => (delivered.push(file), true) } }));
    const ownerTurn = new TurnState({ origin: "owner_message", triggerExternalId: "x", triggerMessageId: "m", reactableIds: [] });
    const sentToOwner = await vaultTools.execute("vault_file", { name: "ausweis", send_to_owner: true }, ownerTurn);
    check(sentToOwner.ok && delivered[0]?.body.equals(pdf) && !sentToOwner.text.includes(pdfMarker), "vault_file sends it to the owner, the model does not see the content");
    const shelfId = /files \["([0-9a-f]{16})"\]/.exec(sentToOwner.text)?.[1] ?? "";
    check(shelf.get(shelfId)?.body.equals(pdf), "mail_send finds it on the shelf");
    const heartbeat = await vaultTools.execute("vault_file", { name: "ausweis", send_to_owner: true }, new TurnState({ origin: "heartbeat", triggerExternalId: "", triggerMessageId: "", reactableIds: [] }));
    check(!heartbeat.ok && delivered.length === 1, "without the owner asking nothing opens");

    console.log("The worker checks what it accepts");
    const forgedFile = await fetch(`${ORIGIN}/api/vault/files/fremd`, { method: "PUT", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    check(forgedFile.status === 403, "file from a foreign origin: 403");
    // With the owner's session, but past the client: the worker itself has to refuse unsealed data.
    const cookie = (await context.cookies(ORIGIN)).map((c) => `${c.name}=${c.value}`).join("; ");
    const unsealed = await fetch(`${ORIGIN}/api/vault/files/klartext`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({ filename: "a.pdf", mimeType: "application/pdf", size: 4, sealed: Buffer.from("%PDF").toString("base64url") }),
    });
    check(unsealed.status === 400, "the worker refuses unsealed data");

    console.log("Replace and delete files");
    await waitFor(page, "Personalausweis 2026.pdf");
    await shot(page, "15-files");
    await page.locator(".vault-item", { hasText: "Personalausweis 2026.pdf" }).hover();
    await page.locator(".vault-item", { hasText: "Personalausweis 2026.pdf" }).getByRole("button", { name: "Replace" }).click();
    check(await page.locator('input[name="site"]').count() === 0, "the name stays when replacing");
    const pdf2 = Buffer.from(`%PDF-1.4\n% neu\n%%EOF\n`);
    await page.locator('input[name="file"]').setInputFiles({ name: "Ausweis neu.pdf", mimeType: "application/pdf", buffer: pdf2 });
    await page.getByRole("button", { name: "Replace" }).last().click();
    // The chosen file name is already in the dialog; it is only done when the dialog is closed.
    await page.locator("dialog").waitFor({ state: "detached" });
    await waitFor(page, "Ausweis neu.pdf");
    check((await files.open("ausweis"))?.body.equals(pdf2), "replaced: the server opens the new one");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "16-files-phone");
    await page.setViewportSize({ width: 1280, height: 820 });
    await db.exec("update public.web_sessions set verified_at = now() - interval '10 minutes'");
    await page.locator(".vault-item", { hasText: "ausweis-foto" }).hover();
    await page.locator(".vault-item", { hasText: "ausweis-foto" }).getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete ausweis-foto" }).click();
    await waitFor(page, "ausweis-foto is deleted");
    check((await db.query("select name from public.vault_files")).rows.length === 1, "the file is gone");
    const [reauths] = (await db.query<{ count: number }>("select count(*)::int as count from public.audit_log where event = 'web_login' and detail->>'reauth' = 'true'")).rows;
    check(reauths?.count === 2, "the passkey was asked again before deleting");
    // Reload: the audit from before is not 10 seconds old yet and would otherwise come from the cache.
    await page.goto(`${ORIGIN}/audit`);
    await waitFor(page, "Vault: file ausweis replaced");
    check((await page.locator("main").innerText()).includes("Vault: file ausweis-foto deleted"), "storing and deleting are in the audit");

    console.log("Connections");
    // COROS against the test provider: one tool points to its `get_day`, the others are missing at the provider
    // (struck through), and `secret_admin_tool` is in no catalog.
    const provider = await fakeProvider({ tools: ["get_day", "secret_admin_tool"] });
    const corosTools = COROS_TOOLS.map((spec) =>
      spec.name === "coros_daily_health" ? remoteTool({ name: spec.name, remote: "get_day", description: spec.description, schema: { date: z.string() } }) : spec,
    );
    const connectorTools = new Map<string, ToolDefinition>();
    const connectors = new ConnectorService({
      store: pgliteConnectors(db),
      sealKey: randomBytes(32),
      vaultKey: () => loadVaultKey(keys.privateKey),
      drivers: (clients) => [mcpOAuthDriver({ id: "coros", url: `${FAKE_ORIGIN}/mcp`, issuer: FAKE_ORIGIN, scope: "", tools: corosTools, promptLine: "coros" }, { clients, fetch: provider.fetch })],
      tools: { add: (defs) => defs.forEach((def) => connectorTools.set(def.name, def)), remove: (names) => names.forEach((name) => connectorTools.delete(name)) },
      onChange: () => undefined,
      origins: [ORIGIN],
      audit: async (event, detail) => void (await db.query("insert into public.audit_log (event, detail) values ($1, $2)", [event, JSON.stringify(detail)])),
    });
    await connectors.start();
    try {
      // The provider approves at once and sends back, as COROS would after signing in.
      await page.route(`${FAKE_ORIGIN}/**`, async (route) => {
        const back = provider.authorize(route.request().url());
        await route.fulfill({ status: 302, headers: { location: `${back.redirect}?code=${back.code}&state=${back.state}` } });
      });
      const finishBodies: string[] = [];
      page.on("request", (request) => void (request.url().includes("/finish") && finishBodies.push(request.postData() ?? "")));
      await nav("Connections").click();
      await page.locator(".conn", { hasText: "COROS" }).waitFor({ timeout: 15_000 });
      check((await page.locator(".conn").count()) === 2, "two services in the catalog");
      await shot(page, "11-connections");
      await page.locator(".conn", { hasText: "COROS" }).getByRole("button", { name: "Connect", exact: true }).click();
      await page
        .locator(".conn.is-ok", { hasText: "COROS" })
        .waitFor({ timeout: 30_000 })
        .catch(async (error: unknown) => {
          const rows = (await db.query("select id, status, error from public.connectors")).rows;
          console.log(`--- Page (${page.url()}) ---\n${await page.locator("body").innerText().catch(() => "")}\n--- connectors ---\n${JSON.stringify(rows)}\n--- Worker ---\n${workerOutput.split("\n").slice(-15).join("\n")}`);
          throw error;
        });
      check(page.url() === `${ORIGIN}/connections`, "code and state disappear from the address bar");
      check(finishBodies.length === 1 && !finishBodies[0]!.includes("code-") && finishBodies[0]!.includes("sv1."), "the code goes to the worker only sealed");
      const [stored] = (await db.query<{ status: string; sealed: string; pending: string | null }>("select status, sealed, pending from public.connectors where id = 'coros'")).rows;
      check(stored?.status === "connected" && stored.sealed.startsWith("v1.") && !stored.sealed.includes("at-") && stored.pending === null, "tokens are stored only sealed in the database");
      const day = connectorTools.get("coros_daily_health");
      const result = day ? await day.run({ date: "2026-10-03" }, new TurnState({ origin: "owner_message", triggerExternalId: "", triggerMessageId: "", reactableIds: [] })) : null;
      check(result?.ok === true && result.text.includes("1800 kcal"), "Serain reads through the connection");
      check(!connectorTools.has("secret_admin_tool") && connectorTools.has("coros_daily_health"), "only tools from the catalog");
      const card = page.locator(".conn", { hasText: "COROS" });
      await card.locator("summary").click();
      // The list expands (200 ms); it is read once it stands.
      await card.getByText("of the service.").waitFor();
      const cardText = await card.innerText();
      check(cardText.includes("Struck through: COROS does not offer it right now.") && cardText.includes("Serain does not get 1 other tool of the service."), "the card shows what is missing and what Serain does not get");
      await shot(page, "12-connected");
      await nav("Audit").click();
      await waitFor(page, "Connected: COROS");
      await nav("Connections").click();
      await page.locator(".conn.is-ok", { hasText: "COROS" }).waitFor();
      await page.locator(".conn", { hasText: "COROS" }).getByRole("button", { name: "Disconnect", exact: true }).click();
      await page.getByRole("button", { name: "Disconnect COROS" }).click();
      await waitFor(page, "COROS is disconnected.");
      check((await db.query("select 1 from public.connectors")).rows.length === 0, "connection deleted");
      check(provider.seen.revoked.length === 1, "revoked at the provider");
      check(!connectorTools.has("coros_daily_health"), "tools unregistered");
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(page, "13-connections-phone");
      await page.setViewportSize({ width: 1280, height: 820 });
    } finally {
      await connectors.stop();
      await provider.close();
    }

    console.log("Sign out");
    await page.getByRole("button", { name: "Sign out" }).click();
    await waitFor(page, "Sign in with passkey");
    await shot(page, "10-sign-in");
    check((await db.query("select 1 from public.web_sessions")).rows.length === 0, "session deleted in the database");
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await waitFor(page, "Passkey added");
    check(true, "signing in with the passkey");

    check(errors.length === 0, `no errors in the console${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    check(server.problems.length === 0, `database connections clean${server.problems.length ? `: ${server.problems.join(" | ")}` : ""}`);
  } finally {
    await browser.close();
    worker.kill("SIGTERM");
    await server.stop();
    await db.close();
  }
  console.log(failures === 0 ? "\nAll green." : `\n${failures} checks failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
