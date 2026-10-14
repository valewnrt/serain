import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.js";

afterEach(() => vi.restoreAllMocks());

describe("Logger", () => {
  it("redacts Claude keys and subscription tokens, even unknown ones", () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
    log.error(`401 with sk-ant-api03-${"a".repeat(30)} and sk-ant-oat01-${"b".repeat(30)}`);
    expect(lines.join("")).toContain("sk-ant-api03-[redacted]");
    expect(lines.join("")).toContain("sk-ant-oat01-[redacted]");
    expect(lines.join("")).not.toMatch(/aaaa|bbbb/);
  });
});
