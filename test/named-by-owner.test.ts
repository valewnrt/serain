import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
vi.mock("../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown>) => void audits.push({ event, detail }),
}));

const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState, defineTool } = await import("../src/agent/tools/types.js");
const { ownerNamedSenders } = await import("../src/mail/cleanup.js");
const { ownerNamedEvent } = await import("../src/calendar/named.js");
const { calendarTools } = await import("../src/agent/tools/calendar.js");
type CalendarEntry = import("../src/calendar/types.js").CalendarEntry;
type TurnOrigin = import("../src/agent/tools/types.js").TurnOrigin;

/**
 * No preview when the owner asked for it themselves (addendum D8 of 2026-10-03).
 * The registry does not judge the words, the tool proves them; the registry
 * makes sure the proof only comes from the owner's own text.
 */

const turn = (origin: TurnOrigin, ownerWords?: string) =>
  new TurnState({ origin, triggerExternalId: "x1", triggerMessageId: "m1", reactableIds: [], ...(ownerWords !== undefined ? { ownerWords } : {}) });

function setup(level: "irreversible" | "money" = "irreversible") {
  const ran: string[] = [];
  const previews: string[] = [];
  const registry = new ToolRegistry({
    covered: async () => false,
    request: async (_def, _level, args) => {
      previews.push(String(args["sender"]));
      return { ok: true, text: "waiting for Alex" };
    },
  }).register(
    defineTool({
      name: "unsubscribe",
      description: "test",
      level,
      schema: { sender: z.string() },
      confirm: {
        preview: (args) => `unsubscribe: ${args.sender}`,
        undo: () => "not possible",
        namedByOwner: (args, ownerWords) => (ownerWords.toLowerCase().includes(args.sender) ? args.sender : null),
      },
      async run(args) {
        ran.push(args.sender);
        return { ok: true, text: "unsubscribed" };
      },
    }),
  );
  return { registry, ran, previews };
}

describe("No preview when Alex named it themselves (addendum D8)", () => {
  it("runs directly when the tool proves it from Alex's words, also after untrusted content, and is in the audit", async () => {
    const { registry, ran, previews } = setup();
    const state = turn("owner_message", "melde mich vom Kelvo newsletter ab");
    state.taint("mailbox");
    audits.length = 0;
    const result = await registry.execute("unsubscribe", { sender: "kelvo" }, state);
    expect(result.text).toMatch(/^unsubscribed/);
    expect(ran).toEqual(["kelvo"]);
    expect(previews).toEqual([]);
    expect(audits.find((entry) => entry.event === "approval_waived")?.detail).toMatchObject({ tool: "unsubscribe", named_by_owner: "kelvo", tainted: true });
  });

  it("asks when Alex did not name the sender", async () => {
    const { registry, ran, previews } = setup();
    await registry.execute("unsubscribe", { sender: "shop" }, turn("owner_message", "räum mein postfach auf"));
    expect(ran).toEqual([]);
    expect(previews).toEqual(["shop"]);
  });

  it("never in a turn Alex did not trigger, even if someone repeats their words there", async () => {
    for (const origin of ["task", "heartbeat", "untrusted"] as const) {
      const { registry, ran, previews } = setup();
      await registry.execute("unsubscribe", { sender: "kelvo" }, turn(origin, "melde mich vom kelvo newsletter ab"));
      expect(ran).toEqual([]);
      expect(previews).toEqual(["kelvo"]);
    }
  });

  it("never for money", async () => {
    const { registry, ran, previews } = setup("money");
    await registry.execute("unsubscribe", { sender: "kelvo" }, turn("owner_message", "melde mich vom kelvo newsletter ab"));
    expect(ran).toEqual([]);
    expect(previews).toEqual(["kelvo"]);
  });
});

