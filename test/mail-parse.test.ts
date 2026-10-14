import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { attachmentLabel, toMailMessage } from "../src/mail/parse.js";

const raw = [
  "From: Anna Beispiel <anna@example.org>",
  "To: alex@example.org",
  "Subject: Onboarding",
  "Message-ID: <x@example.org>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="aa"',
  "",
  "--aa",
  'Content-Type: multipart/related; boundary="bb"',
  "",
  "--bb",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p><img src="cid:logo@x"></p>',
  "--bb",
  "Content-Type: image/png",
  "Content-ID: <logo@x>",
  "Content-Disposition: inline; filename=logo.png",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgo=",
  "--bb--",
  "--aa",
  "Content-Type: text/calendar; charset=utf-8; method=REQUEST",
  "",
  "BEGIN:VCALENDAR",
  "END:VCALENDAR",
  "--aa",
  "Content-Type: application/pdf",
  "Content-Disposition: attachment; filename=Vertrag.pdf",
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0=",
  "--aa--",
  "",
].join("\r\n");

describe("Attachments of a mail (addendum D33 of 2026-10-08)", () => {
  it("leaves out embedded logos and calls an invitation without a file name what it is", async () => {
    const mail = toMailMessage("gmx", "INBOX:1", await simpleParser(raw), new Date(), "Inbox");
    expect(mail.attachments).toEqual(["calendar-invitation.ics", "Vertrag.pdf"]);
  });

  it("lists an image as an attachment if it is not embedded, and everything unnamed as \"(unnamed)\"", () => {
    expect(attachmentLabel({ filename: "foto.jpg", contentType: "image/jpeg", inline: false })).toBe("foto.jpg");
    expect(attachmentLabel({ filename: "logo.png", contentType: "image/png", inline: true })).toBeNull();
    expect(attachmentLabel({ filename: undefined, contentType: "application/octet-stream", inline: false })).toBe("(unnamed)");
  });
});
