import { describe, expect, it } from "vitest";
import { checkIngress } from "../src/security/allowlist.js";

const OWNER = "+4915112345678";
const STRANGER = "+4917612345678";

describe("ingress allowlist", () => {
  it("lets Alex through", () => {
    expect(checkIngress({ from: OWNER, isGroup: false }, OWNER)).toEqual({
      allowed: true,
      from: OWNER,
    });
  });

  it("normalises spellings of the own number", () => {
    const verdict = checkIngress({ from: "+49 151 123 456-78", isGroup: false }, OWNER);
    expect(verdict.allowed).toBe(true);
  });

  it("rejects unknown numbers", () => {
    const verdict = checkIngress({ from: STRANGER, isGroup: false }, OWNER);
    expect(verdict).toEqual({ allowed: false, reason: "unknown_sender", from: STRANGER });
  });

  it("rejects groups, even when Alex writes", () => {
    const verdict = checkIngress({ from: OWNER, isGroup: true }, OWNER);
    expect(verdict).toEqual({ allowed: false, reason: "group", from: OWNER });
  });

  it("rejects unusable senders", () => {
    const verdict = checkIngress({ from: "unbekannt", isGroup: false }, OWNER);
    expect(verdict).toEqual({ allowed: false, reason: "malformed_sender", from: "unbekannt" });
  });

  it("lets nothing through when the owner number is broken", () => {
    const verdict = checkIngress({ from: OWNER, isGroup: false }, "keine-nummer");
    expect(verdict.allowed).toBe(false);
  });

  it("does not confuse a number that starts with the own one", () => {
    const verdict = checkIngress({ from: `${OWNER}9`, isGroup: false }, OWNER);
    expect(verdict.allowed).toBe(false);
  });
});
