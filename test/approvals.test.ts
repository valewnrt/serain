import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeApprovalStore } from "./approvals-store.fake.js";

const auditMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...args) }));

const { ApprovalService, parseDecision, decisionFromReaction, isRevokeCommand, renderPreview } =
  await import("../src/security/approvals.js");
const { encodeGrant } = await import("../src/agent/tools/grants.js");
const { ToolRegistry, ToolBlockedError } = await import("../src/agent/tools/registry.js");
const { defineTool, TurnState } = await import("../src/agent/tools/types.js");
const { APPROVAL_TTL_MS, MAX_PENDING_APPROVALS } = await import("../src/config/limits.js");

/**
 * The confirmation protocol (D8.3, D14). Tested above all is what must NOT
 * happen: a level 3 tool never runs from the model turn, never after
 * expiry, never twice and never with arguments other than in the preview.
 */

type Origin = "owner_message" | "schedule" | "heartbeat" | "untrusted";

function turn(origin: Origin = "owner_message", taintSources: string[] = []) {
  return new TurnState({
    origin,
    triggerExternalId: "m-1",
    triggerMessageId: "db-1",
    reactableIds: ["m-1"],
    taintSources,
  });
}

let sentMails: Array<{ to: string; body: string }> = [];
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
    sentMails.push(args);
    return { ok: true, text: "Mail is out." };
  },
});

let booked: Array<{ fee: number }> = [];
const bookTable = defineTool({
  name: "book_table",
  description: "Reserves a table.",
  level: "write_reversible",
  schema: { cancellation_fee_eur: z.number() },
  // W1: the level depends on the cost consequence, not on the action type.
  consequence: (args) => (args.cancellation_fee_eur > 0 ? "money" : "write_reversible"),
  confirm: {
    preview: (args) => `Tisch reservieren, Stornogebühr ${args.cancellation_fee_eur} €`,
    undo: (args) => `Storno kostet ${args.cancellation_fee_eur} €`,
    // Any existing kind: money never gets a standing approval.
    grantKey: () => ({ kind: "confirm_selftest" }),
  },
  async run(args) {
    booked.push({ fee: args.cancellation_fee_eur });
    return { ok: true, text: "Reserved." };
  },
});

interface Rig {
  store: FakeApprovalStore;
  service: InstanceType<typeof ApprovalService>;
  registry: InstanceType<typeof ToolRegistry>;
  previews: string[];
  /** Provenance each preview would be stored with (D8.4). */
  previewTaint: Array<readonly string[]>;
  clock: { now: Date };
}

function rig(opts: { previewFails?: boolean } = {}): Rig {
  const store = new FakeApprovalStore();
  const previews: string[] = [];
  const previewTaint: Array<readonly string[]> = [];
  const clock = { now: new Date("2026-09-19T10:00:00Z") };
  const service = new ApprovalService({
    store,
    now: () => clock.now,
    async sendPreview(text, taintSources) {
      if (opts.previewFails) return null;
      previews.push(text);
      previewTaint.push(taintSources);
      return { externalId: `preview-${previews.length}`, messageId: `db-preview-${previews.length}` };
    },
  });
  const registry = new ToolRegistry(service).registerAll([sendMail, bookTable]);
  return { store, service, registry, previews, previewTaint, clock };
}

const MAIL = { to: "anna@example.com", body: "Komme 10 min später." };

beforeEach(() => {
  auditMock.mockClear();
  sentMails = [];
  booked = [];
});

describe("registration", () => {
  it("still does not admit level 3 without the protocol", () => {
    expect(() => new ToolRegistry().register(sendMail)).toThrow(ToolBlockedError);
  });

  it("does not admit a tool with consequence without the protocol, even if its base level is harmless", () => {
    expect(() => new ToolRegistry().register(bookTable)).toThrow(ToolBlockedError);
  });

  it("requires a preview", () => {
    const blind = defineTool({
      name: "wire_money",
      description: "Transfers money.",
      level: "money",
      schema: {},
      async run() {
        return { ok: true, text: "gone" };
      },
    });
    expect(() => rig().registry.register(blind)).toThrow(/preview/);
  });
});

