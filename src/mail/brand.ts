import { getDomain } from "tldts";

/**
 * What the owner calls a sender: "Amazon", not `no-reply@amazon.de`
 * (decision of 2026-10-13: a short list instead of the names of spam mails).
 * Built only from the address. The display name from the header may only
 * supply the spelling ("DHL" instead of "Dhl"), and only if it matches the
 * domain's name letter for letter: a display name "Mom" in front of a foreign
 * address thus never gets into a preview.
 *
 * Freemail providers (gmail.com, gmx.net, …) say nothing about the sender,
 * there the whole address stands. Apple's "Hide My Email" is reversed:
 * `support_at_nutriloopapp_com_abcdef1234_0a1b2c3d@privaterelay.appleid.com`
 * is NutriLoop.
 */
export function senderLabel(address: string, displayName = ""): string {
  const real = unrelay(address.trim().toLowerCase());
  const domain = real.split("@")[1] ?? "";
  const registrable = getDomain(domain) ?? domain;
  if (!registrable || FREEMAIL.has(registrable)) return real;
  const label = registrable.split(".")[0] ?? "";
  if (!/^[a-z0-9-]+$/.test(label)) return real;
  return spelled(label, displayName) ?? (label.length <= 3 ? label.toUpperCase() : label.charAt(0).toUpperCase() + label.slice(1));
}

/** Apple's relay address: `<local>_at_<domain with _ instead of .>_<random>_<checksum>`. */
function unrelay(address: string): string {
  const [local = "", domain = ""] = address.split("@");
  if (domain !== "privaterelay.appleid.com") return address;
  const match = /^(.+?)_at_([a-z0-9_-]+?)_[a-z0-9]{6,}_[a-z0-9]{6,}$/.exec(local);
  if (!match?.[1] || !match[2] || !match[2].includes("_")) return address;
  return `${match[1]}@${match[2].replace(/_/g, ".")}`;
}

const plain = (word: string) => word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Suffixes a company appends to its domain: "nutriloopapp" is NutriLoop. */
const DOMAIN_SUFFIXES = ["app", "hq", "mail", "news", "online", "shop", "group"];

function spelled(label: string, displayName: string): string | null {
  const words = displayName.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const exact = words.find((word) => plain(word) === label);
  if (exact) return exact;
  const prefix = words.find((word) => {
    const base = plain(word);
    return base.length >= 3 && DOMAIN_SUFFIXES.some((suffix) => label === `${base}${suffix}`);
  });
  return prefix ?? null;
}

/** Mailboxes for everyone: the domain name here would be "Gmail" for every person. */
const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "gmx.net",
  "gmx.de",
  "gmx.at",
  "gmx.ch",
  "gmx.com",
  "web.de",
  "t-online.de",
  "freenet.de",
  "arcor.de",
  "posteo.de",
  "posteo.net",
  "mailbox.org",
  "outlook.com",
  "outlook.de",
  "hotmail.com",
  "hotmail.de",
  "live.com",
  "live.de",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "yahoo.de",
  "aol.com",
  "aol.de",
  "proton.me",
  "protonmail.com",
  "pm.me",
  // Relay addresses that cannot be reversed.
  "appleid.com",
]);
