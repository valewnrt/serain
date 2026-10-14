import { describe, expect, it } from "vitest";
import { promisesFollowUp } from "../src/agent/promises.js";

/**
 * Promises to get back to the owner (addendum to D33 of 2026-10-13), in
 * Serain's own text. Built in for English and German; in other languages the
 * safety net stays silent. The German cases live in `test/tools.test.ts`.
 */
describe("promisesFollowUp", () => {
  it("recognises English promises the way Serain writes", () => {
    for (const text of [
      "done, i'll let you know as soon as the place is confirmed",
      "entered it. i'll get back to you when they reply",
      "i will keep you posted",
      "ill keep you updated on that",
      "i'll text you once the mail is there",
      "as soon as it arrives, i'll tell you",
      "once they confirm, i'll let you know",
    ]) {
      expect(promisesFollowUp(text), text).toBe(true);
    }
  });

  it("does not take an instruction or a plain statement for a promise", () => {
    for (const text of [
      "let me know if anything changes",
      "you'll know by friday",
      "i'll tell you what it says: 9 am, room 4",
      "they said they'd get back to you",
      "done ✅",
    ]) {
      expect(promisesFollowUp(text), text).toBe(false);
    }
  });

  it("still recognises German", () => {
    expect(promisesFollowUp("eingetragen, meld mich, sobald ort und zeit da sind")).toBe(true);
    expect(promisesFollowUp("meld dich mal")).toBe(false);
  });

  it("stays silent in a language without built-in patterns", () => {
    expect(promisesFollowUp("yer ve saat belli olunca sana haber veririm")).toBe(false);
  });
});
