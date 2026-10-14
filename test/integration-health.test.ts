import { beforeEach, describe, expect, it, vi } from "vitest";

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
vi.mock("../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown> = {}) => void audits.push({ event, detail }),
}));

const { IntegrationHealth, describeDown, describeExpiry, failureKind, mailSubject, monitoredCalendar, reconnectCommand } = await import("../src/health/integrations.js");
const { MailTrigger, EMPTY_TRIGGER_STATE } = await import("../src/mail/trigger.js");
const { fakeMailAccount } = await import("./mail-account.fake.js");
const { installTranslations } = await import("../src/i18n/catalog.js");
const { health: healthText } = await import("../src/i18n/messages/health.js");
type Incident = import("../src/health/incidents.js").Incident;
type ExpiringConnector = import("../src/health/integrations.js").ExpiringConnector;
type Calendar = import("../src/calendar/types.js").Calendar;

// Monday, 05.10.2026, 12:00 in Berlin.
const NOON = new Date("2026-10-05T10:00:00Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const GMX = mailSubject({ id: "gmx" });

beforeEach(() => void (audits.length = 0));

function harness(options: { connectors?: ExpiringConnector[]; sendFails?: boolean } = {}) {
  let now = NOON;
  let paused = false;
  const sent: Array<{ text: string; context: Record<string, unknown>; verbatim: boolean }> = [];
  const incidents = new Map<string, Incident>();
  let warned: Record<string, string> = {};
  let seq = 0;
  const health = new IntegrationHealth({
    send: async (text, context, sendOptions) => {
      if (options.sendFails) return false;
      sent.push({ text, context, verbatim: sendOptions?.verbatim === true });
      return true;
    },
    incidents: {
      find: async (component) => incidents.get(component) ?? null,
      open: async (component, cause) => {
        const incident: Incident = { id: `i${(seq += 1)}`, component, started_at: now.toISOString(), ended_at: null, root_cause: cause, note: null, detail: {} };
        incidents.set(component, incident);
        return incident;
      },
      close: async (component) => void incidents.delete(component),
      markNotified: async (incident) => void (incident.detail = { ...incident.detail, notified: true }),
    },
    ...(options.connectors ? { connectors: async () => options.connectors! } : {}),
    expiryWarned: { load: async () => ({ ...warned }), save: async (value) => void (warned = { ...value }) },
    paused: async () => paused,
    now: () => now,
  });
  return {
    health,
    sent,
    incidents,
    warned: () => warned,
    advance: (ms: number) => void (now = new Date(now.getTime() + ms)),
    setNow: (next: Date) => void (now = next),
    setPaused: (value: boolean) => void (paused = value),
  };
}

describe("reporting broken logins (audit 2026-10-05)", () => {
  it("stays silent on short dropouts and reports only after 20 min, once, with an all-clear", async () => {
    const h = harness();
    h.health.record(GMX, false, new Error("Connection timed out"));
    h.advance(10 * MINUTE);
    h.health.record(GMX, true);
    await h.health.maybeRun();
    expect(h.sent).toHaveLength(0);
    expect(h.incidents.size).toBe(0);

    h.health.record(GMX, false, new Error("Connection timed out"));
    h.advance(19 * MINUTE);
    h.health.record(GMX, false, new Error("Connection timed out"));
    await h.health.maybeRun();
    expect(h.sent).toHaveLength(0);
    h.advance(2 * MINUTE);
    await h.health.maybeRun();
    await h.health.maybeRun();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toBe("gmx geht seit 21 min nicht. bis es wieder geht, seh ich dort keine neuen mails.");
    expect(h.sent[0]?.text).not.toMatch(/[–—]/);
    expect(h.incidents.get("integration:gmx")?.detail["notified"]).toBe(true);
    expect(audits).toContainEqual({ event: "integration_health", detail: expect.objectContaining({ integration: "gmx", healthy: false, kind: "unreachable" }) });

    h.health.record(GMX, true);
    await h.health.maybeRun();
    expect(h.sent[1]?.text).toBe("gmx geht wieder.");
    expect(h.incidents.size).toBe(0);
    await h.health.maybeRun();
    expect(h.sent).toHaveLength(2);
  });

  it("says when the login is rejected and names no numbers from the error", () => {
    expect(failureKind("Login to mailbox gmx failed: AUTHENTICATIONFAILED")).toBe("auth");
    expect(failureKind("Gmail (gmail): Google hands out no token: invalid_grant")).toBe("auth");
    expect(failureKind("getaddrinfo ENOTFOUND imap.gmx.net")).toBe("unreachable");
    expect(describeDown(GMX, 25, "AUTHENTICATIONFAILED")).toBe(
      "gmx lässt mich seit 25 min nicht rein, das passwort wird abgelehnt. bis du's neu verbindest, seh ich dort keine neuen mails.",
    );
    expect(describeDown(mailSubject({ id: "google" }), 25, "invalid_grant")).toContain("gmail lässt mich seit 25 min nicht rein, die freigabe wird abgelehnt.");
    expect(reconnectCommand(GMX, "AUTHENTICATIONFAILED")).toBe("pnpm integration connect gmx");
    expect(reconnectCommand(GMX, "getaddrinfo ENOTFOUND imap.gmx.net")).toBeNull();
  });

  it("sends the reconnect command as its own bubble, only when it is the login (addendum D23 of 2026-10-10)", async () => {
    const h = harness();
    h.health.record(GMX, false, new Error("AUTHENTICATIONFAILED Invalid credentials"));
    h.advance(25 * MINUTE);
    await h.health.maybeRun();
    expect(h.sent.map((entry) => entry.text)).toEqual([
      "gmx lässt mich seit 25 min nicht rein, das passwort wird abgelehnt. bis du's neu verbindest, seh ich dort keine neuen mails.",
      "pnpm integration connect gmx",
    ]);
    expect(h.sent[1]?.verbatim).toBe(true);
    expect(h.sent[0]?.verbatim).toBe(false);

    const down = harness();
    down.health.record(GMX, false, new Error("Connection timed out"));
    down.advance(25 * MINUTE);
    await down.health.maybeRun();
    expect(down.sent).toHaveLength(1);
  });

  it("does not report at night but at 8 o'clock if it still fails then; if it recovers before, it stays silent", async () => {
    const h = harness();
    h.setNow(new Date("2026-10-05T21:00:00Z")); // 23:00 Berlin
    h.health.record(GMX, false, new Error("down"));
    h.advance(60 * MINUTE);
    await h.health.maybeRun();
    expect(h.sent).toHaveLength(0);
    expect(h.incidents.has("integration:gmx")).toBe(true);
    h.setNow(new Date("2026-10-06T06:01:00Z")); // 08:01 Berlin
    await h.health.maybeRun();
    expect(h.sent).toHaveLength(1);

    const quiet = harness();
    quiet.setNow(new Date("2026-10-05T21:00:00Z"));
    quiet.health.record(GMX, false, new Error("down"));
    quiet.advance(60 * MINUTE);
    await quiet.health.maybeRun();
    quiet.health.record(GMX, true);
    await quiet.health.maybeRun();
    expect(quiet.sent).toHaveLength(0);
    expect(quiet.incidents.size).toBe(0);
  });

  it("does not report again after a restart, and closes an old incident on the first success", async () => {
    const first = harness();
    first.health.record(GMX, false, new Error("down"));
    first.advance(25 * MINUTE);
    await first.health.maybeRun();
    expect(first.sent).toHaveLength(1);

    // New process, same database.
    const second = harness();
    for (const [key, value] of first.incidents) second.incidents.set(key, value);
    second.health.record(GMX, false, new Error("down"));
    second.advance(25 * MINUTE);
    await second.health.maybeRun();
    expect(second.sent).toHaveLength(0);
    second.health.record(GMX, true);
    await second.health.maybeRun();
    expect(second.sent.map((entry) => entry.text)).toEqual(["gmx geht wieder."]);
  });

  it("does not count a disconnect by Alex as an outage", async () => {
    const h = harness();
    h.health.record(GMX, false, Object.assign(new Error("The mailbox gmx is disconnected."), { disconnected: true }));
    h.advance(30 * MINUTE);
    await h.health.maybeRun();
    expect(h.sent).toHaveLength(0);
    expect(h.incidents.size).toBe(0);
  });

  it("keeps trying when the report did not go out, and stays silent under the kill switch", async () => {
    const h = harness({ sendFails: true });
    h.health.record(GMX, false, new Error("down"));
    h.advance(25 * MINUTE);
    await h.health.maybeRun();
    expect(h.incidents.get("integration:gmx")?.detail["notified"]).toBeUndefined();

    const p = harness();
    p.setPaused(true);
    p.health.record(GMX, false, new Error("down"));
    p.advance(25 * MINUTE);
    await p.health.maybeRun();
    expect(p.sent).toHaveLength(0);
    expect(p.incidents.size).toBe(0);
  });

  it("gets every fetch from the mail trigger, without blaming the mailbox for a database error", async () => {
    const box = fakeMailAccount("gmx", "alex@gmx.example");
    const seen: boolean[] = [];
    let state = { ...EMPTY_TRIGGER_STATE };
    let now = NOON;
    let cursorFails = false;
    const trigger = new MailTrigger({
      accounts: [box.account],
      items: { known: async () => [], insert: async () => true, pending: async () => [], markNotified: async () => undefined },
      state: { load: async () => state, save: async (next) => void (state = next) },
      cursor: {
        load: async () => {
          if (cursorFails) throw new Error("db weg");
          return null;
        },
        save: async () => undefined,
      },
      judge: { ask: async () => { throw new Error("not needed"); } },
      digest: async () => ({ summary: "", what: null, when: null, due: null }),
      paused: async () => false,
      inProbation: async () => false,
      fire: () => undefined,
      health: (_account, ok) => void seen.push(ok),
      now: () => now,
    });
    await trigger.maybeRun();
    box.fail(new Error("Connection timed out"));
    now = new Date(now.getTime() + 2 * MINUTE);
    await trigger.maybeRun();
    cursorFails = true;
    now = new Date(now.getTime() + 2 * MINUTE);
    await trigger.maybeRun();
    expect(seen).toEqual([true, false]);
  });

  it("wraps the calendar in bookkeeping that only counts list", async () => {
    const outcomes: boolean[] = [];
    let fail = false;
    const calendar = {
      label: "Alex's iCloud calendar",
      invites: false,
      deleteUndo: "",
      list: async () => {
        if (fail) throw new Error("iCloud calendar is not reachable right now.");
        return { entries: [], truncated: false };
      },
    } as unknown as Calendar;
    const watched = monitoredCalendar(calendar, (ok) => void outcomes.push(ok));
    expect(watched.label).toBe("Alex's iCloud calendar");
    await watched.list({ from: "", to: "", limit: 1 });
    fail = true;
    await expect(watched.list({ from: "", to: "", limit: 1 })).rejects.toThrow(/not reachable/);
    expect(outcomes).toEqual([true, false]);
  });
});

describe("warning before an approval expires (D51)", () => {
  const bank = (expiresAt: Date | null): ExpiringConnector => ({ id: "bank", name: "Bank", expiresAt });

  it("warns seven days ahead exactly once per expiry, and again after renewing", async () => {
    const connectors = [bank(new Date(NOON.getTime() + 8 * DAY))];
    const h = harness({ connectors });
    await h.health.maybeRun();
    expect(h.sent).toHaveLength(0);
    h.advance(DAY + 2 * 60 * MINUTE);
    await h.health.maybeRun();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toBe("die freigabe für bank läuft di. 13.10. aus. erneuern dauert eine minute: serain.example.com, unter verbindungen.");
    h.advance(2 * 60 * MINUTE);
    await h.health.maybeRun();
    expect(h.sent).toHaveLength(1);

    connectors[0] = bank(new Date(NOON.getTime() + 180 * DAY));
    h.advance(172 * DAY);
    await h.health.maybeRun();
    expect(h.sent).toHaveLength(2);
  });

  it("does not say it at night and ignores connections without expiry", async () => {
    const h = harness({ connectors: [bank(new Date(NOON.getTime() + 3 * DAY)), { id: "coros", name: "COROS", expiresAt: null }] });
    h.setNow(new Date("2026-10-05T22:00:00Z"));
    await h.health.maybeRun();
    expect(h.sent).toHaveLength(0);
    h.setNow(new Date("2026-10-06T07:00:00Z"));
    await h.health.maybeRun();
    expect(h.sent.map((entry) => entry.context["connector"])).toEqual(["bank"]);
  });

  it("calls an already expired approval that", async () => {
    const h = harness({ connectors: [bank(new Date(NOON.getTime() - DAY))] });
    await h.health.maybeRun();
    expect(h.sent[0]?.text).toBe("die freigabe für bank ist abgelaufen. neu verbinden dauert eine minute: serain.example.com, unter verbindungen.");
  });

  it("names the approval the way Alex calls it when the catalog says so", async () => {
    const h = harness({ connectors: [{ ...bank(new Date(NOON.getTime() + 3 * DAY)), grantName: "bank" as const }] });
    await h.health.maybeRun();
    expect(h.sent[0]?.text).toBe("die bankfreigabe läuft do. 08.10. aus. erneuern dauert eine minute: serain.example.com, unter verbindungen.");
  });

  it("names no address without SERAIN_WEB_ORIGIN, only the tab", () => {
    const soon = { ...bank(new Date(NOON.getTime() + 3 * DAY)), grantName: "bank" as const };
    expect(describeExpiry(soon, NOON, null)).toBe("die bankfreigabe läuft do. 08.10. aus. erneuern dauert eine minute: im webinterface unter verbindungen.");
    expect(describeExpiry(bank(new Date(NOON.getTime() - DAY)), NOON, null)).toBe(
      "die freigabe für bank ist abgelaufen. neu verbinden dauert eine minute: im webinterface unter verbindungen.",
    );
    expect(describeExpiry(soon, NOON, "https://Serain.Example.COM")).toContain("serain.example.com, unter verbindungen.");
  });
});

describe("disruptions in the <context> (audit 2026-10-05)", () => {
  it("names a login only after five minutes without success, in English, and never the other side's error text", () => {
    const h = harness();
    h.health.record(GMX, false, new Error("AUTHENTICATIONFAILED Invalid credentials (Failure) user=alex"));
    expect(h.health.failing()).toEqual([]);
    h.advance(6 * MINUTE);
    const [line] = h.health.failing();
    expect(line).toBe("gmx hasn't let me in for 6 min, the password is rejected. until you reconnect it, i won't see new mails there.");
    h.health.record(GMX, true);
    expect(h.health.failing()).toEqual([]);
  });
});

describe("health texts in other languages", () => {
  it("speaks English when asked, with the month as a word", () => {
    const soon = { id: "bank", name: "Bank", grantName: "bank" as const, expiresAt: new Date(NOON.getTime() + 3 * DAY) };
    expect(describeExpiry(soon, NOON, null, "en")).toBe("the bank approval expires on Thu, Oct 8. renewing takes a minute: in the web interface under connections.");
    expect(describeDown(GMX, 25, "AUTHENTICATIONFAILED", "en")).toBe(
      "gmx hasn't let me in for 25 min, the password is rejected. until you reconnect it, i won't see new mails there.",
    );
    expect(describeDown(mailSubject({ id: "serain", serains: true }), 25, "ETIMEDOUT", "en")).toBe(
      "my mailbox hasn't worked for 25 min. until it works again, i won't see new mails there.",
    );
  });

  it("renders a translated language and keeps the provider name verbatim", () => {
    installTranslations("tr", {
      [healthText.downMail.en]: "{name} {minutes} dakikadır çalışmıyor. düzelene kadar orada yeni postaları göremem.",
      [healthText.up.en]: "{name} yeniden çalışıyor.",
    });
    expect(describeDown(GMX, 25, "ETIMEDOUT", "tr")).toBe("gmx 25 dakikadır çalışmıyor. düzelene kadar orada yeni postaları göremem.");
    // A line without translation stays English.
    expect(describeDown(GMX, 25, "AUTHENTICATIONFAILED", "tr")).toContain("hasn't let me in for 25 min");
  });
});
