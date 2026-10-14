import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));

const { describeBatch, describeDifference, lineDiff } = await import("../src/mail/batch.js");
const { mailTools } = await import("../src/agent/tools/mail.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { MailError } = await import("../src/mail/types.js");
const { fakeMailAccount, memoryKeep } = await import("./mail-account.fake.js");
type ToolDefinition = import("../src/agent/tools/types.js").ToolDefinition;
type MailAccount = import("../src/mail/types.js").MailAccount;

const turn = (origin: "owner_message" | "approval" = "owner_message") =>
  new TurnState({ origin, triggerExternalId: "x1", triggerMessageId: "m1", reactableIds: [] });

function gate() {
  const requests: Array<{ tool: string; level: string; preview: string }> = [];
  return {
    requests,
    gate: {
      covered: async () => false,
      request: async (def: ToolDefinition, level: string, args: Record<string, unknown>) => {
        requests.push({ tool: def.name, level, preview: await def.confirm!.preview(args) });
        return { ok: true, text: "wartet auf Alex" };
      },
    },
  };
}

const letter = (company: string) =>
  [`Sehr geehrte Damen und Herren der ${company},`, "", "ich bitte um Auskunft nach Art. 15 DSGVO.", "", "Mit freundlichen Grüßen", "Alex Beispiel"].join("\n");

/** Reads a mail back from the first one and the difference, the way Alex has to in the preview. */
function reconstruct(first: string, difference: string): string {
  const lines = first.split("\n");
  const blocks = difference.split("\n").slice(1);
  const out: string[] = [];
  let at = 0;
  let index = 0;
  while (index < blocks.length) {
    const start = Number(/Zeile (\d+):/.exec(blocks[index]!)![1]) - 1;
    out.push(...lines.slice(at, start));
    at = start;
    index += 1;
    while (index < blocks.length && !/^ {2}Zeile/.test(blocks[index]!)) {
      const [, sign, rest] = /^ {2}([−+]) (.*)$/.exec(blocks[index]!)!;
      const line = rest === "(Leerzeile)" ? "" : rest!;
      if (sign === "−") at += 1;
      else out.push(line);
      index += 1;
    }
  }
  out.push(...lines.slice(at));
  return out.join("\n");
}

describe("series mail in English", () => {
  it("renders the frame in English and keeps the mails verbatim", async () => {
    const { t } = await import("../src/i18n/catalog.js");
    const { mail } = await import("../src/i18n/messages/mail.js");
    expect(t(mail.batchTextExcept, undefined, "en")).toBe("Text same as mail 1, except:");
    expect(t(mail.batchMail, { number: 2, to: "b@y.example" }, "en")).toBe("Mail 2 to b@y.example");
  });
});

describe("series mail: preview with differences (D63, building block E)", () => {
  it("shows the first in full and a changed greeting as a line with its number", () => {
    expect(describeDifference(letter("A GmbH"), letter("B AG"))).toBe(
      "Text wie Mail 1, außer:\n  Zeile 1:\n  − Sehr geehrte Damen und Herren der A GmbH,\n  + Sehr geehrte Damen und Herren der B AG,",
    );
    expect(describeDifference(letter("A GmbH"), letter("A GmbH"))).toBe("Text wie Mail 1.");
  });

  it("every mail can be read back exactly from mail 1 and the difference, even with duplicate lines", () => {
    const first = ["Hallo,", "", "eins", "", "zwei", "", "Gruß"].join("\n");
    const others = [
      ["Hallo,", "", "eins", "", "drei", "", "Gruß"].join("\n"),
      ["Hallo,", "", "", "eins", "", "zwei", "", "Gruß", "PS"].join("\n"),
      ["Hi,", "eins", "", "zwei", ""].join("\n"),
    ];
    for (const other of others) {
      const difference = describeDifference(first, other);
      expect(difference).not.toBeNull();
      expect(reconstruct(first, difference!)).toBe(other);
    }
  });

  it("shows a mail in full when it differs too much", () => {
    const other = Array.from({ length: 12 }, (_, n) => `ganz anders ${n}`).join("\n");
    expect(describeDifference(letter("A GmbH"), other)).toBeNull();
    expect(describeBatch([{ to: "a@x.example", subject: "S", text: letter("A GmbH") }, { to: "b@y.example", subject: "S", text: other }])).toContain(`\n\n${other}`);
  });

  it("the diff is minimal: equal lines stay equal", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c"]).map((op) => op.kind)).toEqual(["same", "removed", "added", "same"]);
  });
});

