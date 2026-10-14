import { randomUUID } from "node:crypto";
import {
  Spectrum,
  SpectrumCloudError,
  attachment as attachmentContent,
  reaction as reactionContent,
  reply as replyContent,
  type Content,
  type Message,
  type PlatformProviderConfig,
  type Space,
  voice as voiceContent,
} from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import type {
  Channel,
  ChannelCapabilities,
  FetchedAttachment,
  InboundAttachment,
  InboundMessage,
  InboundReaction,
  MessageEffect,
  OutboundFile,
  SendExtras,
  SendResult,
  TextStyle,
} from "../types.js";
import { normalizeE164 } from "../e164.js";
import { log } from "../../log.js";

export const PHOTON_CHANNEL = "photon";

/**
 * What the adapter needs from Spectrum. Its own narrow shape, so tests can plug
 * in a fake without reaching Photon's cloud.
 */
export interface PhotonApp {
  readonly messages: AsyncIterable<[Space, Message]>;
  /** The 1:1 conversation with a number, even without a previous message. */
  dm(peer: string): Promise<Space>;
  /** Texts past Spectrum via Photon, with `clientMessageId` (addendum D38 of 2026-10-13). */
  readonly texts: PhotonTexts;
  stop(): Promise<void>;
}

/**
 * Text, thread reply, link preview and editing via Photon's own SDK
 * (`@photon-ai/advanced-imessage`), which Spectrum itself sends on. Spectrum
 * does not pass a `clientMessageId` through; without it a second attempt after
 * an abort could be a duplicate.
 */
export interface PhotonTexts {
  send(chat: string, text: string, options: PhotonTextOptions): Promise<{ guid: string }>;
  /** Own messages in the conversation created after `after`. */
  ownSince(chat: string, after: Date): Promise<Array<{ guid: string; text: string }>>;
  edit(chat: string, guid: string, text: string): Promise<void>;
}

export interface PhotonTextOptions {
  /** Photon executes it at most once: a second call with the same ID fails with ALREADY_EXISTS. */
  clientMessageId: string;
  replyTo?: string | { guid: string; partIndex: number };
  formatting?: Array<{ type: TextStyle["type"]; start: number; length: number }>;
  /** Apple's identifier of the effect. */
  effect?: string;
  enableLinkPreview?: boolean;
}

export interface PhotonAdapterOptions {
  projectId: string;
  projectSecret: string;
  /** Replacement for Spectrum, tests only. */
  connect?: () => Promise<PhotonApp>;
  /** Photon rejects the credentials for good. Serain then exits. */
  onFatal?: (status: number, reason: string) => void;
  /** Read receipt for a message Serain sent. */
  onStatus?: (status: { externalId: string; status: string; detail: Record<string, unknown> }) => void;
  /** Pause before the second send attempt, tests only. */
  retryDelayMs?: number;
}

/**
 * Spectrum's types assume `exactOptionalPropertyTypes: false`; under Serain's
 * stricter setting the conditional types of `config()` collapse to `never`.
 * Calling it without arguments is the documented way (access via the project),
 * hence the one cast here at the boundary to the SDK.
 */
const imessageProvider = (imessage.config as unknown as () => PlatformProviderConfig)();

/** The part of Photon's SDK client that `PhotonTexts` needs. */
interface PhotonMessagesApi {
  sendText(chat: string, text: string, options: PhotonTextOptions): Promise<{ guid: string }>;
  listInChat(
    chat: string,
    filter: { pageSize: number; isFromMe: boolean; after: Date },
  ): Promise<{ messages: ReadonlyArray<{ guid: string; content: { text?: string } }> }>;
  edit(chat: string, message: string, newText: string): Promise<unknown>;
}

/**
 * Photon's client from Spectrum's runtime: the same connection and the same
 * token renewal Spectrum sends with. Spectrum keeps it under `__internal` and
 * offers no public way to it; this is the second spot at the boundary to the
 * SDK, pinned to Spectrum 12.10.1. If it is missing, connecting already fails,
 * loudly, instead of sending only later running into nothing.
 */
