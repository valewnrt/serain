import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
vi.mock("../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown>) => void audits.push({ event, detail }),
}));

const { seal, open, parseSealKey, SealError } = await import("../src/integrations/seal.js");
const { Integrations, IntegrationUnavailable } = await import("../src/integrations/service.js");
type IntegrationRow = import("../src/integrations/types.js").IntegrationRow;
type IntegrationStore = import("../src/integrations/types.js").IntegrationStore;

const KEY = randomBytes(32);
const GMX = { kind: "imap", user: "alex@example.org", password: "app-passwort-123", imapHost: "imap.gmx.net", imapPort: 993, smtpHost: "mail.gmx.net", smtpPort: 587 } as const;
const GOOGLE = { kind: "google", clientId: "client-id-0123456789", clientSecret: "client-secret", refreshToken: "refresh-token-0123456789" } as const;

function memoryStore(mailItems: Record<string, number> = {}) {
  const rows = new Map<string, IntegrationRow>();
  const store: IntegrationStore = {
    list: async () => [...rows.values()],
    has: async (id) => rows.has(id),
    get: async (id) => rows.get(id) ?? null,
    put: async (row) => void rows.set(row.id, row),
    saveState: async (id, state) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, state });
    },
    remove: async (id) => (rows.delete(id) ? { mailItems: mailItems[id] ?? 0 } : null),
  };
  return { rows, store };
}

describe("sealing (W16)", () => {
  it("opens what it sealed, and nothing in the sealed value is readable", () => {
    const sealed = seal(KEY, GMX);
    expect(sealed).not.toContain("app-passwort");
    expect(sealed).not.toContain(Buffer.from("app-passwort-123").toString("base64url"));
    expect(open(KEY, sealed)).toEqual(GMX);
    expect(seal(KEY, GMX)).not.toBe(sealed);
  });

  it("fails with a wrong key and on a modified entry", () => {
    const sealed = seal(KEY, GMX);
    expect(() => open(randomBytes(32), sealed)).toThrow(SealError);
    const parts = sealed.split(".");
    const data = Buffer.from(parts[3]!, "base64url");
    data[0] = data[0]! ^ 1;
    expect(() => open(KEY, [parts[0], parts[1], parts[2], data.toString("base64url")].join("."))).toThrow(SealError);
    expect(() => open(KEY, "v0.a.b.c")).toThrow(/unknown format/);
  });

  it("takes only a 32-byte key and does not name it in the message", () => {
    expect(parseSealKey(KEY.toString("base64"))).toEqual(KEY);
    expect(() => parseSealKey("zu-kurz")).toThrow(/32 bytes/);
    expect(() => parseSealKey("zu-kurz")).not.toThrow(/zu-kurz/);
  });
});

describe("integrations (D30)", () => {
  it("knows only `owner` and `serain` as a mailbox owner, no name", async () => {
    const { imapSecretSchema } = await import("../src/integrations/types.js");
    expect(imapSecretSchema.parse({ ...GMX, owner: "owner" }).owner).toBe("owner");
    expect(imapSecretSchema.parse({ ...GMX, owner: "serain" }).owner).toBe("serain");
    expect(imapSecretSchema.parse(GMX).owner).toBeUndefined();
    expect(() => imapSecretSchema.parse({ ...GMX, owner: "alex" })).toThrow();
  });

  it("stores only sealed values and hands out the secret only for the matching kind", async () => {
    const { store, rows } = memoryStore();
    const integrations = new Integrations(store, KEY);
    await integrations.connect({ id: "gmx", account: "alex@example.org", scopes: ["imap", "smtp"], secret: GMX });
    expect(JSON.stringify([...rows.values()])).not.toContain("app-passwort");
    expect(await integrations.secret("gmx", "imap")).toEqual(GMX);
    await expect(integrations.secret("gmx", "google")).rejects.toThrow(IntegrationUnavailable);
    await expect(integrations.secret("fehlt", "imap")).rejects.toThrow(/not connected/);
    expect(audits.at(-1)).toEqual({ event: "integration_connected", detail: { id: "gmx", kind: "imap", scopes: ["imap", "smtp"], reconnect: false } });
  });

  it("is off without a key: no list, no secret, no connecting", async () => {
    const { store } = memoryStore();
    const off = new Integrations(store, null);
    expect(off.enabled).toBe(false);
    expect(await off.list()).toEqual([]);
    await expect(off.connect({ id: "gmx", account: "a", scopes: [], secret: GMX })).rejects.toThrow(/SERAIN_INTEGRATION_KEY/);
  });

  it("keeps the trigger's bookmark when reconnecting the same account", async () => {
    const { store, rows } = memoryStore();
    const integrations = new Integrations(store, KEY);
    await integrations.connect({ id: "gmx", account: "alex@example.org", scopes: [], secret: GMX });
    await integrations.saveState("gmx", { uidNext: 812 });
    await integrations.connect({ id: "gmx", account: "alex@example.org", scopes: [], secret: GMX });
    expect(rows.get("gmx")?.state).toEqual({ uidNext: 812 });
    await integrations.connect({ id: "gmx", account: "anderes@example.org", scopes: [], secret: GMX });
    expect(rows.get("gmx")?.state).toEqual({});
  });
});

