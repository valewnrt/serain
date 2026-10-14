import { redactValue } from "../log.js";
import { loadDevVars } from "./dotenv.js";

/**
 * Secrets come from the process environment (`src/config/dotenv.ts`).
 * Values are never logged, never given to the model, never written to the repo.
 * Who runs Serain and where lives in `src/config/owner.ts`.
 */
loadDevVars();

const REQUIRED = [
  "PHOTON_PROJECT_ID",
  "PHOTON_PROJECT_SECRET",
  "OWNER_PHONE",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SERAIN_DB_URL",
] as const;

function required(name: (typeof REQUIRED)[number]): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Env ${name} is missing. Serain does not start without it.`);
  }
  return value;
}

function e164(name: (typeof REQUIRED)[number]): string {
  const value = required(name);
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error(`Env ${name} is not an E.164 number (expected +49…).`);
  }
  return value;
}

function companionPort(raw: string | undefined): number | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("Env SERAIN_COMPANION_PORT is not a port between 1024 and 65535.");
  }
  return port;
}

/**
 * How Serain reaches Claude (Agent SDK). The default is an API key from the
 * Anthropic Console: that is what Anthropic requires for applications built on
 * Claude, and every request has a price that the budget cap counts. The
 * subscription token (`claude setup-token`) is the option for purely personal
 * use of one's own instance, at one's own risk; it costs nothing per request.
 *
 * If both are set, the key wins: whoever enters a key has chosen the billed,
 * capped path, and a forgotten token must not silently undermine that. The
 * child process always gets exactly one of the two (`claudeChildEnv` in
 * `src/agent/model.ts`). Without either, Serain runs only over OpenRouter, if
 * there is a key for it.
 */
export type ClaudeAuth = "api_key" | "oauth";

export function pickClaudeAuth(apiKey: string, oauthToken: string): ClaudeAuth | null {
  if (apiKey) return "api_key";
  if (oauthToken) return "oauth";
  return null;
}

const anthropicApiKey = process.env["ANTHROPIC_API_KEY"]?.trim() ?? "";
const claudeOauthToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"]?.trim() ?? "";

export const env = {
  ownerPhone: e164("OWNER_PHONE"),
  /** Photon project (D38). Photon assigns the number from the shared pool. */
  photonProjectId: required("PHOTON_PROJECT_ID"),
  photonProjectSecret: required("PHOTON_PROJECT_SECRET"),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
  /**
   * Postgres through the pooler as role `serain_server` (0030, addendum D50 of
   * 2026-10-11): only for the clock, which would otherwise blow Supabase's free
   * quota for logs and egress. Set with `pnpm db:password`.
   */
  dbUrl: required("SERAIN_DB_URL"),
  /** API key from the Anthropic Console (`sk-ant-api…`). The default way to Claude. */
  anthropicApiKey,
  /** Subscription token (`sk-ant-oat…`). Personal use only, at one's own risk. */
  claudeOauthToken,
  /** The chosen access, null without Claude. See {@link pickClaudeAuth}. */
  claudeAuth: pickClaudeAuth(anthropicApiKey, claudeOauthToken),
  openrouterApiKey: process.env["OPENROUTER_API_KEY"]?.trim() ?? "",
  /**
   * Tavily key for the executor's web search (D16). Optional: without it there
   * is no `web_search` tool; fetching single pages still works.
   */
  tavilyApiKey: process.env["TAVILY_API_KEY"]?.trim() ?? "",
  /**
   * Unix socket of the sandbox helper (D20). Optional: without it there is
   * neither `run_code` nor attachments. On the server `/run/serain-sandbox.sock`.
   */
  sandboxSocket: process.env["SERAIN_SANDBOX_SOCKET"]?.trim() ?? "",
  /**
   * Directory for the socket of the filter proxy through which the sandbox job
   * `media_fetch` downloads videos (D61). Must match `MEDIA_PROXY_DIR` in the
   * helper; on the server `/run/serain/media-proxy`. Without it, `media_watch`
   * works only for YouTube.
   */
  mediaProxyDir: process.env["SERAIN_MEDIA_PROXY_DIR"]?.trim() ?? "",
  /**
   * Mac companion (D28). Optional, and only both together: the loopback port on
   * which the SSH tunnel makes the Mac appear, and the shared token. Without
   * them there are neither the `mac_*` tools nor `mac_browser`.
   */
  companionPort: companionPort(process.env["SERAIN_COMPANION_PORT"]),
  companionToken: process.env["SERAIN_COMPANION_TOKEN"]?.trim() ?? "",
  /**
   * Key for sealed credentials (D30, W16), 32 bytes base64. Optional: without
   * it there are no integrations (mail, Google). Lives only in the server env
   * and locally in `.dev.vars`, never in the database.
   */
  integrationKey: process.env["SERAIN_INTEGRATION_KEY"]?.trim() ?? "",
  /**
   * Private key of the vault (D49), P-256 as PKCS#8 base64url. Optional:
   * without it there are no logged-in sessions. The web interface knows the
   * public part; it seals entries in the browser, only the server can open them.
   * Generated with `pnpm web vault-key`.
   */
  vaultKey: process.env["SERAIN_VAULT_KEY"]?.trim() ?? "",
  /**
   * Typesafe key for Jev as the browser pilot (D35). Optional: without it there
   * is no `web_browse`.
   */
  typesafeApiKey: process.env["TYPESAFE_API_KEY"]?.trim() ?? "",
  /**
   * Path to an installed Chrome or Chromium for `web_browse` (D35). On the
   * server `/usr/local/bin/serain-chromium`, see `deploy/README.md`.
   */
  chromePath: process.env["SERAIN_CHROME_PATH"]?.trim() ?? "",
  /**
   * Enable Banking app for read access to the bank account (D51): app ID and
   * private RSA key as PEM, base64-encoded so it fits on one line. Optional:
   * without both, the bank cannot be connected in the web interface.
   * Generated with `pnpm connector bank-key`.
   */
  enableBankingAppId: process.env["ENABLE_BANKING_APP_ID"]?.trim() ?? "",
  enableBankingKey: process.env["ENABLE_BANKING_KEY"]?.trim() ?? "",
  /**
   * The bank as Enable Banking lists it (`pnpm connector bank-check
   * <search_term>` shows the exact name), and its country per ISO 3166-1.
   * Without a bank there is no connection.
   */
  enableBankingBank: process.env["ENABLE_BANKING_BANK"]?.trim() ?? "",
  enableBankingCountry: process.env["ENABLE_BANKING_COUNTRY"]?.trim().toUpperCase() || "DE",
  /** Echo mode for the end-to-end test of the channel, without a model call. */
  echoOnly: process.env["SERAIN_ECHO_ONLY"] === "1",
  logLevel: process.env["SERAIN_LOG_LEVEL"]?.trim() || "info",
  /**
   * Healthchecks.io dead man's switch (W11, `src/health/deadman.ts`). Optional:
   * without it Serain runs normally, just without the external alarm path. Never
   * log or commit the value: it carries the secret ping UUID, so it is
   * registered as a secret right away, before anything is logged.
   */
  healthchecksPingUrl: process.env["HEALTHCHECKS_PING_URL"]?.trim() || undefined,
  /**
   * The only writable directory in operation. The Agent SDK keeps its state
   * there; otherwise the systemd service runs read-only.
   */
  dataDir: process.env["SERAIN_DATA_DIR"]?.trim() || process.cwd(),
  /**
   * Set by systemd (`RuntimeDirectory=serain`): there the service reports what
   * it is doing right now (`src/health/work.ts`). Empty locally, then only in memory.
   */
  runtimeDir: process.env["RUNTIME_DIRECTORY"]?.trim() || null,
} as const;

// Every secret is registered here, once, and not in `src/index.ts`: scripts that
// only load `env` log too. A new secret in `env` gets its line here.
redactValue(env.photonProjectSecret);
redactValue(env.supabaseSecretKey);
redactValue(env.dbUrl);
redactValue(env.anthropicApiKey);
redactValue(env.claudeOauthToken);
redactValue(env.openrouterApiKey);
redactValue(env.tavilyApiKey);
redactValue(env.companionToken);
redactValue(env.healthchecksPingUrl);
redactValue(env.integrationKey);
redactValue(env.vaultKey);
redactValue(env.typesafeApiKey);
redactValue(env.enableBankingKey);

export type Env = typeof env;