describe("Which senders Alex named (mail_cleanup)", () => {
  const kelvo = "no-reply_at_updates_kelvo_health_q1w2e3r4t5_9f8e7d6c@privaterelay.appleid.com";

  it("proves Kelvo from \"kelvo\" in Alex's message, also with capitals and a suffix", () => {
    expect(ownerNamedSenders([{ address: kelvo, action: "unsubscribe" }], "bitte melde mich vom kelvo newsletter ab")).toBe("kelvo");
    expect(ownerNamedSenders([{ address: "newsletter@mail.zalando.de", action: "unsubscribe" }], "Zalandos Mails nerven, abmelden")).toBe("zalandos");
    expect(
      ownerNamedSenders(
        [
          { address: "news@zalando.de", action: "unsubscribe" },
          { address: "info@about-you.de", action: "trash" },
        ],
        "melde mich bei zalando und about you ab",
      ),
    ).toBe("zalando, about");
  });

  it("proves nothing with common words or fragments", () => {
    expect(ownerNamedSenders([{ address: "news@shop.example", action: "unsubscribe" }], "melde mich von den news ab")).toBeNull();
    expect(ownerNamedSenders([{ address: "updates@kelvora.example", action: "unsubscribe" }], "melde mich von kelvo ab")).toBeNull();
    expect(ownerNamedSenders([{ address: kelvo, action: "unsubscribe" }], "melde mich von allen updates ab")).toBeNull();
  });

  it("asks as soon as one sender does not match, more than three or spam are among them", () => {
    expect(
      ownerNamedSenders(
        [
          { address: kelvo, action: "unsubscribe" },
          { address: "deals@ryanair.example", action: "unsubscribe" },
        ],
        "melde mich vom kelvo newsletter ab",
      ),
    ).toBeNull();
    expect(ownerNamedSenders([{ address: kelvo, action: "spam" }], "kelvo ist spam")).toBeNull();
    const four = ["aaaa", "bbbb", "cccc", "dddd"].map((name) => ({ address: `news@${name}.example`, action: "unsubscribe" as const }));
    expect(ownerNamedSenders(four, "aaaa bbbb cccc dddd abmelden")).toBeNull();
    expect(ownerNamedSenders([], "kelvo")).toBeNull();
  });
});

describe("Which event Alex named for deletion (calendar_delete)", () => {
  const award = { current_title: "Sommerfest-Finale", has_guests: false };

  it("proves the event from Alex's words, also written apart, with a typo or as …termin", () => {
    expect(ownerNamedEvent(award, "lösch das doppelte sommer festv")).toBe("sommerfest");
    expect(ownerNamedEvent(award, "kannst du das finale löschen")).toBe("finale");
    expect(ownerNamedEvent({ current_title: "Zahnarzt Dr. Weber", has_guests: false }, "Entferne den Zahnarzttermin")).toBe("zahnarzt");
    expect(ownerNamedEvent({ current_title: "Padel", has_guests: false }, "lösche padel morgen")).toBe("padel");
    expect(ownerNamedEvent(award, "lo\u0308sch den sommer fest")).toBe("sommerfest");
  });

  it("asks with guests, without a delete word, with common words or fragments", () => {
    expect(ownerNamedEvent({ ...award, has_guests: true }, "lösch das sommer fest")).toBeNull();
    expect(ownerNamedEvent(award, "wann ist der sommer fest?")).toBeNull();
    expect(ownerNamedEvent(award, "sag den sommer fest ab")).toBeNull();
    expect(ownerNamedEvent({ current_title: "Termin Meeting", has_guests: false }, "lösch das meeting")).toBeNull();
    expect(ownerNamedEvent({ current_title: "Mint", has_guests: false }, "lösch den termin")).toBeNull();
    expect(ownerNamedEvent({ current_title: "Sommerabend", has_guests: false }, "lösch das sommer fest")).toBeNull();
    expect(ownerNamedEvent({ current_title: "Padel", has_guests: false }, "bin auf dem weg zum padel, nimm mich raus")).toBeNull();
    expect(ownerNamedEvent({ current_title: "Padel", has_guests: false }, "wie ist die entfernung zum padel")).toBeNull();
    expect(ownerNamedEvent(award, "lösch das sommerfest bitte nicht")).toBeNull();
    expect(ownerNamedEvent(award, "lösch keinen sommer fest")).toBeNull();
    // Someone else's event named like a filler word is named by no message.
    expect(ownerNamedEvent({ current_title: "Bitte", has_guests: false }, "bitte lösch den zahnarzt")).toBeNull();
    expect(ownerNamedEvent({ current_title: "Kannst Nochmal", has_guests: false }, "kannst du den zahnarzt nochmal löschen")).toBeNull();
    expect(ownerNamedEvent({ current_title: "Löschen", has_guests: false }, "lösch den zahnarzt")).toBeNull();
  });
});