describe("disconnecting really deletes (W13)", () => {
  it("revokes at the provider, deletes the credential with its mail data and writes the deletion with numbers into the audit log", async () => {
    const { store, rows } = memoryStore({ google: 7 });
    const revoked: string[] = [];
    const integrations = new Integrations(store, KEY, {
      google: async (secret) => void revoked.push(secret.kind === "google" ? secret.refreshToken : ""),
    });
    await integrations.connect({ id: "google", account: "alex@gmail.example", scopes: ["gmail.readonly"], secret: GOOGLE });
    const result = await integrations.disconnect("google", "cli");
    expect(result).toEqual({ id: "google", existed: true, mailItems: 7, revoked: true });
    expect(revoked).toEqual([GOOGLE.refreshToken]);
    expect(rows.size).toBe(0);
    expect(audits.at(-1)).toEqual({
      event: "integration_disconnected",
      detail: { id: "google", kind: "google", via: "cli", mail_items: 7, revoked: true },
    });
    expect(JSON.stringify(audits)).not.toContain(GOOGLE.refreshToken);
  });

  it("deletes even when the revocation fails, and says so", async () => {
    const { store, rows } = memoryStore();
    const integrations = new Integrations(store, KEY, { google: async () => Promise.reject(new Error("offline")) });
    await integrations.connect({ id: "google", account: "a@b.example", scopes: [], secret: GOOGLE });
    expect((await integrations.disconnect("google", "cli")).revoked).toBe(false);
    expect(rows.size).toBe(0);
  });

  it("has no revocation for IMAP and reports an unknown credential as not existing", async () => {
    const { store } = memoryStore({ gmx: 3 });
    const integrations = new Integrations(store, KEY);
    await integrations.connect({ id: "gmx", account: "a@b.example", scopes: [], secret: GMX });
    expect(await integrations.disconnect("gmx", "owner")).toEqual({ id: "gmx", existed: true, mailItems: 3, revoked: null });
    expect(await integrations.disconnect("gmx", "owner")).toEqual({ id: "gmx", existed: false, mailItems: 0, revoked: null });
  });
});

