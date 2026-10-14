import { describe, expect, it } from "vitest";
import { CodeRequests, extractCode } from "../src/sites/codes.js";

describe("code from Alex's message (D56)", () => {
  it("recognises the bare code in the usual spellings", () => {
    expect(extractCode("483920")).toBe("483920");
    expect(extractCode(" 483 920 ")).toBe("483920");
    expect(extractCode("483-920")).toBe("483920");
    expect(extractCode("G-483920")).toBe("483920");
    expect(extractCode("Code: 4839")).toBe("4839");
    expect(extractCode("der code ist 12345678.")).toBe("12345678");
    expect(extractCode("the code is 12345678")).toBe("12345678");
  });

  it("is language neutral: a message that is essentially one code is a code, whatever word stands before it", () => {
    expect(extractCode("kod 483920")).toBe("483920");
    expect(extractCode("código 483920")).toBe("483920");
    expect(extractCode("código: 483920")).toBe("483920");
    expect(extractCode("el código es 483920")).toBe("483920");
    expect(extractCode("код 483920")).toBe("483920");
    expect(extractCode("コード483920")).toBe("483920");
    expect(extractCode("認証コードは483920です")).toBe("483920");
    expect(extractCode("483920 👍")).toBe("483920");
  });

  it("recognises a forwarded SMS with exactly one number", () => {
    expect(extractCode("Dein Bestätigungscode für Bahn lautet 618273. Teile ihn mit niemandem.")).toBe("618273");
    expect(extractCode("Your verification code is 618 273")).toBe("618273");
    // Common stems of other languages count in a forwarded SMS too.
    expect(extractCode("Doğrulama kodunuz 483920. Bu kodu kimseyle paylaşmayın.")).toBe("483920");
    expect(extractCode("Tu código de verificación es 483920. No lo compartas con nadie.")).toBe("483920");
  });

  it("takes no ordinary message and none with two numbers", () => {
    expect(extractCode("ok")).toBeNull();
    expect(extractCode("treffen wir uns um 1430?")).toBeNull();
    expect(extractCode("Code 1234 oder 5678, weiß nicht")).toBeNull();
    expect(extractCode("123")).toBeNull();
    expect(extractCode("1234567890")).toBeNull();
    expect(extractCode(`Anmeldecode 123456 ${"x".repeat(400)}`)).toBeNull();
    // More than a few words around a number, without a code word in any known language: conversation.
    expect(extractCode("bugün saat 1430 da buluşalım mı")).toBeNull();
    expect(extractCode("kod 1234 ya da 5678")).toBeNull();
  });
});

describe("waiting for a code", () => {
  function setup(opts: { ask?: boolean; waitMs?: number } = {}) {
    let now = 0;
    const asked: string[] = [];
    const codes = new CodeRequests({
      ask: async (site) => (asked.push(site), opts.ask ?? true),
      now: () => now,
      waitMs: opts.waitMs ?? 1_000,
      lateMs: 10_000,
    });
    return { codes, asked, advance: (ms: number) => void (now += ms) };
  }

  it("intercepts a message only while someone waits", async () => {
    const { codes, asked } = setup();
    expect(codes.matches("483920")).toBe(false);
    const pending = codes.request("bahn");
    await Promise.resolve();
    expect(asked).toEqual(["bahn"]);
    expect(codes.waiting).toBe("bahn");
    expect(codes.matches("hallo")).toBe(false);
    expect(codes.matches("483920")).toBe(true);
    expect(codes.deliver("483920")).toEqual({ site: "bahn", late: false });
    expect(await pending).toBe("483920");
    expect(codes.waiting).toBeNull();
  });

  it("intercepts a code with a word in any language while a login waits", async () => {
    const { codes } = setup();
    const pending = codes.request("bank");
    await Promise.resolve();
    expect(codes.matches("kod 483920")).toBe(true);
    expect(codes.deliver("código 483920")).toEqual({ site: "bank", late: false });
    expect(await pending).toBe("483920");
  });

  it("does not wait when the question did not go out, and intercepts nothing afterwards", async () => {
    const { codes } = setup({ ask: false });
    expect(await codes.request("bahn")).toBeNull();
    expect(codes.matches("483920")).toBe(false);
  });

  it("serves only one login at a time", async () => {
    const { codes } = setup();
    const first = codes.request("bahn");
    expect(await codes.request("amazon")).toBeNull();
    codes.deliver("111111");
    expect(await first).toBe("111111");
  });

  it("still intercepts a late code instead of handing it to the model", async () => {
    const { codes, advance } = setup({ waitMs: 5 });
    expect(await codes.request("bahn")).toBeNull();
    expect(codes.matches("483920")).toBe(true);
    expect(codes.deliver("483920")).toEqual({ site: "bahn", late: true });
    advance(20_000);
    expect(codes.matches("483920")).toBe(false);
  });

  it("ends with the kill switch and with the task's cancellation", async () => {
    const { codes } = setup({ waitMs: 60_000 });
    const stopped = codes.request("bahn");
    await Promise.resolve();
    codes.cancelAll();
    expect(await stopped).toBeNull();
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => (cancel = resolve));
    const aborted = codes.request("bahn", cancelled);
    cancel();
    expect(await aborted).toBeNull();
  });
});
