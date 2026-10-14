import { describe, expect, it } from "vitest";
import type { ImapFlow } from "imapflow";

const { imapAccount } = await import("../src/mail/imap.js");

const SECRET = { kind: "imap", user: "alex@example.org", password: "app-passwort-123", imapHost: "imap.example.org", imapPort: 993, smtpHost: "smtp.example.org", smtpPort: 587 } as const;

const raw = (uid: number) =>
  Buffer.from(`From: Max <max@example.org>\r\nTo: alex@example.org\r\nSubject: Mail ${uid}\r\nMessage-ID: <${uid}@example.org>\r\nDate: Sun, 20 Sep 2026 18:00:00 +0000\r\n\r\nText ${uid}\r\n`);

/**
 * An IMAP server in memory that behaves like GMX behind imapflow on
 * 2026-09-20: `mailbox.uidNext` is the state of the SELECT and stands still,
 * even when new mail arrives. Only SEARCH and STATUS see the real state.
 */
function fakeServer(initialUids: number[]) {
  const uids = [...initialUids];
  const selectedUidNext = Math.max(...uids) + 1;
  const searches: string[] = [];
  const client = {
    usable: true,
    mailbox: { uidValidity: 1648211439n, uidNext: selectedUidNext },
    on: () => undefined,
    connect: async () => undefined,
    logout: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    status: async () => ({ uidNext: Math.max(...uids) + 1 }),
    search: async (query: { uid?: string }) => {
      searches.push(query.uid ?? "");
      const from = Number((query.uid ?? "1:*").split(":")[0]);
      const hits = uids.filter((uid) => uid >= from);
      // IMAP: `n:*` always returns at least the last mail.
      return hits.length > 0 ? hits : [Math.max(...uids)];
    },
    fetchAll: async (range: number[]) => [...range].reverse().map((uid) => ({ uid, internalDate: new Date("2026-09-20T18:00:00Z"), source: raw(uid) })),
  };
  return { deliver: (uid: number) => void uids.push(uid), searches, create: () => client as unknown as ImapFlow };
}

describe("IMAP: new mail on a long-open connection (regression 2026-09-20)", () => {
  it("sees new mails although the connection's mailbox.uidNext stood still", async () => {
    const server = fakeServer([9974, 9975]);
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    const first = await box.newSince(null, 10);
    expect(first).toEqual({ cursor: { uidValidity: "1648211439", uidNext: 9976 }, messages: [] });

    server.deliver(9976);
    server.deliver(9977);
    const next = await box.newSince(first.cursor, 10);
    // In order of receipt: the reply to a mail must never be classified before it.
    expect(next.messages.map((mail) => `${mail.id} ${mail.subject}`)).toEqual(["gmx:9976 Mail 9976", "gmx:9977 Mail 9977"]);
    expect(next.cursor).toEqual({ uidValidity: "1648211439", uidNext: 9978 });
    expect(server.searches).toEqual(["9976:*"]);
  });

  it("reads nothing twice without new mail and keeps the cursor", async () => {
    const server = fakeServer([9974, 9975]);
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    const cursor = { uidValidity: "1648211439", uidNext: 9976 };
    expect(await box.newSince(cursor, 10)).toEqual({ cursor, messages: [] });
  });

  it("takes the fresh state from the server on the first run, not the one from SELECT", async () => {
    const server = fakeServer([9974, 9975]);
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    server.deliver(9976);
    expect((await box.newSince(null, 10)).cursor).toEqual({ uidValidity: "1648211439", uidNext: 9977 });
  });

  it("counts anew when the server has reassigned the UIDs", async () => {
    const server = fakeServer([5, 6]);
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    expect(await box.newSince({ uidValidity: "1", uidNext: 9000 }, 10)).toEqual({ cursor: { uidValidity: "1648211439", uidNext: 7 }, messages: [] });
  });

  it("keeps to the limit per round and continues there next time", async () => {
    const server = fakeServer([1, 2, 3, 4, 5]);
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    const round = await box.newSince({ uidValidity: "1648211439", uidNext: 2 }, 2);
    expect(round.messages).toHaveLength(2);
    expect(round.cursor["uidNext"]).toBe(4);
  });
});

/**
 * An IMAP server with an inbox and "Gesendet" (sent) that searches by
 * substrings like GMX: `FROM anna@example.org` also matches `hanna@example.org`.
 */
