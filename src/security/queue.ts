import { log } from "../log.js";

/**
 * One queue per conversation (D10). Two quick messages in a row
 * must not overtake each other and should not produce two replies:
 * messages within the debounce window are bundled into one turn,
 * turns of the same conversation run strictly one after the other.
 *
 * Since D50, three more rules:
 *
 * - **Preempt.** If a message arrives while a turn is running that has not yet
 *   done anything the owner sees or that lasts, that turn ends and its batch
 *   goes into the next one along with the new message. That is why a short
 *   debounce window is enough: it no longer has to wait for a second message.
 * - **Collect.** What arrives while a turn is running waits, bundled, for
 *   its end instead of splitting into several turns.
 * - **Immediate.** Events nobody follows up on (the result of a
 *   job, a due appointment) wait for no window.
 *
 * Since D57, a fourth:
 *
 * - **Steer.** If the running turn can no longer be preempted because it has
 *   already done something, it accepts the message itself and reads it at the
 *   next tool. What it has not seen by its end, it gives
 *   back; that runs right after it, without a new window.
 */
export interface ConversationQueueOptions<T> {
  debounceMs: number;
  /**
   * How long `hold` may postpone a waiting turn in total, counted
   * from the first buffered message. Without a value there is no postponing.
   */
  maxHoldMs?: number;
  run: (batch: T[], key: string, control: RunControl<T>) => Promise<void>;
  /** Does a turn with this entry start without debounce when nothing else is waiting? */
  immediate?: (item: T) => boolean;
  /** May this entry preempt or steer a running turn (D57)? */
  preempts?: (item: T) => boolean;
  /**
   * Reports every change of `busy`: from the first accepted entry until the
   * last turn is through, without a gap between window, turn and follow-up turn.
   * The deploy waits on this (src/health/work.ts).
   */
  onBusy?: (busy: boolean) => void;
}

/** What a running turn tells the queue about itself. */
export interface RunControl<T> {
  /**
   * While set, a following entry may preempt the turn. The
   * function decides: true means preempted, false means the turn has already
   * done something and runs to completion.
   */
  setPreempter(preempter: (() => boolean) | null): void;
  /**
   * While set, an entry that can no longer preempt the turn may go into
   * it (D57). True means accepted: the entry now belongs to the turn,
   * and what it no longer processes comes back via `giveBack`.
   */
  setSteerer(steerer: ((item: T) => boolean) | null): void;
  /**
   * Accepted but not processed (D57): the entries run right after
   * this turn, before everything that came afterwards, and without a new window.
   */
  giveBack(items: T[]): void;
  /** Preempted: the batch already belongs to the next turn, this one leaves nothing behind. */
  readonly preempted: boolean;
}

interface Running<T> {
  batch: T[];
  firstAt: number;
  preempter: (() => boolean) | null;
  steerer: ((item: T) => boolean) | null;
  preempted: boolean;
  done: Promise<void>;
}

interface Slot<T> {
  buffer: T[];
  /** When the first message of the waiting turn arrived. Cap for `hold`. */
  firstAt: number;
  timer: NodeJS.Timeout | null;
  /** The window has expired; the buffer only waits for the end of the running turn. */
  due: boolean;
  /** Never two at once per conversation. */
  running: Running<T> | null;
}

export class ConversationQueue<T> {
  private slots = new Map<string, Slot<T>>();
  private draining = false;
  private reportedBusy = false;

  constructor(private readonly opts: ConversationQueueOptions<T>) {}