describe("mail_send_each is level 3 (D63, building block E)", () => {
  const mails = [
    { to: "privacy@a.example", subject: "Auskunft nach Art. 15 DSGVO", text: letter("A GmbH") },
    { to: "datenschutz@b.example", subject: "Auskunft nach Art. 15 DSGVO", text: letter("B AG") },
  ];

  it("never runs from the turn; the preview names every recipient and every difference and asks at the end", async () => {
    const box = fakeMailAccount("gmx", "alex@example.org");
    const approvals = gate();
    const registry = new ToolRegistry(approvals.gate).registerAll(mailTools({ accounts: [box.account], keep: memoryKeep() }));
    await registry.execute("mail_send_each", { mails }, turn());
    expect(box.sent).toEqual([]);
    const [request] = approvals.requests;
    expect(request?.level).toBe("irreversible");
    // From Alex's main mailbox no sender is shown: that is the default.
    expect(request?.preview).toContain("2 Mails, jede einzeln:\n\nMail 1 an privacy@a.example");
    expect(request?.preview).not.toContain("alex@example.org");
    expect(request?.preview.endsWith("\n\nSollen die so raus?")).toBe(true);
    expect(request?.preview).toContain(`Mail 1 an privacy@a.example\nBetreff: Auskunft nach Art. 15 DSGVO\n\n${letter("A GmbH")}`);
    expect(request?.preview).toContain("Mail 2 an datenschutz@b.example\nBetreff: Auskunft nach Art. 15 DSGVO\nText wie Mail 1, außer:");
    expect(request?.preview).toContain("+ Sehr geehrte Damen und Herren der B AG,");
  });

  it("rejects two mails to the same address instead of sending them twice", async () => {
    const box = fakeMailAccount("gmx", "alex@example.org");
    const registry = new ToolRegistry(gate().gate).registerAll(mailTools({ accounts: [box.account], keep: memoryKeep() }));
    const result = await registry.execute("mail_send_each", { mails: [mails[0], { ...mails[1], to: "privacy@a.example" }] }, turn());
    expect(result.ok).toBe(false);
    expect(box.sent).toEqual([]);
  });

  it("sends every mail separately after approval and records every id", async () => {
    const box = fakeMailAccount("gmx", "alex@example.org");
    const recorded: string[] = [];
    const sent = { record: async (_account: string, id: string) => void recorded.push(id), ours: async () => false };
    const registry = new ToolRegistry(gate().gate).registerAll(mailTools({ accounts: [box.account], keep: memoryKeep(), sent }));
    const result = await registry.executeApproved({ id: "a1", tool: "mail_send_each", status: "approved", args: { mails } }, turn("approval"));
    expect(result.ok).toBe(true);
    expect(box.sent.map((mail) => mail.to)).toEqual([["privacy@a.example"], ["datenschutz@b.example"]]);
    expect(box.sent[1]?.text).toBe(letter("B AG"));
    expect(recorded).toEqual(["<sent-1@test>", "<sent-2@test>"]);
  });

  it("says exactly which are out when one fails, and sends the rest anyway", async () => {
    const box = fakeMailAccount("gmx", "alex@example.org");
    const account: MailAccount = {
      ...box.account,
      send: async (mail) => {
        if (mail.to[0] === "privacy@a.example") throw new MailError("Recipient rejected.");
        return box.account.send(mail);
      },
    };
    const registry = new ToolRegistry(gate().gate).registerAll(mailTools({ accounts: [account], keep: memoryKeep() }));
    const result = await registry.executeApproved({ id: "a1", tool: "mail_send_each", status: "approved", args: { mails } }, turn("approval"));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Out: datenschutz@b.example.");
    expect(result.text).toContain("Not sent: privacy@a.example (Recipient rejected.)");
    expect(box.sent).toHaveLength(1);
  });
});
