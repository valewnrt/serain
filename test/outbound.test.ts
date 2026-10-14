import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, SendExtras, SendResult } from "../src/channel/types.js";

const auditMock = vi.fn(async () => undefined);

vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...(args as [])) }));
const stored: Array<{ body: string; taintSources: readonly string[]; editable: boolean; dedupe?: string; at: string }> = [];
/** What `recentOutboundFingerprints` returns; `null` means: database not readable. */
let recentRows: Array<{ fingerprint: string; at: string }> | null = [];
let storeFails = false;
interface EditableRow {
  id: string;
  external_id: string;
  body: string;
  created_at: string;
  taint_sources: string[];
  raw: Record<string, unknown>;
}
/** What `editableOutbound` returns: the database already filters by time and flag. */
let editableRows: EditableRow[] = [];
const edits: Array<{ id: string; body: string; raw: Record<string, unknown> }> = [];
vi.mock("../src/db/messages.js", () => ({
  storeOutbound: async (
    _channel: string,
    _to: string,
    body: string,
    _result: unknown,
    provenance: { taintSources: readonly string[] },
    meta: { editable?: boolean; dedupe?: string } = {},
  ) => {
    if (storeFails) throw new Error("Outbound message not saved: fetch failed");
    const at = new Date().toISOString();
    stored.push({ body, taintSources: provenance.taintSources, editable: meta.editable === true, ...(meta.dedupe ? { dedupe: meta.dedupe } : {}), at });
    return { id: "db-out", created_at: at };
  },
  recentOutboundFingerprints: async () => {
    if (recentRows === null) throw new Error("Recent messages not readable: fetch failed");
    return recentRows;
  },
  editableOutbound: async () => editableRows,
  storeEdit: async (id: string, body: string, raw: Record<string, unknown>) => {
    edits.push({ id, body, raw });
  },
}));

const { OutboundGate } = await import("../src/outbound.js");

interface FakeChannel extends Channel {
  sends: Array<{ text: string; replyTo?: string; extras?: SendExtras }>;
  reactions: Array<{ messageId: string; emoji: string }>;
  edited: Array<{ externalId: string; text: string }>;
}

function fakeChannel(
  options: { replyThreads?: boolean; reactions?: boolean; formatting?: boolean; effects?: boolean; edit?: boolean; files?: boolean; voice?: boolean; richLinks?: boolean; filesFail?: boolean } = {},
): FakeChannel {
  const sends: Array<{ text: string; replyTo?: string; extras?: SendExtras }> = [];
  const reactions: Array<{ messageId: string; emoji: string }> = [];
  const edited: Array<{ externalId: string; text: string }> = [];
  const result = (): SendResult => ({ externalId: `x-${sends.length}`, chatId: "c" });
  const channel: FakeChannel = {
    name: "fake",
    capabilities: {
      reactions: options.reactions ?? true,
      typing: true,
      readReceipts: true,
      replyThreads: options.replyThreads ?? false,
      attachments: false,
      formatting: options.formatting ?? false,
      effects: options.effects ?? false,
      edit: options.edit ?? false,
      files: options.files ?? false,
      voice: options.voice ?? false,
      richLinks: options.richLinks ?? false,
    },
    sends,
    reactions,
    edited,
    async start() {},
    async stop() {},
    isConnected: () => true,
    async waitUntilConnected() {},
    async send(_to, text, extras) {
      sends.push({ text, ...(extras && Object.keys(extras).length ? { extras } : {}) });
      return result();
    },
    async react(_to, messageId, emoji) {
      reactions.push({ messageId, emoji });
    },
    async typing() {},
    async markRead() {},
    async fetchAttachment() {
      throw new Error("no attachments");
    },
    onInbound() {},
    onReaction() {},
  };
  if (options.replyThreads) {
    channel.sendReply = async (_to, text, replyTo, extras) => {
      sends.push({ text, replyTo, ...(extras && Object.keys(extras).length ? { extras } : {}) });
      return result();
    };
  }
  if (options.edit) {
    channel.edit = async (externalId, text) => {
      edited.push({ externalId, text });
    };
  }
  if (options.files) {
    channel.sendFile = async (_to, file, replyTo) => {
      if (options.filesFail) throw new Error("Attachments not allowed for this project");
      sends.push({ text: `${file.voice ? "voice" : "file"}:${file.name}:${file.mimeType}:${file.body.length}`, ...(replyTo ? { replyTo } : {}) });
      return result();
    };
  }
  if (options.richLinks) {
    channel.sendRichLink = async (_to, url, replyTo) => {
      sends.push({ text: `link:${url}`, ...(replyTo ? { replyTo } : {}) });
      return result();
    };
  }
  return channel;
}

