import { describe, expect, it } from "vitest";
import { senderLabel } from "../src/mail/brand.js";
import { cleanupUndo, describePlan, type CleanupStep } from "../src/mail/cleanup.js";

describe("Senders by name (decision of 2026-10-13)", () => {
  it("takes the domain's name, not the address", () => {
    expect(senderLabel("no-reply@amazon.de")).toBe("Amazon");
    expect(senderLabel("info@backblaze.com")).toBe("Backblaze");
    expect(senderLabel("survey@yourexperience.barcelo.com")).toBe("Barcelo");
    expect(senderLabel("reise@my.check24.de")).toBe("Check24");
    expect(senderLabel("news@shop.co.uk")).toBe("Shop");
  });

  it("capitalises short names and takes over the spelling only if it matches letter for letter", () => {
    expect(senderLabel("geschaeftskunde@dhl.de")).toBe("DHL");
    expect(senderLabel("geschaeftskunde@dhl.de", "DHL Paket")).toBe("DHL");
    expect(senderLabel("survey@yourexperience.barcelo.com", "Barceló Hotel Group")).toBe("Barceló");
    expect(senderLabel("hi@nutriloopapp.com", "NutriLoop")).toBe("NutriLoop");
    // A display name that does not match the address never gets into the preview.
    expect(senderLabel("no-reply@amazon.de", "Mama")).toBe("Amazon");
    expect(senderLabel("no-reply@amazon.de", "Аmazon")).toBe("Amazon");
    expect(senderLabel("info@backblaze.com", "Back to school")).toBe("Backblaze");
  });

  it("reverses Apple's relay addresses and otherwise shows them in full", () => {
    expect(senderLabel("support_at_nutriloopapp_com_abcdef1234_0a1b2c3d@privaterelay.appleid.com", "NutriLoop")).toBe("NutriLoop");
    expect(senderLabel("no-reply_at_updates_fitly_health_abcdef1234_0a1b2c3d@privaterelay.appleid.com")).toBe("Fitly");
    expect(senderLabel("abcdef1234@privaterelay.appleid.com")).toBe("abcdef1234@privaterelay.appleid.com");
  });

  it("shows the whole address for freemail providers: there every person is called Gmail", () => {
    expect(senderLabel("jemand@gmail.com", "Gmail")).toBe("jemand@gmail.com");
    expect(senderLabel("jemand@gmx.net")).toBe("jemand@gmx.net");
    expect(senderLabel("Jemand@Web.de")).toBe("jemand@web.de");
  });
});

const step = (address: string, label: string, action: CleanupStep["action"], ids: number, route: CleanupStep["route"] = null, deferred = false): CleanupStep => ({
  address,
  label,
  action,
  ids: Array.from({ length: ids }, (_, index) => `${address}-${index}`),
  route,
  ...(deferred ? { deferred } : {}),
});
const oneClick = (host: string): CleanupStep["route"] => ({ kind: "one_click", url: `https://${host}/u`, host });

describe("Cleanup preview as a question (decision of 2026-10-13)", () => {
  it("asks with names as a list, without addresses, routes and hosts", () => {
    const steps = [
      step("support_at_nutriloopapp_com_abcdef1234_0a1b2c3d@privaterelay.appleid.com", "NutriLoop", "unsubscribe", 2, { kind: "page", url: "https://x.convertkit-mail4.com/u", host: "x.convertkit-mail4.com" }),
      step("info@backblaze.com", "Backblaze", "unsubscribe", 2, oneClick("hub.backblaze.com")),
      step("getstarted@backblaze.com", "Backblaze", "unsubscribe", 2, oneClick("hub.backblaze.com")),
      step("survey@yourexperience.barcelo.com", "Barcelo", "unsubscribe", 1, { kind: "mailto", address: "unsubscribe-md_1@mailin1.us2.mcsv.net", subject: "unsubscribe", body: "unsubscribe" }),
      step("geschaeftskunde@dhl.de", "DHL", "unsubscribe", 1, oneClick("custcomm.dhl.de")),
      step("no-reply@amazon.de", "Amazon", "unsubscribe", 1, oneClick("www.amazon.de")),
    ];
    const lines = describePlan(steps, 0, 180);
    expect(lines).toEqual([
      "Soll ich dich bei",
      "• Backblaze",
      "• NutriLoop",
      "• Amazon",
      "• Barcelo",
      "• DHL",
      "abmelden und die 9 Mails der letzten 180 Tage in den Papierkorb legen?",
    ]);
    // A single sender stays in the sentence.
    expect(describePlan([steps[5]!], 0, 180)).toEqual(["Soll ich dich bei Amazon abmelden und die eine Mail der letzten 180 Tage in den Papierkorb legen?"]);
    expect(cleanupUndo(steps.map((entry) => entry.action))).toBe("Den Papierkorb kannst du zurückholen, die Abmeldung nicht.");
  });

  it("names an unsubscribe mail to someone other than a mailing service, because it goes out in Alex's name", () => {
    const lines = describePlan(
      [step("news@shop.example", "Shop", "unsubscribe", 1, { kind: "mailto", address: "chef@firma.example", subject: "x", body: "y" })],
      0,
      90,
    );
    expect(lines).toContain("Abmelde-Mail geht in deinem Namen an chef@firma.example.");
  });

  it("splits mixed plans into short lines and always names all spam senders", () => {
    const spam = Array.from({ length: 10 }, (_, index) => step(`s${index}@gmail.com`, `s${index}@gmail.com`, "spam", 1));
    const many = Array.from({ length: 12 }, (_, index) => step(`n@brand${index}.example`, `Brand${index}`, "unsubscribe", 1, oneClick(`brand${index}.example`)));
    const lines = describePlan([...many, step("x@noroute.example", "Noroute", "unsubscribe", 2), step("t@trash.example", "Trash", "trash", 3), ...spam], 2, 30);
    expect(lines[0]).toBe("Soll ich so aufräumen? Mails der letzten 30 Tage:");
    expect(lines[1]).toBe("Abmelden und 12 Mails in den Papierkorb:");
    expect(lines.slice(2, 11)).toHaveLength(9);
    expect(lines[10]).toBe("• und 4 weiteren");
    expect(lines).toContain("Abmelden geht nicht, nur 2 Mails in den Papierkorb: Noroute");
    expect(lines).toContain("Nur 3 Mails in den Papierkorb: Trash");
    const spamAt = lines.indexOf("Alle 10 Mails in den Spam-Ordner von");
    expect(lines.slice(spamAt + 1, spamAt + 11)).toEqual(spam.map((entry) => `• ${entry.address}`));
    expect(lines.at(-1)).toBe("2 Absender stehen auf deiner Behalten-Liste und bleiben.");
    expect(cleanupUndo(["unsubscribe", "spam"])).toBe("Papierkorb und Spam-Ordner kannst du zurückholen, die Abmeldung nicht.");
  });
});
