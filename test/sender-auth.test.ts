import { simpleParser } from "mailparser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const auditMock = vi.fn(async () => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...(args as [])) }));

const { fromDomain, imapTrust, senderTrust, verifiedSenderDomain, GMAIL_TRUST } = await import("../src/mail/sender-auth.js");
const { toMailMessage } = await import("../src/mail/parse.js");
const { fromGmail } = await import("../src/mail/gmail.js");
const { mailTools } = await import("../src/agent/tools/mail.js");
const { MailError } = await import("../src/mail/types.js");
const { unbackedLinks, dropUnbackedLinks, linkDropped } = await import("../src/security/links.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { defineTool, TurnState } = await import("../src/agent/tools/types.js");
type MailAccount = import("../src/mail/types.js").MailAccount;
type MailMessage = import("../src/mail/types.js").MailMessage;

/**
 * Home page of a confirmed, known sender (addendum D8.4 of 2026-10-12).
 * Reason: after a mail from the university, Serain wanted to send Alex the
 * link to its portal, and the registry stopped it. The header stacks follow
 * the order of real mails at GMX and Gmail; the attacks are those from the
 * security review of the first draft.
 */

const gmx = imapTrust("imap.gmx.net");
const h = (name: string, value: string) => ({ name, value: ` ${value}` });

/** How GMX delivers: Return-Path, its verdict, its Received line, then everything from the sender. */
function gmxMail(verdict: string | null, sender: Array<{ name: string; value: string }> = [], from = "Prüfungsamt <pruefung@hochschule.example>") {
  return [
    h("Return-Path", "<bounce@hochschule.example>"),
    ...(verdict === null ? [] : [h("Authentication-Results", verdict)]),
    h("Received", "from mail.hochschule.example ([192.0.2.7]) by mx-ha.gmx.net (mxgmx001 [10.0.0.1]) with ESMTPS; Mon, 12 Oct 2026 18:59:00 +0200"),
    h("Received", "from exch.hds.local by mail.hochschule.example"),
    ...sender,
    h("From", from),
  ];
}
const GMX_OK = "gmx.net; dkim=none; spf=pass smtp.mailfrom=pruefung@hochschule.example; dmarc=none header.from=hochschule.example; iprev=pass policy.iprev=192.0.2.7";
const FROM = "Prüfungsamt <pruefung@hochschule.example>";

describe("verifiedSenderDomain with GMX", () => {
  it("knows GMX and no other IMAP host", () => {
    expect(gmx?.authserv).toBe("gmx.net");
    expect(imapTrust("imap.example.org")).toBeNull();
    expect(verifiedSenderDomain(gmxMail(GMX_OK), null)).toBeNull();
  });

  it("confirms DMARC pass and, without a policy, SPF or DKIM of the same organisation (the reason)", () => {
    expect(verifiedSenderDomain(gmxMail(GMX_OK), gmx)).toBe("hochschule.example");
    expect(verifiedSenderDomain(gmxMail("gmx.net; dkim=pass header.i=@mail.hochschule.example; spf=none; dmarc=none header.from=hochschule.example"), gmx)).toBe(
      "hochschule.example",
    );
    expect(
      verifiedSenderDomain(gmxMail("gmx.net; dkim=pass header.i=@hochschule.example; spf=pass smtp.mailfrom=x@hochschule.example; dmarc=pass header.from=hochschule.example policy.dmarc=reject"), gmx),
    ).toBe("hochschule.example");
  });

  it("blocks foreign SPF, soft SPF, DMARC fail and a verdict about another domain", () => {
    for (const verdict of [
      "gmx.net; dkim=none; spf=pass smtp.mailfrom=bounce@versand.example; dmarc=none header.from=hochschule.example",
      "gmx.net; dkim=none; spf=softfail smtp.mailfrom=x@hochschule.example; dmarc=none header.from=hochschule.example",
      "gmx.net; dkim=pass header.i=@hochschule.example; spf=pass smtp.mailfrom=x@hochschule.example; dmarc=fail header.from=hochschule.example",
      "gmx.net; spf=pass smtp.mailfrom=x@hochschule.example; dmarc=none header.from=andere.de",
      "gmx.net; dmarc=pass",
    ]) {
      expect(verifiedSenderDomain(gmxMail(verdict), gmx)).toBeNull();
    }
  });

  it("believes no verdict below GMX's Received line, even if GMX set none itself", () => {
    const forged = h("Authentication-Results", "gmx.net; dmarc=pass header.from=hochschule.example");
    expect(verifiedSenderDomain(gmxMail(null, [forged]), gmx)).toBeNull();
    // With its own forged GMX Received line below: the first from the top counts.
    expect(verifiedSenderDomain(gmxMail(null, [forged, h("Received", "from evil by mx-ha.gmx.net")]), gmx)).toBeNull();
  });

  it("requires GMX's Received line and nothing foreign above it", () => {
    const withoutHop = gmxMail(GMX_OK).filter((field) => !field.value.includes("mx-ha.gmx.net"));
    expect(verifiedSenderDomain(withoutHop, gmx)).toBeNull();
    expect(verifiedSenderDomain([h("Received", "from a by relay.example"), ...gmxMail(GMX_OK)], gmx)).toBeNull();
  });

  it("reads quotes and comments like the provider (envelope address from the sender)", () => {
    const quoted =
      'gmx.net; dkim=none; spf=pass smtp.mailfrom="x; dmarc=pass header.from=bank.example spf=pass smtp.mailfrom=y@bank.example"@evil.example; dmarc=none header.from=bank.example';
    expect(verifiedSenderDomain(gmxMail(quoted, [], "Bank <service@bank.example>"), gmx)).toBeNull();
    const comment = 'gmx.net; spf=pass smtp.mailfrom="("@evil.example; dmarc=fail header.from=bank.example; x=y (dmarc=pass header.from=bank.example)';
    expect(verifiedSenderDomain(gmxMail(comment, [], "service@bank.example"), gmx)).toBeNull();
    expect(verifiedSenderDomain(gmxMail("gmx.net; dmarc=none header.from=bank.example; dmarc=pass header.from=bank.example", [], "service@bank.example"), gmx)).toBeNull();
    expect(verifiedSenderDomain(gmxMail('gmx.net; spf=pass smtp.mailfrom="unterminated@bank.example', [], "service@bank.example"), gmx)).toBeNull();
  });

  it("checks only with exactly one From line, raw from the header lines", () => {
    const two = gmxMail("gmx.net; dkim=pass header.i=@evil.example; spf=pass smtp.mailfrom=x@evil.example; dmarc=pass header.from=evil.example", [h("From", "service@bank.example")], "a@evil.example");
    expect(verifiedSenderDomain(two, gmx)).toBeNull();
    expect(verifiedSenderDomain(gmxMail(GMX_OK).filter((field) => field.name !== "From"), gmx)).toBeNull();
  });

  it("takes exactly one sender address", () => {
    expect(fromDomain('"chef@bank.example" <phish@evil.example>')).toBeNull();
    expect(fromDomain("a@hochschule.example, b@hochschule.example")).toBeNull();
    expect(fromDomain("Prüfungsamt <Pruefung@Hochschule.EXAMPLE>")).toBe("hochschule.example");
    expect(fromDomain("x".repeat(200_000))).toBeNull();
  });
});

describe("verifiedSenderDomain with Gmail", () => {
  const ok =
    "mx.google.com; dkim=pass header.i=@hochschule.example header.s=s1; spf=pass (google.com: domain of x@hochschule.example) smtp.mailfrom=x@hochschule.example; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=hochschule.example";
  const gmail = (arc: string | null, below: Array<{ name: string; value: string }> = []) => [
    h("Delivered-To", "alex@example.org"),
    h("Received", "by 2002:a05:7010:2a9d:b0:54d:e1fe:651b with SMTP id x; Mon, 12 Oct 2026"),
    ...(arc === null ? [] : [h("ARC-Authentication-Results", `i=1; ${arc}`)]),
    h("Return-Path", "<x@hochschule.example>"),
    h("Received", "from mail.hochschule.example (mail.hochschule.example. [192.0.2.7]) by mx.google.com with ESMTPS id y"),
    h("Received-SPF", "pass"),
    ...(arc === null ? [] : [h("Authentication-Results", arc)]),
    ...below,
    h("From", "pruefung@hochschule.example"),
  ];

  it("takes Gmail's ARC verdict above its Received line", () => {
    expect(verifiedSenderDomain(gmail(ok), GMAIL_TRUST)).toBe("hochschule.example");
  });

  it("believes no verdict below it, not even with Gmail's identifier", () => {
    const forged = [h("ARC-Authentication-Results", `i=1; ${ok}`), h("Authentication-Results", ok)];
    expect(verifiedSenderDomain(gmail(null, forged), GMAIL_TRUST)).toBeNull();
  });

  it("through the adapter: fromGmail", () => {
    const mail = fromGmail("google", {
      id: "1",
      threadId: "t",
      payload: {
        mimeType: "text/plain",
        headers: gmail(ok).map((field) => ({ name: field.name, value: field.value.trim() })),
        body: { data: Buffer.from("Hallo").toString("base64url") },
      },
    });
    expect(mail.senderDomain).toBe("hochschule.example");
  });
});

describe("IMAP adapter", () => {
  it("reads the header lines in their order", async () => {
    const raw = (fields: Array<{ name: string; value: string }>) =>
      [...fields.map((field) => `${field.name}:${field.value}`), "To: alex@example.org", "Subject: Ticket", "Content-Type: text/plain; charset=utf-8", "", "Hallo"].join(
        "\r\n",
      );
    const genuine = toMailMessage("gmx", "1", await simpleParser(raw(gmxMail(GMX_OK))), new Date(), "Inbox", gmx);
    expect(genuine.senderDomain).toBe("hochschule.example");
    const forged = gmxMail(null, [h("Authentication-Results", GMX_OK)]);
    expect(toMailMessage("gmx", "1", await simpleParser(raw(forged)), new Date(), "Inbox", gmx).senderDomain).toBeUndefined();
    expect(toMailMessage("gmx", "1", await simpleParser(raw(gmxMail(GMX_OK))), new Date(), "Inbox").senderDomain).toBeUndefined();
  });
});

describe("unbackedLinks with a confirmed sender", () => {
  const senders = ["hochschule.example", "mail.bank.example"];

  it("lets through the home page of the same registrable domain, also of another subdomain", () => {
    for (const link of ["portal.hochschule.example", "https://portal.hochschule.example/", "hochschule.example", "https://www.bank.example", "online.bank.example/"]) {
      expect(unbackedLinks(`hier: ${link}`, [], senders)).toEqual([]);
    }
  });

  it("stops paths, queries, foreign domains and private suffixes", () => {
    expect(unbackedLinks("portal.hochschule.example/login", [], senders)).toHaveLength(1);
    expect(unbackedLinks("https://hochschule.example/?next=https://evil.example", [], senders)).toHaveLength(1);
    expect(unbackedLinks("hochschule-portal.de", [], senders)).toHaveLength(1);
    expect(unbackedLinks("evil.github.io", [], ["github.io"])).toHaveLength(1);
    expect(unbackedLinks("bank.example.evil.example", [], senders)).toHaveLength(1);
    expect(dropUnbackedLinks("erst portal.hochschule.example, dann portal.hochschule.example/x", [], senders)).toBe(
      `erst portal.hochschule.example, dann ${linkDropped()}`,
    );
  });
});

describe("mail_read: only a confirmed sender Alex has known for a while", () => {
  const mail: MailMessage = {
    id: "gmx:1",
    threadKey: "t",
    from: FROM,
    to: "alex@example.org",
    subject: "Ticket",
    date: "2026-10-12T17:00:00.000Z",
    snippet: "",
    bulk: false,
    folder: "Inbox",
    text: "Hallo",
    attachments: [],
    messageId: "<m@hochschule.example>",
    references: [],
    senderDomain: "hochschule.example",
  };
  const now = new Date("2026-10-12T19:00:00.000Z");
  const read = async (known: boolean | "error" | undefined) => {
    const asked: Array<{ domain: string; before: Date }> = [];
    const box = {
      id: "gmx",
      address: "alex@example.org",
      search: async () => [],
      read: async () => mail,
      send: async () => ({ messageId: "" }),
      newSince: async () => ({ cursor: {}, messages: [] }),
      close: async () => undefined,
      ...(known === undefined
        ? {}
        : {
            knewDomainBefore: async (domain: string, before: Date) => {
              asked.push({ domain, before });
              if (known === "error") throw new MailError("Mailbox gone.");
              return known;
            },
          }),
    } as MailAccount;
    const tool = mailTools({ accounts: [box], now: () => now }).find((entry) => entry.name === "mail_read");
    const state = new TurnState({ origin: "owner_message", triggerExternalId: "m", triggerMessageId: "d", reactableIds: [] });
    return { result: await tool!.run({ id: "gmx:1" } as never, state), asked };
  };

  it("confirms with a note in the text when mail from there is older than 30 days", async () => {
    const { result, asked } = await read(true);
    expect(result.senderDomain).toBe("hochschule.example");
    expect(result.text).toContain("(sender verified: hochschule.example)");
    expect(asked).toEqual([{ domain: "hochschule.example", before: new Date("2026-09-12T19:00:00.000Z") }]);
  });

  it("does not confirm for a new domain, without the capability or when the mailbox fails", async () => {
    for (const known of [false, undefined, "error"] as const) {
      const { result } = await read(known);
      expect(result.ok).toBe(true);
      expect(result.senderDomain).toBeUndefined();
      expect(result.text).not.toContain("sender verified");
    }
  });
});

describe("Registry: only a tool with vouchesSender confirms", () => {
  const sent: string[] = [];
  const say = defineTool({
    name: "say",
    description: "To Alex.",
    level: "write_reversible",
    textToOwner: true,
    schema: { text: z.string() },
    async run(args) {
      sent.push(args.text);
      return { ok: true, text: "sent" };
    },
  });
  const readMail = (name: string, vouches: boolean, ok = true, senderDomain = "hochschule.example") =>
    defineTool({
      name,
      description: "Reads a mail.",
      level: "read",
      returnsUntrusted: true,
      ...(vouches ? { vouchesSender: true } : {}),
      schema: {},
      async run() {
        return { ok, text: "Hallo", source: "mail from pruefung@hochschule.example", senderDomain };
      },
    });
  const registry = new ToolRegistry().registerAll([
    readMail("mail_read_like", true),
    readMail("mail_read_failed", true, false),
    readMail("other_like", false),
    readMail("odd_domain", true, true, "hochschule.example/evil"),
    say,
  ]);
  const owner = () => new TurnState({ origin: "owner_message", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: ["m-1"] });

  beforeEach(() => {
    sent.length = 0;
    auditMock.mockClear();
  });

  it("lets the home page through after the confirmed mail, a path not", async () => {
    const state = owner();
    await registry.execute("mail_read_like", {}, state);
    expect((await registry.execute("say", { text: "log dich auf portal.hochschule.example ein" }, state)).ok).toBe(true);
    expect((await registry.execute("say", { text: "portal.hochschule.example/bescheide" }, state)).ok).toBe(false);
    expect(sent).toEqual(["log dich auf portal.hochschule.example ein"]);
  });

  it("believes `senderDomain` from no other tool, no failed read and no value that is not a domain", async () => {
    for (const tool of ["other_like", "mail_read_failed", "odd_domain"]) {
      const state = owner();
      await registry.execute(tool, {}, state);
      expect((await registry.execute("say", { text: "portal.hochschule.example" }, state)).ok).toBe(false);
    }
  });
});

describe("What the code knows about a sender (addendum D33 of 2026-10-13)", () => {
  const at = new Date("2026-10-13T08:00:00.000Z");
  const box = (known: boolean | "error" | undefined) => {
    const asked: string[] = [];
    const account = {
      id: "gmx",
      address: "alex@example.org",
      ...(known === undefined
        ? {}
        : {
            knewDomainBefore: async (domain: string) => {
              asked.push(domain);
              if (known === "error") throw new MailError("Mailbox gone.");
              return known;
            },
          }),
    } as unknown as MailAccount;
    return { account, asked };
  };

  it("tells known, new and unverified apart", async () => {
    expect(await senderTrust(box(true).account, "hausverwaltung.example", at)).toBe("known");
    expect(await senderTrust(box(false).account, "hausverwaltung.example", at)).toBe("new");
    expect(await senderTrust(box(true).account, undefined, at)).toBe("unverified");
  });

  it("says nothing where the mailbox cannot tell", async () => {
    expect(await senderTrust(box(undefined).account, "hausverwaltung.example", at)).toBeNull();
    expect(await senderTrust(box("error").account, "hausverwaltung.example", at)).toBeNull();
  });

  it("makes no sender at a general provider known: everyone has an account there", async () => {
    for (const domain of ["gmail.com", "GMX.de", "mail.icloud.com", "web.de"]) {
      const { account, asked } = box(true);
      expect(await senderTrust(account, domain.toLowerCase(), at)).toBeNull();
      expect(asked).toEqual([]);
    }
  });
});