describe("calendar_delete through the registry", () => {
  const entry: CalendarEntry = { id: "event-award-1", title: "Sommerfest-Finale", start: "2026-10-20T18:00:00+02:00", end: "2026-10-20T20:00:00+02:00", allDay: false, location: "", guests: [], status: "confirmed", organizerSelf: true, declined: false };

  function calendarSetup(entries: CalendarEntry[]) {
    const removed: string[] = [];
    const previews: string[] = [];
    const registry = new ToolRegistry({
      covered: async () => false,
      request: async (def, _level, args) => {
        previews.push(await def.confirm!.preview(args));
        return { ok: true, text: "waiting for Alex" };
      },
    }).registerAll(
      calendarTools({
        label: "Alex's iCloud calendar",
        invites: false,
        deleteUndo: "Papierkorb.",
        list: async () => ({ entries, truncated: false }),
        get: async (id) => entries.find((candidate) => candidate.id === id) ?? null,
        create: async () => entry,
        update: async () => entry,
        remove: async (id) => void removed.push(id),
      }),
    );
    return { registry, removed, previews };
  }

  it("deletes at once and only wants a 👍 when Alex named the event", async () => {
    const { registry, removed, previews } = calendarSetup([entry]);
    audits.length = 0;
    const result = await registry.execute("calendar_delete", { event_id: "event-award-1", current_title: "Sommerfest-Finale", has_guests: false }, turn("owner_message", "lösch das doppelte sommer festv"));
    expect(removed).toEqual(["event-award-1"]);
    expect(previews).toEqual([]);
    expect(result.text).toContain("👍");
    expect(audits.find((item) => item.event === "approval_waived")?.detail).toMatchObject({ tool: "calendar_delete", named_by_owner: "sommerfest" });
  });

  it("asks when the event actually has guests, even if the model hides has_guests", async () => {
    const { registry, removed } = calendarSetup([{ ...entry, guests: ["anna@example.org"] }]);
    const result = await registry.execute("calendar_delete", { event_id: "event-award-1", current_title: "Sommerfest-Finale", has_guests: false }, turn("owner_message", "lösch das sommer fest"));
    expect(removed).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("asks when Alex named a different event", async () => {
    const { registry, removed, previews } = calendarSetup([entry]);
    await registry.execute("calendar_delete", { event_id: "event-award-1", current_title: "Sommerfest-Finale", has_guests: false }, turn("owner_message", "lösch den zahnarzt"));
    expect(removed).toEqual([]);
    expect(previews).toEqual(["Soll ich „Sommerfest-Finale“ löschen?"]);
  });
});

describe("Which login Alex named (run_site_task, web_form)", () => {
  it("proves the vault name as a whole word, from four characters", async () => {
    const { ownerNamedSite } = await import("../src/sites/named.js");
    expect(ownerNamedSite("bahn", "schau mal bei der Bahn nach meiner buchung")).toBe("bahn");
    expect(ownerNamedSite("bahn", "wann fährt die bahncard ab")).toBeNull();
    expect(ownerNamedSite("db", "schau bei db nach")).toBeNull();
    expect(ownerNamedSite("bahn", "schau nach meiner buchung")).toBeNull();
  });
});
