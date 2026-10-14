import type { ImapFlow } from "imapflow";
import { describe, expect, it, vi } from "vitest";

/** What nodemailer would send, without network. */
const sentMail: Array<Record<string, unknown>> = [];
const verified: string[] = [];
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: { host: string }) => ({
      sendMail: async (message: Record<string, unknown>) => (sentMail.push(message), { messageId: "<sent@test>" }),
      verify: async () => {
        verified.push(options.host);
        if (options.host === "smtp.kaputt.example") throw new Error("535 Authentication failed");
        return true;
      },
      close: () => undefined,
    }),
  },
}));

const { imapAccount, verifySmtp } = await import("../src/mail/imap.js");

const SECRET = { kind: "imap", user: "alex@example.org", password: "app-passwort-123", imapHost: "imap.example.org", imapPort: 993, smtpHost: "smtp.example.org", smtpPort: 587 } as const;

/** An IMAP server without a sent folder: the copy after sending is silently dropped. */
const client = () =>
  ({
    usable: true,
    on: () => undefined,
    connect: async () => undefined,
    logout: async () => undefined,
    list: async () => [{ path: "INBOX" }],
    getMailboxLock: async () => ({ release: () => undefined }),
  }) as unknown as ImapFlow;

describe("Sender (addendum D31 of 2026-10-08)", () => {
  it("writes from Serain's mailbox with the name Serain, from Alex's only with the address", async () => {
    sentMail.length = 0;
    const own = imapAccount("serain", "hi@serain.example", { ...SECRET, user: "hi@serain.example", owner: "serain" }, client);
    const alex = imapAccount("gmx", "alex@example.org", SECRET, client);
    await own.send({ to: ["anna@example.org"], cc: [], subject: "Termin", text: "Hallo" });
    await alex.send({ to: ["anna@example.org"], cc: [], subject: "Termin", text: "Hallo" });
    expect(sentMail.map((mail) => mail["from"])).toEqual([{ name: "Serain", address: "hi@serain.example" }, "alex@example.org"]);
    expect(own.serains).toBe(true);
    expect(own.cleanup).toBeUndefined();
    expect(alex.serains).toBeUndefined();
    expect(alex.cleanup).toBeDefined();
  });

  it("checks the SMTP login before storing and does not name the password in the message", async () => {
    await verifySmtp(SECRET);
    const failed = verifySmtp({ ...SECRET, smtpHost: "smtp.kaputt.example" });
    await expect(failed).rejects.toThrow(/SMTP login failed: 535/);
    await expect(failed).rejects.not.toThrow(/app-passwort/);
    expect(verified).toEqual(["smtp.example.org", "smtp.kaputt.example"]);
  });
});

describe("Known sender only with a readable verdict (addendum D33 of 2026-10-13)", () => {
  it("does not count mail in the trash and in spam: that is where Serain moves spam", async () => {
    const searched: string[] = [];
    let open = "";
    const boxes = () =>
      ({
        usable: true,
        on: () => undefined,
        connect: async () => undefined,
        logout: async () => undefined,
        list: async () => [
          { path: "INBOX", flags: new Set() },
          { path: "Archiv", flags: new Set() },
          { path: "Papierkorb", flags: new Set(), specialUse: "\\Trash" },
          { path: "Spamverdacht", flags: new Set(), specialUse: "\\Junk" },
        ],
        getMailboxLock: async (path: string) => ((open = path), { release: () => undefined }),
        search: async () => (searched.push(open), []),
      }) as unknown as ImapFlow;
    const gmx = imapAccount("gmx", "alex@example.org", { ...SECRET, imapHost: "imap.gmx.net" }, boxes);
    expect(await gmx.knewDomainBefore?.("hausverwaltung.example", new Date())).toBe(false);
    expect(searched).toEqual(["INBOX", "Archiv"]);
  });

  it("says \"known for a while\" only where it can read the incoming server's verdict", () => {
    expect(imapAccount("gmx", "alex@example.org", { ...SECRET, imapHost: "imap.gmx.net" }, client).knewDomainBefore).toBeDefined();
    expect(imapAccount("serain", "hi@serain.example", SECRET, client).knewDomainBefore).toBeUndefined();
  });
});
