import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, InboundMessage, InboundReaction } from "../src/channel/types.js";
import { FakeMemoryStore } from "./memory-store.fake.js";

/** What happens before the model: allowlist, dedupe, kill switch, first message. */

const auditMock = vi.fn(async () => undefined);
let storeResult: { stored: boolean; message?: { id: string } } = {
  stored: true,
  message: { id: "db-1" },
};

vi.mock("../src/db/audit.js", () => ({
  audit: (...args: unknown[]) => auditMock(...(args as [])),
  toolActionsFor: async () => [],
  outboundOrigin: async () => null,
  reactionsFor: async () => new Map(),
  turnRetriesFor: async () => new Map(),
}));
vi.mock("../src/db/usage.js", () => ({
  monthUsage: async () => ({ apiCostUsd: 0 }),
}));
const storedInbound: InboundMessage[] = [];
vi.mock("../src/db/messages.js", () => ({
  storeInbound: async (message: InboundMessage) => (storedInbound.push(message), storeResult),
  storeOutbound: async () => ({ id: "db-out", created_at: new Date().toISOString() }),
  recentMessages: async () => [],
  recentOutboundFingerprints: async () => [],
}));
let killCommand: "engage" | "release" | null = null;
let killEngaged = false;
// The owner's language is not read from the database in tests (src/i18n/language.ts); detection stays real.
vi.mock("../src/i18n/language.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/i18n/language.js")>()),
  loadOwnerLanguage: async () => "de",
}));
vi.mock("../src/security/killswitch.js", () => ({
  detectKillSwitchCommand: () => killCommand,
  KillSwitch: class {
    get engaged() {
      return killEngaged;
    }
    async load() {
      return { engaged: killEngaged, since: null };
    }
    async engage() {
      killEngaged = true;
    }
    async release() {
      killEngaged = false;
    }
  },
}));
vi.mock("../src/health/heartbeat.js", () => ({
  startHeartbeat: () => ({ stop() {} }),
}));
vi.mock("../src/health/status.js", () => ({
  recordComponentStatus: async () => undefined,
  markPlannedStop: async () => undefined,
}));
// Watchers (D43): in the scheduler's tick, here without a single one.
vi.mock("../src/db/watchers.js", () => ({
  watcherStore: {
    insert: async () => {
      throw new Error("no watcher in the test");
    },
    active: async () => [],
    countActive: async () => 0,
    due: async () => [],
    claim: async () => false,
    update: async () => false,
    cancel: async () => false,
  },
  watchPollerState: { load: async () => ({ hitDay: null, hitCount: 0 }), save: async () => undefined },
}));
vi.mock("../src/memory/index.js", () => ({
  // Proposals (D42) only read here whether there is something to ask: never.
  defaultMemoryDeps: () => ({ store: new FakeMemoryStore(), embed: async () => [], now: () => new Date() }),
  // The nightly consolidation (D40) has nothing to do here.
  afterMemory: async <T,>(work: () => Promise<T>) => work(),
  maybeConsolidate: async () => "skipped",
  maybeClassifyAreas: async () => ({ classified: 0, more: false }),
  buildMemoryContext: async () => ({ userModel: "", facts: [], summaries: [], question: null }),
  renderMemory: () => "",
  markQuestionShown: async () => undefined,
  afterTurn: async () => undefined,
}));
vi.mock("../src/agent/tools/memory.js", () => ({ memoryTools: () => [] }));
vi.mock("../src/db/audit-probe.js", () => ({
  auditProbe: {},
  selftestState: { lastRunAt: async () => new Date(), record: async () => undefined },
}));
// The heartbeat (D9) looks along in the scheduler's tick. Here it has only just
// looked, so it interferes with none of these tests.
vi.mock("../src/db/proactive.js", () => ({
  calendarEvents: () => async () => null,
  heartbeatState: {
    load: async () => ({
      lastCheckedAt: new Date().toISOString(),
      lastLookedAt: new Date().toISOString(),
      sentDay: null,
      sentCount: 0,
      behaviorVersion: 1,
      probationSince: null,
      travelSeen: {},
      deadlinesSeen: {},
      calendarSnapshot: {},
      morningDay: null,
    }),
    save: async () => undefined,
  },
  heartbeatSignals: {
    lastMessageAt: async () => null,
    inboundSince: async () => 0,
    dueCommitments: async () => [],
    ownCalendarEdits: async () => [],
    channelRatio: async () => 0,
  },
}));
// Broken access and expiring grants (D55): there are none here. Without this
// dummy every stop asks the dead database address and hangs for seconds.
vi.mock("../src/db/connectors.js", () => ({ connectorStore: { connected: async () => [] } }));
vi.mock("../src/db/integration-health.js", () => ({
  integrationIncidents: { find: async () => null, open: async () => null, close: async () => undefined, markNotified: async () => undefined },
  connectorExpiryWarned: { load: async () => ({}), save: async () => undefined },
}));
// Missions (D63) in memory: the runtime loads them at start.
vi.mock("../src/db/missions.js", async () => {
  const { FakeMissionStore } = await import("./mission-store.fake.js");
  return { missionStore: new FakeMissionStore() };
});
vi.mock("../src/db/schedules.js", async () => {
  const { FakeMissedReminderStore, FakeScheduleStore } = await import("./schedule-store.fake.js");
  return { scheduleStore: new FakeScheduleStore(), missedReminderStore: new FakeMissedReminderStore() };
});
vi.mock("../src/db/recovery.js", async () => {
  const { FakeRecoveryStore } = await import("./recovery-store.fake.js");
  return { recoveryStore: new FakeRecoveryStore() };
});
vi.mock("../src/db/approvals.js", async () => {
  const { FakeApprovalStore } = await import("./approvals-store.fake.js");
  return { approvalStore: new FakeApprovalStore(), activeGrantKeys: async () => [] };
});
const claimFirstMessage = vi.fn(async () => false);
vi.mock("../src/hello.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, claimFirstMessage: () => claimFirstMessage() };
});
vi.mock("../src/agent/turn.js", () => ({
  runTurn: async () => ({
    provider: "subscription",
    model: "sonnet",
    costUsd: 0,
    text: "",
    messagesSent: 0,
    reactionsSent: 0,
    steps: 1,
    stopReason: "end_turn",
    usedTextFallback: false,
    factExtractionBlocked: false,
    deferred: [],
  }),
}));
vi.mock("../src/budget.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, claimBudgetWarnings: async () => [] };
});

