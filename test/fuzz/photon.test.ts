import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { Message, Space } from "@spectrum-ts/core";
import { FUZZ_TIMEOUT_MS, hostileString, params } from "./helpers.js";

/**
 * Photon frames (D38) through the same entry as test/channel.test.ts: a
 * simulated Spectrum stream into which the test pushes arbitrary frames.
 *
 * Invariants: a frame, however broken, does not tear down the stream (Alex's
 * next message arrives, without reconnecting); what the adapter reports has
 * sender, IDs and time, `raw` is storable, a group is recognised as a group;
 * and the allowlist lets only Alex through, alone.
 */

vi.mock("../../src/log.js", async (original) => ({
  ...(await original<typeof import("../../src/log.js")>()),
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
}));

const { PhotonChannel } = await import("../../src/channel/photon/adapter.js");
const { checkIngress } = await import("../../src/security/allowlist.js");
const { normalizeE164 } = await import("../../src/channel/e164.js");
type PhotonApp = import("../../src/channel/photon/adapter.js").PhotonApp;
type InboundMessage = import("../../src/channel/types.js").InboundMessage;
type InboundReaction = import("../../src/channel/types.js").InboundReaction;

const ALEX = "+4915112345678";

/** Spectrum fake: a stream the test feeds. Counts how often the adapter connects. */
function fakeSpectrum() {
  const queue: Array<[Space, Message]> = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let connects = 0;
  const space = (id: unknown) =>
    ({
      id,
      send: async () => undefined,
      getMessage: async () => undefined,
      startTyping: async () => undefined,
      stopTyping: async () => undefined,
      read: async () => undefined,
    }) as unknown as Space;
  const app = (): PhotonApp => ({
    messages: {
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => (wake = resolve));
        }
      },
    },
    dm: async (peer) => space(`any;-;${peer}`),
    texts: { send: async () => ({ guid: "out" }), ownSince: async () => [], edit: async () => undefined },
    stop: async () => {
      closed = true;
      wake?.();
    },
  });
  return {
    space,
    connect: async () => {
      connects += 1;
      closed = false;
      return app();
    },
    connects: () => connects,
    push(frameSpace: Space, message: Message) {
      queue.push([frameSpace, message]);
      wake?.();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const senderId = fc.oneof(
  fc.constantFrom(ALEX, "+49 151 12345678", "4915112345678", "+1 (555) 010-0199", "alex@example.com", "", " ", "+", "+0123", "＋４９１５１１２３４５６７８", `${ALEX}\u200B`, `${ALEX};+;chat`),
  hostileString,
  fc.integer(),
  fc.constant(null),
);
const spaceId = fc.oneof(
  fc.constantFrom(`any;-;${ALEX}`, "iMessage;+;chat123456", "any;+;", ";+;", "SMS;-;+491701234567", "chat123456", ""),
  hostileString,
  fc.constant(undefined),
  fc.integer(),
);
const target = fc.oneof(fc.record({ id: fc.oneof(fc.string({ maxLength: 10 }), fc.integer(), fc.constant(null)) }), fc.constant(undefined), fc.constant(null));

const leafContent = fc.oneof(
  fc.record({ type: fc.constant("text"), text: fc.oneof(hostileString, fc.integer(), fc.constant(undefined)) }),
  fc.record({ type: fc.constant("richlink"), url: fc.oneof(fc.webUrl(), hostileString, fc.constant(null)) }),
  fc.record({
    type: fc.constantFrom("attachment", "voice"),
    id: fc.oneof(fc.string({ maxLength: 10 }), fc.constant(undefined), fc.integer()),
    mimeType: fc.oneof(fc.constantFrom("image/jpeg", "audio/m4a"), fc.constant(undefined), fc.integer(), fc.object()),
    name: fc.oneof(hostileString, fc.constant(undefined)),
    size: fc.oneof(fc.integer(), fc.double(), fc.constant(undefined), fc.string()),
  }),
  fc.record({ type: fc.constant("reaction"), emoji: fc.oneof(fc.constantFrom("👍", "❤\uFE0F", ""), hostileString, fc.constant(undefined)), target }),
  fc.record({ type: fc.constant("read"), target }),
  fc.record({ type: fc.oneof(fc.constantFrom("poll", "contact", "edit", "group", "typing", ""), hostileString) }),
  fc.constantFrom<unknown>(null, undefined, 42, "text", [], { type: {} }, { type: null }),
);
const content: fc.Arbitrary<unknown> = fc.letrec<{ content: unknown }>((tie) => ({
  content: fc.oneof({ depthSize: "small" }, leafContent, fc.record({ type: fc.constant("reply"), target, content: tie("content") })),
})).content;

const frame = fc.record({
  id: fc.oneof(fc.uuid(), fc.constant(""), fc.constant(undefined), fc.integer()),
  direction: fc.oneof(fc.constant("inbound"), fc.constantFrom("outbound", "sideways", undefined)),
  platform: fc.oneof(fc.constant("imessage"), fc.constantFrom("sms", undefined)),
  content,
  sender: fc.oneof(fc.record({ id: senderId }), fc.constant(undefined), fc.constant(null)),
  space: spaceId,
  timestamp: fc.oneof(fc.date(), fc.constant(new Date(Number.NaN)), fc.constant(undefined), fc.integer()),
});

describe("Photon frames", () => {
  it(
    "survive arbitrary frames without breaking, and what arrives is complete, storable and correctly classified",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(frame, { minLength: 1, maxLength: 8 }), async (frames) => {
          const fake = fakeSpectrum();
          const channel = new PhotonChannel({ projectId: "p", projectSecret: "s", connect: fake.connect });
          const messages: InboundMessage[] = [];
          const reactions: InboundReaction[] = [];
          channel.onInbound((message) => void messages.push(message));
          channel.onReaction((reaction) => void reactions.push(reaction));
          await channel.start();
          await channel.waitUntilConnected(1_000);
          try {
            for (const f of frames) {
              const s = fake.space(f.space);
              fake.push(s, { ...f, space: s } as unknown as Message);
            }
            // Then the owner writes quite normally: that must arrive, over the same connection.
            const dm = fake.space(`any;-;${ALEX}`);
            fake.push(dm, { id: "sentinel", direction: "inbound", platform: "imessage", content: { type: "text", text: "noch da?" }, sender: { id: ALEX }, space: dm, timestamp: new Date() } as unknown as Message);
            await settle();

            expect(messages.at(-1)?.externalId).toBe("sentinel");
            expect(fake.connects()).toBe(1);
            expect(channel.isConnected()).toBe(true);

            for (const message of messages) {
              expect(message.from).toMatch(/\S/);
              expect(message.externalId).toMatch(/\S/);
              expect(typeof message.chatId).toBe("string");
              expect(message.chatId.length).toBeGreaterThan(0);
              expect(typeof message.text).toBe("string");
              expect(typeof message.replyToExternalId).toBe("string");
              expect(Number.isNaN(message.receivedAt.getTime())).toBe(false);
              expect(message.isGroup).toBe(message.chatId.includes(";+;"));
              expect(JSON.parse(JSON.stringify(message.raw))).toEqual(message.raw);
              const verdict = checkIngress(message, ALEX);
              if (verdict.allowed) {
                expect(message.isGroup).toBe(false);
                expect(normalizeE164(message.from)).toBe(ALEX);
              }
            }
            for (const reaction of reactions) {
              expect(reaction.from).toMatch(/\S/);
              expect(typeof reaction.messageId).toBe("string");
              expect(reaction.messageId.length).toBeGreaterThan(0);
              expect(typeof reaction.emoji).toBe("string");
              expect(reaction.emoji.length).toBeGreaterThan(0);
              expect(Number.isNaN(reaction.receivedAt.getTime())).toBe(false);
              expect(() => JSON.stringify(reaction.raw)).not.toThrow();
            }
          } finally {
            await channel.stop();
          }
        }),
        params(150),
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it("[regression] a frame without content or with a broken reply does not tear down the stream", async () => {
    const fake = fakeSpectrum();
    const channel = new PhotonChannel({ projectId: "p", projectSecret: "s", connect: fake.connect });
    const messages: InboundMessage[] = [];
    channel.onInbound((message) => void messages.push(message));
    await channel.start();
    await channel.waitUntilConnected(1_000);
    const dm = fake.space(`any;-;${ALEX}`);
    const base = { direction: "inbound", platform: "imessage", sender: { id: ALEX }, space: dm, timestamp: new Date() };
    for (const broken of [{ content: null }, { content: { type: "reply" } }, { content: { type: "reaction", emoji: "👍" } }, { content: { type: "text", text: 7 } }]) {
      fake.push(dm, { id: "kaputt", ...base, ...broken } as unknown as Message);
    }
    // A sender made of whitespace is none.
    fake.push(dm, { id: "leer", ...base, sender: { id: " \t" }, content: { type: "text", text: "wer?" } } as unknown as Message);
    fake.push(dm, { id: "danach", ...base, content: { type: "text", text: "hallo" } } as unknown as Message);
    await settle();
    expect(messages.map((message) => message.externalId)).toEqual(["danach"]);
    expect(fake.connects()).toBe(1);
    await channel.stop();
  });
});

describe("Photon sending (addendum D38 of 2026-10-13)", () => {
  /**
   * Photon as it behaved on 2026-10-13: a call arrives and answers (`ok`),
   * arrives and loses the response (`lost`), aborts before (`refused`) or is
   * rejected (`other`). A `clientMessageId` that already arrived is rejected by
   * the server with ALREADY_EXISTS (verified live).
   */
  const attempt = fc.constantFrom("ok", "lost", "refused", "other");
  const call = fc.record({
    text: fc.constantFrom("steht", "steht", "morgen 6 uhr", "ok"),
    attempts: fc.tuple(attempt, attempt),
    lookupWorks: fc.boolean(),
  });

  it(
    "never sends a duplicate, and what it reports as sent arrived exactly once",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(call, { minLength: 1, maxLength: 6 }), async (calls) => {
          const landed: Array<{ guid: string; text: string; clientMessageId: string }> = [];
          let current: (typeof calls)[number] | undefined;
          let tries = 0;
          const texts: PhotonApp["texts"] = {
            send: async (_chat, text, options) => {
              if (landed.some((entry) => entry.clientMessageId === options.clientMessageId)) {
                throw Object.assign(new Error("already processed"), { grpcCode: 6 });
              }
              const outcome = current!.attempts[tries]!;
              tries += 1;
              if (outcome === "refused") throw Object.assign(new Error("[upstream] read ECONNRESET"), { grpcCode: 14 });
              if (outcome === "other") throw Object.assign(new Error("Target not allowed"), { grpcCode: 7 });
              const guid = `g-${landed.length + 1}`;
              landed.push({ guid, text, clientMessageId: options.clientMessageId });
              if (outcome === "lost") throw Object.assign(new Error("[upstream] read ECONNRESET"), { grpcCode: 14 });
              return { guid };
            },
            ownSince: async () => {
              if (!current!.lookupWorks) throw new Error("Photon unreachable");
              return [...landed].reverse().map(({ guid, text }) => ({ guid, text }));
            },
            edit: async () => undefined,
          };
          const fake = fakeSpectrum();
          const channel = new PhotonChannel({
            projectId: "p",
            projectSecret: "s",
            connect: async () => ({ ...(await fake.connect()), texts }),
            retryDelayMs: 0,
          });
          await channel.start();
          await channel.waitUntilConnected(1_000);
          // Wordings that might have arrived without their channel ID becoming known.
          const unknownIds = new Set<string>();
          try {
            for (const c of calls) {
              current = c;
              tries = 0;
              const before = landed.length;
              const result = await channel.send(ALEX, c.text).then(
                (value) => ({ ok: true as const, value }),
                () => ({ ok: false as const }),
              );
              const mine = landed.slice(before);
              // Never more than one attempt after the first, never a duplicate.
              expect(tries).toBeLessThanOrEqual(2);
              expect(mine.length).toBeLessThanOrEqual(1);
              if (result.ok) {
                expect(mine).toHaveLength(1);
                // The channel ID is this message's or unknown, never that of an earlier one with the same wording.
                expect(["", mine[0]!.guid]).toContain(result.value.externalId);
                if (!result.value.externalId) unknownIds.add(c.text);
              } else {
                if (mine.length === 1) {
                  // Arrived and still reported as failed: only if the conversation was not readable or the same
                  // wording could already have arrived once without a channel ID. Better a duplicate later than a
                  // reply that counts as sent and never arrived.
                  expect(!c.lookupWorks || unknownIds.has(c.text)).toBe(true);
                }
                if (tries === 2 && c.attempts[1] !== "other") unknownIds.add(c.text);
              }
            }
          } finally {
            await channel.stop();
          }
        }),
        params(200),
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe("Ingress allowlist", () => {
  const owner = fc.constantFrom(ALEX, "+15550100199", "+491701234567");
  const from = fc.oneof(
    senderId.map((value) => String(value)),
    owner.map((number) => number.replace("+", "")),
    owner.map((number) => `${number.slice(0, 3)} ${number.slice(3, 6)}-${number.slice(6)}`),
    fc.tuple(owner, hostileString).map(([number, junk]) => `${number}${junk}`),
    fc.tuple(hostileString, owner).map(([junk, number]) => `${junk}${number}`),
  );

  it("lets only the owner through alone, never a group, never another number", () => {
    fc.assert(
      fc.property(from, fc.boolean(), owner, (sender, isGroup, ownerPhone) => {
        const verdict = checkIngress({ from: sender, isGroup }, ownerPhone);
        // Independent oracle: after removing whitespace and separators, exactly the number, with or without plus.
        const digits = sender.trim().replace(/[\s\-().]/g, "");
        const isOwner = digits === ownerPhone || `+${digits}` === ownerPhone;
        expect(verdict.allowed).toBe(isOwner && !isGroup);
        if (isGroup) expect(verdict.allowed).toBe(false);
      }),
      params(2_000),
    );
  });
});
