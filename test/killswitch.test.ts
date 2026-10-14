import { describe, expect, it } from "vitest";
import { detectKillSwitchCommand } from "../src/security/killswitch.js";

describe("kill switch codeword", () => {
  it("detects the stop command", () => {
    expect(detectKillSwitchCommand("Serain stopp")).toBe("engage");
    expect(detectKillSwitchCommand("serain stop")).toBe("engage");
    expect(detectKillSwitchCommand("  SERAIN STOPP sofort")).toBe("engage");
    expect(detectKillSwitchCommand("Serain, stopp")).toBe("engage");
  });

  it("detects the release", () => {
    expect(detectKillSwitchCommand("Serain weiter")).toBe("release");
    expect(detectKillSwitchCommand("serain weiter bitte")).toBe("release");
  });

  it("does not trigger on normal text", () => {
    expect(detectKillSwitchCommand("kannst du serain stoppen wenn du willst")).toBeNull();
    expect(detectKillSwitchCommand("stopp")).toBeNull();
    expect(detectKillSwitchCommand("Serain, was geht?")).toBeNull();
    expect(detectKillSwitchCommand("Serain stoppuhr")).toBeNull();
  });
});
