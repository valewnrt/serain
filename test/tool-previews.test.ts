import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));

// The cleanup tool must read the outcome of `runCleanup` as data, never from its wording:
// the mock reports in words that contain none of the old German markers.
vi.mock("../src/mail/cleanup.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/mail/cleanup.js")>();
  return {
    ...original,
    findRoutes: async () =>
      Array.from({ length: 13 }, (_, index) => ({ address: `news${index}@shop.example`, label: `Shop ${index}`, action: "trash", ids: [String(index)], route: null })),
    runCleanup: async (_account: unknown, _cleanup: unknown, steps: readonly { address: string }[]) =>
      steps.map((step, index) => ({
        text: `${step.address}: ${index === 0 ? "kaputt" : index === 1 ? "hm" : "ok"}`,
        outcome: index === 0 ? "failed" : index === 1 ? "unconfirmed" : "done",
      })),
  };
});

const { installTranslations } = await import("../src/i18n/catalog.js");
const { ownerLanguage } = await import("../src/i18n/language.js");
const { tools: messages } = await import("../src/i18n/messages/tools.js");
const { decodeGrant, describeGrant, encodeGrant } = await import("../src/agent/tools/grants.js");
const { mailTools } = await import("../src/agent/tools/mail.js");
const { calendarTools } = await import("../src/agent/tools/calendar.js");
const { describeFields } = await import("../src/agent/tools/forms.js");
const { siteTaskTools } = await import("../src/agent/tools/site.js");
const { selftestTools } = await import("../src/agent/tools/selftest.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { fakeMailAccount, memoryKeep } = await import("./mail-account.fake.js");
const { ConfidentialGuard } = await import("../src/security/confidential.js");

type ToolDefinition = import("../src/agent/tools/types.js").ToolDefinition;
type Calendar = import("../src/calendar/types.js").Calendar;

/**
 * The fixed frame of tool previews (D8.3, D14) in German (tests run with
 * OWNER_LANGUAGE=de), English and a translated third language (Turkish, from
 * a fake catalog), with the content verbatim in every language; plus the
 * structured standing-approval keys and the structured cleanup outcome.
 */

expect(
  installTranslations("tr", {
    [messages.mailTo.en]: "{to} adresine e-posta",
    [messages.mailSubject.en]: "Konu: {subject}",
    [messages.mailAsk.en]: "Böyle gönderilsin mi?",
    [messages.mailUndo.en]: "Gönderdikten sonra geri alamam.",
    [messages.grantMailTo.en]: "{to} adresine e-postalar",
    [messages.createAsk.en]: "\"{title}\" eklensin ve davetler gönderilsin mi?",
    [messages.timeRange.en]: "{from} ile {to} arası",
  }),
).toEqual([]);

/** Renders in this language for the duration of the test. */
function speak(language: string): void {
  vi.spyOn(ownerLanguage, "current", "get").mockReturnValue(language);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function tool(defs: ToolDefinition[], name: string): ToolDefinition {
  const def = defs.find((entry) => entry.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}

const mail = () => {
  const box = fakeMailAccount("gmx", "alex@example.org");
  return tool(mailTools({ accounts: [box.account], keep: memoryKeep() }), "mail_send");
};

/** The preview without the first line, the warning about a new recipient (`src/mail/recipients.ts`, not this frame). */
const body = async (preview: string | Promise<string>) => (await preview).split("\n").slice(1).join("\n");

const mailArgs = { to: ["anna@example.com"], cc: [], subject: "Treffen {to} morgen", text: "Hallo Anna,\nbis morgen.", files: [] };

describe("standing approval keys (D8.3)", () => {
  it("stores kind and parameters as canonical JSON, not as a sentence", () => {
    expect(encodeGrant({ kind: "mail_to", to: "anna@example.com" })).toBe('{"kind":"mail_to","to":"anna@example.com"}');
    expect(encodeGrant({ kind: "confirm_selftest" })).toBe('{"kind":"confirm_selftest"}');
    expect(decodeGrant('{"kind":"mail_to_as_serain","to":"a@b.example"}')).toEqual({ kind: "mail_to_as_serain", to: "a@b.example" });
  });

  it("the tools return structured scopes", () => {
    expect(mail().confirm!.grantKey!(mailArgs)).toEqual({ kind: "mail_to", to: "anna@example.com" });
    expect(mail().confirm!.grantKey!({ ...mailArgs, cc: ["b@example.com"] })).toBeNull();
    expect(tool(selftestTools(), "confirm_selftest").confirm!.grantKey!({})).toEqual({ kind: "confirm_selftest" });
  });

  it("puts a key into words in the language of the moment, the address verbatim", () => {
    const key = encodeGrant({ kind: "mail_to", to: "anna@example.com" });
    expect(describeGrant(key, "de")).toBe("Mails an anna@example.com");
    expect(describeGrant(key, "en")).toBe("mails to anna@example.com");
    expect(describeGrant(key, "tr")).toBe("anna@example.com adresine e-postalar");
    // A language without a translation reads English.
    expect(describeGrant(key, "fi")).toBe("mails to anna@example.com");
    expect(describeGrant(encodeGrant({ kind: "mail_to_as_serain", to: "anna@example.com" }), "en")).toBe("mails as Serain to anna@example.com");
    expect(describeGrant(encodeGrant({ kind: "confirm_selftest" }), "de")).toBe("Testläufe der Bestätigung");
  });

  it("shows keys from before the structured form as stored, and never trusts a broken one", () => {
    expect(describeGrant("Mails an anna@example.com", "en")).toBe("Mails an anna@example.com");
    expect(describeGrant('{"kind":"mail_to"}', "en")).toBe('{"kind":"mail_to"}');
    expect(describeGrant('{"kind":"pay_all","to":"x"}', "en")).toBe('{"kind":"pay_all","to":"x"}');
    expect(decodeGrant("{not json")).toBeNull();
  });
});

describe("mail preview", () => {
  it("German as before, with the content verbatim", async () => {
    expect(await body(mail().confirm!.preview(mailArgs))).toBe(
      "Mail an anna@example.com\nBetreff: Treffen {to} morgen\n\nHallo Anna,\nbis morgen.\n\nSoll die so raus?",
    );
    expect(mail().confirm!.undo(mailArgs)).toBe("Zurückholen kann ich sie danach nicht.");
  });

  it("English frame, same content", async () => {
    speak("en");
    expect(await body(mail().confirm!.preview(mailArgs))).toBe(
      "Mail to anna@example.com\nSubject: Treffen {to} morgen\n\nHallo Anna,\nbis morgen.\n\nSend it like this?",
    );
    expect(mail().confirm!.undo(mailArgs)).toBe("I can't get it back after that.");
  });

  it("a translated language gets its frame, the content stays as written", async () => {
    speak("tr");
    expect(await body(mail().confirm!.preview(mailArgs))).toBe(
      "anna@example.com adresine e-posta\nKonu: Treffen {to} morgen\n\nHallo Anna,\nbis morgen.\n\nBöyle gönderilsin mi?",
    );
  });

  it("names the words that work when an attachment only goes right away", () => {
    const later = mail().confirm!.later!;
    expect(later.refuse!({ ...mailArgs, files: ["f1"] })?.text).toBe(
      "Mit Anhang geht das nur sofort, die Datei liegt nur bis zum nächsten Neustart bei mir. „ja“ oder „nein“.",
    );
    speak("en");
    expect(later.refuse!({ ...mailArgs, files: ["f1"] })?.text).toBe(
      "With an attachment this only works right away, I only keep the file until my next restart. \"yes\" or \"no\".",
    );
  });
});

describe("calendar preview", () => {
  const calendar = {
    label: "Alex's calendar",
    invites: true,
    deleteUndo: "restore it on the web.",
  } as unknown as Calendar;
  const create = () => tool(calendarTools(calendar), "calendar_create");
  const args = { title: "Planung {x}", start: "2026-10-16 09:00", end: "2026-10-16 10:30", guests: ["anna@example.com"], despite_overlap: false };

  it("German: question, time span in German form, guests", () => {
    expect(create().confirm!.preview(args)).toBe(
      "Soll ich „Planung {x}“ eintragen und die Einladungen verschicken?\nFr., 16.10., 09:00 bis Fr., 16.10., 10:30\nGäste: anna@example.com",
    );
  });

  it("English frame and English dates", () => {
    speak("en");
    expect(create().confirm!.preview(args)).toBe(
      "Shall I add \"Planung {x}\" and send the invitations?\nFri, 10/16, 09:00 to Fri, 10/16, 10:30\nGuests: anna@example.com",
    );
  });

  it("a translated language with dates in its locale", () => {
    speak("tr");
    const preview = String(create().confirm!.preview(args));
    expect(preview.split("\n")[0]).toBe("\"Planung {x}\" eklensin ve davetler gönderilsin mi?");
    expect(preview.split("\n")[1]).toMatch(/^.+ ile .+ arası$/);
    // Lines without a translation stay English.
    expect(preview.split("\n")[2]).toBe("Guests: anna@example.com");
  });

  it("a series in the owner's form, and invalid times say so in the frame", () => {
    const series = { ...args, repeat: { weekdays: ["mo", "fr"] as const, until: "2026-10-30" } };
    expect(String(create().confirm!.preview(series)).split("\n")[2]).toMatch(/^Serie: 5 Termine, .+ bis 30\.10\.2026$/);
    expect(String(create().confirm!.preview({ ...args, start: "morgen" })).split("\n")[1]).toBe("morgen (ungültig, wird nicht angelegt)");
    speak("en");
    expect(String(create().confirm!.preview(series)).split("\n")[2]).toMatch(/^Series: 5 events, Mon, Fri until 10\/30\/2026$/);
  });

  it("the delete preview with and without guests", () => {
    const remove = tool(calendarTools(calendar), "calendar_delete");
    expect(remove.confirm!.preview({ event_id: "abcde", current_title: "Zahnarzt", has_guests: true })).toBe("Soll ich „Zahnarzt“ löschen? Die Gäste kriegen eine Absage.");
    expect(remove.confirm!.undo({ event_id: "abcde", current_title: "Zahnarzt", has_guests: true })).toBe("Die Absage holt keiner zurück. restore it on the web.");
    speak("en");
    expect(remove.confirm!.preview({ event_id: "abcde", current_title: "Zahnarzt", has_guests: false })).toBe("Shall I delete \"Zahnarzt\"?");
  });
});

describe("form fields in the submit preview", () => {
  const fields = [
    { label: "Name:", value: "Alex Muster", state: "text" as const },
    { label: "Newsletter", value: "", state: "unchecked" as const },
    { label: "AGB gelesen", value: "", state: "checked" as const },
    { label: "", value: "", state: "text" as const },
    { label: "Kennwort", value: "", state: "password" as const },
  ];

  it("leaves unchecked boxes out by their state, not by a word", () => {
    expect(describeFields(fields, "de")).toEqual([
      "• Name: Alex Muster",
      "• AGB gelesen: angehakt",
      "• Kennwort: [Passwort, ausgeblendet]",
      "Leer: (ohne Beschriftung)",
    ]);
  });

  it("words the states in English, labels and values verbatim", () => {
    expect(describeFields(fields, "en")).toEqual(["• Name: Alex Muster", "• AGB gelesen: checked", "• Kennwort: [password, hidden]", "Empty: (no label)"]);
    // A value that happens to read like a state is content and stays.
    expect(describeFields([{ label: "Status", value: "nicht angehakt", state: "text" }], "en")).toEqual(["• Status: nicht angehakt"]);
  });
});

describe("other previews", () => {
  it("logged-in session and self test in English", () => {
    speak("en");
    const site = tool(
      siteTaskTools({
        sites: { list: async () => ["bahn"] },
        tasks: { precondition: async () => null, start: () => undefined },
        port: { send: async () => true } as never,
        confidential: async () => ConfidentialGuard.from([]),
      }),
      "run_site_task",
    );
    expect(site.confirm!.preview({ site: "bahn", task: "Buchung ABC prüfen" })).toBe(
      "Shall I log in at bahn with your login from the vault and take a look?\nBuchung ABC prüfen",
    );
    const selftest = tool(selftestTools(), "confirm_selftest");
    expect(selftest.confirm!.preview({ note: "probe" })).toBe("Shall I test the confirmation (probe)? Nothing happens except an entry in the audit log.");
  });
});

describe("mail cleanup reads outcomes as data", () => {
  it("lists what failed and what is unconfirmed from the structured outcome", async () => {
    const box = fakeMailAccount("gmx", "alex@example.org");
    const cleanup = tool(mailTools({ accounts: [box.account], keep: memoryKeep() }), "mail_cleanup");
    const senders = Array.from({ length: 13 }, (_, index) => ({ address: `news${index}@shop.example`, action: "trash" as const }));
    const result = await cleanup.run(
      { days: 90, senders },
      new TurnState({ origin: "owner_message", triggerExternalId: "x", triggerMessageId: "m", reactableIds: [] }),
    );
    const lines = result.text.split("\n");
    expect(lines[1]).toBe("12 of 13 senders done, 13 mails found.");
    expect(lines[2]).toBe("news0@shop.example: kaputt");
    expect(lines[3]).toBe("news1@shop.example: hm");
    expect(result.text).not.toContain("news2@shop.example");
  });
});
