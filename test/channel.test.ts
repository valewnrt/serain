import { describe, expect, it, vi } from "vitest";
import { resolveContents, type Message, type Space } from "@spectrum-ts/core";
import { PhotonChannel, type PhotonApp, type PhotonTextOptions } from "../src/channel/photon/adapter.js";
import { normalizeE164 } from "../src/channel/e164.js";
import type { InboundMessage, InboundReaction } from "../src/channel/types.js";

const ALEX = "+4915112345678";
const DM = `any;-;${ALEX}`;

/** An error as Photon's SDK throws it: with gRPC status (`IMessageError.grpcCode`). */
function grpcError(grpcCode: number, message: string): Error {
  return Object.assign(new Error(message), { grpcCode });
}
const UNAVAILABLE = () => grpcError(14, "[upstream] read ECONNRESET");
const ALREADY_EXISTS = () => grpcError(6, "[upstream] Operation already processed with this client message ID");

/** What went through Photon's text path (addendum D38 of 2026-10-13). */
interface TextCall {
  chat: string;
  text: string;
  options: PhotonTextOptions;
}

/**
 * Fake for Spectrum: a message stream the test feeds, and spaces that record
 * what was sent. What the adapter passes to `space.send` the tests resolve with
 * Spectrum's own `resolveContents`, so they check what would really go over the
 * wire. Texts go past Spectrum via `texts`; `failures` sets what the next calls
 * fail with.
 */
class FakeSpectrum {
  readonly texts: TextCall[] = [];
  readonly edits: Array<{ chat: string; guid: string; text: string }> = [];
  /** Photon's conversation as `ownSince` reads it: what really arrived. */
  readonly delivered: Array<{ guid: string; text: string }> = [];
  /** Errors for the next text calls; `deliverThen` means: arrived, the response got lost. */
  failures: Array<Error | "deliverThen"> = [];
  readonly sent: unknown[] = [];
  readonly typing: string[] = [];
  readonly reads: string[] = [];
  readonly stored = new Map<string, Message>();
  private readonly queue: Array<[Space, Message]> = [];
  private wake: (() => void) | null = null;
  private closed = false;
  counter = 0;

  space(id = DM): Space {
    const space = {
      id,
      // Like Spectrum: the sent message comes back as outbound, with its conversation.
      send: vi.fn(async (content: unknown) => {
        this.sent.push(content);
        this.counter += 1;
        return { id: `out-${this.counter}`, direction: "outbound", content, space };
      }),
      startTyping: vi.fn(async () => void this.typing.push("start")),
      stopTyping: vi.fn(async () => void this.typing.push("stop")),
      read: vi.fn(async (message: Message) => void this.reads.push(message.id)),
      getMessage: vi.fn(async (messageId: string) => this.stored.get(messageId)),
    } as unknown as Space;
    return space;
  }

  app(): PhotonApp {
    const self = this;
    return {
      messages: {
        async *[Symbol.asyncIterator]() {
          while (!self.closed) {
            const next = self.queue.shift();
            if (next) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => (self.wake = resolve));
          }
        },
      },
      dm: async (peer) => self.space(`any;-;${peer}`),
      texts: {
        send: async (chat, text, options) => {
          self.texts.push({ chat, text, options });
          if (self.texts.some((call, index) => index < self.texts.length - 1 && call.options.clientMessageId === options.clientMessageId && self.landed.has(index))) {
            throw ALREADY_EXISTS();
          }
          const failure = self.failures.shift();
          if (failure instanceof Error) throw failure;
          self.counter += 1;
          const guid = `out-${self.counter}`;
          self.landed.add(self.texts.length - 1);
          self.delivered.push({ guid, text });
          if (failure === "deliverThen") throw UNAVAILABLE();
          return { guid };
        },
        ownSince: async () => [...self.delivered].reverse(),
        edit: async (chat, guid, text) => void self.edits.push({ chat, guid, text }),
      },
      stop: async () => {
        self.closed = true;
        self.wake?.();
      },
    };
  }

  /** Indices in `texts` whose call reached Photon: that is how Photon recognises the second delivery. */
  private readonly landed = new Set<number>();

  push(space: Space, message: Message): void {
    this.queue.push([space, message]);
    this.wake?.();
  }
}

function inbound(space: Space, id: string, content: Record<string, unknown>, from = ALEX): Message {
  return {
    id,
    direction: "inbound",
    platform: "imessage",
    content,
    sender: { id: from, __platform: "imessage" },
    space,
    timestamp: new Date("2026-10-01T20:00:00Z"),
  } as unknown as Message;
}

