import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeApprovalStore } from "./approvals-store.fake.js";
import { FakeScheduleStore } from "./schedule-store.fake.js";

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
vi.mock("../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown>) => void audits.push({ event, detail }),
}));

const { ApprovalService, reissueHead, expiredText } = await import("../src/security/approvals.js");
const { encodeGrant } = await import("../src/agent/tools/grants.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState, defineTool } = await import("../src/agent/tools/types.js");
const { calendarTools } = await import("../src/agent/tools/calendar.js");
const { MAIL_TRIGGER_TOOLS } = await import("../src/mail/trigger.js");
const { APPROVAL_TTL_MS, CALENDAR_OFFER_TTL_MS, MAIL_TURN_LIMITS, MAX_PENDING_APPROVALS } = await import("../src/config/limits.js");
type Calendar = import("../src/calendar/types.js").Calendar;
type EntryDraft = import("../src/calendar/types.js").EntryDraft;

/**
 * Expired preview (addendum D8 of 2026-10-10, decision 9): a 👍
 * or "yes" on it reissues the same preview with the same stored
 * arguments. It only runs after a new 👍, never directly;
 * once per preview, never money, never after the kill switch, never when the action
 * has become pointless, and never with a standing approval.
 */

const NOW = new Date("2026-10-12T08:00:00Z");

let mails: Array<{ to: string; body: string }> = [];
const sendMail = defineTool({
  name: "send_mail",
  description: "Sends a mail.",
  level: "irreversible",
  schema: { to: z.string(), body: z.string() },
  confirm: {
    preview: (args) => `Mail an ${args.to}: ${args.body}`,
    undo: () => "gibt es nicht, raus ist raus",
    grantKey: (args) => ({ kind: "mail_to", to: args.to }),
  },
  async run(args) {
    mails.push(args);
    return { ok: true, text: "out" };
  },
});

let booked = 0;
const bookTable = defineTool({
  name: "book_table",
  description: "Reserves a table.",
  level: "write_reversible",
  schema: { fee: z.number() },
  consequence: (args) => (args.fee > 0 ? "money" : "write_reversible"),
  confirm: { preview: (args) => `Tisch, Storno ${args.fee} €`, undo: () => "Storno kostet" },
  async run() {
    booked += 1;
    return { ok: true, text: "reserved" };
  },
});

function rig() {
  const clock = { now: NOW };
  const store = new FakeApprovalStore();
  const previews: Array<{ text: string; taint: readonly string[] }> = [];
  const created: EntryDraft[] = [];
  const calendar: Calendar = {
    label: "Alex's iCloud calendar",
    invites: false,
    deleteUndo: "aus dem Papierkorb",
    list: async () => ({ entries: [], truncated: false }),
    get: async () => null,
    create: async (draft) => {
      created.push(draft);
      return { id: "neu", title: draft.title ?? "", start: "", end: "", allDay: false, location: "", guests: [], status: "confirmed", organizerSelf: true, declined: false };
    },
    update: async () => {
      throw new Error("not needed");
    },
    remove: async () => undefined,
  };
  // The registry is created after the service, as in the runtime: hence a function.
  let registry!: InstanceType<typeof ToolRegistry>;
  const taintOf = new Map<string, string[]>();
  const service = new ApprovalService({
    store,
    now: () => clock.now,
    async sendPreview(text, taint) {
      previews.push({ text, taint });
      const id = `preview-${previews.length}`;
      taintOf.set(id, [...taint]);
      return { externalId: id, messageId: `db-${id}` };
    },
    definition: (tool) => registry.definition(tool),
    previewTaint: async (id) => taintOf.get(id) ?? ["preview of unknown origin"],
  });
  registry = new ToolRegistry(service)
    .registerAll([sendMail, bookTable])
    .registerAll(calendarTools(calendar, undefined, () => clock.now, { reminders: new FakeScheduleStore() }));
  const owner = () => new TurnState({ origin: "owner_message", triggerExternalId: "m", triggerMessageId: "db-m", reactableIds: ["m"] });
  const mailTurn = () =>
    new TurnState({ origin: "untrusted", triggerExternalId: "", triggerMessageId: "", reactableIds: [], toolNames: MAIL_TRIGGER_TOOLS, limits: MAIL_TURN_LIMITS, taintSources: ["Alex's inbox"] });
  const thumbsUp = (previewExternalId: string) => service.decide({ previewExternalId, decision: "approve", via: "tapback", decisionMessageId: null });
  const later = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
  return { clock, store, previews, created, service, registry, owner, mailTurn, thumbsUp, later };
}

const MAIL = { to: "anna@example.com", body: "Komme 10 min später." };
const TRAIN = { title: "Zug nach Berlin", start: "2026-10-16 07:12", end: "2026-10-16 11:20", location: "Frankfurt (Main) Hbf", kind: "train" };

beforeEach(() => {
  audits.length = 0;
  mails = [];
  booked = 0;
});

describe("👍 on an expired preview (decision 9)", () => {
  it("reissues the same preview and runs nothing", async () => {
    const r = rig();
    await r.registry.execute("send_mail", MAIL, r.owner());
    r.later(APPROVAL_TTL_MS + 1);
    const outcome = await r.thumbsUp("preview-1");
    expect(outcome.kind).toBe("reissued");
    if (outcome.kind !== "reissued") return;
    expect(mails).toEqual([]);
    // The same preview, without „ja immer“: when reissued there is only the single approval.
    expect(r.previews[1]!.text).toBe(
      `${reissueHead()}\n\nMail an anna@example.com: Komme 10 min später.\ngibt es nicht, raus ist raus`,
    );
    // New row, new ID, new deadline, same arguments; the old one stays expired.
    expect(outcome.approval).toMatchObject({
      tool: "send_mail",
      args: MAIL,
      status: "pending",
      previewExternalId: "preview-2",
      grantKey: "",
      reissuedFrom: outcome.from.id,
      expiresAt: new Date(r.clock.now.getTime() + APPROVAL_TTL_MS).toISOString(),
    });
    expect(outcome.approval.id).not.toBe(outcome.from.id);
    expect(r.store.rows.find((row) => row.id === outcome.from.id)?.status).toBe("expired");
    expect(audits.find((entry) => entry.event === "approval_reissued")?.detail).toMatchObject({ approval_id: outcome.approval.id, reissued_from: outcome.from.id, tool: "send_mail" });
  });

  it("runs only after a new 👍, with exactly the stored arguments", async () => {
    const r = rig();
    await r.registry.execute("send_mail", MAIL, r.owner());
    r.later(APPROVAL_TTL_MS + 1);
    await r.thumbsUp("preview-1");
    const outcome = await r.thumbsUp("preview-2");
    expect(outcome.kind).toBe("approved");
    if (outcome.kind !== "approved") return;
    await r.service.complete(outcome.approval, await r.registry.executeApproved(outcome.approval, r.owner()));
    expect(mails).toEqual([MAIL]);
  });

  it("reissues each expired preview only once, and a reissued one never again", async () => {
    const r = rig();
    await r.registry.execute("send_mail", MAIL, r.owner());
    r.later(APPROVAL_TTL_MS + 1);
    expect((await r.thumbsUp("preview-1")).kind).toBe("reissued");
    // A second 👍 or „ja“ on the old one: silent, no third preview.
    expect((await r.service.decide({ previewExternalId: "preview-1", decision: "approve", via: "thread_reply", decisionMessageId: "db-ja" })).kind).toBe("none");
    r.later(APPROVAL_TTL_MS + 1);
    expect(await r.thumbsUp("preview-2")).toMatchObject({ kind: "expired", text: expiredText() });
    expect(await r.thumbsUp("preview-2")).toEqual({ kind: "none" });
    expect(r.previews).toHaveLength(2);
    expect(audits.filter((entry) => entry.event === "approval_reissue_refused").map((entry) => entry.detail["reason"])).toEqual(["already_reissued"]);
    expect(mails).toEqual([]);
  });

  it("never grants a standing approval, not even on „ja immer“", async () => {
    const r = rig();
    await r.registry.execute("send_mail", MAIL, r.owner());
    r.later(APPROVAL_TTL_MS + 1);
    const reissued = await r.service.decide({ previewExternalId: "preview-1", decision: "approve_standing", via: "thread_reply", decisionMessageId: "db-immer" });
    expect(reissued.kind).toBe("reissued");
    expect(r.previews[1]!.text).not.toContain("ja immer");
    const approved = await r.service.decide({ previewExternalId: "preview-2", decision: "approve_standing", via: "thread_reply", decisionMessageId: "db-immer-2" });
    expect(approved).toMatchObject({ kind: "approved", approval: { scope: "once" } });
    expect(await r.store.hasGrant("send_mail", encodeGrant({ kind: "mail_to", to: "anna@example.com" }))).toBe(false);
    expect(audits.some((entry) => entry.event === "approval_grant")).toBe(false);
  });

  it("never reissues money, only says that it has expired", async () => {
    const r = rig();
    await r.registry.execute("book_table", { fee: 30 }, r.owner());
    expect(r.store.rows[0]?.level).toBe("money");
    r.later(APPROVAL_TTL_MS + 1);
    expect(await r.thumbsUp("preview-1")).toMatchObject({ kind: "expired", text: expiredText() });
    expect(r.previews).toHaveLength(1);
    expect(booked).toBe(0);
    expect(audits.find((entry) => entry.event === "approval_reissue_refused")?.detail).toMatchObject({ reason: "money", tool: "book_table" });
  });

  it("reissues nothing after the kill switch and stays silent", async () => {
    const r = rig();
    await r.registry.execute("send_mail", MAIL, r.owner());
    await r.service.cancelAll("kill_switch");
    expect(await r.thumbsUp("preview-1")).toEqual({ kind: "none" });
    r.later(APPROVAL_TTL_MS + 1);
    expect(await r.thumbsUp("preview-1")).toEqual({ kind: "none" });
    expect(r.previews).toHaveLength(1);
  });

  it("leaves a 👎 on an expired preview without consequence, as before", async () => {
    const r = rig();
    await r.registry.execute("send_mail", MAIL, r.owner());
    r.later(APPROVAL_TTL_MS + 1);
    expect(await r.service.decide({ previewExternalId: "preview-1", decision: "deny", via: "tapback", decisionMessageId: null })).toEqual({ kind: "none" });
    expect(r.previews).toHaveLength(1);
  });

  it("reissues an offer from the mail, with the same provenance and a new 24 h deadline", async () => {
    const r = rig();
    await r.registry.execute("calendar_offer", TRAIN, r.mailTurn());
    r.later(CALENDAR_OFFER_TTL_MS + 1);
    const outcome = await r.thumbsUp("preview-1");
    expect(outcome.kind).toBe("reissued");
    // Tuesday 10:00 now: the preview is freshly computed, Friday is still „freitag“.
    expect(r.previews[1]!.text).toContain(`${reissueHead()}\n\ndeine bahnbuchung für freitag steht noch nicht im kalender, rein damit? 👍`);
    // The new deadline is in the row, no longer in the text (Alex knows it).
    if (outcome.kind !== "reissued") return;
    expect(outcome.approval.expiresAt).toBe(new Date(r.clock.now.getTime() + CALENDAR_OFFER_TTL_MS).toISOString());
    expect(r.previews[1]!.text).not.toMatch(/verfällt/i);
    expect(r.previews[1]!.taint).toEqual(["Alex's inbox"]);
    expect(r.created).toEqual([]);
  });

  it("reissues nothing that has become pointless, only says that it has expired", async () => {
    const r = rig();
    await r.registry.execute("calendar_offer", TRAIN, r.mailTurn());
    // Saturday: the train has left.
    r.clock.now = new Date("2026-10-17T08:00:00Z");
    expect(await r.thumbsUp("preview-1")).toMatchObject({ kind: "expired", text: expiredText() });
    expect(r.previews).toHaveLength(1);
    expect(r.created).toEqual([]);
    expect(audits.find((entry) => entry.event === "approval_reissue_refused")?.detail).toMatchObject({ reason: "stale" });
  });

  it("respects the cap on open previews", async () => {
    const r = rig();
    await r.registry.execute("send_mail", MAIL, r.owner());
    r.later(APPROVAL_TTL_MS + 1);
    for (let i = 0; i < MAX_PENDING_APPROVALS; i++) await r.registry.execute("send_mail", { ...MAIL, body: `Nr. ${i}` }, r.owner());
    expect(await r.thumbsUp("preview-1")).toMatchObject({ kind: "expired", text: expiredText() });
    expect(audits.find((entry) => entry.event === "approval_reissue_refused")?.detail).toMatchObject({ reason: "too_many_pending" });
  });

  it("counts as untrusted if the provenance of the old preview is unreadable", async () => {
    const r = rig();
    await r.registry.execute("send_mail", MAIL, r.owner());
    r.later(APPROVAL_TTL_MS + 1);
    // The preview is a different one from the one whose provenance the rig knows.
    r.store.rows[0]!.previewExternalId = "unbekannt";
    expect((await r.thumbsUp("unbekannt")).kind).toBe("reissued");
    expect(r.previews[1]!.taint).toEqual(["preview of unknown origin"]);
  });
});
