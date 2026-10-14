import { describe, expect, it } from "vitest";
import { ConversationQueue } from "../src/security/queue.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("conversation queue", () => {
  it("bundles messages in the debounce window into one turn", async () => {
    const turns: string[][] = [];
    const queue = new ConversationQueue<string>({
      debounceMs: 30,
      run: async (batch) => {
        turns.push(batch);
      },
    });

    queue.submit("alex", "hi");
    await tick(10);
    queue.submit("alex", "noch was");
    await queue.drain();

    expect(turns).toEqual([["hi", "noch was"]]);
  });

  it("never lets turns of the same conversation overlap", async () => {
    const order: string[] = [];
    const queue = new ConversationQueue<string>({
      debounceMs: 5,
      run: async (batch) => {
        order.push(`start:${batch[0]}`);
        await tick(30);
        order.push(`ende:${batch[0]}`);
      },
    });

    queue.submit("alex", "eins");
    await tick(20);
    queue.submit("alex", "zwei");
    await queue.drain();

    expect(order).toEqual(["start:eins", "ende:eins", "start:zwei", "ende:zwei"]);
  });

  it("keeps different conversations apart", async () => {
    const seen: Record<string, string[]> = {};
    const queue = new ConversationQueue<string>({
      debounceMs: 5,
      run: async (batch, key) => {
        seen[key] = batch;
      },
    });

    queue.submit("a", "eins");
    queue.submit("b", "zwei");
    await queue.drain();

    expect(seen).toEqual({ a: ["eins"], b: ["zwei"] });
  });

  it("survives an error in the turn", async () => {
    const done: string[] = [];
    const queue = new ConversationQueue<string>({
      debounceMs: 5,
      run: async (batch) => {
        if (batch[0] === "böse") throw new Error("broken");
        done.push(batch[0]!);
      },
    });

    queue.submit("alex", "böse");
    await tick(20);
    queue.submit("alex", "gut");
    await queue.drain();

    expect(done).toEqual(["gut"]);
  });
  it("postpones a waiting turn while typing and bundles the follow-up message (D25)", async () => {
    const turns: string[][] = [];
    const queue = new ConversationQueue<string>({
      debounceMs: 20,
      maxHoldMs: 500,
      run: async (batch) => void turns.push(batch),
    });
    queue.submit("alex", "also");
    await tick(10);
    queue.hold("alex", 120);
    await tick(60);
    expect(turns).toEqual([]);
    queue.submit("alex", "ich meinte morgen");
    await tick(40);
    expect(turns).toEqual([["also", "ich meinte morgen"]]);
  });

  it("never holds longer than maxHoldMs from the first message, even if the indicator hangs", async () => {
    const turns: string[][] = [];
    const queue = new ConversationQueue<string>({
      debounceMs: 20,
      maxHoldMs: 80,
      run: async (batch) => void turns.push(batch),
    });
    queue.submit("alex", "hi");
    for (let i = 0; i < 6; i += 1) {
      await tick(15);
      queue.hold("alex", 1_000);
    }
    await tick(20);
    expect(turns).toEqual([["hi"]]);
  });

  it("makes no turn from a typing indicator alone and has no effect without maxHoldMs", async () => {
    const turns: string[][] = [];
    const queue = new ConversationQueue<string>({ debounceMs: 20, run: async (batch) => void turns.push(batch) });
    queue.hold("alex", 1_000);
    await tick(30);
    expect(turns).toEqual([]);
    queue.submit("alex", "hi");
    queue.hold("alex", 1_000);
    await tick(40);
    expect(turns).toEqual([["hi"]]);
  });

  it("starts events without a window, messages with one (D50)", async () => {
    const turns: string[][] = [];
    const queue = new ConversationQueue<string>({
      debounceMs: 50,
      immediate: (item) => item.startsWith("ereignis"),
      run: async (batch) => void turns.push(batch),
    });
    queue.submit("alex", "ereignis: auftrag fertig");
    await tick(5);
    expect(turns).toEqual([["ereignis: auftrag fertig"]]);
    queue.submit("alex", "hi");
    await tick(5);
    expect(turns).toHaveLength(1);
    await tick(60);
    expect(turns).toEqual([["ereignis: auftrag fertig"], ["hi"]]);
  });

  it("collects what arrives during a turn into one turn afterwards", async () => {
    const turns: string[][] = [];
    const queue = new ConversationQueue<string>({
      debounceMs: 5,
      run: async (batch) => {
        turns.push(batch);
        if (batch[0] === "lang") await tick(60);
      },
    });
    queue.submit("alex", "lang");
    await tick(10);
    queue.submit("alex", "eins");
    await tick(20);
    queue.submit("alex", "zwei");
    await queue.drain();
    expect(turns).toEqual([["lang"], ["eins", "zwei"]]);
  });

  it("preempts a running turn while it allows it and gives its batch to the next", async () => {
    const turns: string[][] = [];
    const preempted: string[][] = [];
    let allow = true;
    const queue = new ConversationQueue<string>({
      debounceMs: 5,
      preempts: () => true,
      run: async (batch, _key, control) => {
        turns.push(batch);
        let stop: () => void = () => undefined;
        const stopped = new Promise<void>((resolve) => (stop = resolve));
        control.setPreempter(() => {
          if (!allow) return false;
          stop();
          return true;
        });
        await Promise.race([stopped, tick(40)]);
        control.setPreempter(null);
        if (control.preempted) preempted.push(batch);
      },
    });
    queue.submit("alex", "eins");
    await tick(10);
    queue.submit("alex", "zwei");
    await tick(20);
    expect(preempted).toEqual([["eins"]]);
    allow = false;
    queue.submit("alex", "drei");
    await queue.drain();
    expect(turns).toEqual([["eins"], ["eins", "zwei"], ["drei"]]);
  });

  it("hands a message to a committed turn instead of collecting it behind (D57)", async () => {
    const turns: string[][] = [];
    const steered: string[] = [];
    const queue = new ConversationQueue<string>({
      debounceMs: 5,
      preempts: (item) => !item.startsWith("ereignis"),
      run: async (batch, _key, control) => {
        turns.push(batch);
        control.setPreempter(() => false);
        control.setSteerer((item) => {
          steered.push(item);
          return true;
        });
        await tick(40);
        control.setSteerer(null);
        control.setPreempter(null);
      },
    });
    queue.submit("alex", "eins");
    await tick(15);
    queue.submit("alex", "zwei");
    // An event does not steer, it waits as before.
    queue.submit("alex", "ereignis: auftrag fertig");
    await queue.drain();
    expect(steered).toEqual(["zwei"]);
    expect(turns).toEqual([["eins"], ["ereignis: auftrag fertig"]]);
  });

  it("queues a message behind one that is already waiting instead of overtaking it in the turn (D57)", async () => {
    const turns: string[][] = [];
    let accept = false;
    const queue = new ConversationQueue<string>({
      debounceMs: 5,
      preempts: () => true,
      run: async (batch, _key, control) => {
        turns.push(batch);
        control.setPreempter(() => false);
        control.setSteerer(() => accept);
        await tick(40);
        control.setSteerer(null);
      },
    });
    queue.submit("alex", "eins");
    await tick(15);
    queue.submit("alex", "zwei"); // the turn is not accepting anything right now
    accept = true;
    queue.submit("alex", "drei");
    await queue.drain();
    expect(turns).toEqual([["eins"], ["zwei", "drei"]]);
  });

  it("runs what was given back right after the turn, without a window and before everything that came after (D57)", async () => {
    const turns: Array<{ batch: string[]; at: number }> = [];
    const started = Date.now();
    const queue = new ConversationQueue<string>({
      debounceMs: 200,
      preempts: () => true,
      run: async (batch, _key, control) => {
        turns.push({ batch, at: Date.now() - started });
        if (batch[0] !== "eins") return;
        let taken: string | null = null;
        control.setPreempter(() => false);
        control.setSteerer((item) => {
          if (taken) return false;
          taken = item;
          return true;
        });
        await tick(40);
        control.setSteerer(null);
        // The turn did not see the message anymore.
        if (taken) control.giveBack([taken]);
      },
    });
    queue.submit("alex", "eins", Date.now() - 200);
    await tick(10);
    queue.submit("alex", "zwei");
    await tick(10);
    queue.submit("alex", "drei");
    await queue.drain();
    expect(turns.map((turn) => turn.batch)).toEqual([["eins"], ["zwei", "drei"]]);
    // Without a new window: the second turn starts right after the first, not 200 ms after "drei".
    expect(turns[1]?.at).toBeLessThan(150);
  });

  it("counts the window from arrival, not from acceptance (D50)", async () => {
    const turns: string[][] = [];
    const queue = new ConversationQueue<string>({ debounceMs: 60, run: async (batch) => void turns.push(batch) });
    // Storing and checking cost 50 ms before the message got into the queue.
    queue.submit("alex", "hi", Date.now() - 50);
    await tick(25);
    expect(turns).toEqual([["hi"]]);
  });

  it("reports busy without a gap: window, turn and follow-up turn (deploy waits on it)", async () => {
    const changes: boolean[] = [];
    const queue = new ConversationQueue<string>({
      debounceMs: 20,
      immediate: (item) => item === "ergebnis",
      onBusy: (busy) => changes.push(busy),
      run: async (batch) => {
        await tick(10);
        // Like a job whose result comes back as its own turn.
        if (batch[0] === "hi") queue.submit("alex", "ergebnis");
      },
    });

    queue.submit("alex", "hi");
    expect(changes).toEqual([true]); // already in the window, before a turn runs
    await tick(80);
    expect(changes).toEqual([true, false]);
    expect(queue.busy).toBe(false);
  });
});