const { Runtime } = await import("../src/runtime.js");
const { env } = await import("../src/config/env.js");
const { helloMessage } = await import("../src/hello.js");

type InboundHandler = (message: InboundMessage) => void | Promise<void>;
type ReactionHandler = (reaction: InboundReaction) => void | Promise<void>;

function fakeChannel(options: { reactions?: boolean } = {}): {
  channel: Channel;
  deliver: (message: InboundMessage) => Promise<void>;
  sent: string[];
  reactions: Array<{ messageId: string; emoji: string }>;
} {
  let handler: InboundHandler = () => undefined;
  let reactionHandler: ReactionHandler = () => undefined;
  void reactionHandler;
  const sent: string[] = [];
  const reactions: Array<{ messageId: string; emoji: string }> = [];
  const channel: Channel = {
    name: "photon",
    capabilities: {
      reactions: options.reactions ?? true,
      typing: false,
      readReceipts: false,
      replyThreads: false,
      attachments: false,
      formatting: false,
      effects: false,
      edit: false,
      files: false,
      voice: false,
      richLinks: false,
    },
    async start() {},
    async stop() {},
    isConnected: () => true,
    async waitUntilConnected() {},
    async send(_to: string, text: string) {
      sent.push(text);
      return { externalId: "out-1", chatId: "c" };
    },
    async react(_to: string, messageId: string, emoji: string) {
      reactions.push({ messageId, emoji });
    },
    async typing() {},
    async markRead() {},
    onReaction(cb: ReactionHandler) {
      reactionHandler = cb;
    },
    onInbound(cb: InboundHandler) {
      handler = cb;
    },
  } as unknown as Channel;
  return {
    channel,
    deliver: async (message) => void (await handler(message)),
    sent,
    reactions,
  };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: "photon",
    externalId: "m-1",
    chatId: "c-1",
    from: env.ownerPhone,
    isGroup: false,
    text: "hi",
    attachments: [],
    raw: {},
    ...overrides,
  } as InboundMessage;
}

async function deliverOne(message: InboundMessage): Promise<void> {
  const { channel, deliver } = fakeChannel();
  const runtime = new Runtime(channel);
  await runtime.start();
  await deliver(message);
  await runtime.stop();
}

beforeEach(() => {
  auditMock.mockClear();
  claimFirstMessage.mockClear();
  claimFirstMessage.mockResolvedValue(false);
  killCommand = null;
  killEngaged = false;
  storeResult = { stored: true, message: { id: "db-1" } };
  storedInbound.length = 0;
});

/**
 * The kill switch itself is unchanged (regex, before the model, state per
 * message from the DB). Only the acknowledgement is a tapback now: the owner
 * knows what they wrote, a sentence would only be noise. But a kill switch must
 * never stay without any feedback, hence the text path as the emergency exit.
 */