describe("disconnecting takes effect immediately, also in the running process (W13)", () => {
  it("answers disconnected after the credential is deleted, without touching the mailbox again", async () => {
    const { connectServices } = await import("../src/integrations/setup.js");
    const { MailError } = await import("../src/mail/types.js");
    const { store } = memoryStore();
    const integrations = new Integrations(store, KEY);
    await integrations.connect({ id: "gmx", account: "alex@example.org", scopes: [], secret: GMX });
    const services = await connectServices(integrations);
    expect(services.mail.map((account) => `${account.id} ${account.address}`)).toEqual(["gmx alex@example.org"]);
    expect(services.calendar).toBeNull();
    await integrations.disconnect("gmx", "cli");
    await expect(services.mail[0]!.search({ sinceDays: 1, limit: 1, folder: "all" })).rejects.toThrow(MailError);
    await expect(services.mail[0]!.search({ sinceDays: 1, limit: 1, folder: "all" })).rejects.toThrow(/disconnected/);
    // Also a mailbox's capabilities (D37): nothing is moved any more after disconnecting.
    await expect(services.mail[0]!.cleanup!.move("inbox", ["1"], "trash")).rejects.toThrow(/disconnected/);
    await expect(services.mail[0]!.cleanup!.scan("inbox", 1, 1)).rejects.toThrow(/disconnected/);
    await expect(services.mail[0]!.cleanup!.headersFrom(["news@shop.example"], 1, 1)).rejects.toThrow(/disconnected/);
  });

  it("takes the mailbox connected first as the main mailbox, no matter which provider", async () => {
    const { connectServices } = await import("../src/integrations/setup.js");
    const { store } = memoryStore();
    const integrations = new Integrations(store, KEY);
    await integrations.connect({ id: "google", account: "alex@gmail.example", scopes: [], secret: GOOGLE });
    await integrations.connect({ id: "gmx", account: "alex@example.org", scopes: [], secret: GMX });
    expect((await connectServices(integrations)).mail.map((account) => account.id)).toEqual(["google", "gmx"]);
    // Reconnecting (new password) does not change the order.
    await integrations.connect({ id: "google", account: "alex@gmail.example", scopes: [], secret: GOOGLE });
    const services = await connectServices(integrations);
    expect(services.mail.map((account) => account.id)).toEqual(["google", "gmx"]);
    expect(services.calendar).not.toBeNull();

    const other = new Integrations(memoryStore().store, KEY);
    await other.connect({ id: "posteo", account: "alex@posteo.example", scopes: [], secret: { ...GMX, imapHost: "posteo.de", smtpHost: "posteo.de" } });
    await other.connect({ id: "google", account: "alex@gmail.example", scopes: [], secret: GOOGLE });
    expect((await connectServices(other)).mail.map((account) => account.id)).toEqual(["posteo", "google"]);
  });
  it("puts Serain's own mailbox behind all of Alex's, without cleanup (addendum D31 of 2026-10-08)", async () => {
    const { connectServices } = await import("../src/integrations/setup.js");
    const { store } = memoryStore();
    const integrations = new Integrations(store, KEY);
    const own = { ...GMX, user: "hi@serain.example", imapHost: "imap.example.com", smtpHost: "smtp.example.com", smtpPort: 465, owner: "serain" } as const;
    await integrations.connect({ id: "serain", account: "hi@serain.example", scopes: [], secret: own });
    await integrations.connect({ id: "google", account: "alex@gmail.example", scopes: [], secret: GOOGLE });
    await integrations.connect({ id: "gmx", account: "alex@example.org", scopes: [], secret: GMX });
    const services = await connectServices(integrations);
    expect(services.mail.map((account) => [account.id, account.serains === true, Boolean(account.cleanup)])).toEqual([
      ["google", false, false],
      ["gmx", false, true],
      ["serain", true, false],
    ]);
  });

  it("cleans up in Gmail only once Alex granted gmail.modify (addendum D37 of 2026-10-13)", async () => {
    const { connectServices } = await import("../src/integrations/setup.js");
    const { store } = memoryStore();
    const integrations = new Integrations(store, KEY);
    await integrations.connect({ id: "google", account: "alex@gmail.example", scopes: ["https://www.googleapis.com/auth/gmail.readonly"], secret: GOOGLE });
    expect((await connectServices(integrations)).mail[0]?.cleanup).toBeUndefined();
    await integrations.connect({ id: "google", account: "alex@gmail.example", scopes: ["https://www.googleapis.com/auth/gmail.modify"], secret: GOOGLE });
    const services = await connectServices(integrations);
    expect(services.mail[0]?.cleanup).toBeDefined();
    await integrations.disconnect("google", "cli");
    await expect(services.mail[0]!.cleanup!.move("inbox", ["aaaaaa01"], "trash")).rejects.toThrow(/disconnected/);
  });
});