function correspondenceServer(options: {
  inbox?: Array<{ uid: number; from: string }>;
  sent?: Array<{ uid: number; to: string[]; cc?: string[] }>;
  sentFolder?: boolean;
}) {
  const inbox = options.inbox ?? [];
  const sent = options.sent ?? [];
  let selected = "";
  const searches: Array<{ folder: string; query: Record<string, unknown> }> = [];
  const fetched: Array<{ folder: string; fields: string[] }> = [];
  const contains = (value: string, needle: unknown) => typeof needle === "string" && value.toLowerCase().includes(needle.toLowerCase());
  const client = {
    usable: true,
    on: () => undefined,
    connect: async () => undefined,
    logout: async () => undefined,
    list: async () => [{ path: "INBOX" }, ...(options.sentFolder === false ? [] : [{ path: "Gesendet", specialUse: "\\Sent" }])],
    getMailboxLock: async (path: string) => {
      selected = path;
      return { release: () => undefined };
    },
    search: async (query: Record<string, unknown>) => {
      searches.push({ folder: selected, query });
      if (selected === "INBOX") return inbox.filter((mail) => contains(mail.from, query["from"])).map((mail) => mail.uid);
      const or = (query["or"] as Array<Record<string, string>> | undefined) ?? [];
      return sent
        .filter((mail) => or.some((term) => (term["to"] && mail.to.some((to) => contains(to, term["to"]))) || (term["cc"] && (mail.cc ?? []).some((cc) => contains(cc, term["cc"])))))
        .map((mail) => mail.uid);
    },
    fetchAll: async (uids: number[], query: Record<string, unknown>) => {
      fetched.push({ folder: selected, fields: Object.keys(query) });
      return uids.map((uid) => {
        if (selected === "INBOX") return { uid, envelope: { from: [{ address: inbox.find((mail) => mail.uid === uid)?.from }] } };
        const mail = sent.find((entry) => entry.uid === uid);
        return { uid, envelope: { to: (mail?.to ?? []).map((address) => ({ address })), cc: (mail?.cc ?? []).map((address) => ({ address })) } };
      });
    },
  };
  return { searches, fetched, create: () => client as unknown as ImapFlow };
}

describe("IMAP: has there been mail with the address before? (addendum D34)", () => {
  it("knows a sender from the inbox and then no longer looks in sent", async () => {
    const server = correspondenceServer({ inbox: [{ uid: 7, from: "Anna@Example.org" }] });
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    expect(await box.hasCorresponded?.("anna@example.org")).toBe(true);
    expect(server.searches.map((entry) => entry.folder)).toEqual(["INBOX"]);
    const since = server.searches[0]?.query["since"] as Date;
    expect(Math.round((Date.now() - since.getTime()) / 86_400_000)).toBe(3 * 365);
    // Only the envelope, never the text.
    expect(server.fetched).toEqual([{ folder: "INBOX", fields: ["uid", "envelope"] }]);
  });

  it("knows a recipient from sent, also in Cc", async () => {
    const server = correspondenceServer({ sent: [{ uid: 3, to: ["max@example.org"], cc: ["anna@example.org"] }] });
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    expect(await box.hasCorresponded?.("anna@example.org")).toBe(true);
    expect(server.searches.map((entry) => entry.folder)).toEqual(["INBOX", "Gesendet"]);
  });

  it("is not fooled by the substring IMAP searches with", async () => {
    const server = correspondenceServer({
      inbox: [{ uid: 1, from: "hanna@example.org" }],
      sent: [{ uid: 2, to: ["johanna@example.org"] }],
    });
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    expect(await box.hasCorresponded?.("anna@example.org")).toBe(false);
  });

  it("fails honestly without a sent folder instead of claiming \"never written\"", async () => {
    const server = correspondenceServer({ sentFolder: false });
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    await expect(box.hasCorresponded?.("anna@example.org")).rejects.toThrow(/no folder for sent mail/);
  });
});

/**
 * An IMAP server with several folders as at GMX on 2026-10-03: inbox,
 * "Gelöscht", "Spamverdacht", "Gesendet", a custom folder, plus a virtual one
 * and one that cannot be selected. UIDs only apply in their own folder.
 */
