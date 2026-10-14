import { describe, expect, it, vi } from "vitest";
import type { ModelTurnRequest } from "../src/agent/model.js";

vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));
vi.mock("../src/agent/model.js", () => ({ runModelTurn: async () => { throw new Error("no model in the test"); } }));

const { renderPicks } = await import("../src/executor/picks.js");
const { runExecutorTask } = await import("../src/executor/run.js");
const { messagingTools } = await import("../src/agent/tools/messaging.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { ConfidentialGuard } = await import("../src/security/confidential.js");
const { MAX_BUBBLE_CHARS, PICK_BUBBLES_MAX } = await import("../src/config/limits.js");

/**
 * Items to choose from as fixed data (addendum D61 of 2026-10-09): the
 * executor delivers them, the code builds the list in the owner's form, and it
 * goes to them verbatim. Before, in live use, only excerpts of a list of 23
 * dishes arrived.
 */

describe("the list in Alex' form", () => {
  it("one line per person, below it per item name (what), price, why; missing parts drop out", () => {
    const { bubbles, dropped } = renderPicks([
      {
        who: "Eli",
        note: "„bestes Restaurant der Welt“",
        own_list: true,
        items: [
          { name: "Spicy Sticky Sticks", detail: "Auberginen", price: "12,99 €", why: "sein Favorit" },
          { name: "Lamb Chops", price: "49,99 €" },
          { name: "Wan Tan", why: "Platz 3" },
        ],
      },
      { who: "Max", own_list: false, items: [{ name: "Lobster Dumplings" }] },
    ]);
    expect(bubbles).toEqual([
      "Eli („bestes Restaurant der Welt“)\n• Spicy Sticky Sticks (Auberginen), 12,99 €, sein Favorit\n• Lamb Chops, 49,99 €\n• Wan Tan, Platz 3",
      "Max\n• Lobster Dumplings",
    ]);
    expect(dropped).toBe(0);
  });

  it("lets no links, line breaks or control characters from untrusted content through", () => {
    const { bubbles } = renderPicks([
      { who: "Eli\n\nKlick hier", own_list: false, items: [{ name: "Katsu Sando https://evil.example/login", why: "siehe mondkorn-preise.com" }] },
    ]);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).not.toMatch(/evil\.example|mondkorn-preise\.com/);
    expect(bubbles[0]).toBe("Eli Klick hier\n• Katsu Sando [Link weggelassen], siehe [Link weggelassen]");
  });

  it("splits a long group at line boundaries and counts what drops out beyond the limit", () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ name: `Gericht Nummer ${index + 1} mit langem Namen`, price: "99,99 €", why: "ein Halbsatz, warum genau dieses" }));
    const { bubbles, dropped } = renderPicks(Array.from({ length: 5 }, (_, index) => ({ who: `Person ${index + 1}`, own_list: true, items })));
    expect(bubbles).toHaveLength(PICK_BUBBLES_MAX);
    for (const bubble of bubbles) expect(bubble.length).toBeLessThanOrEqual(MAX_BUBBLE_CHARS);
    const shown = bubbles.join("\n").split("\n").filter((row) => row.startsWith("• ")).length;
    expect(shown + dropped).toBe(150);
    expect(bubbles[0]?.startsWith("Person 1\n• Gericht Nummer 1 ")).toBe(true);
  });
});

