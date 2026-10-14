import { describe, expect, it } from "vitest";
import { checkUrl, guardedLookup, isPublicAddress } from "../src/executor/netguard.js";

describe("SSRF protection", () => {
  it("blocks everything that points inside", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.17.0.1",
      "192.168.1.1",
      "169.254.169.254", // metadata service
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "64:ff9b::7f00:1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("lets public addresses through", () => {
    for (const address of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:1.1.1.1"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("takes the unreadable for not public", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });

  it("checks the URL before a socket opens", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data",
      "http://2130706433/", // 127.0.0.1 as a decimal number
      "http://0x7f.1/",
      "http://localhost/",
      "http://db.internal/",
      "https://user:pass@example.com/",
      "https://example.com:8443/",
      "not a url",
    ]) {
      expect(checkUrl(url).ok, url).toBe(false);
    }
    expect(checkUrl("https://example.com/a?b=c").ok).toBe(true);
    expect(checkUrl("http://example.com:80/").ok).toBe(true);
  });

  it("blocks a name that resolves to localhost", async () => {
    const error = await new Promise<Error | null>((resolve) =>
      guardedLookup("localhost", {}, (err) => resolve(err)),
    );
    expect(error?.name).toBe("BlockedAddressError");
  });
});