function folderServer(contents: Record<string, Array<{ uid: number; day: number; from: string; unsubscribe?: boolean; html?: string }>>) {
  let selected = "";
  const locks: string[] = [];
  const fetched: Array<{ folder: string; fields: string[] }> = [];
  const mailIn = (folder: string, uid: number) => (contents[folder] ?? []).find((mail) => mail.uid === uid);
  const client = {
    usable: true,
    on: () => undefined,
    connect: async () => undefined,
    logout: async () => undefined,
    list: async () => [
      { path: "INBOX", flags: new Set<string>() },
      { path: "Gelöscht", specialUse: "\\Trash", flags: new Set<string>() },
      { path: "Spamverdacht", specialUse: "\\Junk", flags: new Set<string>() },
      { path: "Gesendet", specialUse: "\\Sent", flags: new Set<string>() },
      { path: "Rechnungen", flags: new Set<string>() },
      { path: "Markiert", specialUse: "\\Flagged", flags: new Set<string>() },
      { path: "Ablage", flags: new Set(["\\Noselect"]) },
    ],
    getMailboxLock: async (path: string) => {
      selected = path;
      locks.push(path);
      return { release: () => undefined };
    },
    search: async (query: { from?: string; or?: Array<{ from: string }> }) => {
      const wanted = query.or ? query.or.map((term) => term.from) : query.from ? [query.from] : null;
      return (contents[selected] ?? []).filter((mail) => !wanted || wanted.some((from) => mail.from.includes(from))).map((mail) => mail.uid);
    },
    fetchAll: async (uids: number[], query: Record<string, unknown>) => {
      fetched.push({ folder: selected, fields: Object.keys(query) });
      return uids.map((uid) => {
        const mail = mailIn(selected, uid);
        const head =
          `From: ${mail?.from}\r\nTo: alex@example.org\r\nSubject: ${selected} ${uid}\r\nDate: ${new Date(Date.UTC(2026, 8, mail?.day ?? 1)).toUTCString()}\r\n` +
          (mail?.html ? "Content-Type: text/html; charset=utf-8\r\n" : "");
        return {
          uid,
          internalDate: new Date(Date.UTC(2026, 8, mail?.day ?? 1)),
          envelope: { subject: `${selected} ${uid}`, from: [{ address: mail?.from }] },
          headers: Buffer.from(mail?.unsubscribe ? `List-Unsubscribe: <https://fitly.example/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\n` : "\r\n"),
          source: Buffer.from(`${head}\r\n${mail?.html ?? `Text ${uid}`}\r\n`),
        };
      });
    },
  };
  return { locks, fetched, create: () => client as unknown as ImapFlow };
}

describe("IMAP: every folder (addendum D31 of 2026-10-03)", () => {
  const contents = {
    INBOX: [{ uid: 5, day: 1, from: "anna@example.org" }],
    Gelöscht: [{ uid: 5, day: 20, from: "news@fitly.example", unsubscribe: true }],
    Spamverdacht: [{ uid: 9, day: 15, from: "news@fitly.example", unsubscribe: true }],
    Gesendet: [{ uid: 3, day: 10, from: "alex@example.org" }],
    Rechnungen: [{ uid: 2, day: 5, from: "rechnung@shop.example" }],
    Markiert: [{ uid: 5, day: 1, from: "anna@example.org" }],
  };

  it("searches all selectable folders, without virtual ones, and says where each mail lies", async () => {
    const server = folderServer(contents);
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    const found = await box.search({ sinceDays: 90, limit: 10, folder: "all" });
    expect(found.map((mail) => `${mail.folder} ${mail.subject}`)).toEqual([
      "Trash Gelöscht 5",
      "Spam Spamverdacht 9",
      "Sent Gesendet 3",
      "Rechnungen Rechnungen 2",
      "Inbox INBOX 5",
    ]);
    expect(server.locks).not.toContain("Markiert");
    expect(server.locks).not.toContain("Ablage");
    // Same UID in two folders, two different IDs; in the inbox the bare UID as before.
    expect(found.find((mail) => mail.folder === "Inbox")?.id).toBe("gmx:5");
    expect(found.find((mail) => mail.folder === "Trash")?.id).toMatch(/^gmx:[0-9a-f]{8}-5$/);
  });

  it("loads the text only for the hits that make it into the selection across all folders", async () => {
    const server = folderServer(contents);
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    const found = await box.search({ sinceDays: 90, limit: 2, folder: "all" });
    expect(found.map((mail) => mail.folder)).toEqual(["Trash", "Spam"]);
    expect(server.fetched.filter((entry) => entry.fields.includes("source")).map((entry) => entry.folder).sort()).toEqual(["Gelöscht", "Spamverdacht"]);
  });

  it("narrows down to one folder", async () => {
    const server = folderServer(contents);
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    expect((await box.search({ sinceDays: 90, limit: 10, folder: "trash" })).map((mail) => mail.subject)).toEqual(["Gelöscht 5"]);
    expect((await box.search({ sinceDays: 90, limit: 10, folder: "inbox" })).map((mail) => mail.subject)).toEqual(["INBOX 5"]);
  });

  it("reads a mail from the trash by its ID, and one from the inbox as before", async () => {
    const server = folderServer(contents);
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    const [trashed] = await box.search({ sinceDays: 90, limit: 1, folder: "trash" });
    const providerId = trashed!.id.slice("gmx:".length);
    expect((await box.read(providerId))?.subject).toBe("Gelöscht 5");
    expect((await box.read("5"))?.subject).toBe("INBOX 5");
    // A folder that does not exist (any more), and nonsense: no mail, no error.
    expect(await box.read("deadbeef-5")).toBeNull();
    expect(await box.read("../INBOX")).toBeNull();
  });

  it("finds the unsubscribe route outside the inbox, never in spam, and only for the exact address", async () => {
    const server = folderServer({ ...contents, Rechnungen: [{ uid: 2, day: 5, from: "old-news@fitly.example", unsubscribe: true }] });
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    const rows = await box.cleanup!.headersFrom(["news@fitly.example"], 90, 50);
    expect(rows.map((row) => `${row.fromAddress} ${row.listUnsubscribe}`)).toEqual(["news@fitly.example <https://fitly.example/u>"]);
    expect(rows[0]?.providerId).toMatch(/^[0-9a-f]{8}-5$/);
    expect(server.locks).not.toContain("Spamverdacht");
    expect(server.locks).not.toContain("Gesendet");
    // Only header lines, never the text.
    expect(server.fetched.some((entry) => entry.fields.includes("source"))).toBe(false);
  });
});