  /**
   * Accepts an entry and schedules the turn. `arrivedAt` (ms since epoch): the
   * window runs from the arrival, not from the acceptance; otherwise storing and
   * checking before it would add their cost every time (D50).
   */
  submit(key: string, item: T, arrivedAt: number = Date.now()): void {
    if (this.draining) {
      log.warn("Queue is shutting down, message no longer accepted");
      return;
    }
    const slot = this.slots.get(key) ?? { buffer: [], firstAt: 0, timer: null, due: false, running: null };
    this.slots.set(key, slot);
    const preempts = this.opts.preempts;
    // If a message is already waiting behind the turn, this one queues behind it
    // instead of overtaking it inside the turn (D57).
    const steerable = !slot.buffer.some((entry) => preempts?.(entry) === true);
    if (slot.buffer.length === 0) slot.firstAt = Date.now();
    slot.buffer.push(item);

    const running = slot.running;
    if (running && !running.preempted && preempts?.(item)) {
      if (running.preempter?.() === true) {
        // Preempted: the old batch goes before the new message, the window
        // starts over with it, and `hold` keeps counting from its first one.
        running.preempted = true;
        slot.buffer = [...running.batch, ...slot.buffer];
        slot.firstAt = Math.min(slot.firstAt, running.firstAt);
      } else if (steerable && running.steerer?.(item) === true) {
        // Steered (D57): the message now belongs to the running turn.
        slot.buffer.pop();
        this.reportBusy();
        return;
      }
    }
    this.reportBusy();

    if (slot.timer) clearTimeout(slot.timer);
    const immediate = this.opts.immediate;
    if (immediate && slot.buffer.every((entry) => immediate(entry))) {
      slot.timer = null;
      this.flush(key);
      return;
    }
    slot.timer = setTimeout(() => this.flush(key), Math.max(0, this.opts.debounceMs - (Date.now() - arrivedAt)));
  }

  /**
   * Postpones a waiting turn because the owner is still typing (D25). Only takes
   * effect when something is already in the buffer: a typing indicator alone is no turn.
   * Never longer than `maxHoldMs` from the first message: an indicator that
   * gets stuck must not silence Serain.
   */
  hold(key: string, ms: number): void {
    const slot = this.slots.get(key);
    const maxHoldMs = this.opts.maxHoldMs ?? 0;
    if (this.draining || !slot || !slot.timer || slot.buffer.length === 0 || maxHoldMs <= 0) return;
    const left = slot.firstAt + maxHoldMs - Date.now();
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => this.flush(key), Math.max(0, Math.min(ms, left)));
  }

  private flush(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.timer = null;
    if (slot.buffer.length === 0) return;
    if (slot.running) {
      slot.due = true;
      return;
    }
    this.start(key, slot);
  }

  private start(key: string, slot: Slot<T>): void {
    const batch = slot.buffer;
    slot.buffer = [];
    slot.due = false;
    const running: Running<T> = { batch, firstAt: slot.firstAt, preempter: null, steerer: null, preempted: false, done: Promise.resolve() };
    const control: RunControl<T> = {
      setPreempter: (preempter) => {
        running.preempter = preempter;
      },
      setSteerer: (steerer) => {
        running.steerer = steerer;
      },
      giveBack: (items) => {
        if (items.length === 0) return;
        if (slot.buffer.length === 0) slot.firstAt = Date.now();
        slot.buffer = [...items, ...slot.buffer];
        slot.due = true;
        if (slot.timer) {
          clearTimeout(slot.timer);
          slot.timer = null;
        }
      },
      get preempted() {
        return running.preempted;
      },
    };
    slot.running = running;
    running.done = Promise.resolve()
      .then(() => this.opts.run(batch, key, control))
      .catch((error: unknown) => {
        log.error(`Turn for ${key} failed:`, error);
      })
      .finally(() => {
        slot.running = null;
        // What came during the turn and is past its window runs
        // now as one turn. If the window is still running, the timer starts it.
        if (slot.buffer.length > 0 && (slot.due || (!slot.timer && this.draining))) this.start(key, slot);
        this.reportBusy();
      });
  }

  /** Waits until all running and buffered turns are through. */
  async drain(): Promise<void> {
    this.draining = true;
    for (const [key, slot] of this.slots) {
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = null;
        this.flush(key);
      }
    }
    for (const slot of this.slots.values()) {
      while (slot.running) await slot.running.done;
    }
  }

  get busy(): boolean {
    return [...this.slots.values()].some((slot) => slot.running !== null || slot.buffer.length > 0);
  }

  private reportBusy(): void {
    const busy = this.busy;
    if (busy === this.reportedBusy) return;
    this.reportedBusy = busy;
    this.opts.onBusy?.(busy);
  }
}