async function connected() {
  const fake = new FakeSpectrum();
  const channel = new PhotonChannel({ projectId: "p", projectSecret: "s", connect: async () => fake.app(), retryDelayMs: 1 });
  const messages: InboundMessage[] = [];
  const reactions: InboundReaction[] = [];
  channel.onInbound((message) => void messages.push(message));
  channel.onReaction((reaction) => void reactions.push(reaction));
  await channel.start();
  await channel.waitUntilConnected(1_000);
  return { fake, channel, messages, reactions };
}

/** Until the adapter has processed the stream. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("E.164 normalisation", () => {
  it("accepts common notations", () => {
    expect(normalizeE164("+49 151 1234567")).toBe("+491511234567");
    expect(normalizeE164("+1 (555) 010-0199")).toBe("+15550100199");
    expect(normalizeE164("15550100199")).toBe("+15550100199");
  });

  it("rejects everything that is not a number", () => {
    expect(normalizeE164("hallo")).toBeNull();
    expect(normalizeE164("+0123456789")).toBeNull();
    expect(normalizeE164("")).toBeNull();
  });
});

describe("Photon adapter, receiving", () => {
  it("reads text, sender in E.164 and the conversation", async () => {
    const { fake, channel, messages } = await connected();
    fake.push(fake.space(), inbound(fake.space(), "m-1", { type: "text", text: " hi " }, "+49 151 12345678"));
    await settle();
    expect(messages).toMatchObject([
      { channel: "photon", externalId: "m-1", from: ALEX, chatId: DM, isGroup: false, text: "hi", replyToExternalId: "" },
    ]);
    // Storable: no Message object with functions in the raw frame.
    expect(() => JSON.stringify(messages[0]?.raw)).not.toThrow();
    await channel.stop();
  });

  it("passes through the thread root of a reply", async () => {
    const { fake, channel, messages } = await connected();
    const target = { id: "pv-1" };
    fake.push(fake.space(), inbound(fake.space(), "m-2", { type: "reply", target, content: { type: "text", text: "ja" } }));
    await settle();
    expect(messages[0]).toMatchObject({ text: "ja", replyToExternalId: "pv-1" });
    await channel.stop();
  });

  it("turns a sent link into text", async () => {
    const { fake, channel, messages } = await connected();
    fake.push(fake.space(), inbound(fake.space(), "m-3", { type: "richlink", url: "https://example.com/a" }));
    await settle();
    expect(messages[0]?.text).toBe("https://example.com/a");
    await channel.stop();
  });

  it("recognises groups by the chat ID, so the allowlist rejects them", async () => {
    const { fake, channel, messages } = await connected();
    const group = fake.space("any;+;chat123");
    fake.push(group, inbound(group, "m-4", { type: "text", text: "hallo" }));
    await settle();
    expect(messages[0]?.isGroup).toBe(true);
    await channel.stop();
  });

  it("ignores own messages and content Serain does not need", async () => {
    const { fake, channel, messages } = await connected();
    const own = { ...inbound(fake.space(), "m-5", { type: "text", text: "echo" }), direction: "outbound" } as Message;
    fake.push(fake.space(), own);
    fake.push(fake.space(), inbound(fake.space(), "m-6", { type: "poll", title: "?", options: [] }));
    await settle();
    expect(messages).toHaveLength(0);
    await channel.stop();
  });

  it("reads a tapback with sender and target", async () => {
    const { fake, channel, reactions } = await connected();
    fake.push(fake.space(), inbound(fake.space(), "r-1", { type: "reaction", emoji: "👍", target: { id: "pv-1" } }, "+49 151 12345678"));
    await settle();
    expect(reactions).toMatchObject([{ channel: "photon", from: ALEX, messageId: "pv-1", emoji: "👍" }]);
    await channel.stop();
  });

  it("discards a tapback without sender instead of guessing", async () => {
    const { fake, channel, reactions } = await connected();
    const anonymous = { ...inbound(fake.space(), "r-2", { type: "reaction", emoji: "👍", target: { id: "pv-1" } }), sender: undefined } as Message;
    fake.push(fake.space(), anonymous);
    await settle();
    expect(reactions).toHaveLength(0);
    await channel.stop();
  });

  it("reports a read receipt as delivery status", async () => {
    const fake = new FakeSpectrum();
    const statuses: Array<{ externalId: string; status: string }> = [];
    const channel = new PhotonChannel({
      projectId: "p",
      projectSecret: "s",
      connect: async () => fake.app(),
      onStatus: ({ externalId, status }) => void statuses.push({ externalId, status }),
    });
    await channel.start();
    await channel.waitUntilConnected(1_000);
    fake.push(fake.space(), inbound(fake.space(), "rd-1", { type: "read", target: { id: "out-7" } }));
    await settle();
    expect(statuses).toEqual([{ externalId: "out-7", status: "read" }]);
    await channel.stop();
  });
});

describe("Photon adapter, sending", () => {
  it("sends text to Alex's conversation, with its own clientMessageId per message", async () => {
    const { fake, channel } = await connected();
    const result = await channel.send("+49 151 12345678", "moin");
    expect(result).toEqual({ externalId: "out-1", chatId: DM, status: "sent", retried: false });
    await channel.send(ALEX, "noch was");
    expect(fake.texts.map(({ chat, text }) => ({ chat, text }))).toEqual([
      { chat: DM, text: "moin" },
      { chat: DM, text: "noch was" },
    ]);
    expect(fake.texts[0]?.options.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.texts[1]?.options.clientMessageId).not.toBe(fake.texts[0]?.options.clientMessageId);
    expect(fake.sent).toEqual([]);
    await channel.stop();
  });

  it("replies in the thread of the remembered message, with the part for multi-part ones", async () => {
    const { fake, channel } = await connected();
    const space = fake.space();
    fake.push(space, inbound(space, "in-42", { type: "text", text: "frage" }));
    fake.push(space, inbound(space, "p:1/in-43", { type: "text", text: "zweiter teil" }));
    await settle();
    await channel.sendReply(ALEX, "dazu:", "in-42");
    expect(fake.texts.at(-1)).toMatchObject({ text: "dazu:", options: { replyTo: "in-42" } });
    await channel.sendReply(ALEX, "und dazu:", "p:1/in-43");
    expect(fake.texts.at(-1)).toMatchObject({ text: "und dazu:", options: { replyTo: { guid: "in-43", partIndex: 1 } } });
    await channel.stop();
  });

  it("[addendum D48 of 2026-10-08] sends a link preview as text with preview, in the thread of the remembered message", async () => {
    const { fake, channel } = await connected();
    expect(channel.capabilities.richLinks).toBe(true);
    const space = fake.space();
    fake.push(space, inbound(space, "in-7", { type: "text", text: "frage" }));
    await settle();
    await channel.sendRichLink(ALEX, "https://shop.example/p/1", "in-7");
    expect(fake.texts.at(-1)).toMatchObject({ text: "https://shop.example/p/1", options: { enableLinkPreview: true, replyTo: "in-7" } });
    await channel.sendRichLink(ALEX, "https://shop.example/p/2");
    expect(fake.texts.at(-1)?.options).not.toHaveProperty("replyTo");
    await channel.stop();
  });

  it("[D48] sends emphasis as ranges, so exactly the text arrives", async () => {
    const { fake, channel } = await connected();
    await channel.send(ALEX, "um 15.30 (pünktlich)", { styles: [{ type: "bold", start: 3, length: 5 }] });
    expect(fake.texts.at(-1)).toMatchObject({ text: "um 15.30 (pünktlich)", options: { formatting: [{ type: "bold", start: 3, length: 5 }] } });
    await channel.stop();
  });

  it("[D48] sends the effect with Apple's identifier, also in a thread", async () => {
    const { fake, channel } = await connected();
    await channel.send(ALEX, "alles gute", { effect: "confetti" });
    expect(fake.texts.at(-1)?.options).toMatchObject({ effect: "com.apple.messages.effect.CKConfettiEffect" });

    const space = fake.space();
    fake.push(space, inbound(space, "in-50", { type: "text", text: "bestanden!" }));
    await settle();
    await channel.sendReply(ALEX, "glückwunsch", "in-50", { effect: "fireworks", styles: [{ type: "bold", start: 0, length: 11 }] });
    expect(fake.texts.at(-1)?.options).toMatchObject({
      replyTo: "in-50",
      effect: "com.apple.messages.effect.CKFireworksEffect",
      formatting: [{ type: "bold", start: 0, length: 11 }],
    });
    await channel.stop();
  });

  it("[D48] edits a just-sent message, but none it did not send itself", async () => {
    const { fake, channel } = await connected();
    const sent = await channel.send(ALEX, "am montag");
    await channel.edit(sent.externalId, "am dienstag");
    expect(fake.edits).toEqual([{ chat: DM, guid: sent.externalId, text: "am dienstag" }]);

    const space = fake.space();
    fake.push(space, inbound(space, "in-51", { type: "text", text: "von alex" }));
    await settle();
    await expect(channel.edit("in-51", "umgeschrieben")).rejects.toThrow("no longer knows");
    await expect(channel.edit("weg", "umgeschrieben")).rejects.toThrow("no longer knows");
    await channel.stop();
  });

  it("sends without thread if the target is unknown, instead of not at all", async () => {
    const { fake, channel } = await connected();
    await channel.sendReply(ALEX, "dazu:", "weg");
    expect(fake.texts.map((call) => call.text)).toEqual(["dazu:"]);
    expect(fake.texts[0]?.options).not.toHaveProperty("replyTo");
    await channel.stop();
  });
  it("puts a tapback on a remembered message", async () => {
    const { fake, channel } = await connected();
    const space = fake.space();
    fake.push(space, inbound(space, "in-43", { type: "text", text: "serain stopp" }));
    await settle();
    await channel.react(ALEX, "in-43", "👍");
    const [content] = await resolveContents([fake.sent.at(-1) as never]);
    expect(content).toMatchObject({ type: "reaction", emoji: "👍" });
    expect((content as { target: Message }).target.id).toBe("in-43");
    await channel.stop();
  });

  it("throws for a tapback without a findable target", async () => {
    const { channel } = await connected();
    await expect(channel.react(ALEX, "weg", "👍")).rejects.toThrow();
    await channel.stop();
  });

  it("finds the target of a tapback after a restart in Alex's conversation (D52)", async () => {
    // Fresh adapter: no message from the owner yet, so no known conversation.
    const { fake, channel } = await connected();
    const earlier = inbound(fake.space(`any;-;${ALEX}`), "in-vor-neustart", { type: "text", text: "recherchier das" });
    fake.stored.set(earlier.id, earlier);
    await channel.react(ALEX, "in-vor-neustart", "❌");
    const [content] = await resolveContents([fake.sent.at(-1) as never]);
    expect(content).toMatchObject({ type: "reaction", emoji: "❌" });
    expect((content as { target: Message }).target.id).toBe("in-vor-neustart");
    await channel.stop();
  });

  it("rejects a send target that is not a number", async () => {
    const { channel } = await connected();
    await expect(channel.send("alex", "moin")).rejects.toThrow("not a valid number");
    await channel.stop();
  });

  it("marks Alex's last message as read and types", async () => {
    const { fake, channel } = await connected();
    const space = fake.space();
    fake.push(space, inbound(space, "in-44", { type: "text", text: "hi" }));
    await settle();
    await channel.markRead(ALEX);
    await channel.typing(ALEX, true);
    await channel.typing(ALEX, false);
    expect(fake.reads).toEqual(["in-44"]);
    expect(fake.typing).toEqual(["start", "stop"]);
    await channel.stop();
  });

  it("does not remember every stranger who writes to the shared number, and still reaches Alex", async () => {
    const { fake, channel } = await connected();
    const alex = fake.space();
    fake.push(alex, inbound(alex, "in-alex", { type: "text", text: "hi" }));
    for (let i = 0; i < 120; i += 1) {
      const stranger = `+1415555${String(i).padStart(4, "0")}`;
      const space = fake.space(`any;-;${stranger}`);
      fake.push(space, inbound(space, `in-x${i}`, { type: "text", text: "hallo" }, stranger));
    }
    await settle();
    const caches = channel as unknown as { spaces: Map<string, Space>; lastInbound: Map<string, Message> };
    expect(caches.spaces.size).toBeLessThanOrEqual(50);
    expect(caches.lastInbound.size).toBeLessThanOrEqual(50);
    const sent = await channel.send(ALEX, "noch da");
    expect(sent.chatId).toBe(DM);
    await channel.stop();
  });
});

describe("Photon adapter, abort while sending (addendum D38 of 2026-10-13)", () => {
  it("tries a second time after UNAVAILABLE, with the same clientMessageId", async () => {
    const { fake, channel } = await connected();
    fake.failures = [UNAVAILABLE()];
    const result = await channel.send(ALEX, "steht, morgen 6 uhr");
    expect(result).toMatchObject({ externalId: "out-1", status: "sent", retried: true });
    expect(fake.texts).toHaveLength(2);
    expect(fake.texts[1]?.options.clientMessageId).toBe(fake.texts[0]?.options.clientMessageId);
    expect(fake.delivered).toEqual([{ guid: "out-1", text: "steht, morgen 6 uhr" }]);
    await channel.stop();
  });

  it("sends no duplicate if the first attempt did arrive, and finds its channel ID", async () => {
    const { fake, channel } = await connected();
    fake.failures = ["deliverThen"];
    const result = await channel.send(ALEX, "steht, morgen 6 uhr");
    expect(fake.texts).toHaveLength(2);
    expect(fake.delivered).toHaveLength(1);
    expect(result).toMatchObject({ externalId: "out-1", status: "sent", retried: true });
    // Also editable like any other own message.
    await channel.edit("out-1", "steht, morgen 7 uhr");
    expect(fake.edits).toHaveLength(1);
    await channel.stop();
  });

  it("throws if the second attempt aborts too: then nothing arrived", async () => {
    const { fake, channel } = await connected();
    fake.failures = [UNAVAILABLE(), UNAVAILABLE()];
    await expect(channel.send(ALEX, "steht")).rejects.toThrow("ECONNRESET");
    expect(fake.texts).toHaveLength(2);
    expect(fake.delivered).toEqual([]);
    await channel.stop();
  });

  it("does not retry anything Photon rejects for another reason", async () => {
    const { fake, channel } = await connected();
    fake.failures = [grpcError(7, "Target not allowed for this project")];
    await expect(channel.send(ALEX, "steht")).rejects.toThrow("Target not allowed");
    fake.failures = [new Error("irgendwas")];
    await expect(channel.sendReply(ALEX, "steht", "weg")).rejects.toThrow("irgendwas");
    expect(fake.texts).toHaveLength(2);
    await channel.stop();
  });

  it("sets a tapback again after UNAVAILABLE: the same state, no second message", async () => {
    const { fake, channel } = await connected();
    const space = fake.space();
    fake.push(space, inbound(space, "in-60", { type: "text", text: "danke" }));
    await settle();
    const send = vi.mocked(space.send);
    send.mockRejectedValueOnce(UNAVAILABLE());
    await channel.react(ALEX, "in-60", "👍");
    expect(send).toHaveBeenCalledTimes(2);
    const [content] = await resolveContents([fake.sent.at(-1) as never]);
    expect(content).toMatchObject({ type: "reaction", emoji: "👍" });
    await channel.stop();
  });
});

describe("Photon adapter, attachments", () => {
  function media(bytes: Buffer, size?: number) {
    return {
      type: "attachment",
      id: "att-1",
      name: "IMG_1.HEIC",
      mimeType: "image/heic",
      ...(size !== undefined ? { size } : {}),
      read: async () => bytes,
      stream: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 3));
            controller.enqueue(bytes.subarray(3));
            controller.close();
          },
        }),
    };
  }

  it("delivers metadata on the message and the bytes on demand", async () => {
    const { fake, channel, messages } = await connected();
    const bytes = Buffer.from("0123456789");
    fake.push(fake.space(), inbound(fake.space(), "m-7", media(bytes, 10)));
    await settle();
    const attachment = messages[0]?.attachments[0];
    expect(attachment).toEqual({ id: "att-1", name: "IMG_1.HEIC", mimeType: "image/heic", size: 10 });
    const fetched = await channel.fetchAttachment(attachment!, 1_000);
    expect(fetched.body.equals(bytes)).toBe(true);
    expect(fetched.contentType).toBe("image/heic");
    await channel.stop();
  });

  it("aborts as soon as the attachment is larger than allowed, even without a size", async () => {
    const { fake, channel, messages } = await connected();
    fake.push(fake.space(), inbound(fake.space(), "m-8", media(Buffer.alloc(20))));
    await settle();
    await expect(channel.fetchAttachment(messages[0]!.attachments[0]!, 10)).rejects.toThrow("larger");
    await channel.stop();
  });

  it("knows no attachment it has not seen itself", async () => {
    const { channel } = await connected();
    await expect(channel.fetchAttachment({ id: "fremd" }, 10)).rejects.toThrow("no longer retrievable");
    await channel.stop();
  });
});

describe("Photon adapter, connection", () => {
  it("reports rejected credentials as final and does not keep trying", async () => {
    const { SpectrumCloudError } = await import("@spectrum-ts/core");
    const connect = vi.fn(async (): Promise<PhotonApp> => {
      throw new SpectrumCloudError(401, "unauthorized", "bad secret");
    });
    const fatal = vi.fn();
    const channel = new PhotonChannel({ projectId: "p", projectSecret: "s", connect, onFatal: fatal });
    await channel.start();
    await settle();
    expect(fatal).toHaveBeenCalledWith(401, "unauthorized");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(channel.isConnected()).toBe(false);
    await channel.stop();
  });

  it("is no longer connected after stop", async () => {
    const { channel } = await connected();
    expect(channel.isConnected()).toBe(true);
    await channel.stop();
    expect(channel.isConnected()).toBe(false);
  });
});
