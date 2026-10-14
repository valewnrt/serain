import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configChecks,
  hashValue,
  isLocalOnly,
  nextStep,
  parseEnvExample,
  parseServerProbe,
  redactor,
  render,
  serverChecks,
  STEPS,
  type Check,
  type ServerState,
} from "../scripts/setup-check.js";

const ROOT = join(import.meta.dirname, "..");
const specs = parseEnvExample(readFileSync(join(ROOT, ".env.example"), "utf8"));
const spec = (name: string) => specs.find((entry) => entry.name === name);

// All values made up.
const VARS: Record<string, string> = {
  OWNER_NAME: "Alex",
  OWNER_PHONE: "+4915112345678",
  OWNER_TIMEZONE: "Europe/Berlin",
  PHOTON_PROJECT_ID: "project-0000",
  PHOTON_PROJECT_SECRET: "photon-secret-made-up-0000",
  SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_madeupmadeupmadeup",
  SERAIN_DB_URL: "postgresql://serain_server.abc:pw-made-up-0000@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
  ANTHROPIC_API_KEY: "sk-ant-api03-madeupmadeupmadeup",
  SERAIN_HOST: "root@203.0.113.10",
  SUPABASE_DB_PASSWORD: "db-password-made-up",
};

function serverState(env: Record<string, string>, facts: Record<string, string> = {}): ServerState {
  return {
    facts: {
      user: "yes",
      node: "v22.23.1",
      docker: "yes",
      envfile: "root:serain 640",
      revision: "a".repeat(40),
      "unit.serain": "active",
      "unit.serain-sandbox.socket": "active",
      "unit.serain-watchdog.timer": "active",
      ...facts,
    },
    env: Object.fromEntries(Object.entries(env).map(([name, value]) => [name, hashValue(value)])),
    duplicates: [],
  };
}

const serverVars = Object.fromEntries(Object.entries(VARS).filter(([name]) => !isLocalOnly(spec(name)!)));
const byId = (checks: readonly Check[], id: string) => checks.find((check) => check.id === id);