function photonMessages(app: unknown): () => PhotonMessagesApi {
  const runtime = (app as { __internal?: { platforms?: Map<string, { client?: unknown }> } }).__internal?.platforms?.get("imessage");
  const lines = runtime?.client as Array<{ client?: { messages?: PhotonMessagesApi } }> | undefined;
  if (!Array.isArray(lines) || typeof lines[0]?.client?.messages?.sendText !== "function") {
    throw new Error("Spectrum: Photon's iMessage client not found");
  }
  // Spectrum reconciles the lines on every token renewal: look only when sending.
  return () => {
    const messages = lines.length === 1 ? lines[0]?.client?.messages : undefined;
    if (!messages) throw new Error(`Photon: ${lines.length} lines instead of one`);
    return messages;
  };
}

/** Spectrum with exactly the iMessage provider, without telemetry. */
async function connectSpectrum(projectId: string, projectSecret: string): Promise<PhotonApp> {
  const app = await Spectrum({
    projectId,
    projectSecret,
    providers: [imessageProvider],
    // Multi-part messages (text plus photo) arrive as separate messages; the
    // runtime's debounce merges them back into one turn.
    options: { flattenGroups: true, logLevel: "warn" },
    telemetry: false,
  });
  const im = imessage(app);
  let messages: () => PhotonMessagesApi;
  try {
    messages = photonMessages(app);
  } catch (error) {
    await app.stop().catch(() => undefined);
    throw error;
  }
  return {
    messages: app.messages,
    // In the shared pool the chat ID of a 1:1 conversation is deterministic.
    dm: async (peer) => im.space.get(`any;-;${peer}`),
    texts: {
      send: (chat, text, options) => messages().sendText(chat, text, options),
      ownSince: async (chat, after) =>
        (await messages().listInChat(chat, { pageSize: 10, isFromMe: true, after })).messages.map((message) => ({
          guid: message.guid,
          text: message.content.text ?? "",
        })),
      edit: async (chat, guid, text) => {
        await messages().edit(chat, guid, text);
      },
    },
    stop: () => app.stop(),
  };
}

/** Status codes after which a new attempt is pointless: credentials wrong or blocked. */
const FATAL_STATUS = new Set([401, 403]);
/**
 * Pause before the second send attempt. Photon's gateway reports `[upstream]
 * read ECONNRESET` when its backend connection drops (addendum D38 of
 * 2026-10-13); Spectrum does not retry that, because Photon does not mark it as
 * retryable.
 */
const SEND_RETRY_DELAY_MS = 2_000;
/** gRPC UNAVAILABLE: the call did not complete; only Photon knows whether it took effect. */
const GRPC_UNAVAILABLE = 14;
/** gRPC ALREADY_EXISTS: the same `clientMessageId` already went through (verified live 2026-10-13). */
const GRPC_ALREADY_EXISTS = 6;
/** How far before the first attempt the adapter looks for the message Photon reports as already sent (clocks differ). */
const SENT_LOOKUP_SLACK_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/** How many inbound messages the adapter remembers for tapbacks, threads and attachments. */
const RECENT_MESSAGES = 200;
/**
 * How many conversations the adapter remembers. It sees every sender before the
 * allowlist one level up discards them; without a bound, memory would grow with
 * every stranger who writes to the shared number. Serain only talks to the
 * owner; `spaceFor` fetches an evicted conversation from Photon again.
 */
const KNOWN_PEERS = 50;

/** Serain's effect names as Apple's identifiers, as Spectrum lists them. */
const EFFECT_IDS: Record<MessageEffect, (typeof imessage.effect.message)[keyof typeof imessage.effect.message]> =
  imessage.effect.message;

/** Content with bytes to fetch later: file attachment or voice message. */
type MediaContent = Extract<Content, { type: "attachment" | "voice" }>;

function remember<K, V>(map: Map<K, V>, key: K, value: V, limit = RECENT_MESSAGES): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next().value as K;
    map.delete(oldest);
  }
}

