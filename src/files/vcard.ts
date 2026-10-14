/**
 * A contact as vCard 3.0 (sending files, audit 2026-10-05). Version 3.0,
 * because iOS and macOS open it without asking. Written by hand: it is a
 * handful of lines, and so no field goes through a library that reads it
 * differently.
 */

export interface VcardContact {
  name: string;
  phones?: readonly string[] | undefined;
  emails?: readonly string[] | undefined;
  org?: string | undefined;
  address?: string | undefined;
  note?: string | undefined;
}

/** RFC 6350/2426: escape backslash, comma, semicolon and line break. */
export function escapeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold lines over 75 bytes without splitting a character; continuation lines start with a space. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    const limit = parts.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function buildVcard(contact: VcardContact): Buffer {
  const words = contact.name.trim().split(/\s+/);
  const family = words.length > 1 ? words[words.length - 1]! : "";
  const given = words.length > 1 ? words.slice(0, -1).join(" ") : (words[0] ?? "");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${escapeValue(family)};${escapeValue(given)};;;`,
    `FN:${escapeValue(contact.name.trim())}`,
    ...(contact.org ? [`ORG:${escapeValue(contact.org)}`] : []),
    ...(contact.phones ?? []).map((phone) => `TEL;TYPE=CELL:${escapeValue(phone)}`),
    ...(contact.emails ?? []).map((email) => `EMAIL;TYPE=INTERNET:${escapeValue(email)}`),
    // An address as free text: into the street line, that way iOS shows all of it.
    ...(contact.address ? [`ADR;TYPE=HOME:;;${escapeValue(contact.address)};;;;`] : []),
    ...(contact.note ? [`NOTE:${escapeValue(contact.note)}`] : []),
    "END:VCARD",
  ];
  return Buffer.from(lines.map(foldLine).join("\r\n") + "\r\n", "utf8");
}