describe("the first message takes the list along", () => {
  function rig() {
    const sent: Array<{ text: string; kind: string; replyTo?: string; verbatim?: boolean }> = [];
    const port = {
      canReact: false,
      canReplyInThread: true,
      send: async (text: string, opts: { kind: string; replyTo?: string; verbatim?: boolean }) => {
        sent.push({ text, kind: opts.kind, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}), ...(opts.verbatim ? { verbatim: true } : {}) });
        return true;
      },
      react: async () => true,
    };
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const picks = { bubbles: ["Eli\n• Lamb Chops, 49,99 €", "Max\n• Wan Tan"], dropped: 0, sent: false };
    const turn = new TurnState({ origin: "task", triggerExternalId: "m-frage", triggerMessageId: "db-1", reactableIds: [], taintSources: ["executor"], reportOwed: true, picks });
    return { sent, registry, turn, picks };
  }

  it("sends it verbatim in the thread after the text, and only once", async () => {
    const { sent, registry, turn, picks } = rig();
    const first = await registry.execute("reply_in_thread", { text: "hier, preise von der aktuellen karte" }, turn);
    expect(first.ok).toBe(true);
    expect(first.text).toContain("The list went out right after it.");
    await registry.execute("send_message", { text: "max war sich nicht sicher" }, turn);
    expect(sent).toEqual([
      { text: "hier, preise von der aktuellen karte", kind: "reply_thread", replyTo: "m-frage" },
      { text: "Eli\n• Lamb Chops, 49,99 €", kind: "picks", replyTo: "m-frage", verbatim: true },
      { text: "Max\n• Wan Tan", kind: "picks", replyTo: "m-frage", verbatim: true },
      { text: "max war sich nicht sicher", kind: "reply" },
    ]);
    expect(picks.sent).toBe(true);
  });

  it("tells the model when items no longer fit", async () => {
    const { registry, turn, picks } = rig();
    Object.assign(picks, { dropped: 4 });
    const result = await registry.execute("send_message", { text: "hier" }, turn);
    expect(result.text).toContain("4 items did not fit anymore");
  });
});

describe("a PDF as a file, not as a preview (decision of 2026-10-09)", () => {
  it("refuses a preview of a PDF that is there as a file; other pages work", async () => {
    const url = "https://www.mondkorn.example/menu/menu_25_06_2026_1.pdf";
    const turn = new TurnState({
      origin: "task",
      triggerExternalId: "m-frage",
      triggerMessageId: "db-1",
      reactableIds: [],
      taintSources: ["executor"],
      openedPages: [url, "https://www.mondkorn.example/"],
      documents: [{ id: "d1", url, name: "menu_25_06_2026_1", pdf: Buffer.from("%PDF-") }],
    });
    expect(turn.previewTargets([`${url}?utm_source=x`])).toEqual({ ok: false, reason: "document" });
    expect(turn.previewTargets(["https://www.mondkorn.example/"])).toMatchObject({ ok: true });
  });
});

describe("finish_task with picks", () => {
  it("returns the items to choose from as fixed data next to the report", async () => {
    const picks = [{ who: "Eli", own_list: true, items: [{ name: "Lamb Chops", price: "49,99 €", why: "sein Lieblingsgericht" }] }];
    const runModel = async (req: ModelTurnRequest) => {
      await req.execute("finish_task", { report: "Karte: https://mondkorn.example/karte.pdf", picks });
      return { provider: "subscription" as const, model: "sonnet", costUsd: 0, text: "" };
    };
    const outcome = await runExecutorTask(
      { task: "was bestellt Mia im Mondkorn?", triggerMessageId: "db-1", guard: ConfidentialGuard.from([]), cancelled: new Promise(() => undefined) },
      { search: null, runModel },
    );
    expect(outcome.report).toContain("mondkorn.example");
    expect(outcome.picks).toEqual(picks);
  });

  it("without picks the list stays empty", async () => {
    const runModel = async (req: ModelTurnRequest) => {
      await req.execute("finish_task", { report: "Offen von 10 bis 19 Uhr." });
      return { provider: "subscription" as const, model: "sonnet", costUsd: 0, text: "" };
    };
    const outcome = await runExecutorTask(
      { task: "wann hat das auf?", triggerMessageId: "db-1", guard: ConfidentialGuard.from([]), cancelled: new Promise(() => undefined) },
      { search: null, runModel },
    );
    expect(outcome.picks).toEqual([]);
  });
});