/**
 * Photon adapter (D2, D38). Holds an outbound gRPC stream via Spectrum to
 * Photon's iMessage lines: no open port, no webhook (D10). Knows neither the
 * allowlist nor the model; security sits one level above, so swapping the
 * adapter cannot undermine it.
 *
 * Spectrum works with objects (`Space`, `Message`), Serain with IDs and
 * numbers. The adapter translates: it remembers the latest inbound messages so
 * a tapback or a thread reply finds its target, and the media contents so a
 * turn only fetches the bytes when it reads them.
 */
export class PhotonChannel implements Channel {
  readonly name = PHOTON_CHANNEL;
  readonly capabilities: ChannelCapabilities = {
    reactions: true,
    typing: true,
    readReceipts: true,
    replyThreads: true,
    attachments: true,
    // Bold, italic, strikethrough via `markdown()`, effects via `effect()`,
    // editing via `edit()`. Verified against Photon Free on 2026-10-02 (D48).
    formatting: true,
    effects: true,
    edit: true,
    // Spectrum uploads the bytes and sends them as an attachment (`attachments.upload`).
    files: true,
    // Spectrum sends `voice()` with `isAudioMessage: true`; verified against
    // Photon Free on 2026-10-08: `is_audio_message = 1` for the recipient (D59).
    voice: true,
    // Spectrum sends `richlink()` as `sendText(url, { enableLinkPreview: true })`: Photon's Mac
    // fetches the preview (addendum D48 of 2026-10-08).
    richLinks: true,
  };

  private readonly connect: () => Promise<PhotonApp>;
  private readonly onFatal: PhotonAdapterOptions["onFatal"];
  private readonly onStatus: PhotonAdapterOptions["onStatus"];
  private readonly retryDelayMs: number;
  private app: PhotonApp | null = null;
  private connected = false;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private connectedWaiters: Array<() => void> = [];
  private handler: ((message: InboundMessage) => void | Promise<void>) | null = null;
  private reactionHandler: ((reaction: InboundReaction) => void | Promise<void>) | null = null;
  private readonly spaces = new Map<string, Space>();
  private readonly recent = new Map<string, Message>();
  private readonly lastInbound = new Map<string, Message>();
  private readonly media = new Map<string, MediaContent>();
  /** Self-sent texts with their conversation: only these can be edited. */
  private readonly sentTexts = new Map<string, string>();
  /** Wordings that arrived or might have arrived without a known channel ID: a search for them would be ambiguous. */
  private readonly unresolved = new Map<string, number>();
  private readonly unknownTypes = new Set<string>();

