import { describe, expect, it } from "vitest";

const { ownerNamedEvent } = await import("../src/calendar/named.js");

/**
 * `ownerNamedEvent` lets `calendar_delete` run without a preview (addendum D8
 * of 2026-10-13). Word lists exist for English and German only; every other
 * language, and every negation, reservation or question, keeps the preview.
 */

const dentist = { current_title: "Dentist Dr. Weber", has_guests: false };
const zahnarzt = { current_title: "Zahnarzt Dr. Weber", has_guests: false };

describe("ownerNamedEvent in English", () => {
  it("proves a clear instruction by the owner's words", () => {
    expect(ownerNamedEvent(dentist, "delete the dentist", "en")).toBe("dentist");
    expect(ownerNamedEvent(dentist, "can you remove the dentist appointment", "en")).toBe("dentist");
    expect(ownerNamedEvent(dentist, "please delete the dentistappointment", "en")).toBe("dentist");
    expect(ownerNamedEvent({ current_title: "Summer Party", has_guests: false }, "delete the duplicate summer party", "en")).toBe("summer");
  });

  it("keeps the preview for every negation, contraction included", () => {
    for (const text of [
      "never delete the dentist",
      "i won't remove the dentist",
      "you shouldn't delete the dentist",
      "don't delete the dentist",
      "dont delete the dentist",
      "do not delete the dentist",
      "can’t you just not delete the dentist",
      "doesn't matter, delete nothing but the dentist",
      "no, delete the dentist",
    ]) {
      expect(ownerNamedEvent(dentist, text, "en"), text).toBeNull();
    }
  });

  it("keeps the preview for reservations and conditions", () => {
    expect(ownerNamedEvent(dentist, "delete everything except the dentist", "en")).toBeNull();
    expect(ownerNamedEvent(dentist, "keep the dentist, delete the gym", "en")).toBeNull();
    expect(ownerNamedEvent(dentist, "if it rains delete the dentist", "en")).toBeNull();
    expect(ownerNamedEvent(dentist, "maybe delete the dentist", "en")).toBeNull();
  });

  it("keeps the preview for questions, with or without a question mark", () => {
    expect(ownerNamedEvent(dentist, "should I delete the dentist appt?", "en")).toBeNull();
    expect(ownerNamedEvent(dentist, "should i delete the dentist", "en")).toBeNull();
    expect(ownerNamedEvent(dentist, "ok. did you delete the dentist", "en")).toBeNull();
    expect(ownerNamedEvent(dentist, "when is the dentist", "en")).toBeNull();
  });

  it("does not count cancel or a guest event", () => {
    expect(ownerNamedEvent(dentist, "cancel the dentist", "en")).toBeNull();
    expect(ownerNamedEvent({ ...dentist, has_guests: true }, "delete the dentist", "en")).toBeNull();
    expect(ownerNamedEvent({ current_title: "Meeting", has_guests: false }, "delete the meeting", "en")).toBeNull();
  });
});

describe("ownerNamedEvent in German", () => {
  it("proves a clear instruction by the owner's words", () => {
    expect(ownerNamedEvent(zahnarzt, "lösch den zahnarzt", "de")).toBe("zahnarzt");
    expect(ownerNamedEvent(zahnarzt, "kannst du den zahnarzttermin entfernen", "de")).toBe("zahnarzt");
  });

  it("keeps the preview for negations, reservations and questions", () => {
    expect(ownerNamedEvent(zahnarzt, "lösch den zahnarzt bitte nicht", "de")).toBeNull();
    expect(ownerNamedEvent(zahnarzt, "lösch alles außer dem zahnarzt", "de")).toBeNull();
    expect(ownerNamedEvent(zahnarzt, "lass den zahnarzt, lösch das gym", "de")).toBeNull();
    expect(ownerNamedEvent(zahnarzt, "soll ich den zahnarzt löschen", "de")).toBeNull();
    expect(ownerNamedEvent(zahnarzt, "falls es regnet, lösch den zahnarzt", "de")).toBeNull();
  });
});

describe("ownerNamedEvent in other languages (fail closed)", () => {
  it("always keeps the preview when the language has no word lists", () => {
    expect(ownerNamedEvent(dentist, "delete the dentist", "tr")).toBeNull();
    expect(ownerNamedEvent(dentist, "delete the dentist", "es")).toBeNull();
    expect(ownerNamedEvent(zahnarzt, "lösch den zahnarzt", "fr")).toBeNull();
  });

  it("keeps the preview for words of another language even while the owner's language is English or German", () => {
    // Turkish "etme" is "don't": no list knows it, the Turkish letters give it away.
    expect(ownerNamedEvent({ current_title: "Dişçi", has_guests: false }, "dişçiyi delete etme", "de")).toBeNull();
    expect(ownerNamedEvent(dentist, "¿no remove el dentista?", "en")).toBeNull();
  });

  it("follows the current language by default", () => {
    // Tests run with OWNER_LANGUAGE=de.
    expect(ownerNamedEvent(zahnarzt, "lösch den zahnarzt")).toBe("zahnarzt");
  });
});
