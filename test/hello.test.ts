import { beforeEach, describe, expect, it, vi } from "vitest";

const auditMock = vi.fn(async () => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...(args as [])) }));

const { claimFirstMessage, helloMessage } = await import("../src/hello.js");
const { installTranslations } = await import("../src/i18n/catalog.js");
const { core } = await import("../src/i18n/messages/core.js");
type HelloStore = Awaited<typeof import("../src/hello.js")>["supabaseHelloStore"];

/**
 * The first message may go out exactly once in the life of this installation.
 * Twice would be embarrassing and cannot be taken back, so a test hangs on
 * every way it could slip out a second time.
 */

/** Marker in memory, with the same atomicity as the primary key in the DB. */
function fakeStore(options: { history?: boolean } = {}): HelloStore & { claims: string[] } {
  let claimed = false;
  const claims: string[] = [];
  return {
    claims,
    async claim(reason: string) {
      if (claimed) return false;
      claimed = true;
      claims.push(reason);
      return true;
    },
    async hasHistory() {
      return options.history === true;
    },
  };
}

beforeEach(() => auditMock.mockClear());

describe("first message", () => {
  it("introduces Serain in the starting language and names the stop word that works", () => {
    expect(helloMessage()).toBe("hi. ich bin serain. schreib einfach, was du brauchst. „serain stopp“ hält mich jederzeit an.");
    expect(helloMessage("en")).toBe('hi. i\'m serain. just text me what you need. "serain stop" stops me anytime.');
    // Nothing about one installation: no city, no country, no number.
    for (const lang of ["de", "en"]) expect(helloMessage(lang)).not.toMatch(/frankfurt|kalifornien|california|\+\d/i);
  });

  it("uses a translated catalog and its stop word, and English until there is one", () => {
    expect(helloMessage("tr")).toBe(helloMessage("en"));
    installTranslations("tr", {
      [core.hello.en]: "selam. ben serain. ne istersen yaz. \"serain {stop}\" beni her an durdurur.",
    });
    // The stop word is English until the word lists are translated: a hint always names a word that works.
    expect(helloMessage("tr")).toBe('selam. ben serain. ne istersen yaz. "serain stop" beni her an durdurur.');
  });

  it("goes out at the very first start", async () => {
    const store = fakeStore();
    expect(await claimFirstMessage("+49150", store)).toBe(true);
    expect(store.claims).toEqual(["first_start"]);
  });

  it("does not go out at any later start", async () => {
    const store = fakeStore();
    expect(await claimFirstMessage("+49150", store)).toBe(true);
    expect(await claimFirstMessage("+49150", store)).toBe(false);
    expect(await claimFirstMessage("+49150", store)).toBe(false);
  });

  it("never goes out with existing history and still ticks itself off", async () => {
    // Exactly the case of the next deploy: the owner has been writing with Serain since yesterday.
    const store = fakeStore({ history: true });
    expect(await claimFirstMessage("+49150", store)).toBe(false);
    expect(store.claims).toEqual(["existing_history"]);
    expect(auditMock).toHaveBeenCalledWith("hello", { sent: false, reason: "existing_history" });
    // And not afterwards either, if the history looks empty for some reason.
    const second = { ...store, async hasHistory() { return false; } };
    expect(await claimFirstMessage("+49150", second)).toBe(false);
  });

  it("wins only once with two simultaneous starts", async () => {
    const store = fakeStore();
    const results = await Promise.all([
      claimFirstMessage("+49150", store),
      claimFirstMessage("+49150", store),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("stays silent when the history is not readable", async () => {
    const store: HelloStore = {
      async claim() {
        throw new Error("should not have been asked at all");
      },
      async hasHistory() {
        throw new Error("db gone");
      },
    };
    expect(await claimFirstMessage("+49150", store)).toBe(false);
  });

  it("stays silent when the marker cannot be set", async () => {
    const store: HelloStore = {
      async claim() {
        throw new Error("db gone");
      },
      async hasHistory() {
        return false;
      },
    };
    expect(await claimFirstMessage("+49150", store)).toBe(false);
  });
});