describe("kill switch acknowledged by tapback", () => {
  async function run(options: { reactions?: boolean } = {}): Promise<{
    sent: string[];
    reactions: Array<{ messageId: string; emoji: string }>;
  }> {
    const { channel, deliver, sent, reactions } = fakeChannel(options);
    const runtime = new Runtime(channel);
    await runtime.start();
    await deliver(inbound({ text: "serain stopp", externalId: "m-stop" }));
    await runtime.stop();
    return { sent, reactions };
  }

  it("acknowledges \"serain stopp\" with 👍 and without text", async () => {
    killCommand = "engage";
    const { sent, reactions } = await run();
    expect(reactions).toEqual([{ messageId: "m-stop", emoji: "👍" }]);
    expect(sent).toEqual([]);
    expect(killEngaged).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(
      "outbound_ack",
      expect.objectContaining({ via: "reaction", command: "engage" }),
    );
  });

  it("acknowledges \"serain weiter\" with 👍 and releases", async () => {
    killEngaged = true;
    killCommand = "release";
    const { sent, reactions } = await run();
    expect(reactions).toEqual([{ messageId: "m-stop", emoji: "👍" }]);
    expect(sent).toEqual([]);
    expect(killEngaged).toBe(false);
  });

  it("falls back to text when the channel cannot do tapbacks", async () => {
    killCommand = "engage";
    const { sent, reactions } = await run({ reactions: false });
    expect(reactions).toEqual([]);
    expect(sent).toEqual(["gestoppt. ich mach nichts mehr, bis du „serain weiter“ schreibst."]);
    expect(auditMock).toHaveBeenCalledWith(
      "outbound_ack",
      expect.objectContaining({ via: "text", command: "engage" }),
    );
  });

  it("still does not handle a message at all while stopped", async () => {
    killEngaged = true;
    const { sent, reactions } = await run();
    expect(sent).toEqual([]);
    expect(reactions).toEqual([]);
    expect(auditMock).toHaveBeenCalledWith(
      "kill_switch",
      expect.objectContaining({ skipped: true }),
      "db-1",
    );
  });
});

describe("greeting at start", () => {
  it("sends the first message only when the marker was free", async () => {
    claimFirstMessage.mockResolvedValue(true);
    const { channel, sent } = fakeChannel();
    const runtime = new Runtime(channel);
    await runtime.start();
    await runtime.stop();
    expect(sent).toEqual([helloMessage()]);
    expect(sent[0]).toContain("„serain stopp“");
  });

  it("stays silent at every later start", async () => {
    const { channel, sent } = fakeChannel();
    const runtime = new Runtime(channel);
    await runtime.start();
    await runtime.stop();
    expect(sent).toEqual([]);
  });
});

describe("allowlist and dedupe before anything else", () => {
  it("drops a foreign number before anything is stored", async () => {
    await deliverOne(inbound({ from: "+15551234567", externalId: "m-fremd" }));
    expect(auditMock).toHaveBeenCalledWith(
      "inbound_rejected",
      expect.objectContaining({ reason: "unknown_sender", channel: "photon" }),
    );
    expect(auditMock).not.toHaveBeenCalledWith("inbound", expect.anything(), expect.anything());
  });

  it("drops a message delivered twice", async () => {
    storeResult = { stored: false };
    await deliverOne(inbound());
    expect(auditMock).toHaveBeenCalledWith("inbound_duplicate", expect.objectContaining({ external_id: "m-1" }));
    expect(auditMock).not.toHaveBeenCalledWith("inbound", expect.anything(), expect.anything());
  });
});

/**
 * Two-step codes (D56): the owner's answer to the question for a code is
 * intercepted before storing. It reaches neither model nor history; only a
 * placeholder is in `messages`.
 */
describe("code for a login", () => {
  type WithCodes = { codes: { request(site: string): Promise<string | null> } };

  it("goes straight to the waiting login, only a placeholder is stored", async () => {
    const { channel, deliver, sent, reactions } = fakeChannel();
    const runtime = new Runtime(channel);
    await runtime.start();
    const pending = (runtime as unknown as WithCodes).codes.request("bahn");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent[0]).toContain("Die Anmeldung bei bahn will einen Code");
    await deliver(inbound({ text: "483920", externalId: "m-code", raw: { text: "483920" } }));
    expect(await pending).toBe("483920");
    expect(JSON.stringify(storedInbound)).not.toContain("483920");
    expect(storedInbound[0]?.text).toContain("entered by the system");
    expect(reactions).toEqual([{ messageId: "m-code", emoji: "👍" }]);
    // No turn: the arrival shows only as `site_code`, never as `inbound`.
    expect(auditMock).toHaveBeenCalledWith("site_code", { site: "bahn", late: false }, "db-1");
    expect(auditMock).not.toHaveBeenCalledWith("inbound", expect.anything(), expect.anything());
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain("483920");
    await runtime.stop();
  });

  it("lets a number without a waiting login go the normal way", async () => {
    await deliverOne(inbound({ text: "483920" }));
    expect(storedInbound[0]?.text).toBe("483920");
  });
});
