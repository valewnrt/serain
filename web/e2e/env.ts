import { loadDevVars } from "../../src/config/dotenv.js";

/**
 * Environment for `pnpm web:e2e`, loaded before anything from `src/`.
 *
 * First dummies for everything `src/config/env.ts` could reach a service with
 * (as in vitest.config.ts): dead addresses, invented values. They come before
 * `.dev.vars` and therefore always win, so a forgotten path never ends up in
 * the real database or at Photon. The same goes for the owner's time zone and
 * starting language (both pinned like in vitest.config.ts, but English, the
 * language of the web interface). Then `.dev.vars`, if it exists (e.g. for
 * `SERAIN_CHROME_PATH`), and an owner name for the run if none is set. That
 * way the test also runs in a fresh checkout.
 */
Object.assign(process.env, {
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SECRET_KEY: "e2e-secret-key",
  SERAIN_DB_URL: "postgresql://serain_server:e2e@127.0.0.1:9/postgres",
  PHOTON_PROJECT_ID: "e2e-photon-project",
  PHOTON_PROJECT_SECRET: "e2e-photon-secret",
  OWNER_PHONE: "+4915112345678",
  OPENROUTER_API_KEY: "",
  CLAUDE_CODE_OAUTH_TOKEN: "",
  HEALTHCHECKS_PING_URL: "",
  SERAIN_INTEGRATION_KEY: "",
  SERAIN_VAULT_KEY: "",
  ENABLE_BANKING_APP_ID: "",
  ENABLE_BANKING_KEY: "",
  TYPESAFE_API_KEY: "",
  SERAIN_COMPANION_PORT: "",
  SERAIN_COMPANION_TOKEN: "",
  OWNER_TIMEZONE: "Europe/Berlin",
  OWNER_LANGUAGE: "en",
});
loadDevVars();
process.env["OWNER_NAME"] ||= "Alex";