/** Sends and lets the minimum gap between bubbles pass meanwhile. */
async function send(
  gate: InstanceType<typeof OutboundGate>,
  text: string,
  options?: { replyTo?: string },
): Promise<boolean> {
  const promise = gate.sendToOwner(text, { kind: "test" }, options ?? {});
  await vi.runAllTimersAsync();
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  auditMock.mockClear();
  stored.length = 0;
  storeFails = false;
  recentRows = [];
  editableRows = [];
  edits.length = 0;
});

afterEach(() => vi.useRealTimers());

describe("OutboundGate", () => {
  it("stores every bubble with the origin of its text (D8.4)", async () => {
    const gate = new OutboundGate(fakeChannel(), "+49");
    const clean = gate.sendToOwner("von mir", { kind: "test" });
    await vi.runAllTimersAsync();
    await clean;
    const derived = gate.sendToOwner("aus der mail\n\nzweiter absatz", { kind: "test" }, { taintSources: ["Alex's inbox"] });
    await vi.runAllTimersAsync();
    await derived;
    expect(stored.map((entry) => entry.taintSources)).toEqual([[], ["Alex's inbox"], ["Alex's inbox"]]);
  });

  it("strips Markdown", async () => {
    const channel = fakeChannel();
    const gate = new OutboundGate(channel, "+4915100000000");
    await send(gate, "**wichtig**: `pnpm test`");
    expect(channel.sends[0]?.text).toBe("wichtig: pnpm test");
  });

  it("[D48] turns bold, italic and strikethrough into ranges when the channel can format", async () => {
    const channel = fakeChannel({ formatting: true });
    const gate = new OutboundGate(channel, "+49");
    await send(gate, "treffen um **15 uhr**, nicht ~~14~~");
    expect(channel.sends[0]).toEqual({
      text: "treffen um 15 uhr, nicht 14",
      extras: {
        styles: [
          { type: "bold", start: 11, length: 6 },
          { type: "strikethrough", start: 25, length: 2 },
        ],
      },
    });
    expect(stored[0]?.body).toBe("treffen um 15 uhr, nicht 14");
  });

  it("[addendum D23 of 2026-10-08] sends a value to copy verbatim, without formatting", async () => {
    const channel = fakeChannel({ formatting: true });
    const gate = new OutboundGate(channel, "+49");
    const sending = gate.sendToOwner("  ab_cd_ef **x**  ", { kind: "copy" }, { verbatim: true });
    await vi.runAllTimersAsync();
    await sending;
    expect(channel.sends).toEqual([{ text: "ab_cd_ef **x**" }]);
  });

  it("[D48] sends without ranges when the channel cannot format", async () => {
    const channel = fakeChannel();
    const gate = new OutboundGate(channel, "+49");
    await send(gate, "treffen um **15 uhr**");
    expect(channel.sends[0]).toEqual({ text: "treffen um 15 uhr" });
  });

  it("[D48] attaches the effect only to the first bubble and only when the channel can do it", async () => {
    const channel = fakeChannel({ effects: true });
    const gate = new OutboundGate(channel, "+49");
    const sending = gate.sendToOwner("alles gute!\n\nheute wird gefeiert", { kind: "test" }, { effect: "confetti" });
    await vi.runAllTimersAsync();
    await sending;
    expect(channel.sends.map((entry) => entry.extras)).toEqual([{ effect: "confetti" }, undefined]);
    expect(auditMock).toHaveBeenCalledWith("outbound", expect.objectContaining({ effect: "confetti" }), "db-out");

    const plain = fakeChannel();
    const sendingPlain = new OutboundGate(plain, "+49").sendToOwner("alles gute!", { kind: "test" }, { effect: "confetti" });
    await vi.runAllTimersAsync();
    await sendingPlain;
    expect(plain.sends[0]).toEqual({ text: "alles gute!" });
  });

  it("[D48] marks only explicitly editable messages as editable", async () => {
    const gate = new OutboundGate(fakeChannel(), "+49");
    await send(gate, "eine vorschau");
    const sending = gate.sendToOwner("eine antwort", { kind: "test" }, { editable: true });
    await vi.runAllTimersAsync();
    await sending;
    expect(stored.map((entry) => entry.editable)).toEqual([false, true]);
  });

  it("splits long replies into bubbles", async () => {
    const channel = fakeChannel();
    const gate = new OutboundGate(channel, "+4915100000000");
    await send(gate, "Erster Absatz.\n\nZweiter Absatz.\n\nDritter Absatz.");
    expect(channel.sends.map((entry) => entry.text)).toEqual([
      "Erster Absatz.",
      "Zweiter Absatz.",
      "Dritter Absatz.",
    ]);
  });

  it("does not send the same message twice in a row (W23)", async () => {
    const channel = fakeChannel();
    const gate = new OutboundGate(channel, "+4915100000000");
    expect(await send(gate, "Wann genau?")).toBe(true);
    expect(await send(gate, "wann   genau?")).toBe(false);
    expect(channel.sends).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledWith("outbound_duplicate", expect.anything());
  });

  describe("double send (the identical reply twice)", () => {
    it("lets two simultaneous identical messages out only once", async () => {
      const channel = fakeChannel();
      const gate = new OutboundGate(channel, "+49");
      // Both check before the first one reaches the channel: the minimum gap holds it up.
      const first = gate.trySendToOwner("Bin dran.", { kind: "test" });
      const second = gate.trySendToOwner("bin  dran.", { kind: "test" });
      await vi.runAllTimersAsync();
      expect((await first).status).toBe("sent");
      expect((await second).status).toBe("duplicate");
      expect(channel.sends).toHaveLength(1);
    });

    it("releases the block when nothing went out: the second attempt goes through", async () => {
      const channel = fakeChannel();
      const send = channel.send.bind(channel);
      let fail = true;
      channel.send = async (to, text, extras) => {
        if (fail) throw new Error("UNAVAILABLE");
        return send(to, text, extras);
      };
      const gate = new OutboundGate(channel, "+49");
      const failed = gate.trySendToOwner("Erinnerung: Müll raus", { kind: "test" });
      await vi.runAllTimersAsync();
      expect((await failed).status).toBe("failed");
      fail = false;
      const retried = gate.trySendToOwner("Erinnerung: Müll raus", { kind: "test" });
      await vi.runAllTimersAsync();
      expect((await retried).status).toBe("sent");
      expect(channel.sends).toHaveLength(1);
    });

    it("knows after a restart what the previous process just sent", async () => {
      const before = fakeChannel();
      const old = new OutboundGate(before, "+49");
      await send(old, "Erster Absatz.\n\nZweiter Absatz.");
      // Every bubble carries the same fingerprint, and never the text.
      const prints = new Set(stored.map((row) => row.dedupe));
      expect(prints.size).toBe(1);
      expect([...prints][0]).toMatch(/^[0-9a-f]{32}$/);
      recentRows = stored.map((row) => ({ fingerprint: row.dedupe ?? "", at: row.at }));

      const after = fakeChannel();
      const fresh = new OutboundGate(after, "+49");
      expect(await fresh.restoreRecent()).toBe(2);
      const again = fresh.trySendToOwner("Erster Absatz.\n\nZweiter Absatz.", { kind: "test" });
      await vi.runAllTimersAsync();
      expect((await again).status).toBe("duplicate");
      expect(await send(fresh, "Etwas anderes.")).toBe(true);
      expect(after.sends.map((entry) => entry.text)).toEqual(["Etwas anderes."]);
    });

    it("forgets after the window what went out before the restart", async () => {
      recentRows = [{ fingerprint: "0".repeat(32), at: new Date(Date.now() - 60_000).toISOString() }];
      const gate = new OutboundGate(fakeChannel(), "+49");
      await gate.restoreRecent();
      await vi.advanceTimersByTimeAsync(61_000);
      // An entry that is too old blocks nothing: only fresh ones are checked against.
      expect(await send(gate, "Neu.")).toBe(true);
    });

    it("starts with an empty block when the database is not readable, instead of not at all", async () => {
      recentRows = null;
      const gate = new OutboundGate(fakeChannel(), "+49");
      expect(await gate.restoreRecent()).toBe(0);
      expect(auditMock).toHaveBeenCalledWith("error", expect.objectContaining({ stage: "outbound_restore" }));
      expect(await send(gate, "Geht trotzdem.")).toBe(true);
    });
  });

  it("lets identical previews through: two equal actions are two confirmations", async () => {
    const channel = fakeChannel();
    const gate = new OutboundGate(channel, "+4915100000000");
    const preview = () => {
      const promise = gate.sendToOwnerWithReceipt("Soll ich?", { kind: "approval_preview" }, { allowDuplicate: true });
      void vi.runAllTimersAsync();
      return promise;
    };
    expect(await preview()).not.toBeNull();
    expect(await preview()).not.toBeNull();
    expect(channel.sends).toHaveLength(2);
  });

  it("sends a preview with paragraphs as one bubble: the 👍 needs exactly one channel ID (D14)", async () => {
    const channel = fakeChannel();
    const gate = new OutboundGate(channel, "+4915100000000");
    const text = "Soll ich?\nMail an anna@example.org\n\nHi Anna,\n\nkomme später.\n\n👍 oder „ja\" hier im Thread.";
    const promise = gate.sendToOwnerWithReceipt(text, { kind: "approval_preview" }, { allowDuplicate: true, singleBubble: true });
    void vi.runAllTimersAsync();
    expect(await promise).not.toBeNull();
    expect(channel.sends.map((entry) => entry.text)).toEqual([text]);
  });

  it("allows the same message again after the dedupe window", async () => {
    const channel = fakeChannel();
    const gate = new OutboundGate(channel, "+4915100000000");
    await send(gate, "Wann genau?");
    vi.setSystemTime(Date.now() + 300_000);
    expect(await send(gate, "Wann genau?")).toBe(true);
    expect(channel.sends).toHaveLength(2);
  });

  it("replies in the thread with every bubble, so no gap is left in between", async () => {
    const channel = fakeChannel({ replyThreads: true });
    const gate = new OutboundGate(channel, "+4915100000000");
    await send(gate, "Erster Absatz.\n\nZweiter Absatz.", { replyTo: "m-1" });
    expect(channel.sends[0]).toEqual({ text: "Erster Absatz.", replyTo: "m-1" });
    expect(channel.sends[1]).toEqual({ text: "Zweiter Absatz.", replyTo: "m-1" });
  });

  it("sends without a thread when the channel cannot do threads", async () => {
    const channel = fakeChannel({ replyThreads: false });
    const gate = new OutboundGate(channel, "+4915100000000");
    await send(gate, "Antwort.", { replyTo: "m-1" });
    expect(channel.sends).toEqual([{ text: "Antwort." }]);
  });

  it("does not send an empty message", async () => {
    const channel = fakeChannel();
    const gate = new OutboundGate(channel, "+4915100000000");
    expect(await send(gate, "   ")).toBe(false);
    expect(channel.sends).toHaveLength(0);
  });

  it("sets tapbacks", async () => {
    const channel = fakeChannel();
    const gate = new OutboundGate(channel, "+4915100000000");
    expect(await gate.react("m-1", "👍")).toBe(true);
    expect(channel.reactions).toEqual([{ messageId: "m-1", emoji: "👍" }]);
  });

  it("does not react when the channel cannot do tapbacks", async () => {
    const channel = fakeChannel({ reactions: false });
    const gate = new OutboundGate(channel, "+4915100000000");
    expect(await gate.react("m-1", "👍")).toBe(false);
    expect(channel.reactions).toHaveLength(0);
  });

  it("acknowledges with a tapback and then sends no text", async () => {
    const channel = fakeChannel();
    const gate = new OutboundGate(channel, "+4915100000000");
    const promise = gate.acknowledge("m-1", "Gestoppt.", { kind: "kill_switch_ack" });
    await vi.runAllTimersAsync();
    expect(await promise).toBe("reaction");
    expect(channel.reactions).toEqual([{ messageId: "m-1", emoji: "👍" }]);
    expect(channel.sends).toHaveLength(0);
    expect(auditMock).toHaveBeenCalledWith(
      "outbound_ack",
      expect.objectContaining({ via: "reaction", kind: "kill_switch_ack" }),
    );
  });

  it("sends the text version when the tapback fails", async () => {
    const channel = fakeChannel();
    channel.react = async () => {
      throw new Error("socket gone");
    };
    const gate = new OutboundGate(channel, "+4915100000000");
    const promise = gate.acknowledge("m-1", "Gestoppt.", { kind: "kill_switch_ack" });
    await vi.runAllTimersAsync();
    expect(await promise).toBe("text");
    expect(channel.sends).toEqual([{ text: "Gestoppt." }]);
    expect(auditMock).toHaveBeenCalledWith(
      "outbound_ack",
      expect.objectContaining({ via: "text", kind: "kill_switch_ack" }),
    );
  });

  it("sends the text version when the channel cannot do tapbacks", async () => {
    const channel = fakeChannel({ reactions: false });
    const gate = new OutboundGate(channel, "+4915100000000");
    const promise = gate.acknowledge("m-1", "Bin wieder da.");
    await vi.runAllTimersAsync();
    expect(await promise).toBe("text");
    expect(channel.sends).toEqual([{ text: "Bin wieder da." }]);
  });

  it("sends the text version when there is no message at all", async () => {
    const channel = fakeChannel();
    const gate = new OutboundGate(channel, "+4915100000000");
    const promise = gate.acknowledge("", "Bin wieder da.");
    await vi.runAllTimersAsync();
    expect(await promise).toBe("text");
    expect(channel.reactions).toHaveLength(0);
    expect(channel.sends).toEqual([{ text: "Bin wieder da." }]);
  });

  it("reports honestly when the text version did not go out either", async () => {
    const channel = fakeChannel({ reactions: false });
    channel.send = async () => {
      throw new Error("Photon is not connected");
    };
    const gate = new OutboundGate(channel, "+4915100000000");
    const promise = gate.acknowledge("m-1", "Gestoppt.");
    await vi.runAllTimersAsync();
    expect(await promise).toBe("none");
    expect(auditMock).toHaveBeenCalledWith(
      "outbound_ack",
      expect.objectContaining({ via: "none" }),
    );
  });

  it("[addendum D52 of 2026-10-13] reports when the channel breaks off in the middle of a reply, also after the first bubbles", async () => {
    const channel = fakeChannel();
    const original = channel.send.bind(channel);
    let calls = 0;
    channel.send = async (to, text, extras) => {
      calls += 1;
      if (calls === 2) throw new Error("[upstream] read ECONNRESET");
      return original(to, text, extras);
    };
    const gate = new OutboundGate(channel, "+4915100000000");
    const partial = gate.trySendToOwner("erster absatz\n\nzweiter absatz", { kind: "reply" });
    await vi.runAllTimersAsync();
    expect(await partial).toMatchObject({ status: "sent", undelivered: true });
    expect(auditMock).toHaveBeenCalledWith("outbound_failed", expect.objectContaining({ bubble: 2, bubbles: 2, kind: "reply" }));

    const none = gate.trySendToOwner("ganz anderer text", { kind: "reply" });
    calls = 1;
    await vi.runAllTimersAsync();
    expect(await none).toEqual({ status: "failed", undelivered: true });

    // Our own limits are not a broken line.
    const empty = gate.trySendToOwner("   ", { kind: "reply" });
    expect(await empty).toEqual({ status: "failed" });
  });

  it("[addendum D38 of 2026-10-13] records in the audit when a bubble only went through on the second attempt", async () => {
    const channel = fakeChannel();
    const original = channel.send.bind(channel);
    channel.send = async (to, text, extras) => ({ ...(await original(to, text, extras)), retried: true });
    const gate = new OutboundGate(channel, "+4915100000000");
    expect(await send(gate, "Hallo")).toBe(true);
    expect(auditMock).toHaveBeenCalledWith("outbound", expect.objectContaining({ retried: true }), expect.anything());
  });

  it("does not resort to retrying on a channel error", async () => {
    const channel = fakeChannel();
    channel.send = async () => {
      throw new Error("socket gone");
    };
    const gate = new OutboundGate(channel, "+4915100000000");
    expect(await send(gate, "Hallo")).toBe(false);
    expect(auditMock).toHaveBeenCalledWith(
      "outbound_failed",
      expect.objectContaining({ reason: "socket gone" }),
    );
  });
});