describe("request", () => {
  it("does not run the tool, sends the preview and fixes the arguments", async () => {
    const { registry, store, previews } = rig();
    const result = await registry.execute("send_mail", MAIL, turn());
    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toBe("Not done yet, the preview is with Alex.");
    expect(sentMails).toHaveLength(0);
    expect(previews[0]).toContain("Mail an anna@example.com: Komme 10 min später.");
    expect(previews[0]).toContain("\ngibt es nicht, raus ist raus");
    // No fixed header and no deadline anymore: the tool asks the question itself.
    expect(previews[0]).not.toMatch(/Soll ich\?|Verfällt|Rückweg:/);
    expect(store.rows[0]).toMatchObject({
      tool: "send_mail",
      level: "irreversible",
      args: MAIL,
      status: "pending",
      previewExternalId: "preview-1",
    });
  });

  it("passes the requesting turn's taint to the preview (D8.4)", async () => {
    const { registry, previewTaint } = rig();
    await registry.execute("send_mail", MAIL, turn());
    await registry.execute("send_mail", { ...MAIL, body: "Antwort auf die Mail" }, turn("untrusted", ["Alex's inbox"]));
    expect(previewTaint).toEqual([[], ["Alex's inbox"]]);
  });

  it("builds the preview from the arguments, not from the model's text", () => {
    expect(renderPreview("Mail an X", "keiner", null)).toBe("Mail an X\nkeiner");
    // A key from before the structured form is shown as stored.
    expect(renderPreview("Mail an X", "keiner", "Mails an X")).toBe("Mail an X\nkeiner\n„ja immer“ gilt ab dann für Mails an X.");
    // A structured key is put in words in the language of the line; the address stays verbatim.
    const key = encodeGrant({ kind: "mail_to", to: "x@example.com" });
    expect(renderPreview("Mail an X", "keiner", key)).toBe("Mail an X\nkeiner\n„ja immer“ gilt ab dann für Mails an x@example.com.");
    expect(renderPreview("Mail to X", "none", key, null, "en")).toBe('Mail to X\nnone\n"yes always" covers mails to x@example.com from then on.');
  });

  it("does nothing if the preview does not go out", async () => {
    const { registry, store } = rig({ previewFails: true });
    const result = await registry.execute("send_mail", MAIL, turn());
    expect(result.ok).toBe(false);
    expect(store.rows).toHaveLength(0);
  });

  it("caps the open previews", async () => {
    const { registry, previews } = rig();
    for (let i = 0; i < MAX_PENDING_APPROVALS; i += 1) {
      await registry.execute("send_mail", { ...MAIL, body: `Nr. ${i}` }, turn());
    }
    const result = await registry.execute("send_mail", { ...MAIL, body: "eine zu viel" }, turn());
    expect(result.ok).toBe(false);
    expect(previews).toHaveLength(MAX_PENDING_APPROVALS);
  });

  it("raises the level by cost consequence (W1)", async () => {
    const { registry, store } = rig();
    await registry.execute("book_table", { cancellation_fee_eur: 0 }, turn());
    expect(booked).toEqual([{ fee: 0 }]);
    await registry.execute("book_table", { cancellation_fee_eur: 200 }, turn());
    expect(booked).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ tool: "book_table", level: "money" });
  });
});

