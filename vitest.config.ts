import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, type Plugin } from "vitest/config";

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * The aliases from tsconfig.json (`paths`), which vite does not read: `@instance/x.js`
 * is `instance/x.ts` if the instance has that file, else the empty default
 * (docs/INSTANCE.md); `@serain/x.js` is `src/x.ts`.
 */
function instanceAliases(): Plugin {
  const ts = (path: string) => path.replace(/\.js$/, ".ts");
  return {
    name: "serain-instance",
    enforce: "pre",
    resolveId(source) {
      if (source.startsWith("@instance/")) {
        const file = ts(source.slice("@instance/".length));
        const own = join(ROOT, "instance", file);
        return existsSync(own) ? own : join(ROOT, "src", "instance", "defaults", file);
      }
      if (source.startsWith("@serain/")) return join(ROOT, "src", ts(source.slice("@serain/".length)));
      return null;
    },
  };
}

/**
 * Tests sehen nie echte Zugänge. `src/config/env.ts` lädt lokal `.dev.vars`,
 * überschreibt aber nichts, was schon gesetzt ist — also stehen hier Attrappen
 * für alles, womit ein Test sonst die produktive Datenbank, Photon oder ein
 * bezahltes Modell erreichen könnte. Ein vergessener Mock scheitert dann an
 * einer toten Adresse statt still auf echte Daten zu schreiben.
 */
export default defineConfig({
  plugins: [instanceAliases()],
  test: {
    // Subagents arbeiten in Worktrees unter `.claude/worktrees/`; deren Kopien
    // der Tests gehören nicht zu diesem Checkout.
    exclude: [...configDefaults.exclude, ".claude/**"],
    env: {
      SUPABASE_URL: "http://127.0.0.1:9",
      SUPABASE_SECRET_KEY: "test-secret-key",
      SERAIN_DB_URL: "postgresql://serain_server:test@127.0.0.1:9/postgres",
      // Der Adapter-Test setzt eine Attrappe statt Spectrum ein; mit diesen
      // Werten scheiterte ein vergessener Test an Photons Anmeldung.
      PHOTON_PROJECT_ID: "test-photon-project",
      PHOTON_PROJECT_SECRET: "test-photon-secret",
      OWNER_PHONE: "+4915112345678",
      // Ein erfundener Besitzer, in allen Tests und Evals derselbe (src/config/owner.ts).
      OWNER_NAME: "Alex",
      OWNER_TIMEZONE: "Europe/Berlin",
      OWNER_COUNTRY: "DE",
      OWNER_REGION: "HE",
      OWNER_CITY: "Musterstadt",
      // Fixed texts to the owner render in German in tests, so existing expectations on them stay valid (src/i18n).
      OWNER_LANGUAGE: "de",
      SERAIN_WEB_ORIGIN: "https://serain.example.com",
      // Feste Deckel für die Budget-Tests (src/config/limits.ts): 6,50 $ API, 20 $ gesamt.
      SERAIN_API_BUDGET_USD: "6.5",
      SERAIN_TOTAL_BUDGET_USD: "20",
      SERAIN_FIXED_COST_USD: "",
      OPENROUTER_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      HEALTHCHECKS_PING_URL: "",
      // Phase 4: ohne Schlüssel keine Integrationen, ohne Key und Chrome kein Browser.
      // Mit den echten Werten aus `.dev.vars` hinge ein Runtime-Test an der toten Datenbank-Adresse.
      SERAIN_INTEGRATION_KEY: "",
      SERAIN_VAULT_KEY: "",
      ENABLE_BANKING_APP_ID: "",
      ENABLE_BANKING_KEY: "",
      ENABLE_BANKING_BANK: "",
      TYPESAFE_API_KEY: "",
      SERAIN_CHROME_PATH: "",
      SERAIN_COMPANION_PORT: "",
      SERAIN_COMPANION_TOKEN: "",
    },
  },
});