  constructor(opts: PhotonAdapterOptions) {
    this.connect = opts.connect ?? (() => connectSpectrum(opts.projectId, opts.projectSecret));
    this.onFatal = opts.onFatal;
    this.onStatus = opts.onStatus;
    this.retryDelayMs = opts.retryDelayMs ?? SEND_RETRY_DELAY_MS;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.loop ??= this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const app = this.app;
    this.app = null;
    this.connected = false;
    await app?.stop().catch((error: unknown) => log.warn("Photon: unclean stop:", error));
    await this.loop;
    this.loop = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async waitUntilConnected(timeoutMs: number): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectedWaiters = this.connectedWaiters.filter((entry) => entry !== waiter);
        reject(new Error(`Photon connection not established within ${timeoutMs} ms`));
      }, timeoutMs);
      const waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      this.connectedWaiters.push(waiter);
    });
  }

  onInbound(handler: (message: InboundMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  onReaction(handler: (reaction: InboundReaction) => void | Promise<void>): void {
    this.reactionHandler = handler;
  }

  async send(to: string, text: string, extras: SendExtras = {}): Promise<SendResult> {
    const space = await this.spaceFor(to);
    return this.sendText(space, text, textOptions(extras));
  }

  /** File, with `replyToExternalId` in the thread; if the message is not found, without a thread like `sendReply`. */
  async sendFile(to: string, file: OutboundFile, replyToExternalId?: string): Promise<SendResult> {
    const space = await this.spaceFor(to);
    const content = file.voice
      ? voiceContent(file.body, { name: file.name, mimeType: file.mimeType })
      : attachmentContent(file.body, { name: file.name, mimeType: file.mimeType });
    const target = replyToExternalId ? await this.findMessage(replyToExternalId, space) : undefined;
    if (replyToExternalId && !target) log.warn(`Photon: thread target ${replyToExternalId} not found, sending file without thread`);
    return this.result(space, await space.send(target ? replyContent(content, target) : content));
  }

  /** Link preview, with `replyToExternalId` in the thread; if the message is not found, without a thread. */
  async sendRichLink(to: string, url: string, replyToExternalId?: string): Promise<SendResult> {
    const space = await this.spaceFor(to);
    const target = replyToExternalId ? await this.findMessage(replyToExternalId, space) : undefined;
    if (replyToExternalId && !target) log.warn(`Photon: thread target ${replyToExternalId} not found, sending preview without thread`);
    // Like Spectrum's `richlink()`: the URL as text, Photon's Mac fetches the preview.
    return this.sendText(space, url, { enableLinkPreview: true, ...(target ? { replyTo: replyTarget(target.id) } : {}) });
  }

  /**
   * Reply in a thread. If the adapter cannot find the message (older than its
   * memory and no longer retrievable from Photon), the reply goes out normally:
   * better without a thread than not at all.
   */
  async sendReply(to: string, text: string, replyToExternalId: string, extras: SendExtras = {}): Promise<SendResult> {
    const space = await this.spaceFor(to);
    const target = await this.findMessage(replyToExternalId, space);
    if (!target) log.warn(`Photon: thread target ${replyToExternalId} not found, sending without thread`);
    return this.sendText(space, text, { ...textOptions(extras), ...(target ? { replyTo: replyTarget(target.id) } : {}) });
  }

  /**
   * Editing only for texts this process sent: after a restart a message can no
   * longer be changed, and Apple only allows it for 15 minutes anyway. Only the
   * text changes; emphasis is lost when editing.
   */
  async edit(externalId: string, text: string): Promise<void> {
    const chat = this.sentTexts.get(externalId);
    const app = this.app;
    if (chat === undefined || !app) throw new Error("the channel no longer knows this message");
    await app.texts.edit(chat, externalId, text);
  }

  /**
   * A tapback sets a state, it does not append a message: a second attempt with
   * the same emoji changes nothing that already arrived. So after an abort it
   * simply goes out once more (addendum D38 of 2026-10-13).
   */
  async react(to: string, messageId: string, emoji: string): Promise<void> {
    // Search in the owner's conversation, not only in known ones: after a restart
    // the adapter knows none until someone writes (D52).
    const target = await this.findMessage(messageId, await this.spaceFor(to));
    if (!target) throw new Error("message for the tapback not found");
    const sent = await this.once(() => target.space.send(reactionContent(emoji, target)), "tapback");
    if (!sent) throw new Error("Photon did not confirm the tapback");
  }

  async typing(to: string, on: boolean): Promise<void> {
    const space = await this.spaceFor(to);
    await (on ? space.startTyping() : space.stopTyping());
  }

  /** iMessage only knows "chat read"; the target is the owner's last message. */
  async markRead(to: string): Promise<void> {
    const target = normalizeE164(to);
    const last = target ? this.lastInbound.get(target) : undefined;
    if (!last) return;
    await last.space.read(last);
  }

  async fetchAttachment(attachment: InboundAttachment, maxBytes: number): Promise<FetchedAttachment> {
    const content = this.media.get(attachment.id);
    if (!content) throw new Error("the attachment is no longer retrievable");
    if (content.size !== undefined && content.size > maxBytes) {
      throw new Error(`the attachment is larger than ${Math.round(maxBytes / 1_048_576)} MB`);
    }
    const reader = (await content.stream()).getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value as Uint8Array);
        total += chunk.length;
        if (total > maxBytes) {
          throw new Error(`the attachment is larger than ${Math.round(maxBytes / 1_048_576)} MB`);
        }
        chunks.push(chunk);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return { body: Buffer.concat(chunks), contentType: content.mimeType };
  }

  /**
   * Connect, read, reconnect with a growing pause after an abort. Spectrum keeps
   * the stream alive itself and catches up after short drops; if it still ends
   * or throws, everything starts over here.
   */
  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        const app = await this.connect();
        if (this.stopped) {
          await app.stop();
          return;
        }
        this.app = app;
        this.connected = true;
        attempt = 0;
        log.info("Photon: connected");
        for (const resolve of this.connectedWaiters.splice(0)) resolve();
        for await (const [space, message] of app.messages) {
          // A broken frame must not tear down the stream: otherwise the adapter
          // reconnects, and if Photon redelivers the same frame, Serain hangs in
          // a loop and no longer hears the owner (fuzzing 2026-10-04).
          try {
            this.onMessage(space, message);
          } catch (error) {
            log.warn("Photon: frame discarded:", (error as Error).message);
          }
        }
        if (!this.stopped) log.warn("Photon: message stream ended, reconnecting");
      } catch (error) {
        if (error instanceof SpectrumCloudError && FATAL_STATUS.has(error.status)) {
          this.connected = false;
          this.stopped = true;
          this.onFatal?.(error.status, error.code);
          return;
        }
        if (!this.stopped) log.error("Photon: connection lost:", (error as Error).message);
      }
      this.connected = false;
      const app = this.app;
      this.app = null;
      await app?.stop().catch(() => undefined);
      if (this.stopped) return;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS)));
    }
  }

  private onMessage(space: Space, message: Message): void {
    if (message.direction !== "inbound" || message.platform !== "imessage") return;
    const content = message.content as Content | null | undefined;
    if (!content || typeof content !== "object") return;
    if (content.type === "reaction") {
      this.dispatchReaction(message, text(content.emoji), text(content.target?.id));
      return;
    }
    if (content.type === "read") {
      const target = text(content.target?.id);
      if (target) this.onStatus?.({ externalId: target, status: "read", detail: {} });
      return;
    }
    const inbound = this.normalizeInbound(space, message);
    if (!inbound) return;
    void Promise.resolve(this.handler?.(inbound)).catch((error: unknown) => {
      log.error("Inbound handler failed:", error);
    });
  }

  private dispatchReaction(message: Message, emoji: string, targetId: string): void {
    const from = this.senderOf(message);
    if (!from || !targetId || !emoji) {
      log.warn("Photon: tapback without sender or target discarded");
      return;
    }
    const reaction: InboundReaction = {
      channel: PHOTON_CHANNEL,
      from,
      messageId: targetId,
      emoji,
      receivedAt: receivedAt(message),
      raw: { id: text(message.id), type: "reaction", target: targetId, emoji },
    };
    void Promise.resolve(this.reactionHandler?.(reaction)).catch((error: unknown) => {
      log.error("Reaction handler failed:", error);
    });
  }

  private normalizeInbound(space: Space, message: Message): InboundMessage | null {
    const from = this.senderOf(message);
    if (!from) {
      log.warn("Photon: message without sender discarded");
      return null;
    }
    // Without message and conversation ID there is neither dedupe nor group detection: discard instead of guessing.
    const externalId = text(message.id);
    const chatId = text(space?.id);
    if (!externalId || !chatId) {
      log.warn("Photon: message without ID or conversation discarded");
      return null;
    }
    let content = message.content;
    let replyTo = "";
    if (content.type === "reply") {
      replyTo = text(content.target?.id);
      content = content.content;
      if (!content || typeof content !== "object") return null;
    }
    let body = "";
    const attachments: InboundAttachment[] = [];
    switch (content.type) {
      // Without text as a string the frame is broken, not an empty message from the owner.
      case "text":
        if (typeof content.text !== "string") return null;
        body = content.text;
        break;
      // A sent link arrives as a rich link; for Serain it is text.
      case "richlink":
        if (typeof content.url !== "string") return null;
        body = content.url;
        break;
      case "attachment":
      case "voice": {
        const id = text(content.id) || `${externalId}:media`;
        remember(this.media, id, content);
        const mimeType = text(content.mimeType);
        const name = text(content.name);
        const size = typeof content.size === "number" && Number.isFinite(content.size) ? content.size : undefined;
        attachments.push({
          id,
          ...(mimeType ? { mimeType } : {}),
          ...(name ? { name } : {}),
          ...(size !== undefined ? { size } : {}),
        });
        break;
      }
      default:
        // Serain does not need polls, contact cards, edits and group events.
        // Name each type once per process, so it stays visible what Photon
        // delivers.
        {
          const type = String((content as { type?: unknown }).type).slice(0, 40);
          if (!this.unknownTypes.has(type) && this.unknownTypes.size < 20) {
            this.unknownTypes.add(type);
            log.info(`Photon: content of type ${type} not processed`);
          }
        }
        return null;
    }

    // The same rule as in Photon's provider: group chats carry `;+;` in the ID.
    const isGroup = chatId.includes(";+;");
    remember(this.recent, externalId, message);
    if (!isGroup) {
      remember(this.spaces, from, space, KNOWN_PEERS);
      remember(this.lastInbound, from, message, KNOWN_PEERS);
    }
    return {
      channel: PHOTON_CHANNEL,
      externalId,
      from,
      chatId,
      isGroup,
      participants: [],
      text: body.trim(),
      replyToExternalId: replyTo,
      attachments,
      receivedAt: receivedAt(message),
      // Only what can be stored. The Message object carries functions and cycles.
      raw: {
        id: externalId,
        type: message.content.type,
        space: chatId,
        sender: text(message.sender?.id) || null,
        reply_to: replyTo || null,
        attachments,
      },
    };
  }

  private senderOf(message: Message): string | null {
    // Whitespace only is no sender; an email address is, and the allowlist then discards it visibly.
    const raw = text(message.sender?.id).trim();
    if (!raw) return null;
    return normalizeE164(raw) ?? raw;
  }

  private async spaceFor(to: string): Promise<Space> {
    const target = normalizeE164(to);
    if (!target) throw new Error("send target is not a valid number");
    const known = this.spaces.get(target);
    if (known) return known;
    const app = this.app;
    if (!app) throw new Error("Photon is not connected");
    const space = await app.dm(target);
    remember(this.spaces, target, space, KNOWN_PEERS);
    return space;
  }

  /**
   * A text via Photon's SDK, with one `clientMessageId` for both attempts
   * (addendum D38 of 2026-10-13). If the first aborts with UNAVAILABLE, the
   * same call goes out again after `SEND_RETRY_DELAY_MS`. If the first did
   * arrive after all, Photon rejects the second with ALREADY_EXISTS: then it is
   * sent, and the channel ID comes from the conversation. If the second aborts
   * too, the conversation decides: if the text is there, it arrived; otherwise
   * it throws, and the turn delivers the reply later (addendum D52).
   */
  private async sendText(space: Space, text: string, options: Omit<PhotonTextOptions, "clientMessageId">): Promise<SendResult> {
    const call = { ...options, clientMessageId: randomUUID() };
    const startedAt = Date.now();
    const texts = () => {
      if (!this.app) throw new Error("Photon is not connected");
      return this.app.texts;
    };
    let guid: string;
    let retried = false;
    try {
      guid = (await texts().send(space.id, text, call)).guid;
    } catch (error) {
      if (grpcCode(error) !== GRPC_UNAVAILABLE) throw error;
      log.warn(`Photon: send aborted (${(error as Error).message}), second attempt with the same clientMessageId`);
      await sleep(this.retryDelayMs);
      retried = true;
      try {
        guid = (await texts().send(space.id, text, call)).guid;
      } catch (second) {
        const code = grpcCode(second);
        if (code === GRPC_ALREADY_EXISTS) {
          log.warn("Photon: the first attempt did arrive, no duplicate sent");
          // Without a channel ID it still counts as delivered; only a 👍 on it then finds nothing.
          guid = (await this.sentSince(space.id, text, startedAt)) ?? "";
          if (!guid) remember(this.unresolved, text, Date.now(), KNOWN_PEERS);
        } else {
          const found = code === GRPC_UNAVAILABLE ? await this.sentSince(space.id, text, startedAt) : null;
          if (found === null) {
            // Whether it arrived after all stays open: the same wording is ambiguous for the next search.
            if (code === GRPC_UNAVAILABLE) remember(this.unresolved, text, Date.now(), KNOWN_PEERS);
            throw second;
          }
          log.warn("Photon: second attempt aborted, but the message is in the conversation");
          guid = found;
        }
      }
    }
    if (guid) remember(this.sentTexts, guid, space.id);
    return { externalId: guid, chatId: space.id, status: "sent", retried };
  }

  /**
   * The channel ID of an own text that has been in the conversation since the
   * first attempt, otherwise null. What this process already knows is an
   * earlier message with the same wording, not this one. If the same wording
   * arrived shortly before without a known ID, there is no telling which one it
   * is: then null (fuzzing 2026-10-13).
   */
  private async sentSince(chat: string, text: string, startedAt: number): Promise<string | null> {
    const earlier = this.unresolved.get(text);
    if (earlier !== undefined && earlier >= startedAt - SENT_LOOKUP_SLACK_MS) return null;
    try {
      const app = this.app;
      const own = app ? await app.texts.ownSince(chat, new Date(startedAt - SENT_LOOKUP_SLACK_MS)) : [];
      return own.find((message) => message.text === text && !this.sentTexts.has(message.guid))?.guid ?? null;
    } catch (error) {
      log.warn("Photon: conversation not readable:", (error as Error).message);
      return null;
    }
  }

  /** A call that can be repeated without consequences: a second time after UNAVAILABLE. */
  private async once<T>(call: () => Promise<T>, what: string): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (grpcCode(error) !== GRPC_UNAVAILABLE) throw error;
      log.warn(`Photon: ${what} aborted (${(error as Error).message}), second attempt`);
      await sleep(this.retryDelayMs);
      return call();
    }
  }

  /** First the own memory, then Photon in the conversation where the message must be. */
  private async findMessage(id: string, space: Space): Promise<Message | undefined> {
    return this.recent.get(id) ?? (await space.getMessage(id).catch(() => undefined));
  }

  private result(space: Space, sent: Message | undefined): SendResult {
    if (!sent) throw new Error("Photon did not confirm the send");
    remember(this.recent, sent.id, sent);
    return { externalId: sent.id, chatId: space.id, status: "sent" };
  }
}