describe("[D44] OutboundGate counts delivery", () => {
  const failingChannel = (reason = "Target not allowed for this project") => {
    const channel = fakeChannel();
    channel.send = async () => {
      throw new Error(reason);
    };
    return channel;
  };
  const deliveryAudits = () => (auditMock.mock.calls as unknown as Array<[string, Record<string, unknown>]>).filter(([event]) => event === "delivery_health");

  it("is healthy and idle as long as nothing was sent", () => {
    const gate = new OutboundGate(fakeChannel(), "+49");
    expect(gate.deliveryHealth()).toMatchObject({ healthy: true, idle: true, attempts: 0 });
  });

  it("turns unhealthy after three failed messages and writes that to the audit log once", async () => {
    const gate = new OutboundGate(failingChannel(), "+49");
    await send(gate, "eins");
    await send(gate, "zwei");
    expect(gate.deliveryHealth().healthy).toBe(true);
    await send(gate, "drei");
    await send(gate, "vier");
    expect(gate.deliveryHealth()).toMatchObject({ healthy: false, failures: 4, consecutiveFailures: 4, lastError: "Target not allowed for this project" });
    expect(deliveryAudits()).toEqual([
      [
        "delivery_health",
        { healthy: false, attempts: 3, failures: 3, consecutive_failures: 3, last_error: "Target not allowed for this project" },
      ],
    ]);
  });

  it("turns healthy again with the first message that goes out", async () => {
    const channel = failingChannel();
    const gate = new OutboundGate(channel, "+49");
    for (const text of ["a", "b", "c"]) await send(gate, text);
    channel.send = async () => ({ externalId: "ok-1", chatId: "c" });
    await send(gate, "geht wieder");
    expect(gate.deliveryHealth()).toMatchObject({ healthy: true, consecutiveFailures: 0 });
    expect(deliveryAudits().map(([, detail]) => detail["healthy"])).toEqual([false, true]);
  });

  it("does not count its own rate limit as a failed delivery", async () => {
    const gate = new OutboundGate(fakeChannel(), "+49");
    for (let i = 0; i < 30; i += 1) await send(gate, `nachricht ${i}`);
    expect(await send(gate, "eine zu viel")).toBe(false);
    expect(await send(gate, "noch eine zu viel")).toBe(false);
    expect(await send(gate, "und noch eine")).toBe(false);
    expect(auditMock).toHaveBeenCalledWith("outbound_failed", expect.objectContaining({ reason: "rate_limited" }));
    expect(gate.deliveryHealth()).toMatchObject({ healthy: true, attempts: 30, failures: 0 });
  });

  it("knows when something last went through: failures, rate limit and duplicates do not count", async () => {
    const channel = failingChannel();
    const gate = new OutboundGate(channel, "+49");
    expect(gate.lastDeliveredAt()).toBeNull();
    await send(gate, "geht nicht");
    expect(gate.lastDeliveredAt()).toBeNull();
    channel.send = async () => ({ externalId: "ok-1", chatId: "c" });
    const before = Date.now();
    await send(gate, "geht");
    const delivered = gate.lastDeliveredAt();
    expect(delivered).toBeGreaterThanOrEqual(before);
    await send(gate, "geht");
    expect(gate.lastDeliveredAt()).toBe(delivered);
  });

  it("does not count swallowed duplicates as an attempt", async () => {
    const gate = new OutboundGate(fakeChannel(), "+49");
    await send(gate, "Wann genau?");
    await send(gate, "Wann genau?");
    expect(gate.deliveryHealth()).toMatchObject({ attempts: 1, failures: 0 });
  });

  it("counts a message the channel accepted, even if only storing it fails", async () => {
    const gate = new OutboundGate(fakeChannel(), "+49");
    storeFails = true;
    for (const text of ["a", "b", "c"]) expect(await send(gate, text)).toBe(false);
    expect(gate.deliveryHealth()).toMatchObject({ healthy: true, attempts: 3, failures: 0 });
  });

  it("does not count failed tapbacks: they fall back to text, and that counts", async () => {
    const channel = fakeChannel();
    channel.react = async () => {
      throw new Error("message for the tapback not found");
    };
    const gate = new OutboundGate(channel, "+49");
    for (const id of ["m-1", "m-2", "m-3"]) await gate.react(id, "👍");
    expect(gate.deliveryHealth()).toMatchObject({ healthy: true, idle: true, attempts: 0 });
  });
});

