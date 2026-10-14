import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ImapFlow } from "imapflow";

vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));

const { analyzeTools } = await import("../src/agent/tools/analyze.js");
const { DataSources, calendarSource, mailSource } = await import("../src/datasets/sources.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { imapAccount } = await import("../src/mail/imap.js");
const { DATA_MAIL_HEADER_MAX_BYTES } = await import("../src/config/limits.js");
import type { DataSource } from "../src/datasets/sources.js";
import type { MailAccount, MailHeaderExport } from "../src/mail/types.js";
import type { Calendar } from "../src/calendar/types.js";

// Plain JavaScript outside src/: the helper runs on the server without tsx (D20).
const helper = (await import("../deploy/sandbox/helper.mjs" as string)) as { JOBS: Record<string, { argv: string[] }> };

const NOW = new Date("2026-10-13T10:00:00Z");

function chat() {
  return new TurnState({ origin: "owner_message", triggerExternalId: "x", triggerMessageId: "db-1", reactableIds: [] });
}

/** A sandbox that records the job and returns a fixed output. */
function recording(stdout = "ok") {
  const seen: Array<{ job: string; input: Buffer; timeoutMs: number }> = [];
  return {
    seen,
    sandbox: {
      run: async (request: { job: string; input: Buffer; timeoutMs: number }) => {
        seen.push(request);
        return { exitCode: 0, timedOut: false, truncated: false, stdout: Buffer.from(stdout), stderr: "" };
      },
    },
  };
}

/** The sandbox, just without Docker: the same entry program as on the server, locally with python3. */
const python = spawnSync("python3", ["--version"]).status === 0;
function localPython() {
  return {
    run: async (request: { job: string; input: Buffer }) => {
      // In the container /tmp is a fresh tmpfs; here a separate folder per run.
      const dir = mkdtempSync(join(tmpdir(), "serain-analyze-"));
      const argv = helper.JOBS[request.job]!.argv.map((arg) => arg.replaceAll("/tmp/files", join(dir, "files")));
      const child = spawnSync(argv[0]!, argv.slice(1), { input: request.input, cwd: dir, timeout: 20_000 });
      rmSync(dir, { recursive: true, force: true });
      return { exitCode: child.status ?? 1, timedOut: false, truncated: false, stdout: child.stdout, stderr: child.stderr.toString() };
    },
  };
}

/** Unpacks the job like the entry program in the container: header line, code, files. */
function unpack(input: Buffer): { code: string; files: Map<string, string> } {
  const newline = input.indexOf("\n");
  const head = JSON.parse(input.subarray(0, newline).toString()) as { code: number; files: Array<{ id: string; size: number }> };
  let at = newline + 1;
  const code = input.subarray(at, at + head.code).toString();
  at += head.code;
  const files = new Map<string, string>();
  for (const file of head.files) {
    files.set(file.id, input.subarray(at, at + file.size).toString());
    at += file.size;
  }
  return { code, files };
}

const SPAM_HEAD = (n: number, to: string) =>
  [
    `Received: from mail${n}.bulk-sender.example (mail${n}.bulk-sender.example [203.0.113.${n}]) by mx.gmx.net`,
    `Return-Path: <bounce@bulk-sender.example>`,
    `From: "Prize" <win@lotto-${n}.example>`,
    `To: ${to}`,
    `Subject: You have won ${n}`,
  ].join("\r\n");

/** A mailbox that only returns headers and remembers what was asked. */
function headerBox(rows: MailHeaderExport[]): { box: MailAccount; asked: Array<{ folder: string; since: Date; before: Date; max: number }> } {
  const asked: Array<{ folder: string; since: Date; before: Date; max: number }> = [];
  const box = {
    id: "gmx",
    address: "alex@example.org",
    exportHeaders: async (query: { folder: string; since: Date; before: Date; max: number }) => {
      asked.push(query);
      return { rows, truncated: false };
    },
  } as unknown as MailAccount;
  return { box, asked };
}

function calendarStub(): Calendar {
  return {
    label: "Alex' iCloud calendar",
    list: async () => ({
      entries: [
        { id: "e1", title: "Dentist", start: "2026-03-02T09:00:00+01:00", end: "2026-03-02T09:30:00+01:00", allDay: false, location: "Sampletown", guests: [], status: "confirmed", organizerSelf: true, declined: false, calendar: "Personal" },
      ],
      truncated: false,
    }),
  } as unknown as Calendar;
}

function setup(sources: DataSource[], sandbox = recording().sandbox) {
  const data = new DataSources();
  for (const source of sources) data.add(source);
  return new ToolRegistry().registerAll(analyzeTools({ sandbox, sources: data, now: () => NOW }));
}

describe("analyze_data: analysing own data in the sandbox (D63, building block D)", () => {
  it("exists only with a sandbox and a source directory", () => {
    expect(analyzeTools({ sandbox: null, sources: new DataSources() })).toEqual([]);
    expect(analyzeTools({ sandbox: recording().sandbox, sources: null })).toEqual([]);
    const [tool] = analyzeTools({ sandbox: recording().sandbox, sources: new DataSources() });
    expect(tool).toMatchObject({ name: "analyze_data", level: "read", returnsUntrusted: true, privateResult: true, repeatable: true });
  });

  it("puts the rows into the sandbox as JSONL and gives the program load()", async () => {
    const { box, asked } = headerBox([{ providerId: "7", folder: "Spam", date: "2026-10-12T08:00:00.000Z", headers: SPAM_HEAD(7, "alex@example.org") }]);
    const { sandbox, seen } = recording("3 senders");
    const registry = setup([mailSource(box, "mail_gmx")!, calendarSource(calendarStub())], sandbox);
    const turn = chat();
    const result = await registry.execute(
      "analyze_data",
      { inputs: [{ source: "mail_gmx", folder: "junk", from: "2026-07-01" }, { source: "calendar", from: "2026-01-01", to: "2026-12-31" }], code: "print(len(load('mail_gmx')))" },
      turn,
    );
    expect(result.ok).toBe(true);
    expect(asked[0]).toMatchObject({ folder: "junk", max: 3000 });
    // Berlin days: 1 July 00:00 CEST is 30 June 22:00 UTC, the end is the start of the following day.
    expect(asked[0]!.since.toISOString()).toBe("2026-06-30T22:00:00.000Z");
    expect(asked[0]!.before.toISOString()).toBe("2026-10-13T22:00:00.000Z");
    expect(seen[0]?.job).toBe("compute");
    const { code, files } = unpack(seen[0]!.input);
    expect(code).toMatch(/^import json as _json\n_DATA = \{"mail_gmx":"[0-9a-f]{16}","calendar":"[0-9a-f]{16}"\}\ndef load\(name\):/);
    expect(code.endsWith("print(len(load('mail_gmx')))")).toBe(true);
    const lines = [...files.values()].map((body) => body.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>));
    expect(lines[0]![0]).toMatchObject({ id: "gmx:7", account: "gmx", folder: "Spam" });
    expect(String(lines[0]![0]!["headers"])).toContain("Return-Path: <bounce@bulk-sender.example>");
    expect(lines[1]![0]).toMatchObject({ title: "Dentist", calendar: "Personal", declined: false });
    // Untrusted content: framed, the turn is tainted afterwards.
    expect(result.text).toContain("<untrusted");
    expect(result.text).toContain("mail_gmx: 1 rows, 2026-07-01 to 2026-10-13, spam");
    expect(turn.tainted).toBe(true);
  });

  it("lists the sources when one does not exist, and then computes nothing", async () => {
    const { sandbox, seen } = recording();
    const registry = setup([calendarSource(calendarStub())], sandbox);
    const result = await registry.execute("analyze_data", { inputs: [{ source: "mail_gmx" }], code: "print(1)" }, chat());
    expect(result.ok).toBe(false);
    expect(result.text).toContain("There is no source mail_gmx. There are: calendar (");
    expect(seen).toHaveLength(0);
  });

  it("mail only up to today, folders only for mail, at most one year", async () => {
    const { box } = headerBox([]);
    const registry = setup([mailSource(box, "mail_gmx")!, calendarSource(calendarStub())]);
    const run = (input: Record<string, unknown>) => registry.execute("analyze_data", { inputs: [input], code: "print(1)" }, chat());
    expect((await run({ source: "mail_gmx", to: "2026-10-20" })).text).toContain("only goes up to today");
    expect((await run({ source: "calendar", folder: "inbox" })).text).toContain("has no folders");
    expect((await run({ source: "mail_gmx", from: "2025-01-01" })).text).toContain("At most 366 days");
    expect((await run({ source: "mail_gmx", from: "2026-10-12", to: "2026-10-01" })).text).toContain("from is after to");
    // Events may lie in the future.
    expect((await run({ source: "calendar", from: "2026-10-13", to: "2026-12-31" })).ok).toBe(true);
  });

  it("the same source twice is called name and name_2 in the program", async () => {
    const { box } = headerBox([]);
    const { sandbox, seen } = recording();
    const registry = setup([mailSource(box, "mail_gmx")!], sandbox);
    await registry.execute("analyze_data", { inputs: [{ source: "mail_gmx", folder: "junk" }, { source: "mail_gmx", folder: "inbox" }], code: "print(1)" }, chat());
    expect(unpack(seen[0]!.input).code).toMatch(/"mail_gmx":"[0-9a-f]{16}","mail_gmx_2":"[0-9a-f]{16}"/);
  });

  it("a mailbox without exportHeaders is no source", () => {
    expect(mailSource({ id: "x", address: "x@example.org" } as unknown as MailAccount, "mail_x")).toBeNull();
  });

  it("a failing source says which one, instead of computing with half the data", async () => {
    const { sandbox, seen } = recording();
    const broken: DataSource = { name: "bank", fields: "transactions", load: async () => Promise.reject(new Error("The consent at the bank has expired.")) };
    const registry = setup([broken], sandbox);
    const result = await registry.execute("analyze_data", { inputs: [{ source: "bank" }], code: "print(1)" }, chat());
    expect(result.ok).toBe(false);
    expect(result.text).toContain("bank could not be loaded: The consent at the bank has expired.");
    expect(seen).toHaveLength(0);
  });

  it.skipIf(!python)("real Python: the sandbox entry program finds the data via load()", async () => {
    const rows = [1, 2, 3].map((n) => ({ providerId: String(n), folder: "Spam", date: `2026-10-0${n}T08:00:00.000Z`, headers: SPAM_HEAD(n, n === 3 ? "alex+shop@example.org" : "alex@example.org") }));
    const { box } = headerBox(rows);
    const registry = setup([mailSource(box, "mail_gmx")!], localPython());
    const code = [
      "from email.parser import HeaderParser",
      "from collections import Counter",
      "rows = load('mail_gmx')",
      "to = Counter(HeaderParser().parsestr(r['headers'])['To'] for r in rows)",
      "rp = Counter(HeaderParser().parsestr(r['headers'])['Return-Path'] for r in rows)",
      "print(sorted(to.items()))",
      "print(rp.most_common(1))",
    ].join("\n");
    const result = await registry.execute("analyze_data", { inputs: [{ source: "mail_gmx", folder: "junk" }], code }, chat());
    expect(result.ok).toBe(true);
    expect(result.text).toContain("[('alex+shop@example.org', 1), ('alex@example.org', 2)]");
    expect(result.text).toContain("[('<bounce@bulk-sender.example>', 3)]");
  });
});

