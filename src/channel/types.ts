/**
 * Channel abstraction (D2). Serain only knows this interface; the Photon adapter
 * can be swapped for BlueBubbles or another relay without the agent noticing.
 * Capabilities are declared per adapter so Serain can degrade cleanly (text ack
 * instead of tapback).
 */

/**
 * An attachment as it sits on the message: only metadata that can be stored.
 * `Channel.fetchAttachment` fetches the bytes, only once a turn actually reads
 * them.
 */
export interface InboundAttachment {
  /** Channel ID of the attachment. */
  id: string;
  name?: string;
  mimeType?: string;
  /** Size according to the channel, if known. */
  size?: number;
}

export interface FetchedAttachment {
  body: Buffer;
  contentType?: string;
}

export interface InboundMessage {
  /** Adapter name, ends up as `channel` in `messages`. */
  channel: string;
  /** The channel's own ID of the message. Basis for dedupe. Can be empty. */
  externalId: string;
  /** Sender in E.164. */
  from: string;
  /** Conversation ID of the channel; often empty for 1:1. */
  chatId: string;
  isGroup: boolean;
  participants: string[];
  text: string;
  /**
   * Channel ID of the message this one replies to in a thread. Empty if it is
   * not a thread reply. The "yes" in the thread of a preview depends on this (D8.3).
   */
  replyToExternalId: string;
  attachments: InboundAttachment[];
  receivedAt: Date;
  /** Raw frame for debugging and audit. Never pass it to the model. */
  raw: unknown;
}

/** A tapback someone put on a message. */
export interface InboundReaction {
  channel: string;
  /** Sender in E.164. Without it the tapback is worthless and gets discarded. */
  from: string;
  /** Channel ID of the message the tapback sits on. */
  messageId: string;
  emoji: string;
  receivedAt: Date;
  raw: unknown;
}

/** The owner is typing, or has stopped. Ephemeral: never stored. */
export interface InboundTyping {
  channel: string;
  from: string;
  started: boolean;
  receivedAt: Date;
}

export interface SendResult {
  /** Empty if the channel accepted it but can no longer name its ID. */
  externalId: string;
  chatId: string;
  status?: string | undefined;
  service?: string | undefined;
  /** Only went through on the second attempt (addendum D38 of 2026-10-13). */
  retried?: boolean;
}

/** Emphasis of a piece of text, in UTF-16 units like JavaScript strings. */
export interface TextStyle {
  type: "bold" | "italic" | "strikethrough";
  start: number;
  length: number;
}

/**
 * Effects iMessage plays for the recipient: four on the bubble, the rest across
 * the whole screen. The names are Serain's own; the adapter translates them
 * into its channel's identifiers.
 */
export const MESSAGE_EFFECTS = [
  "slam",
  "loud",
  "gentle",
  "invisible",
  "confetti",
  "balloons",
  "fireworks",
  "celebration",
  "heart",
  "lasers",
  "sparkles",
  "spotlight",
  "echo",
] as const;
export type MessageEffect = (typeof MESSAGE_EFFECTS)[number];

/** What can be attached to a message beyond the plain text. */
export interface SendExtras {
  /** Only if `capabilities.formatting` holds; otherwise the text goes out without. */
  styles?: readonly TextStyle[];
  /** Only if `capabilities.effects` holds. */
  effect?: MessageEffect;
}

/**
 * A file Serain sends to the owner: generated in code (.ics, vCard, PDF) or one
 * the owner sent themselves, under a preview. Never passed through from the web.
 */
export interface OutboundFile {
  /** File name with extension, as the owner sees it. */
  name: string;
  mimeType: string;
  body: Buffer;
  /**
   * Send as a voice message, with waveform and play button instead of as a
   * file (D59). Only audio in an m4a container, only if `capabilities.voice` holds.
   */
  voice?: boolean;
}

export interface ChannelCapabilities {
  reactions: boolean;
  typing: boolean;
  readReceipts: boolean;
  /** Replies in a thread. */
  replyThreads: boolean;
  attachments: boolean;
  /** Bold, italic, strikethrough. */
  formatting: boolean;
  /** Bubble and screen effects. */
  effects: boolean;
  /** Edit own, just-sent messages afterwards. */
  edit: boolean;
  /** Send files, not just receive them. */
  files: boolean;
  /** Send voice messages (`OutboundFile.voice`), not just as a file. */
  voice: boolean;
  /** A URL as a link preview in its own bubble (addendum D48 of 2026-10-08). */
  richLinks: boolean;
}

export interface Channel {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  /** Connects and stays connected, including reconnect. */
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  /** Waits until the connection is up. Throws on timeout. */
  waitUntilConnected(timeoutMs: number): Promise<void>;
  send(to: string, text: string, extras?: SendExtras): Promise<SendResult>;
  /**
   * Reply in the thread of a message. Only present if
   * `capabilities.replyThreads` holds; otherwise Serain sends normally.
   */
  sendReply?(to: string, text: string, replyToExternalId: string, extras?: SendExtras): Promise<SendResult>;
  /**
   * Replaces the text of an own message. Only present if `capabilities.edit`
   * holds. Throws if the channel can no longer change the message (too old,
   * unknown).
   */
  edit?(externalId: string, text: string): Promise<void>;
  /**
   * Sends a file, with `replyToExternalId` in the thread of that message. Only
   * present if `capabilities.files` holds.
   */
  sendFile?(to: string, file: OutboundFile, replyToExternalId?: string): Promise<SendResult>;
  /**
   * Sends a URL as a link preview, with `replyToExternalId` in the thread. The
   * channel fetches the preview itself (with Photon, its Mac via GET), so only
   * `OutboundGate.sendLinkToOwner` calls this, with a checked page. Only present
   * if `capabilities.richLinks` holds.
   */
  sendRichLink?(to: string, url: string, replyToExternalId?: string): Promise<SendResult>;
  /**
   * Tapback on a message in the conversation with `to`. No-op if the adapter
   * cannot do it. The conversation is given because after a restart an adapter
   * only knows it once someone writes; but the ❌ on an aborted task comes
   * before that (D52).
   */
  react(to: string, messageId: string, emoji: string): Promise<void>;
  typing(to: string, on: boolean): Promise<void>;
  markRead(to: string): Promise<void>;
  /**
   * Bytes of an inbound attachment, at most `maxBytes`. A truncated file is
   * worthless, so it throws if the file is larger.
   */
  fetchAttachment(attachment: InboundAttachment, maxBytes: number): Promise<FetchedAttachment>;
  onInbound(handler: (message: InboundMessage) => void | Promise<void>): void;
  /** Inbound tapbacks. Only meaningful if `capabilities.reactions` holds. */
  onReaction(handler: (reaction: InboundReaction) => void | Promise<void>): void;
  /** Inbound typing indicator. Only adapters whose channel delivers it. */
  onTyping?(handler: (typing: InboundTyping) => void): void;
}