describe("[D48] OutboundGate edits its own messages", () => {
  const row = (overrides: Partial<EditableRow> = {}): EditableRow => ({
    id: "db-1",
    external_id: "ext-1",
    body: "treffen am montag um 15 uhr",
    created_at: new Date().toISOString(),
    taint_sources: [],
    raw: { status: "sent", editable: true },
    ...overrides,
  });

  async function edit(gate: InstanceType<typeof OutboundGate>, find: string, text: string) {
    const promise = gate.editOwn(find, text);
    await vi.runAllTimersAsync();
    return promise;
  }

  it("changes the one matching message, as plain text, and records the change", async () => {
    const channel = fakeChannel({ edit: true });
    const gate = new OutboundGate(channel, "+49");
    editableRows = [row({ taint_sources: ["Alex's Google Calendar"] })];
    expect(await edit(gate, "am Montag", "treffen am **dienstag** um 15 uhr")).toEqual({ ok: true });
    expect(channel.edited).toEqual([{ externalId: "ext-1", text: "treffen am dienstag um 15 uhr" }]);
    expect(edits).toEqual([
      { id: "db-1", body: "treffen am dienstag um 15 uhr", raw: { status: "sent", editable: true, edits: 1 } },
    ]);
    expect(auditMock).toHaveBeenCalledWith("outbound_edit", expect.objectContaining({ edits: 1, tainted: true }), "db-1");
  });

  it("finds nothing when no editable message carries the text", async () => {
    const gate = new OutboundGate(fakeChannel({ edit: true }), "+49");
    editableRows = [row()];
    expect(await edit(gate, "freitag", "egal")).toEqual({ ok: false, reason: "not_found" });
  });

  it("does not guess when the text is in several messages", async () => {
    const channel = fakeChannel({ edit: true });
    const gate = new OutboundGate(channel, "+49");
    editableRows = [row(), row({ id: "db-2", external_id: "ext-2", body: "und am montag regnet es" })];
    expect(await edit(gate, "montag", "egal")).toEqual({ ok: false, reason: "ambiguous" });
    expect(channel.edited).toEqual([]);
  });

  it("stops after five edits, like Apple", async () => {
    const gate = new OutboundGate(fakeChannel({ edit: true }), "+49");
    editableRows = [row({ raw: { editable: true, edits: 5 } })];
    expect(await edit(gate, "montag", "egal")).toEqual({ ok: false, reason: "edit_limit" });
  });

  it("rejects what does not fit into a bubble, and what the channel cannot do", async () => {
    editableRows = [row()];
    expect(await edit(new OutboundGate(fakeChannel({ edit: true }), "+49"), "montag", "x".repeat(1_300))).toEqual({
      ok: false,
      reason: "too_long",
    });
    expect(await edit(new OutboundGate(fakeChannel(), "+49"), "montag", "egal")).toEqual({ ok: false, reason: "unsupported" });
  });

  it("reports when the channel refuses, and then records nothing", async () => {
    const channel = fakeChannel({ edit: true });
    channel.edit = async () => {
      throw new Error("edit window expired");
    };
    const gate = new OutboundGate(channel, "+49");
    editableRows = [row()];
    expect(await edit(gate, "montag", "dienstag")).toEqual({ ok: false, reason: "failed" });
    expect(edits).toEqual([]);
  });
});