describe("setup check: what .env.example declares", () => {
  it("reads required, optional and local-only variables from the comments", () => {
    expect(spec("OWNER_NAME")).toMatchObject({ required: true });
    expect(spec("OWNER_LANGUAGE")).toMatchObject({ required: false });
    // Photon's ID and secret share one "Required." comment.
    expect(spec("PHOTON_PROJECT_SECRET")).toMatchObject({ required: true });
    expect(spec("SERAIN_DB_URL")).toMatchObject({ required: true });
    expect(spec("ANTHROPIC_API_KEY")).toMatchObject({ required: false });
    for (const name of ["SERAIN_HOST", "SUPABASE_DB_PASSWORD", "CLOUDFLARE_API_TOKEN", "SITE_IMPRINT_PHONE"]) expect(isLocalOnly(spec(name)!), name).toBe(true);
    expect(isLocalOnly(spec("SUPABASE_SECRET_KEY")!)).toBe(false);
  });

  it("links every step to a section that exists in docs/SETUP.md", () => {
    const slug = (heading: string) => heading.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s/g, "-");
    const anchors = new Set(
      readFileSync(join(ROOT, "docs", "SETUP.md"), "utf8")
        .split("\n")
        .filter((line) => /^#{2,4} /.test(line))
        .map((line) => slug(line.replace(/^#+ /, ""))),
    );
    for (const [step, { anchor }] of Object.entries(STEPS)) expect(anchors.has(anchor), `${step}: ${anchor}`).toBe(true);
  });
});

describe("setup check: local configuration", () => {
  it("names what is missing, per step", () => {
    const { OWNER_PHONE: _phone, PHOTON_PROJECT_SECRET: _secret, ...rest } = VARS;
    const checks = configChecks(rest, specs);
    expect(byId(checks, "local.required.A2")).toMatchObject({ status: "fail", title: expect.stringContaining("OWNER_PHONE") });
    expect(byId(checks, "local.required.A4")).toMatchObject({ status: "fail", title: expect.stringContaining("PHOTON_PROJECT_SECRET") });
    expect(byId(checks, "local.required.A3")).toMatchObject({ status: "ok" });
    expect(nextStep(checks)?.id).toBe("local.required.A2");
  });

  it("refuses the wrong Supabase key and a missing Claude access", () => {
    const { ANTHROPIC_API_KEY: _key, ...rest } = VARS;
    const checks = configChecks({ ...rest, SUPABASE_SECRET_KEY: "sb_publishable_made_up" }, specs);
    expect(byId(checks, "local.supabase-key")).toMatchObject({ status: "fail" });
    expect(byId(checks, "local.claude")).toMatchObject({ status: "fail" });
  });

  it("asks for pnpm db:password and its inputs before SERAIN_DB_URL exists", () => {
    const { SERAIN_DB_URL: _url, SUPABASE_DB_PASSWORD: _password, ...rest } = VARS;
    const checks = configChecks(rest, specs);
    expect(byId(checks, "local.db-url")).toMatchObject({ status: "fail", step: "A7" });
    expect(byId(checks, "local.db-password-inputs")).toMatchObject({ status: "fail", title: expect.stringContaining("SUPABASE_DB_PASSWORD") });
  });
});

describe("setup check: the server", () => {
  it("passes a server that matches .dev.vars", () => {
    const checks = serverChecks(serverState(serverVars), VARS, specs, "a".repeat(40));
    expect(checks.filter((check) => check.status !== "ok")).toEqual([]);
  });

  it("fails when a local-only secret is on the server (the agent must not manage its own infrastructure)", () => {
    const checks = serverChecks(serverState({ ...serverVars, SUPABASE_DB_PASSWORD: VARS["SUPABASE_DB_PASSWORD"]! }), VARS, specs, "a".repeat(40));
    expect(byId(checks, "server.env.local-only")).toMatchObject({ status: "fail", title: expect.stringContaining("SUPABASE_DB_PASSWORD") });
  });

  it("names missing and differing values without showing them", () => {
    const { PHOTON_PROJECT_ID: _id, ...rest } = serverVars;
    const checks = serverChecks(serverState({ ...rest, SUPABASE_SECRET_KEY: "sb_secret_otherotherother" }), VARS, specs, "b".repeat(40));
    expect(byId(checks, "server.env.required")).toMatchObject({ status: "fail", title: expect.stringContaining("PHOTON_PROJECT_ID") });
    expect(byId(checks, "server.env.differs")).toMatchObject({ status: "warn", title: expect.stringContaining("SUPABASE_SECRET_KEY") });
    expect(byId(checks, "server.revision")).toMatchObject({ status: "warn" });
    const text = JSON.stringify(checks);
    for (const value of [VARS["SUPABASE_SECRET_KEY"]!, "sb_secret_otherotherother"]) expect(text).not.toContain(value);
  });

  it("sends an unprovisioned server to provision.sh and an empty one to deploy.sh", () => {
    const checks = serverChecks(serverState(serverVars, { user: "none", node: "none", revision: "none", "unit.serain": "inactive" }), VARS, specs, "a".repeat(40));
    expect(byId(checks, "server.provisioned")).toMatchObject({ status: "fail", fix: expect.stringContaining("provision.sh") });
    expect(byId(checks, "server.revision")).toMatchObject({ status: "fail", fix: expect.stringContaining("deploy.sh") });
  });

  it("reads the probe: facts, hashes and duplicates, never a value", () => {
    const hash = hashValue("x");
    const state = parseServerProbe(["user=yes", "envfile=root:serain 640", `env OWNER_NAME ${hash}`, "dup OWNER_NAME", "OWNER_NAME=leaked"].join("\n"));
    expect(state).toEqual({ facts: { user: "yes", envfile: "root:serain 640" }, env: { OWNER_NAME: hash }, duplicates: ["OWNER_NAME"] });
    expect(parseServerProbe("envfile=none").env).toBeNull();
  });
});

describe("setup check: output", () => {
  it("never shows a secret value, also not inside a message from elsewhere", () => {
    const redact = redactor(VARS);
    const message = `connect failed for ${VARS["SERAIN_DB_URL"]} with ${VARS["PHOTON_PROJECT_SECRET"]}`;
    expect(redact(message)).not.toContain(VARS["PHOTON_PROJECT_SECRET"]);
    expect(redact(message)).not.toContain("pw-made-up-0000");
    // Owner settings are not secret and stay readable in messages about them.
    expect(redact("OWNER_TIMEZONE is Europe/Berlin")).toBe("OWNER_TIMEZONE is Europe/Berlin");
  });

  it("names the next step with its section of the guide", () => {
    const text = render([
      { id: "a", step: "A1", status: "ok", title: "Node.js 22" },
      { id: "b", step: "A6", status: "fail", title: "Server not reachable over SSH", fix: "Check SERAIN_HOST." },
    ]);
    expect(text).toContain("Next: Check SERAIN_HOST. (docs/SETUP.md#a6-server)");
  });
});
