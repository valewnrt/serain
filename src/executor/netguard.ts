import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";

/**
 * SSRF protection for everything Serain fetches on behalf of a model (D8.4, D8.7).
 * The URL comes from a model that may just have read a foreign page; without
 * this check `web_fetch` is a way into the internal network: the cloud's
 * metadata service at 169.254.169.254, Docker at 172.17.0.1, everything on
 * localhost.
 *
 * What is checked is the address actually connected to (`guardedLookup` hangs
 * on the socket), not a name resolved beforehand: otherwise the name points to a
 * public address while checking and to 127.0.0.1 while connecting.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 127], // :: and ::1
  ["64:ff9b::", 96], // NAT64: carries an IPv4 address we did not check
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** IPv4 address from `::ffff:a.b.c.d`, otherwise null. */
function mappedIpv4(address: string): string | null {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (match?.[1]) return match[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex?.[1] || !hex[2]) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = mappedIpv4(address);
    if (mapped) return isPublicAddress(mapped);
    return !blocked.check(address, "ipv6");
  }
  return false;
}

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`${host} points to an internal address`);
    this.name = "BlockedAddressError";
  }
}

/**
 * DNS resolution that only lets public addresses through. Strict: if even one
 * of a name's addresses points inside, the whole name is blocked.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const list = addresses as Array<{ address: string; family: number }>;
    if (list.length === 0 || list.some((entry) => !isPublicAddress(entry.address))) {
      return callback(new BlockedAddressError(hostname), "", 0);
    }
    if (options.all) return callback(null, list as never, 0);
    const first = list[0] as { address: string; family: number };
    callback(null, first.address, first.family);
  });
};

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/** What can be checked on the URL itself, before a socket even opens. */
export function checkUrl(raw: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That is not a URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Only http and https." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with credentials are not fetched." };
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    return { ok: false, reason: "Only the standard ports 80 and 443." };
  }
  // With an IP as host Node asks no DNS, `guardedLookup` would never run.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !isPublicAddress(host)) {
    return { ok: false, reason: "Internal addresses are not fetched." };
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return { ok: false, reason: "Internal addresses are not fetched." };
  }
  return { ok: true, url };
}
