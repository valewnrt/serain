/**
 * Status signals instead of free emojis (style round package 4, addendum D23 of
 * 2026-10-08). The model names a signal, the code picks the emoji. That way ⏰
 * always means the same thing, and a tapback is never an emoji the model made
 * up.
 *
 * The table was agreed in the style round; new signals belong there too.
 */
export const SIGNALS = {
  /** Understood, thanks, fine. Also the code's acknowledgement (kill switch, suggestions). */
  ok: "👍",
  /** The owner is happy about something. */
  love: "❤️",
  /** The owner makes a joke. */
  haha: "😂",
  /** A reminder is set. */
  scheduled: "⏰",
  /** A watcher is set. */
  watching: "👀",
  /** Code only: a task is running (`run_task`). */
  working: "🔍",
  /** Code only: the task delivered a report. */
  done: "✅",
  /** Code only: the task came back without a result or was aborted. */
  failed: "❌",
} as const;

export type Signal = keyof typeof SIGNALS;

/** What the model may set via `react`. 🔍, ✅ and ❌ are set by the code only, because only the code knows whether a task is running. */
export const MODEL_SIGNALS = ["ok", "love", "haha", "scheduled", "watching"] as const satisfies readonly Signal[];

export type ModelSignal = (typeof MODEL_SIGNALS)[number];

/** The signals for the tool description: "ok 👍 (understood, thanks, fine), …". */
export const MODEL_SIGNAL_MEANINGS: Record<ModelSignal, string> = {
  ok: "understood, thanks, fine",
  love: "they are happy about something",
  haha: "they are making a joke",
  scheduled: "reminder is set",
  watching: "watcher is set",
};

/** The emoji for a signal, null for anything else (such as an old entry in the audit log). */
export function signalEmoji(value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(SIGNALS, value) ? SIGNALS[value as Signal] : null;
}
