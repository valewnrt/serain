import { z } from "zod";
import { MODEL_SIGNAL_MEANINGS, MODEL_SIGNALS, SIGNALS, type ModelSignal } from "../../channel/signals.js";
import { MESSAGE_EFFECTS, type MessageEffect } from "../../channel/types.js";
import { MAX_COPY_CHARS, MAX_COPY_VALUES, MAX_LINK_PREVIEWS_PER_TURN } from "../../config/limits.js";
import type { EditOutcome } from "../../outbound.js";
import { defineTool, type ToolDefinition, type ToolResult, type TurnOrigin, type TurnState } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * Messages as tools (D4). Serain does not end a turn with text but with tool
 * calls: zero, one or several messages are possible, a tapback alone too.
 * Whatever the model writes outside these tools, the owner never sees.
 *
 * All tools are level `write_reversible`: the recipient is always the owner
 * (the `MessagePort` knows no other target), so never a "message to third
 * parties", which would be level `irreversible` under D8.3.
 */

export interface MessagePort {
  readonly canReact: boolean;
  readonly canReplyInThread: boolean;
  /**
   * Sends to the owner. Returns false when the OutboundGate refused.
   *
   * `origin` lands in the audit entry: that is how a proactive message is
   * recognised later (W12). `taintSources` is required: what a turn writes
   * after untrusted content is derived from it and is stored with this
   * provenance (D8.4). Whoever sends here passes a copy of `turn.taintSources`,
   * the state at the time of the call.
   */
  send(
    text: string,
    opts: {
      kind: string;
      replyTo?: string;
      origin?: TurnOrigin;
      taintSources: readonly string[];
      /** iMessage effect on the first bubble (D48). */
      effect?: MessageEffect;
      /** May `edit_message` change it later? Only the message tools set this. */
      editable?: boolean;
      /** Verbatim as one bubble, without formatting: a value to copy. */
      verbatim?: boolean;
      /**
       * The channel aborted, in the second attempt too, and not everything
       * arrived (addendum D52 of 2026-10-13). The port calls it before
       * returning; true can still come back when the first bubbles got through.
       */
      onUndelivered?: () => void;
    },
  ): Promise<boolean>;
  react(messageId: string, emoji: string): Promise<boolean>;
  /** Can the channel do effects? Unset: no. */
  readonly canUseEffects?: boolean;
  /**
   * Changes one of Serain's own messages from the last minutes that was sent
   * as editable (D48). Only present when the channel can edit.
   */
  edit?(find: string, text: string): Promise<EditOutcome>;
  /**
   * Sends a checked URL as a link preview in its own bubble (addendum D48 of
   * 2026-10-08). Only present when the channel can do previews. False when
   * nothing went out; a duplicate counts as sent.
   */
  sendLink?(url: string, opts: { replyTo?: string; origin?: TurnOrigin; taintSources: readonly string[] }): Promise<boolean>;
}

const messageText = z
  .string()
  .trim()
  .min(1, "Text must not be empty")
  .max(4_000, "Text is too long for one message");

const effectParam = z
  .enum(MESSAGE_EFFECTS)
  .optional()
  .describe(
    `Almost never. An iMessage effect, only for an occasion ${owner.name} would celebrate themselves (birthday, ` +
      "passed exam, big news): confetti, balloons, fireworks, celebration. invisible hides " +
      "the message until they swipe over it, for a surprise. Never for everyday things, info, appointments or mails.",
  );

/**
 * An effect only when the channel can do it and the turn has not had one yet.
 * Otherwise the message goes out without, and the result tells the model.
 */
function grantEffect(port: MessagePort, turn: TurnState, wanted: MessageEffect | undefined): { effect?: MessageEffect; note: string } {
  if (!wanted) return { note: "" };
  if (!port.canUseEffects) return { note: " Without effect: the channel cannot do effects." };
  if (!turn.claimEffect()) return { note: " Without effect: one per turn is enough." };
  return { effect: wanted, note: "" };
}