describe("IMAP: headers in bulk (D63, building block D)", () => {
  /** Two folders with mails on different days; `headers: true` returns the whole header. */
  function server() {
    const boxes = {
      INBOX: [
        { uid: 10, day: 5 },
        { uid: 11, day: 12 },
      ],
      Spam: [
        { uid: 3, day: 11 },
        { uid: 4, day: 2 },
      ],
    } as Record<string, Array<{ uid: number; day: number }>>;
    let selected = "";
    const fetched: Array<{ folder: string; uids: number[]; fields: string[] }> = [];
    const searches: Array<Record<string, unknown>> = [];
    const client = {
      usable: true,
      on: () => undefined,
      connect: async () => undefined,
      list: async () => [
        { path: "INBOX", flags: new Set<string>() },
        { path: "Spam", specialUse: "\\Junk", flags: new Set<string>() },
      ],
      getMailboxLock: async (path: string) => {
        selected = path;
        return { release: () => undefined };
      },
      search: async (criteria: Record<string, unknown>) => {
        searches.push(criteria);
        return (boxes[selected] ?? []).map((mail) => mail.uid);
      },
      fetchAll: async (uids: number[], query: Record<string, unknown>) => {
        fetched.push({ folder: selected, uids: [...uids], fields: Object.keys(query) });
        return uids.map((uid) => {
          const mail = boxes[selected]!.find((entry) => entry.uid === uid)!;
          const padding = uid === 3 ? `X-Long: ${"a".repeat(DATA_MAIL_HEADER_MAX_BYTES)}\r\n` : "";
          return {
            uid,
            internalDate: new Date(Date.UTC(2026, 9, mail.day, 8)),
            headers: Buffer.from(`Received: from relay [198.51.100.${uid}]\r\nFrom: a${uid}@example.net\r\n${padding}\r\n`),
          };
        });
      },
    };
    return { fetched, searches, create: () => client as unknown as ImapFlow };
  }

  it("never asks for an end in the future: GMX turns that into \"older than 0 s\" with WITHIN (live finding 2026-10-13)", async () => {
    const fake = server();
    const box = imapAccount("gmx", "alex@example.org", { imapHost: "imap.gmx.net", imapPort: 993, smtpHost: "mail.gmx.net", smtpPort: 465, user: "u", password: "p" } as never, fake.create);
    const since = new Date(Date.now() - 30 * 86_400_000);
    await box.exportHeaders!({ folder: "inbox", since, before: new Date(Date.now() + 3_600_000), max: 10 });
    await box.exportHeaders!({ folder: "inbox", since, before: new Date(), max: 10 });
    expect(fake.searches).toEqual([{ since }, { since }]);
    const before = new Date(Date.now() - 86_400_000);
    await box.exportHeaders!({ folder: "inbox", since, before, max: 10 });
    expect(fake.searches[2]).toEqual({ since, before });
  });

  it("fetches the newest across all folders, only within the period, only headers, and truncates long headers", async () => {
    const fake = server();
    const box = imapAccount("gmx", "alex@example.org", { imapHost: "imap.gmx.net", imapPort: 993, smtpHost: "mail.gmx.net", smtpPort: 465, user: "u", password: "p" } as never, fake.create);
    const { rows, truncated } = await box.exportHeaders!({ folder: "all", since: new Date(Date.UTC(2026, 9, 3)), before: new Date(Date.UTC(2026, 9, 12)), max: 2 });
    // Within the period are uid 10 (5th) and spam uid 3 (11th); the 12th and the 2nd are not. Both fit into max 2.
    expect(rows.map((row) => [row.folder, row.providerId.split("-").pop()])).toEqual([
      ["Spam", "3"],
      ["Inbox", "10"],
    ]);
    expect(truncated).toBe(false);
    expect(rows[0]!.headers.length).toBeLessThanOrEqual(DATA_MAIL_HEADER_MAX_BYTES);
    expect(rows[1]!.headers).toContain("Received: from relay [198.51.100.10]");
    // Body and attachments are never fetched.
    expect(fake.fetched.flatMap((call) => call.fields)).not.toContain("source");
    const limited = await box.exportHeaders!({ folder: "all", since: new Date(Date.UTC(2026, 9, 3)), before: new Date(Date.UTC(2026, 9, 12)), max: 1 });
    expect(limited.rows).toHaveLength(1);
    expect(limited.truncated).toBe(true);
  });
});