/**
 * A field of a Spectrum frame as text, otherwise empty. Spectrum's types promise
 * strings; the adapter still checks what comes over the wire first, because
 * the allowlist and dedupe behind it depend on exactly these values.
 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Arrival time of the frame; without a valid value, the own clock. */
function receivedAt(message: Message): Date {
  const at = message.timestamp as unknown;
  return at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
}

/** Emphasis and effect as Photon's send options; the ranges count in UTF-16 like JavaScript. */
function textOptions(extras: SendExtras): Omit<PhotonTextOptions, "clientMessageId"> {
  return {
    ...(extras.styles?.length ? { formatting: extras.styles.map(({ type, start, length }) => ({ type, start, length })) } : {}),
    ...(extras.effect ? { effect: EFFECT_IDS[extras.effect] } : {}),
  };
}

/** Thread target from a Spectrum ID: `p:2/guid` is the third part of a multi-part message. */
function replyTarget(id: string): string | { guid: string; partIndex: number } {
  const part = /^p:(\d+)\//.exec(id);
  return part ? { guid: id.slice(part[0].length), partIndex: Number(part[1]) } : id;
}

/** The gRPC status on Photon's errors (`IMessageError.grpcCode`), otherwise null. */
function grpcCode(error: unknown): number | null {
  const code = (error as { grpcCode?: unknown } | null)?.grpcCode;
  return typeof code === "number" ? code : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