describe("decision", () => {
  async function requested() {
    const r = rig();
    await r.registry.execute("send_mail", MAIL, turn());
    return r;
  }

  it("runs exactly the stored arguments after 👍", async () => {
    const { service, registry, store } = await requested();
    const outcome = await service.decide({
      previewExternalId: "preview-1",
      decision: "approve",
      via: "tapback",
      decisionMessageId: null,
    });
    expect(outcome.kind).toBe("approved");
    if (outcome.kind !== "approved") return;
    const result = await registry.executeApproved(outcome.approval, turn());
    await service.complete(outcome.approval, result);
    expect(sentMails).toEqual([MAIL]);
    expect(store.rows[0]?.status).toBe("executed");
  });

  it("does not fire twice when 👍 and yes both arrive", async () => {
    const { service } = await requested();
    const signal = {
      previewExternalId: "preview-1",
      decision: "approve" as const,
      via: "tapback" as const,
      decisionMessageId: null,
    };
    const [first, second] = await Promise.all([service.decide(signal), service.decide(signal)]);
    expect([first.kind, second.kind].sort()).toEqual(["approved", "none"]);
  });

  it("expires after the time window", async () => {
    const { service, clock, store } = await requested();
    clock.now = new Date(clock.now.getTime() + APPROVAL_TTL_MS + 1);
    const outcome = await service.decide({
      previewExternalId: "preview-1",
      decision: "approve",
      via: "tapback",
      decisionMessageId: null,
    });
    // A 👍 after the deadline never runs anything (addendum D8 of 2026-10-10). Without a registry no fresh
    // preview comes, only the expired notice; reissuing is tested in test/approval-reissue.test.ts.
    expect(outcome).toMatchObject({ kind: "expired", text: "die ist abgelaufen." });
    expect(store.rows[0]?.status).toBe("expired");
    expect(await service.expireDue()).toBe(0);
    expect(sentMails).toHaveLength(0);
  });

  it("ignores a 👍 on a message that is not a preview", async () => {
    const { service } = await requested();
    const outcome = await service.decide({
      previewExternalId: "irgendeine-andere",
      decision: "approve",
      via: "tapback",
      decisionMessageId: null,
    });
    expect(outcome.kind).toBe("none");
  });

  it("declines with 👎 and runs nothing afterwards", async () => {
    const { service, registry } = await requested();
    const outcome = await service.decide({
      previewExternalId: "preview-1",
      decision: "deny",
      via: "tapback",
      decisionMessageId: null,
    });
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") return;
    const result = await registry.executeApproved(outcome.approval, turn());
    expect(result.ok).toBe(false);
    expect(sentMails).toHaveLength(0);
  });

  it("lets nothing open fire after the kill switch", async () => {
    const { service } = await requested();
    await service.cancelAll("kill_switch");
    const outcome = await service.decide({
      previewExternalId: "preview-1",
      decision: "approve",
      via: "tapback",
      decisionMessageId: null,
    });
    expect(outcome.kind).toBe("none");
  });
});

describe("files under the preview (addendum D34 of 2026-10-08)", () => {
  const attach = defineTool({
    name: "send_attachment",
    description: "Sends a mail with an attachment.",
    level: "irreversible",
    schema: { to: z.string() },
    confirm: {
      preview: (args) => `Mail an ${args.to}, Anhang: a.pdf`,
      undo: () => "gibt es nicht",
      files: () => [{ name: "a.pdf", mimeType: "application/pdf", body: Buffer.from("%PDF-1") }],
    },
    async run() {
      return { ok: true, text: "out" };
    },
  });

  function fileRig(fileFails = false) {
    const store = new FakeApprovalStore();
    const files: Array<{ name: string; replyTo: string; taint: readonly string[] }> = [];
    const service = new ApprovalService({
      store,
      sendPreview: async () => ({ externalId: "preview-1", messageId: "db-preview-1" }),
      sendPreviewFile: async (file, replyTo, taint) => {
        files.push({ name: file.name, replyTo, taint });
        return fileFails ? null : "file-1";
      },
    });
    return { store, service, files, registry: new ToolRegistry(service).registerAll([attach]) };
  }

  it("sends the file in the preview's thread, with its provenance, and remembers its ID", async () => {
    const { registry, store, files } = fileRig();
    await registry.execute("send_attachment", { to: "mama@example.org" }, turn("owner_message", ["Alex's inbox"]));
    expect(files).toEqual([{ name: "a.pdf", replyTo: "preview-1", taint: ["Alex's inbox"] }]);
    expect(store.rows[0]).toMatchObject({ previewExternalId: "preview-1", previewFileExternalIds: ["file-1"] });
  });

  it("takes a 👍 on the file as approval of the preview", async () => {
    const { registry, service } = fileRig();
    await registry.execute("send_attachment", { to: "mama@example.org" }, turn());
    const outcome = await service.decide({ previewExternalId: "file-1", decision: "approve", via: "tapback", decisionMessageId: null });
    expect(outcome.kind).toBe("approved");
  });

  it("keeps the preview valid if the file does not go out: it is named there", async () => {
    const { registry, store } = fileRig(true);
    const result = await registry.execute("send_attachment", { to: "mama@example.org" }, turn());
    expect(result.ok).toBe(true);
    expect(store.rows[0]).toMatchObject({ status: "pending", previewFileExternalIds: [] });
  });
});