describe("link preview to Alex (addendum D48 of 2026-10-08)", () => {
  async function sendLink(gate: InstanceType<typeof OutboundGate>, url: string, replyTo?: string) {
    const promise = gate.sendLinkToOwner(url, { kind: "link_preview" }, { taintSources: ["report"], ...(replyTo ? { replyTo } : {}) });
    await vi.runAllTimersAsync();
    return promise;
  }

  it("sends the URL as a preview in the thread, stores it with its origin, logs only the host and doubles nothing", async () => {
    const channel = fakeChannel({ richLinks: true });
    const gate = new OutboundGate(channel, "+49");
    expect(await sendLink(gate, "https://shop.example/p/1?v=2", "q-1")).toMatchObject({ externalId: expect.any(String) });
    expect(channel.sends).toEqual([{ text: "link:https://shop.example/p/1?v=2", replyTo: "q-1" }]);
    expect(stored).toEqual([
      { body: "https://shop.example/p/1?v=2", taintSources: ["report"], editable: false, dedupe: expect.stringMatching(/^[0-9a-f]{32}$/), at: expect.any(String) },
    ]);
    expect(auditMock).toHaveBeenCalledWith("outbound", expect.objectContaining({ richlink: true, host: "shop.example", kind: "link_preview" }), expect.any(String));
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain("/p/1");
    expect(await sendLink(gate, "https://shop.example/p/1?v=2")).toBe("duplicate");
    expect(channel.sends).toHaveLength(1);
  });

  it("sends nothing when the channel cannot do previews", async () => {
    const channel = fakeChannel();
    expect(await sendLink(new OutboundGate(channel, "+49"), "https://shop.example/p/1")).toBeNull();
    expect(channel.sends).toEqual([]);
  });
});