describe("IMAP: unsubscribe link in the mail text (addendum D37 of 2026-10-03)", () => {
  it("takes the link from the newest mail outside spam, and only for the exact address", async () => {
    const server = folderServer({
      INBOX: [{ uid: 1, day: 2, from: "old-news@fitly.example", html: '<a href="https://evil.example/unsubscribe">Unsubscribe</a>' }],
      Gelöscht: [
        { uid: 5, day: 20, from: "news@fitly.example", html: '<a href="https://u1.ct.sendgrid.net/asm/unsubscribe/?d=1">Unsubscribe</a>' },
        { uid: 4, day: 10, from: "news@fitly.example", html: '<a href="https://u1.ct.sendgrid.net/asm/unsubscribe/?d=alt">Unsubscribe</a>' },
      ],
      Spamverdacht: [{ uid: 9, day: 25, from: "news@fitly.example", html: '<a href="https://spam.example/unsubscribe">Unsubscribe</a>' }],
    });
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    const links = await box.cleanup!.linksFrom(["News@Fitly.example"], 90);
    expect([...links.entries()]).toEqual([["news@fitly.example", { url: "https://u1.ct.sendgrid.net/asm/unsubscribe/?d=1", host: "u1.ct.sendgrid.net" }]]);
    expect(server.locks).not.toContain("Spamverdacht");
    // Text only from the one mail that had the link.
    expect(server.fetched.filter((entry) => entry.fields.includes("source"))).toEqual([{ folder: "Gelöscht", fields: ["uid", "source"] }]);
  });

  it("finds nothing when no mail has an unsubscribe link", async () => {
    const server = folderServer({ INBOX: [{ uid: 1, day: 2, from: "anna@example.org", html: '<a href="https://example.org/foto">Foto</a>' }] });
    const box = imapAccount("gmx", "alex@example.org", SECRET, server.create);
    expect((await box.cleanup!.linksFrom(["anna@example.org"], 90)).size).toBe(0);
  });
});

describe("Which folders are \"all\"", () => {
  it("with a server that has an all-mail folder takes only that, trash and spam", async () => {
    const { searchedBoxes } = await import("../src/mail/imap.js");
    const boxes = [
      { path: "INBOX", key: "", label: "Inbox", use: "\\Inbox" },
      { path: "[Gmail]/Alle Nachrichten", key: "a", label: "All Mail", use: "\\All" },
      { path: "[Gmail]/Gesendet", key: "b", label: "Sent", use: "\\Sent" },
      { path: "[Gmail]/Papierkorb", key: "c", label: "Trash", use: "\\Trash" },
      { path: "[Gmail]/Spam", key: "d", label: "Spam", use: "\\Junk" },
    ];
    expect(searchedBoxes(boxes, "all").map((box) => box.use)).toEqual(["\\All", "\\Trash", "\\Junk"]);
    expect(searchedBoxes(boxes, "sent").map((box) => box.path)).toEqual(["[Gmail]/Gesendet"]);
  });
});