describe("standing approval (W4)", () => {
  async function standing() {
    const r = rig();
    await r.registry.execute("send_mail", MAIL, turn());
    const outcome = await r.service.decide({
      previewExternalId: "preview-1",
      decision: "approve_standing",
      via: "thread_reply",
      decisionMessageId: "db-2",
    });
    if (outcome.kind === "approved") await r.registry.executeApproved(outcome.approval, turn());
    sentMails = [];
    return r;
  }

  it("applies to the same task type, without a new preview", async () => {
    const { registry, previews } = await standing();
    const result = await registry.execute("send_mail", { ...MAIL, body: "Bin da." }, turn());
    expect(result.ok).toBe(true);
    expect(sentMails).toHaveLength(1);
    expect(previews).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledWith(
      "approval_grant_used",
      expect.objectContaining({ tool: "send_mail", grant_key: encodeGrant({ kind: "mail_to", to: "anna@example.com" }) }),
      "db-1",
    );
  });

  it("does not apply to another recipient", async () => {
    const { registry } = await standing();
    await registry.execute("send_mail", { to: "fremd@example.com", body: "Hi" }, turn());
    expect(sentMails).toHaveLength(0);
  });

  it("does not apply in a turn Alex did not trigger, nor after untrusted content (D8.4)", async () => {
    const { registry } = await standing();
    await registry.execute("send_mail", MAIL, turn("schedule"));
    await registry.execute("send_mail", MAIL, turn("owner_message", ["https://evil.example"]));
    expect(sentMails).toHaveLength(0);
  });

  it("ends with the revocation", async () => {
    const { registry, service } = await standing();
    expect(await service.revokeGrants("codeword")).toBe(1);
    await registry.execute("send_mail", MAIL, turn());
    expect(sentMails).toHaveLength(0);
  });

  it("never exists for money, not even with „ja immer“", async () => {
    const { registry, service, store } = rig();
    await registry.execute("book_table", { cancellation_fee_eur: 200 }, turn());
    const outcome = await service.decide({
      previewExternalId: "preview-1",
      decision: "approve_standing",
      via: "thread_reply",
      decisionMessageId: "db-2",
    });
    expect(outcome.kind).toBe("approved");
    expect(store.rows[0]?.scope).toBe("once");
    expect(store.grants).toHaveLength(0);
  });
});

describe("reading decisions", () => {
  it("takes only the whole message", () => {
    expect(parseDecision("ja")).toBe("approve");
    expect(parseDecision(" Ja! ")).toBe("approve");
    expect(parseDecision("ja immer")).toBe("approve_standing");
    expect(parseDecision("nö")).toBe("deny");
    expect(parseDecision("ja aber änder noch den betreff")).toBeNull();
    expect(parseDecision("jaja")).toBeNull();
    expect(parseDecision("")).toBeNull();
  });

  it("knows exactly two tapbacks", () => {
    expect(decisionFromReaction("👍")).toBe("approve");
    expect(decisionFromReaction("👎")).toBe("deny");
    expect(decisionFromReaction("❤️")).toBeNull();
  });

  it("detects the revocation like the kill switch by regex", () => {
    expect(isRevokeCommand("serain widerruf")).toBe(true);
    expect(isRevokeCommand("Serain, Widerruf bitte")).toBe(true);
    expect(isRevokeCommand("kannst du das widerrufen")).toBe(false);
  });
});