describe("files to Alex (audit 2026-10-05)", () => {
  const file = (body = "BEGIN:VCALENDAR") => ({ name: "termin.ics", mimeType: "text/calendar", body: Buffer.from(body) });
  async function sendFile(gate: InstanceType<typeof OutboundGate>, f = file(), taint: string[] = []) {
    const promise = gate.sendFileToOwner(f, "Zahnarzt, 2026-10-08 10:00", { kind: "file" }, { taintSources: taint });
    await vi.runAllTimersAsync();
    return promise;
  }

  it("sends only to Alex, stores a row with its origin and no bytes, and doubles nothing", async () => {
    const channel = fakeChannel({ files: true });
    const gate = new OutboundGate(channel, "+49");
    expect(await sendFile(gate, file(), ["Alex's inbox"])).toMatchObject({ externalId: expect.any(String) });
    expect(channel.sends).toEqual([{ text: "file:termin.ics:text/calendar:15" }]);
    expect(stored).toEqual([
      {
        body: "[File: termin.ics] Zahnarzt, 2026-10-08 10:00",
        taintSources: ["Alex's inbox"],
        editable: false,
        dedupe: expect.stringMatching(/^[0-9a-f]{32}$/),
        at: expect.any(String),
      },
    ]);
    expect(await sendFile(gate)).toBeNull();
    expect(channel.sends).toHaveLength(1);
  });

  it("attaches Alex's file in the thread under a preview, also a second time and above 1 MB (addendum D34 of 2026-10-08)", async () => {
    const channel = fakeChannel({ files: true });
    const gate = new OutboundGate(channel, "+49");
    const pdf = { name: "a.pdf", mimeType: "application/pdf", body: Buffer.alloc(2_000_000) };
    for (let index = 0; index < 2; index += 1) {
      const promise = gate.sendFileToOwner(pdf, "", { kind: "approval_preview_file" }, { replyTo: "pv-1", allowDuplicate: true, maxBytes: 12_000_000 });
      await vi.runAllTimersAsync();
      expect(await promise).not.toBeNull();
    }
    expect(channel.sends).toEqual([
      { text: "file:a.pdf:application/pdf:2000000", replyTo: "pv-1" },
      { text: "file:a.pdf:application/pdf:2000000", replyTo: "pv-1" },
    ]);
  });

  it("refuses when the channel cannot do files or the file is too large", async () => {
    expect(await sendFile(new OutboundGate(fakeChannel(), "+49"))).toBeNull();
    const channel = fakeChannel({ files: true });
    expect(await sendFile(new OutboundGate(channel, "+49"), file("x".repeat(1_000_001)))).toBeNull();
    expect(channel.sends).toHaveLength(0);
  });

  it("sends a voice message only when the channel can do it, and stores what was spoken (D59)", async () => {
    const voice = { name: "Serain.m4a", mimeType: "audio/mp4", body: Buffer.from("m4a"), voice: true };
    const send = async (gate: InstanceType<typeof OutboundGate>) => {
      const promise = gate.sendFileToOwner(voice, "klar, mach ich", { kind: "voice" });
      await vi.runAllTimersAsync();
      return promise;
    };
    const fileOnly = fakeChannel({ files: true });
    expect(await send(new OutboundGate(fileOnly, "+49"))).toBeNull();
    expect(fileOnly.sends).toEqual([]);
    const channel = fakeChannel({ files: true, voice: true });
    expect(await send(new OutboundGate(channel, "+49"))).not.toBeNull();
    expect(channel.sends).toEqual([{ text: "voice:Serain.m4a:audio/mp4:3" }]);
    expect(stored).toEqual([
      {
        body: "[Voice message] klar, mach ich",
        taintSources: [],
        editable: false,
        dedupe: expect.stringMatching(/^[0-9a-f]{32}$/),
        at: expect.any(String),
      },
    ]);
  });

  it("does not count a refused file as a broken delivery (D44)", async () => {
    const gate = new OutboundGate(fakeChannel({ files: true, filesFail: true }), "+49");
    for (const body of ["a", "b", "c", "d"]) expect(await sendFile(gate, file(body))).toBeNull();
    expect(gate.deliveryHealth().healthy).toBe(true);
    expect(gate.deliveryHealth().idle).toBe(true);
  });
});
