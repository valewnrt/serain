import { describe, expect, it, vi } from "vitest";

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
vi.mock("../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown>) => {
    audits.push({ event, detail });
  },
}));

const { voiceTools, speakable, VOICE_WANTED } = await import("../src/agent/tools/voice.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { ConfidentialGuard } = await import("../src/security/confidential.js");
const { ownerLanguage } = await import("../src/i18n/language.js");
const helper = (await import("../deploy/sandbox/helper.mjs" as string)) as {
  JOBS: Record<string, { argv: string[]; maxInput: number }>;
  TTS_IMAGE: string;
  dockerArgs(job: string, name: string, language?: string): string[];
};

/** Voice messages to the owner (D59). */

function setup(audio = Buffer.from("m4a-bytes"), exitCode = 0) {
  const runs: Array<{ job: string; input: string; language?: string }> = [];
  const sent: Array<{ name: string; mimeType: string; voice: boolean | undefined; caption: string; kind: string }> = [];
  const sandbox = {
    run: async (request: { job: string; input: Buffer; language?: string }) => {
      runs.push({ job: request.job, input: request.input.toString("utf8"), ...(request.language ? { language: request.language } : {}) });
      return { exitCode, timedOut: false, truncated: false, stdout: audio, stderr: "" };
    },
  };
  const port = {
    sendFile: async (file: { name: string; mimeType: string; voice?: boolean }, caption: string, opts: { kind: string }) => {
      sent.push({ name: file.name, mimeType: file.mimeType, voice: file.voice, caption, kind: opts.kind });
      return true;
    },
  };
  const registry = new ToolRegistry().registerAll(voiceTools({ sandbox, port, canSend: true }));
  return { registry, runs, sent };
}

function turn(ownerWords: string, origin: "owner_message" | "heartbeat" = "owner_message") {
  return new TurnState({ origin, triggerExternalId: "x", triggerMessageId: "db-1", reactableIds: [], ownerWords });
}

describe("send_voice (D59)", () => {
  it("exists only with a sandbox, a file port and a channel that can send voice messages", () => {
    const sandbox = { run: async () => ({ exitCode: 0, timedOut: false, truncated: false, stdout: Buffer.alloc(1), stderr: "" }) };
    const port = { sendFile: async () => true };
    expect(voiceTools({ sandbox: null, port, canSend: true })).toEqual([]);
    expect(voiceTools({ sandbox, port: null, canSend: true })).toEqual([]);
    expect(voiceTools({ sandbox, port, canSend: false })).toEqual([]);
    expect(voiceTools({ sandbox, port, canSend: true }).map((def) => def.name)).toEqual(["send_voice"]);
  });

  it("speaks when Alex sent a voice message themselves, and sends a real voice message", async () => {
    const { registry, runs, sent } = setup();
    const state = turn("[Sprachnachricht] erinner mich morgen ans paket");
    const result = await registry.execute("send_voice", { text: "Klar, morgen früh. 👍" }, state);
    expect(result.ok).toBe(true);
    expect(runs).toEqual([{ job: "text_to_voice", input: "Klar, morgen früh.", language: "de" }]);
    expect(sent).toEqual([{ name: "Serain.m4a", mimeType: "audio/mp4", voice: true, caption: "Klar, morgen früh.", kind: "voice" }]);
    expect(state.ownerHeard).toBe(true);
  });

  it("speaks when Alex asks for it, in German or English", async () => {
    for (const words of [
      "schick mir das als sprachnachricht",
      "kannst du mir das vorlesen?",
      "lies mir die mail vor",
      "als Audio bitte",
      "send me that as a voice note",
      "can you read the mail out loud?",
      "read it aloud",
    ]) {
      const { registry, sent } = setup();
      expect((await registry.execute("send_voice", { text: "Hier." }, turn(words))).ok).toBe(true);
      expect(sent).toHaveLength(1);
    }
  });

  it("stays silent when Alex does not ask for it: never as the default", async () => {
    const { registry, runs, sent } = setup();
    const result = await registry.execute("send_voice", { text: "Hallo!" }, turn("wie wird das wetter morgen?"));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Write it as text");
    expect(runs).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("exists only in turns Alex triggered", async () => {
    const { registry, sent } = setup();
    const result = await registry.execute("send_voice", { text: "Guten Morgen" }, turn("[Sprachnachricht] hallo", "heartbeat"));
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it("says when speech synthesis fails instead of sending an empty message", async () => {
    const { registry, sent } = setup(Buffer.alloc(0), 1);
    const result = await registry.execute("send_voice", { text: "Klar." }, turn("[Sprachnachricht] hey"));
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it("reads out no emoji, links and Markdown", () => {
    expect(speakable("**Klar** 🙂, schau hier: https://example.com/x?y=1 ❤️‍🔥 _fertig_")).toBe("Klar , schau hier: fertig");
    expect(speakable("👍🏼")).toBe("");
    expect(VOICE_WANTED.test("morgen, sprich freitag")).toBe(false);
    expect(VOICE_WANTED.test("did you read my mail?")).toBe(false);
  });

  it("stays closed in other languages: the owner gets text (comfort, not security)", async () => {
    for (const words of ["bunu sesli mesaj olarak gönder", "léemelo en voz alta", "読み上げて", "прочитай мне вслух"]) {
      const { registry, sent } = setup();
      expect(VOICE_WANTED.test(words), words).toBe(false);
      expect((await registry.execute("send_voice", { text: "Hier." }, turn(words))).ok).toBe(false);
      expect(sent).toEqual([]);
    }
  });

  it("speaks with the local voice of the owner's current language, and writes when there is none", async () => {
    const spy = vi.spyOn(ownerLanguage, "current", "get");
    try {
      spy.mockReturnValue("en");
      const english = setup();
      expect((await english.registry.execute("send_voice", { text: "Sure, tomorrow." }, turn("send it as a voice note"))).ok).toBe(true);
      expect(english.runs).toEqual([{ job: "text_to_voice", input: "Sure, tomorrow.", language: "en" }]);

      spy.mockReturnValue("tr");
      const turkish = setup();
      expect((await turkish.registry.execute("send_voice", { text: "Tamam, yarın." }, turn("[Sprachnachricht] yarın hatırlat"))).ok).toBe(true);
      expect(turkish.runs[0]?.language).toBe("tr");

      // No local voice for Japanese: nothing runs, nothing is sent, the model writes instead.
      spy.mockReturnValue("ja");
      const japanese = setup();
      const result = await japanese.registry.execute("send_voice", { text: "はい" }, turn("[Sprachnachricht] 明日"));
      expect(result.ok).toBe(false);
      expect(result.text).toContain("send it as text");
      expect(japanese.runs).toEqual([]);
      expect(japanese.sent).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("the helper speaks in its own image with the same flags and takes nothing from the client into the command line", () => {
    const args = helper.dockerArgs("text_to_voice", "serain-sbx-test", "de").join(" ");
    expect(args).toContain(`${helper.TTS_IMAGE} sh -c`);
    expect(args).toContain("--network none");
    expect(args).toContain("--read-only");
    expect(args).toContain("-c:a aac");
    expect(args).toContain("-ar 24000");
    expect(helper.JOBS["text_to_voice"]!.maxInput).toBeLessThanOrEqual(4 * 1024);
  });

  describe("voice via OpenRouter (addendum D59)", () => {
    function remoteSetup(remote: (text: string) => Promise<Buffer>, guard = ConfidentialGuard.from([])) {
      const runs: string[] = [];
      const sent: Buffer[] = [];
      const sandbox = {
        run: async (request: { job: string; input: Buffer }) => {
          runs.push(request.job);
          const out = request.job === "audio_to_voice" ? Buffer.from("m4a-fish") : Buffer.from("m4a-piper");
          return { exitCode: 0, timedOut: false, truncated: false, stdout: out, stderr: "" };
        },
      };
      const port = {
        sendFile: async (file: { body: Buffer }) => {
          sent.push(file.body);
          return true;
        },
      };
      const registry = new ToolRegistry().registerAll(
        voiceTools({ sandbox, port, canSend: true, remote, confidential: async () => guard }),
      );
      audits.length = 0;
      return { registry, runs, sent };
    }

    it("speaks with Fish Audio and turns the MP3 into a voice message in the sandbox", async () => {
      const spoken: string[] = [];
      const { registry, runs, sent } = remoteSetup(async (text) => {
        spoken.push(text);
        return Buffer.from("mp3");
      });
      expect((await registry.execute("send_voice", { text: "Klar, mach ich." }, turn("als sprachnachricht bitte"))).ok).toBe(true);
      expect(spoken).toEqual(["Klar, mach ich."]);
      expect(runs).toEqual(["audio_to_voice"]);
      expect(sent.map(String)).toEqual(["m4a-fish"]);
      expect(audits).toContainEqual({ event: "voice_synth", detail: { voice: "remote", chars: 15 } });
    });

    it("falls back to Piper when the provider cannot (cap, outage)", async () => {
      const { registry, runs, sent } = remoteSetup(async () => {
        throw new Error("daily voice cap reached");
      });
      expect((await registry.execute("send_voice", { text: "Hallo." }, turn("[Sprachnachricht] hey"))).ok).toBe(true);
      expect(runs).toEqual(["text_to_voice"]);
      expect(sent.map(String)).toEqual(["m4a-piper"]);
      expect(audits[0]?.detail).toMatchObject({ voice: "piper", fallback: "daily voice cap reached" });
    });

    it("never sends a confidential value outside, Piper speaks it locally (D29)", async () => {
      const remote = vi.fn(async () => Buffer.from("mp3"));
      const guard = ConfidentialGuard.from(["DE89 3704 0044 0532 0130 00"]);
      const { registry, runs } = remoteSetup(remote, guard);
      const text = "Deine IBAN ist DE89 3704 0044 0532 0130 00.";
      expect((await registry.execute("send_voice", { text }, turn("lies mir die iban vor"))).ok).toBe(true);
      expect(remote).not.toHaveBeenCalled();
      expect(runs).toEqual(["text_to_voice"]);
      expect(audits[0]?.detail).toMatchObject({ voice: "piper", fallback: "confidential" });
    });

    it("sends nothing outside when the protection list is not readable", async () => {
      const remote = vi.fn(async () => Buffer.from("mp3"));
      const sandbox = { run: async () => ({ exitCode: 0, timedOut: false, truncated: false, stdout: Buffer.from("a"), stderr: "" }) };
      const port = { sendFile: async () => true };
      const registry = new ToolRegistry().registerAll(
        voiceTools({ sandbox, port, canSend: true, remote, confidential: async () => { throw new Error("db gone"); } }),
      );
      expect((await registry.execute("send_voice", { text: "Hallo." }, turn("sprachnachricht"))).ok).toBe(true);
      expect(remote).not.toHaveBeenCalled();
    });
  });
});
