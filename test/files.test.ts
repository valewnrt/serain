import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));

const ICAL = (await import("ical.js")).default;
const { buildIcs } = await import("../src/files/ics.js");
const { buildVcard, foldLine } = await import("../src/files/vcard.js");
const { buildPdf, winAnsi, wrap } = await import("../src/files/pdf.js");
const { cleanFileName, formatSize } = await import("../src/files/name.js");
const { installTranslations } = await import("../src/i18n/catalog.js");
const { ownerLanguage } = await import("../src/i18n/language.js");
const { fileTools, fileName } = await import("../src/agent/tools/files.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
type OutboundFile = import("../src/channel/types.js").OutboundFile;

const NOW = new Date("2026-10-05T10:00:00Z");

/** Runs `work` while the owner's current language is `lang`. */
function inLanguage<T>(lang: string, work: () => T): T {
  const spy = vi.spyOn(ownerLanguage, "current", "get").mockReturnValue(lang);
  try {
    return work();
  } finally {
    spy.mockRestore();
  }
}

describe(".ics: an event to tap", () => {
  it("converts local wall time to UTC and escapes text", () => {
    const built = buildIcs(
      { title: "Zahnarzt; Dr. Beispiel, Kontrolle", start: "2026-10-27 10:00", location: "Musterstraße 1, Musterstadt", description: "Zeile 1\nZeile 2" },
      { uid: "u1@serain", now: NOW },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const text = built.body.toString("utf8");
    expect(text).toContain("\r\n");
    // After the clock change (25.10.) UTC+1 applies.
    expect(text).toContain("DTSTART:20261027T090000Z");
    expect(text).toContain("DTEND:20261027T100000Z");
    // The same library Serain writes to iCloud with: comma escaped, round trip lossless.
    expect(text).toContain("Dr. Beispiel\\, Kontrolle");
    const parsed = new ICAL.Event(new ICAL.Component(ICAL.parse(text) as unknown[]).getFirstSubcomponent("vevent")!);
    expect(parsed.summary).toBe("Zahnarzt; Dr. Beispiel, Kontrolle");
    expect(parsed.description).toBe("Zeile 1\nZeile 2");
  });

  it("all day with an exclusive end, and checks the times", () => {
    const built = buildIcs({ title: "Urlaub", start: "2026-10-12", end: "2026-10-16" }, { uid: "u2", now: NOW });
    expect(built.ok && built.body.toString()).toContain("DTEND;VALUE=DATE:20261017");
    expect(buildIcs({ title: "x", start: "Montag" }, { uid: "u", now: NOW })).toEqual({ ok: false, reason: "start is neither YYYY-MM-DD HH:mm nor YYYY-MM-DD." });
    expect(buildIcs({ title: "x", start: "Montag" }, { uid: "u", now: NOW }).ok).toBe(false);
    expect(buildIcs({ title: "x", start: "2026-10-12 10:00", end: "2026-10-12 09:00" }, { uid: "u", now: NOW }).ok).toBe(false);
    expect(buildIcs({ title: "x", start: "2026-10-12", end: "2026-10-11" }, { uid: "u", now: NOW }).ok).toBe(false);
  });

  it("writes the caption in the owner's language, the dates stay as given", () => {
    const caption = (lang: string, end?: string) =>
      inLanguage(lang, () => {
        const built = buildIcs({ title: "Urlaub", start: "2026-10-12", ...(end ? { end } : {}) }, { uid: "u3", now: NOW });
        return built.ok ? built.summary : built.reason;
      });
    expect(caption("de")).toBe("2026-10-12, ganztägig");
    expect(caption("de", "2026-10-16")).toBe("2026-10-12 bis 2026-10-16, ganztägig");
    expect(caption("en")).toBe("2026-10-12, all day");
    expect(caption("en", "2026-10-16")).toBe("2026-10-12 to 2026-10-16, all day");
    expect(installTranslations("tr", { "{day}, all day": "{day}, tüm gün", "{from} to {to}, all day": "{from} ile {to} arası, tüm gün" })).toEqual([]);
    expect(caption("tr", "2026-10-16")).toBe("2026-10-12 ile 2026-10-16 arası, tüm gün");
    // Without a translation: English.
    expect(caption("ja")).toBe("2026-10-12, all day");
  });
});

describe("file names and sizes", () => {
  it("writes sizes in the number format of the locale, English by default", () => {
    expect(formatSize(857)).toBe("857 B");
    expect(formatSize(12 * 1024)).toBe("12 KB");
    expect(formatSize(1023 * 1024)).toBe("1023 KB");
    expect(formatSize(1_258_291)).toBe("1.2 MB");
    expect(formatSize(1_258_291, "de")).toBe("1,2 MB");
    expect(formatSize(1_258_291, "de-AT")).toBe("1,2 MB");
    expect(formatSize(1_258_291, "tr")).toBe("1,2 MB");
    expect(formatSize(2_000 * 1024 * 1024, "en")).toBe("2000.0 MB");
  });

  it("gives a file without a name the caller's fallback, else an English one", () => {
    expect(cleanFileName("", "application/pdf")).toBe("document.pdf");
    expect(cleanFileName("  ", "image/png")).toBe("file");
    expect(cleanFileName("", "application/pdf", "Dokument.pdf")).toBe("Dokument.pdf");
    expect(cleanFileName("a/b/Rechnung.pdf", "application/pdf", "Dokument.pdf")).toBe("Rechnung.pdf");
  });
});

describe("vCard", () => {
  it("builds a vCard 3.0 with escaped fields and folded lines", () => {
    const text = buildVcard({ name: "Jana Maria Müller", phones: ["+49 151 0000000"], emails: ["jana@example.org"], org: "Praxis; Beispiel", note: "x".repeat(200) }).toString("utf8");
    expect(text).toMatch(/^BEGIN:VCARD\r\nVERSION:3.0\r\nN:Müller;Jana Maria;;;\r\nFN:Jana Maria Müller\r\n/);
    expect(text).toContain("ORG:Praxis\\; Beispiel");
    expect(text).toContain("TEL;TYPE=CELL:+49 151 0000000");
    for (const line of text.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });

  it("never folds in the middle of a character", () => {
    const folded = foldLine(`NOTE:${"ä".repeat(80)}`);
    expect(folded.split("\r\n ").join("")).toBe(`NOTE:${"ä".repeat(80)}`);
    for (const part of folded.split("\r\n")) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
  });
});

describe("PDF", () => {
  it("encodes umlauts, € and typographic characters as WinAnsi, the rest as ?", () => {
    expect(["ä", "ß", "€", "„", "–", "🙂", "Ж"].map(winAnsi)).toEqual([0xe4, 0xdf, 0x80, 0x84, 0x96, 63, 63]);
  });

  it("breaks by width and an overlong word hard", () => {
    const lines = wrap([...Buffer.from("aaa bbb ccc", "latin1")], 10, 40);
    expect(lines.map((line) => Buffer.from(line).toString("latin1"))).toEqual(["aaa bbb", "ccc"]);
    expect(wrap([...Buffer.from("x".repeat(100), "latin1")], 10, 50).length).toBeGreaterThan(1);
  });

  it("yields a PDF a real parser reads, with parentheses, backslash and page break", () => {
    const text = Array.from({ length: 150 }, (_, i) => `Zeile ${i}: (Klammer) \\ Größe 12,50 €`).join("\n");
    const pdf = buildPdf({ title: "Prüfbericht", text, maxPages: 20 });
    expect(pdf.pages).toBeGreaterThan(2);
    expect(pdf.body.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    let poppler = true;
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    } catch {
      poppler = false;
    }
    if (!poppler) return;
    const dir = mkdtempSync(join(tmpdir(), "serain-pdf-"));
    try {
      writeFileSync(join(dir, "t.pdf"), pdf.body);
      const extracted = execFileSync("pdftotext", [join(dir, "t.pdf"), "-"], { encoding: "utf8" });
      expect(extracted).toContain("Prüfbericht");
      expect(extracted).toContain("Zeile 149: (Klammer) \\ Größe 12,50 €");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cuts off after the page limit and says so", () => {
    const pdf = buildPdf({ text: "Zeile\n".repeat(2_000), maxPages: 3 });
    expect(pdf).toMatchObject({ pages: 3, truncated: true });
  });
});

describe("send_file", () => {
  const turn = (taint: string[] = []) =>
    new TurnState({ origin: "owner_message", triggerExternalId: "x", triggerMessageId: "m", reactableIds: [], taintSources: taint });

  function setup(ok = true) {
    const sent: Array<{ file: OutboundFile; caption: string; taint: readonly string[] }> = [];
    const registry = new ToolRegistry().registerAll(
      fileTools({ sendFile: async (file, caption, opts) => (sent.push({ file, caption, taint: opts.taintSources }), ok) }),
    );
    return { registry, sent };
  }

  it("builds the file from fields and passes the turn's provenance along", async () => {
    const { registry, sent } = setup();
    const result = await registry.execute("send_file", { kind: "ics", event: { title: "Zahnarzt Dr. Beispiel", start: "2026-10-27 10:00" } }, turn(["Alex' Posteingang"]));
    expect(result).toMatchObject({ ok: true, text: "Zahnarzt Dr. Beispiel.ics is out." });
    expect(sent[0]?.file.mimeType).toBe("text/calendar");
    expect(sent[0]?.caption).toBe("Zahnarzt Dr. Beispiel, 2026-10-27 10:00");
    expect(sent[0]?.taint).toEqual(["Alex' Posteingang"]);
    const card = await registry.execute("send_file", { kind: "vcard", contact: { name: "Jana Müller", phones: ["+49 151 0000000"] } }, turn());
    expect(card.ok).toBe(true);
    expect(sent[1]?.file.name).toBe("Jana Müller.vcf");
    const pdf = await registry.execute("send_file", { kind: "pdf", title: "Packliste", text: "• Pass\n• Ladekabel" }, turn());
    expect(pdf.ok).toBe(true);
    expect(sent[2]?.file.body.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("requires the fields of the kind and says when the channel refuses", async () => {
    const { registry, sent } = setup();
    expect((await registry.execute("send_file", { kind: "ics", contact: { name: "x" } }, turn())).ok).toBe(false);
    expect((await registry.execute("send_file", { kind: "pdf", event: { title: "x", start: "2026-10-27" } }, turn())).ok).toBe(false);
    expect((await registry.execute("send_file", { kind: "ics", event: { title: "x", start: "morgen" } }, turn())).ok).toBe(false);
    expect(sent).toHaveLength(0);
    const refused = setup(false);
    const result = await refused.registry.execute("send_file", { kind: "pdf", text: "Hallo" }, turn());
    expect(result.ok).toBe(false);
    expect(result.text).toContain("as text");
  });

  it("sends a PDF of the task unchanged as a file, in the thread and up to 10 MB (2026-10-09)", async () => {
    const sent: Array<{ file: OutboundFile; replyTo?: string; maxBytes?: number; kind: string }> = [];
    const registry = new ToolRegistry().registerAll(
      fileTools({
        sendFile: async (file, _caption, opts) => (sent.push({ file, kind: opts.kind, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}), ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) }), true),
      }),
    );
    const pdf = Buffer.from("%PDF-1.4 karte");
    const withDocs = new TurnState({
      origin: "task",
      triggerExternalId: "m-frage",
      triggerMessageId: "m",
      reactableIds: [],
      taintSources: ["executor"],
      documents: [{ id: "d1", url: "https://www.mondkorn.example/menu/menu_25_06_2026_1.pdf", name: "menu_25_06_2026_1", pdf }],
    });
    const result = await registry.execute("send_file", { kind: "document", document: "d1" }, withDocs);
    expect(result).toMatchObject({ ok: true, text: "menu_25_06_2026_1.pdf is out." });
    expect(sent).toEqual([{ file: { name: "menu_25_06_2026_1.pdf", mimeType: "application/pdf", body: pdf }, kind: "document", replyTo: "m-frage", maxBytes: 10_000_000 }]);
    const missing = await registry.execute("send_file", { kind: "document", document: "d2" }, withDocs);
    expect(missing).toMatchObject({ ok: false, text: "This PDF does not exist. There are: d1." });
    expect((await registry.execute("send_file", { kind: "document", document: "d1" }, turn())).ok).toBe(false);
    // Short enough: an image per page instead of a PDF.
    sent.length = 0;
    const pages = new TurnState({
      origin: "task",
      triggerExternalId: "m-frage",
      triggerMessageId: "m",
      reactableIds: [],
      documents: [{ id: "d1", url: "https://x.example/karte.pdf", name: "karte", pdf, pages: [Buffer.from("s1"), Buffer.from("s2")] }],
    });
    const shown = await registry.execute("send_file", { kind: "document", document: "d1" }, pages);
    expect(shown).toMatchObject({ ok: true, text: "karte Seite 1.jpg is out. As an image per page (2 of 2), not as a PDF." });
    expect(sent.map((entry) => [entry.file.name, entry.file.mimeType])).toEqual([["karte Seite 1.jpg", "image/jpeg"], ["karte Seite 2.jpg", "image/jpeg"]]);
  });

  it("sends only a screenshot of this task, with a caption from the code and in the thread (D48 addendum of 2026-10-08)", async () => {
    const sent: Array<{ file: OutboundFile; caption: string; replyTo?: string }> = [];
    const registry = new ToolRegistry().registerAll(
      fileTools({ sendFile: async (file, caption, opts) => (sent.push({ file, caption, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) }), true) }),
    );
    const shots = [
      { id: "s1", jpeg: Buffer.from("jpeg-web"), origin: "web" as const, label: "bahn.de", shows: "Sa, 24.10. — Termine frei (ausgewählt) 14:00 bis 14:40 Uhr" },
      { id: "s2", jpeg: Buffer.from("jpeg-site"), origin: "site" as const, label: "amazon" },
    ];
    const state = new TurnState({ origin: "task", triggerExternalId: "q-1", triggerMessageId: "m", reactableIds: [], taintSources: ["Bericht"], screenshots: shots });
    expect((await registry.execute("send_file", { kind: "screenshot", screenshot: "s2" }, state)).ok).toBe(true);
    expect(sent[0]).toEqual({ file: { name: "Screenshot amazon.jpg", mimeType: "image/jpeg", body: shots[1]!.jpeg }, caption: "Screenshot bei amazon", replyTo: "q-1" });
    // For a public page the history says what the image shows (live 2026-10-09: Serain checked other days than the ones in it).
    expect((await registry.execute("send_file", { kind: "screenshot", screenshot: "s1" }, state)).ok).toBe(true);
    expect(sent[1]?.caption).toBe("Screenshot von bahn.de, zeigt: Sa, 24.10. — Termine frei (ausgewählt) 14:00 bis 14:40 Uhr");
    const unknown = await registry.execute("send_file", { kind: "screenshot", screenshot: "s9" }, state);
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("s1, s2");
    const none = await registry.execute("send_file", { kind: "screenshot", screenshot: "s1" }, turn());
    expect(none.text).toContain("no screenshot");
    expect(sent).toHaveLength(2);
  });

  it("turns every name into a harmless file name", () => {
    expect(fileName("../../etc/passwd", "pdf")).toBe("etc-passwd.pdf");
    expect(fileName("Rechnung: März/2026", "pdf")).toBe("Rechnung- März-2026.pdf");
    expect(fileName("   ", "ics")).toBe("serain.ics");
    expect(fileName("a\u0000b\nc", "vcard")).toBe("a-b-c.vcf");
  });

  it("exists only when the channel can send files", () => {
    expect(fileTools(null)).toEqual([]);
  });
});