const linksParam = z
  .array(z.string().trim().url().max(2_000))
  .max(MAX_LINK_PREVIEWS_PER_TURN)
  .optional()
  .describe(
    `Up to ${MAX_LINK_PREVIEWS_PER_TURN} sources as link previews (title and image of the page), each as its own bubble after the ` +
      "text. Only works for pages the executor opened itself in this task (they are listed under \"Opened " +
      "pages\"); the tool refuses any other address, then send without. What comes as a preview is not repeated in the text. " +
      "If there is a screenshot, no preview.",
  );

/**
 * Where the previews point (addendum D48 of 2026-10-08). The registry already
 * checked and refused before the run (`linkPreviews`); here the opened pages
 * themselves come back, without tracking parameters.
 */
function grantPreviews(links: readonly string[] | undefined, turn: TurnState): { urls: string[] } | ToolResult {
  if (!links || links.length === 0) return { urls: [] };
  const verdict = turn.previewTargets(links);
  return verdict.ok ? { urls: verdict.urls } : { ok: false, text: "Not sent: this preview is not possible. Send without." };
}

/** The previews after the text, in the same thread. Tells the model when one did not go out. */
async function sendPreviews(
  port: MessagePort,
  urls: readonly string[],
  turn: TurnState,
  replyTo: string | undefined,
): Promise<string> {
  if (urls.length === 0 || !port.sendLink) return "";
  turn.claimPreviews(urls.length);
  let sent = 0;
  for (const url of urls) {
    const ok = await port.sendLink(url, {
      ...(replyTo ? { replyTo } : {}),
      origin: turn.origin,
      taintSources: [...turn.taintSources],
    });
    if (ok) sent += 1;
  }
  return sent === urls.length ? ` With ${sent === 1 ? "preview" : `${sent} previews`}.` : ` Previews: ${sent} of ${urls.length} went out.`;
}

const copyParam = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(MAX_COPY_CHARS)
      .refine((value) => !/[\r\n]/.test(value), "A value is one line"),
  )
  .max(MAX_COPY_VALUES)
  .optional()
  .describe(
    `Values ${owner.name} wants to copy or type out (voucher, booking or pickup code, IBAN, amount to transfer, address, ` +
      `tracking number), each as its own bubble after the text, with nothing around it; at most ${MAX_COPY_VALUES}. What is here ` +
      "is not repeated in the text. No program code and no examples.",
  );

/**
 * Values to copy (style round, addendum D23 of 2026-10-08): each as its own
 * bubble, verbatim, in the same thread as the text. Tells the model when one
 * did not go out.
 */
async function sendCopies(port: MessagePort, values: readonly string[] | undefined, turn: TurnState, replyTo: string | undefined): Promise<string> {
  if (!values || values.length === 0) return "";
  let sent = 0;
  for (const value of values) {
    const ok = await port.send(value, {
      kind: "copy",
      origin: turn.origin,
      taintSources: [...turn.taintSources],
      verbatim: true,
      ...(replyTo ? { replyTo } : {}),
      onUndelivered: () => turn.noteUndelivered(),
    });
    if (ok) sent += 1;
  }
  return sent === values.length ? ` With ${sent === 1 ? "the value" : `${sent} values`} separately.` : ` Values: ${sent} of ${values.length} went out.`;
}

/**
 * The list to choose from out of a task (addendum D61 of 2026-10-09): right
 * after the first message, bubble by bubble, verbatim, in the same thread.
 * The code built it, not the model, so nothing is missing and the form is
 * right. Tells the model what did not go out or did not fit.
 */
async function sendPicks(port: MessagePort, turn: TurnState, replyTo: string | undefined): Promise<string> {
  const picks = turn.picks;
  if (!picks || picks.sent) return "";
  // Before the first `await`: a second message in the same turn does not send it again.
  picks.sent = true;
  let sent = 0;
  for (const bubble of picks.bubbles) {
    const ok = await port.send(bubble, {
      kind: "picks",
      origin: turn.origin,
      taintSources: [...turn.taintSources],
      verbatim: true,
      ...(replyTo ? { replyTo } : {}),
      onUndelivered: () => turn.noteUndelivered(),
    });
    if (ok) sent += 1;
  }
  const missing = picks.bubbles.length - sent;
  return [
    missing === 0 ? " The list went out right after it." : ` Of the list, ${missing} of ${picks.bubbles.length} bubbles did not go out.`,
    picks.dropped > 0 ? ` ${picks.dropped} items did not fit anymore; tell ${owner.name}.` : "",
  ].join("");
}

