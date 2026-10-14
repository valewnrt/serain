import { describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { showsCardNumber } from "../src/browser/screenshot.js";
import { installTranslations } from "../src/i18n/catalog.js";
import { forms } from "../src/i18n/messages/forms.js";
import { screenshotBlocker, shotBlockReason, shotBlockText } from "../src/sites/session.js";

/** Screenshots of logged-in pages (addendum D48 of 2026-10-08): what the code recognises does not go to Alex. */

describe("showsCardNumber", () => {
  it("finds card numbers with a valid check digit, grouped too", () => {
    expect(showsCardNumber("Karte 4111 1111 1111 1111 gültig bis 12/29")).toBe(true);
    expect(showsCardNumber("5500-0000-0000-0004")).toBe(true);
    expect(showsCardNumber("Bestellung 4111 1111 1111 1112")).toBe(false);
    expect(showsCardNumber("Karte endet auf 1111")).toBe(false);
    expect(showsCardNumber("Telefon 0611 123456")).toBe(false);
  });
});

/** A page without a browser: visible fields per selector and the text per frame. */
function fakePage(options: { password?: number; code?: number; frames?: Array<string | Error> }): Page {
  return {
    locator: (selector: string) => ({
      count: async () => (selector.includes('type="password"') ? (options.password ?? 0) : selector.includes("one-time-code") ? (options.code ?? 0) : 0),
    }),
    frames: () =>
      (options.frames ?? ["Meine Bestellungen"]).map((text) => ({
        evaluate: async () => {
          if (text instanceof Error) throw text;
          return text;
        },
      })),
  } as unknown as Page;
}

describe("screenshotBlocker", () => {
  it("lets an account page without secrets through", async () => {
    expect(await screenshotBlocker(fakePage({}), ["geheim123"])).toBeNull();
  });

  it("blocks password and code fields, vault values in any frame, and card numbers", async () => {
    expect(await screenshotBlocker(fakePage({ password: 1 }), [])).toBe("password_field");
    expect(await screenshotBlocker(fakePage({ code: 1 }), [])).toBe("code_field");
    expect(await screenshotBlocker(fakePage({ frames: ["Konto", "Ihr Passwort: geheim123"] }), ["geheim123"])).toBe("credentials");
    expect(await screenshotBlocker(fakePage({ frames: ["Code 482913"] }), ["482913"])).toBe("credentials");
    expect(await screenshotBlocker(fakePage({ frames: ["Visa 4111111111111111"] }), [])).toBe("card_number");
  });

  it("says no when a frame cannot be read, and ignores secrets that are too short", async () => {
    expect(await screenshotBlocker(fakePage({ frames: ["ok", new Error("detached")] }), [])).toBe("unreadable");
    expect(await screenshotBlocker(fakePage({ frames: ["abc"] }), ["", "ab"])).toBeNull();
  });
});

describe("why there is no screenshot", () => {
  it("tells the model in English and the owner in their language, unchanged German", () => {
    expect(shotBlockReason("password_field")).toBe("there is a password field on the page");
    expect(shotBlockText("password_field")).toBe("auf der Seite steht ein Passwortfeld");
    expect(shotBlockText("card_number")).toBe("auf der Seite steht eine Kartennummer");
    expect(shotBlockText("credentials", "en")).toBe("login details are on the page");
  });

  it("uses a translated catalog for a third language and English where a line is missing", () => {
    expect(installTranslations("tr", { [forms.shotPasswordField.en]: "sayfada bir şifre alanı var" })).toEqual([]);
    expect(shotBlockText("password_field", "tr")).toBe("sayfada bir şifre alanı var");
    expect(shotBlockText("code_field", "tr")).toBe("there's a field for a code on the page");
  });
});