const EDIT_FAILURES: Record<Exclude<EditOutcome, { ok: true }>["reason"], string> = {
  unsupported: "The channel cannot edit messages.",
  not_found:
    "No message of yours from the last 15 minutes with this text found. Previews, suggestions and " +
    "reminders can never be edited. Send a short correction.",
  ambiguous: "The text is in several messages. Take a longer, unique piece.",
  empty: "The new text is empty.",
  too_long: "The new text does not fit into one bubble. Make it shorter.",
  edit_limit: "This message has already been edited five times, more is not possible. Send a short correction.",
  rate_limited: "Outbound limit reached, nothing changed.",
  failed: "The channel refused the edit, probably the message is too old. Send a short correction.",
};

/**
 * What the model reads when its answer failed at the channel. Do not send
 * again: the adapter already tried twice, and the second run of the turn
 * catches up on what is missing (addendum D52 of 2026-10-13).
 */
const UNDELIVERED = `Did not (fully) reach ${owner.name}: iMessage aborted. Do not send again; what is missing goes out by itself in a few minutes.`;

export function messagingTools(port: MessagePort): ToolDefinition[] {
  // Previews only when the channel can do them (D2: capability or no parameter).
  const previewSchema = port.sendLink ? { links: linksParam } : {};
  const tools: ToolDefinition[] = [
    defineTool({
      name: "send_message",
      description:
        `Sends ${owner.name} a message via iMessage. This is the only way to talk to them: ` +
        "they never read text outside this tool. Short messages, no Markdown except the sparing " +
        "**bold** from the style. Several calls are allowed when they are separate messages in content.",
      level: "write_reversible",
      textToOwner: true,
      linkPreviews: true,
      answersOwner: true,
      schema: { text: messageText, effect: effectParam, copy: copyParam, ...previewSchema },
      async run(args: { text: string; effect?: MessageEffect; copy?: string[]; links?: string[] }, turn) {
        const previews = grantPreviews(args.links, turn);
        if ("ok" in previews) return previews;
        if (!turn.claimMessage()) {
          return { ok: false, text: "Message limit for this turn reached." };
        }
        const { effect, note } = grantEffect(port, turn, args.effect);
        let lost = false;
        const sent = await port.send(args.text, {
          kind: "reply",
          origin: turn.origin,
          taintSources: [...turn.taintSources],
          editable: true,
          ...(effect ? { effect } : {}),
          onUndelivered: () => {
            lost = true;
            turn.noteUndelivered();
          },
        });
        if (lost) return { ok: false, text: UNDELIVERED };
        if (!sent) return { ok: false, text: "Not sent (limit or duplicate)." };
        turn.noteDelivered();
        const listed = await sendPicks(port, turn, undefined);
        const copied = await sendCopies(port, args.copy, turn, undefined);
        const shown = await sendPreviews(port, previews.urls, turn, undefined);
        return { ok: true, text: `Message is out.${note}${listed}${copied}${shown}` };
      },
    }),

    defineTool({
      name: "reply_in_thread",
      description:
        "Like send_message, but as a reply in the thread of the message that triggered this turn. " +
        "For results that belong to exactly this question.",
      level: "write_reversible",
      textToOwner: true,
      linkPreviews: true,
      answersOwner: true,
      schema: { text: messageText, effect: effectParam, copy: copyParam, ...previewSchema },
      async run(args: { text: string; effect?: MessageEffect; copy?: string[]; links?: string[] }, turn) {
        const previews = grantPreviews(args.links, turn);
        if ("ok" in previews) return previews;
        if (!turn.claimMessage()) {
          return { ok: false, text: "Message limit for this turn reached." };
        }
        const threaded = port.canReplyInThread && turn.triggerExternalId.length > 0;
        const { effect, note } = grantEffect(port, turn, args.effect);
        let lost = false;
        const common = {
          origin: turn.origin,
          taintSources: [...turn.taintSources],
          editable: true,
          ...(effect ? { effect } : {}),
          onUndelivered: () => {
            lost = true;
            turn.noteUndelivered();
          },
        };
        const sent = await port.send(
          args.text,
          threaded ? { kind: "reply_thread", replyTo: turn.triggerExternalId, ...common } : { kind: "reply", ...common },
        );
        if (lost) return { ok: false, text: UNDELIVERED };
        if (!sent) return { ok: false, text: "Not sent (limit or duplicate)." };
        turn.noteDelivered();
        const listed = await sendPicks(port, turn, threaded ? turn.triggerExternalId : undefined);
        const copied = await sendCopies(port, args.copy, turn, threaded ? turn.triggerExternalId : undefined);
        const shown = await sendPreviews(port, previews.urls, turn, threaded ? turn.triggerExternalId : undefined);
        return {
          ok: true,
          text: threaded
            ? `Reply is out in the thread.${note}${listed}${copied}${shown}`
            : `Reply is out, but without a thread: the channel cannot do reply threads.${note}${listed}${copied}${shown}`,
        };
      },
    }),

  ];

  const edit = port.edit?.bind(port);
  if (edit) {
    // Only when the channel can edit (D2: capabilities per adapter). Only on the
    // owner's own message and before untrusted content (`ownerOriginOnly`
    // covers both): a mail or page must not silently rewrite what the owner
    // has already read.
    tools.push(
      defineTool({
        name: "edit_message",
        description:
          `Changes one of your messages to ${owner.name} from the last 15 minutes in place. For correcting ` +
          "a detail they will look up later (time, place, amount), when they point out the mistake or you " +
          "notice it yourself. find is a piece of the old text, text the complete new text without " +
          "formatting. Only works as long as you have not read untrusted content in this turn (mail, calendar, web); " +
          "after that you send a short correction. After editing, a 👍 on their remark is enough.",
        level: "write_reversible",
        ownerOriginOnly: true,
        schema: {
          find: z.string().trim().min(3).max(200).describe("A verbatim piece of the message you want to change."),
          text: messageText,
        },
        async run(args: { find: string; text: string }, turn) {
          if (!turn.claimMessage()) {
            return { ok: false, text: "Message limit for this turn reached." };
          }
          const outcome = await edit(args.find, args.text);
          return outcome.ok
            ? { ok: true, text: "Message is changed." }
            : { ok: false, text: EDIT_FAILURES[outcome.reason] };
        },
      }),
    );
  }

  if (port.canReact) {
    // Only register when the channel can do tapbacks. Offering a tool that
    // does not exist in the channel only produces failed attempts (D2:
    // capabilities per adapter, Serain degrades).
    tools.push(
      defineTool({
        name: "react",
        description:
          `Puts a tapback on a message from ${owner.name}. You choose the signal, the code the emoji: ` +
          MODEL_SIGNALS.map((signal) => `${signal} ${SIGNALS[signal]} (${MODEL_SIGNAL_MEANINGS[signal]})`).join(", ") +
          ". Often enough on its own as the whole answer; then send no additional message.",
        level: "write_reversible",
        schema: {
          signal: z.enum(MODEL_SIGNALS).describe("The signal, e.g. ok."),
          message_id: z
            .string()
            .trim()
            .optional()
            .describe("A message from this turn. Unset: the triggering message."),
        },
        async run(args: { signal: ModelSignal; message_id?: string }, turn) {
          const target = args.message_id ?? turn.triggerExternalId;
          if (!target) return { ok: false, text: "No message to react to." };
          if (!turn.reactableIds.includes(target)) {
            return {
              ok: false,
              text: "You cannot react to this message, it does not belong to this turn.",
            };
          }
          if (!turn.claimReaction()) {
            return { ok: false, text: "Tapback limit for this turn reached." };
          }
          const sent = await port.react(target, SIGNALS[args.signal]);
          return sent
            ? { ok: true, text: "Tapback is set." }
            : { ok: false, text: "Tapback did not go out." };
        },
      }),
    );
  }

  tools.push(
    defineTool({
      name: "end_turn",
      description:
        `Ends the turn. Always call it last. If ${owner.name} wrote to you, a message or a tapback ` +
        "goes out before.",
      level: "read",
      endsTurn: true,
      schema: {
        reason: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe(`Optional: why it ends here. ${owner.name} does not see this.`),
      },
      async run() {
        return { ok: true, text: "Turn ended." };
      },
    }),
  );

  return tools;
}
