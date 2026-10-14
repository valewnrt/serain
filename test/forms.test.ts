import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));

const { classifyButton, pageIsForeign, PAYMENT_FIELD, PRICE_PATTERN, readsInWordLanguage } = await import("../src/forms/classify.js");
const { loadEld } = await import("../src/i18n/language.js");
const { blocksAction } = await import("../src/sites/session.js");
const { inOwnerWords, maskProfile, profileLabel, profileValues, PROFILE_LABELS, resolvePlaceholders } = await import("../src/forms/profile.js");
const { installTranslations } = await import("../src/i18n/catalog.js");
const { forms } = await import("../src/i18n/messages/forms.js");
const { FormHolds } = await import("../src/forms/holds.js");
const { openFormSession, FormFailure } = await import("../src/forms/session.js");
const { formTaskTools, describeFields } = await import("../src/agent/tools/forms.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { ConfidentialGuard } = await import("../src/security/confidential.js");
const { collectPage } = await import("../src/browser/page-script.js");
const { inPage } = await import("../src/browser/in-page.js");
type HeldForm = import("../src/forms/session.js").HeldForm;
type FormSession = import("../src/forms/session.js").FormSession;
type OwnerProfile = import("../src/forms/profile.js").OwnerProfile;
type ToolDefinition = import("../src/agent/tools/types.js").ToolDefinition;
type Launched = import("../src/sites/session.js").Launched;

describe("classifying buttons (D63, part C)", () => {
  it("money never, submitting only with a preview, next is the executor's", () => {
    expect(classifyButton("Jetzt kostenpflichtig bestellen", { submits: true })).toBe("money");
    expect(classifyButton("In den Warenkorb", { submits: false })).toBe("money");
    expect(classifyButton("Termin buchen", { submits: true })).toBe("money");
    expect(classifyButton("Zur Kasse", { submits: false })).toBe("money");
    expect(classifyButton("Bestellung widerrufen", { submits: true })).toBe("commit");
    expect(classifyButton("Abo jetzt kündigen", { submits: true })).toBe("commit");
    expect(classifyButton("Kündigung kostenpflichtig bestätigen", { submits: true })).toBe("money");
    expect(classifyButton("Absenden", { submits: true })).toBe("commit");
    expect(classifyButton("Widerspruch einreichen", { submits: false })).toBe("commit");
    // A submit button whose label says nothing counts as submitting (fail closed).
    expect(classifyButton("OK", { submits: true })).toBe("commit");
    // A submit button submits, even when it says "next"; only a "next" that does not submit is the executor's to click.
    expect(classifyButton("Weiter", { submits: true })).toBe("commit");
    expect(classifyButton("Nächster Schritt »", { submits: false })).toBe("next");
    expect(classifyButton("Mehr anzeigen", { submits: false })).toBe("plain");
    // A link that acts is no ordinary link.
    expect(classifyButton("Newsletter abbestellen und austragen", { submits: false })).toBe("commit");
    // Every label counts: the page can hide the visible text behind a harmless aria-label.
    expect(classifyButton(["Mehr anzeigen", "Konto löschen"], { submits: false })).toBe("commit");
    expect(classifyButton(["Info", "Jetzt kaufen"], { submits: false })).toBe("money");
    expect(classifyButton("Kün​digen", { submits: false })).toBe("commit");
    // No purchase may hide behind "refund"; the object of the revocation does not count as a purchase.
    expect(classifyButton("Erstattung beantragen und Premium kaufen", { submits: false })).toBe("money");
    expect(classifyButton("Buchung stornieren", { submits: true })).toBe("commit");
  });

  it("reads English as well", () => {
    expect(classifyButton("Place order", { submits: true })).toBe("money");
    expect(classifyButton("Add to cart", { submits: false })).toBe("money");
    expect(classifyButton("Delete account", { submits: false })).toBe("commit");
    expect(classifyButton("Cancel subscription", { submits: true })).toBe("commit");
    expect(classifyButton("Next", { submits: false })).toBe("next");
    expect(classifyButton("Show more", { submits: false })).toBe("plain");
  });

  it("language-neutral signals hold on every page: price on a submit, checkout target, payment fields", () => {
    // A submit with a price pays, whatever the words.
    expect(classifyButton("Weiter zu 12,99 €", { submits: true })).toBe("money");
    expect(classifyButton("Öde 299,00 TL", { submits: true })).toBe("money");
    expect(classifyButton("Continue", { submits: true, payment: true })).toBe("money");
    // A target on a checkout or payment path is money, even behind a harmless label.
    expect(classifyButton("Mehr anzeigen", { submits: false, kind: "link", target: "/checkout/step-1" })).toBe("money");
    expect(classifyButton("Devam", { submits: true, target: "/odeme/payment?id=3" })).toBe("money");
    // A target that deletes or cancels acts, even behind a harmless label.
    expect(classifyButton("Mehr anzeigen", { submits: false, kind: "link", target: "/account/delete?ok=1" })).toBe("commit");
    // A price on an ordinary link of an English or German page is a product, not a purchase.
    expect(classifyButton("Tagesticket 9,80 €", { submits: false, kind: "link", target: "/tickets/tag" })).toBe("plain");
  });

  it("fails closed on a page in another language: everything that may act needs the preview, money never", () => {
    const tr = { foreign: true } as const;
    // Turkish: buy, add to cart, send. Without word lists none of them is plain.
    expect(classifyButton("Hemen satın al", { submits: false, kind: "button", ...tr })).toBe("commit");
    expect(classifyButton("Sepete ekle", { submits: false, kind: "button", ...tr })).toBe("commit");
    expect(classifyButton("Gönder", { submits: true, kind: "button", ...tr })).toBe("commit");
    expect(classifyButton("Satın al 299 TL", { submits: false, kind: "button", ...tr })).toBe("money");
    // Even a link with a price (it could be "buy now" by GET) is money there.
    expect(classifyButton("Ürün 299,90 TL", { submits: false, kind: "link", target: "/urun/42", ...tr })).toBe("money");
    // A link that may act by its target needs the preview; one to an ordinary path does not.
    expect(classifyButton("Onayla", { submits: false, kind: "link", target: "/siparis/confirm", ...tr })).toBe("commit");
    expect(classifyButton("Hakkımızda", { submits: false, kind: "link", target: "/hakkimizda", ...tr })).toBe("plain");
    expect(classifyButton("Hakkımızda", { submits: false, kind: "link", target: "javascript:", ...tr })).toBe("commit");
    // What is harmless by structure stays plain: checkboxes, tabs, calendar cells, disclosures, arrows.
    expect(classifyButton("KVKK metnini okudum", { submits: false, kind: "button", role: "checkbox", ...tr })).toBe("plain");
    expect(classifyButton("Cumartesi 10", { submits: false, kind: "button", role: "gridcell", ...tr })).toBe("plain");
    expect(classifyButton("Daha fazla", { submits: false, kind: "button", state: "collapsed", ...tr })).toBe("plain");
    expect(classifyButton("›", { submits: false, kind: "button", ...tr })).toBe("next");
    // Spanish and Japanese, the same.
    expect(classifyButton("Comprar ahora", { submits: false, kind: "button", foreign: true })).toBe("commit");
    expect(classifyButton("Pagar 20,00 €", { submits: false, kind: "button", foreign: true })).toBe("money");
    expect(classifyButton("今すぐ購入", { submits: false, kind: "button", foreign: true })).toBe("commit");
    expect(classifyButton("購入する ¥1,200", { submits: false, kind: "button", foreign: true })).toBe("money");
    // English and German words still count on a foreign page.
    expect(classifyButton("Checkout", { submits: false, kind: "link", target: "/x", foreign: true })).toBe("money");
  });

  it("tells a page's language from <html lang> or a text sample, foreign when it cannot tell", async () => {
    const detect = await loadEld();
    expect(readsInWordLanguage({ lang: "de", text: "Widerspruch gegen Werbung" }, detect)).toBe(true);
    expect(readsInWordLanguage({ lang: null, text: "Termin buchen, freie Zeiten am Samstag und Sonntag ansehen" }, detect)).toBe(true);
    expect(readsInWordLanguage({ lang: null, text: "Search results for your query, sorted by relevance" }, detect)).toBe(true);
    expect(readsInWordLanguage({ lang: "tr", text: "Termin" }, detect)).toBe(false);
    expect(readsInWordLanguage({ lang: null, text: "Sepete ekle, hemen satın al, ücretsiz kargo ile kapınızda" }, detect)).toBe(false);
    expect(readsInWordLanguage({ lang: "ja", text: "今すぐ購入" }, detect)).toBe(false);
    // A template's lang="en" around Spanish content: the text wins.
    expect(readsInWordLanguage({ lang: "en", text: "Comprar ahora, añadir al carrito, envío gratis a domicilio" }, detect)).toBe(false);
    // Nothing to tell: foreign.
    expect(readsInWordLanguage({ lang: null, text: "OK" }, detect)).toBe(false);
    expect(await pageIsForeign({ lang: "es", text: "Comprar" })).toBe(true);
  });

  it("finds payment fields by name in several languages, prices in any currency", () => {
    for (const label of ["Kartennummer", "Card number", "CVV", "IBAN", "Kart numarası", "Número de tarjeta", "カード番号"]) expect(PAYMENT_FIELD.test(label)).toBe(true);
    expect(PAYMENT_FIELD.test("Vorname")).toBe(false);
    for (const price of ["12,99 €", "$5", "299 TL", "¥1,200", "CHF 20.00", "1.299,00 zł"]) expect(PRICE_PATTERN.test(price)).toBe(true);
    for (const plain of ["Seite 2", "10:30", "3 Tage", "Gleis 7"]) expect(PRICE_PATTERN.test(plain)).toBe(false);
  });
});

describe("logged-in sessions: information only (D36)", () => {
  it("blocks acting words, money by any signal, and on a foreign page everything not harmless by structure", () => {
    expect(blocksAction(["Konto löschen"], { submits: false, kind: "button" })).toBe(true);
    expect(blocksAction(["Place order"], { submits: true, kind: "button" })).toBe(true);
    expect(blocksAction(["Weiter zu 12,99 €"], { submits: true, kind: "button" })).toBe(true);
    expect(blocksAction(["Rechnungen"], { submits: false, kind: "link", target: "/billing/invoices" })).toBe(true);
    // English or German: reading, searching and paging stay possible.
    expect(blocksAction(["Kontoauszüge"], { submits: false, kind: "link", target: "/account/statements" })).toBe(false);
    expect(blocksAction(["Suchen"], { submits: true, kind: "button", target: "/search" })).toBe(false);
    // Turkish account: a link to an ordinary page is fine, any button and any submit is not.
    const tr = { foreign: true } as const;
    expect(blocksAction(["Hesaplarım"], { submits: false, kind: "link", target: "/hesaplarim", ...tr })).toBe(false);
    expect(blocksAction(["Hesabı kapat"], { submits: false, kind: "button", ...tr })).toBe(true);
    expect(blocksAction(["Ara"], { submits: true, kind: "button", target: "/ara", ...tr })).toBe(true);
    expect(blocksAction(["Para gönder"], { submits: false, kind: "link", target: "/transfer", ...tr })).toBe(true);
  });
});

describe("Alex's details as placeholders", () => {
  const profile: OwnerProfile = { vorname: "Max", nachname: "Muster", strasse: "Hauptstraße 1", plz: "12345", ort: "Musterstadt" };
  const values = profileValues(profile, { email: "max@example.org", telefon: "+4915100000000" });

  it("fills in what exists and names what is missing", () => {
    expect(values["name"]).toBe("Max Muster");
    expect(resolvePlaceholders("{{name}}, {{strasse}}, {{ plz }} {{ort}}", values)).toEqual({ text: "Max Muster, Hauptstraße 1, 12345 Musterstadt", missing: [], used: ["name", "strasse", "plz", "ort"] });
    expect(resolvePlaceholders("geb. {{geburtsdatum}}", values).missing).toEqual(["geburtsdatum"]);
  });

  it("masks values back, the full name before the first name, short ones stay", () => {
    expect(maskProfile("Max Muster wohnt in 12345 Musterstadt, Mail max@example.org, Land DE", { ...values, land: "DE" })).toBe(
      "{{name}} wohnt in {{plz}} {{ort}}, Mail {{email}}, Land DE",
    );
  });

  it("names the fields for the owner in their language and for the model in English", () => {
    expect(profileLabel("strasse")).toBe("Straße und Hausnummer");
    expect(profileLabel("strasse", "en")).toBe("street and house number");
    expect(installTranslations("tr", { [forms.profileStreet.en]: "sokak ve kapı numarası" })).toEqual([]);
    expect(profileLabel("strasse", "tr")).toBe("sokak ve kapı numarası");
    // A line the translation did not deliver stays English.
    expect(profileLabel("plz", "tr")).toBe("postal code");
    expect(PROFILE_LABELS.email).toBe("email address");
  });

  it("only keeps what stands in Alex's words", () => {
    expect(inOwnerWords("Hauptstraße 1", "meine adresse ist hauptstraße  1 in musterstadt")).toBe(true);
    expect(inOwnerWords("Hauptstraße 2", "meine adresse ist hauptstraße 1")).toBe(false);
  });
});

/** A held form without a browser, for the tools. */
function fakeHeld(token = "111111111111"): { held: HeldForm; session: FormSession; submitted: string[]; closed: () => boolean } {
  const submitted: string[] = [];
  let closed = false;
  const held: HeldForm = {
    token,
    site: null,
    host: "www.robinsonliste.de",
    title: "Eintragung",
    button: "Eintragung absenden",
    fields: [
      { label: "Vorname", value: "Max", state: "text" },
      { label: "Ich stimme der Datenschutzerklärung zu", value: "", state: "checked" },
    ],
    image: Buffer.from("jpeg"),
    imageMissing: null,
  };
  const session = {
    where: "robinsonliste.de",
    placeholders: [],
    look: async () => {
      throw new Error("not needed");
    },
    act: async () => {
      throw new Error("not needed");
    },
    hold: async () => held,
    submitHeld: async (form: HeldForm) => {
      submitted.push(form.token);
      return "Seite danach: Danke\nIhre Eintragung ist eingegangen.";
    },
    close: async () => void (closed = true),
  } as FormSession;
  return { held, session, submitted, closed: () => closed };
}

function gate() {
  const requests: Array<{ tool: string; preview: string; undo: string; files: number }> = [];
  return {
    requests,
    gate: {
      covered: async () => false,
      request: async (def: ToolDefinition, _level: string, args: Record<string, unknown>) => {
        requests.push({ tool: def.name, preview: await def.confirm!.preview(args), undo: def.confirm!.undo(args), files: def.confirm!.files?.(args).length ?? 0 });
        return { ok: true, text: "wartet auf Alex" };
      },
    },
  };
}

const turn = (origin: "owner_message" | "task" | "approval" = "owner_message", ownerWords = "", taintSources: string[] = []) =>
  new TurnState({ origin, triggerExternalId: "x1", triggerMessageId: "m1", reactableIds: [], ownerWords, taintSources });

function tools(opts: { profile?: OwnerProfile; holds?: InstanceType<typeof FormHolds>; sites?: string[] } = {}) {
  let stored: OwnerProfile = { ...(opts.profile ?? { vorname: "Max", nachname: "Muster" }) };
  const started: Array<Record<string, unknown>> = [];
  const approvals = gate();
  const holds = opts.holds ?? new FormHolds();
  const registry = new ToolRegistry(approvals.gate).registerAll(
    formTaskTools({
      profile: { load: async () => ({ ...stored }), save: async (next) => void (stored = { ...next }) },
      defaults: () => ({ email: "max@example.org", telefon: "+4915100000000" }),
      holds,
      sites: { list: async () => opts.sites ?? [] },
      confidential: async () => ConfidentialGuard.from(["Max Muster wohnt in der Hauptstraße 1 in Musterstadt."]),
      tasks: { precondition: async () => null, start: (request) => void started.push(request as unknown as Record<string, unknown>) },
    }),
  );
  return { registry, approvals, started, holds, profile: () => stored };
}

describe("web_form: filling in with a preview (D63, part C)", () => {
  it("the preview names the site, the task and every detail with its value", async () => {
    const { registry, approvals, started } = tools();
    await registry.execute("web_form", { url: "https://www.robinsonliste.de/eintragen", task: "In die Robinsonliste für Werbung per Mail eintragen.", uses: ["name", "email"] }, turn());
    expect(started).toEqual([]);
    expect(approvals.requests[0]?.preview).toBe(
      "Soll ich das Formular auf robinsonliste.de ausfüllen?\nIn die Robinsonliste für Werbung per Mail eintragen.\nVon dir trag ich ein:\n• Name Max Muster\n• Mailadresse max@example.org",
    );
    // That only the finished page is submitted now stands in the way back.
    expect(approvals.requests[0]?.undo).toBe("Was ich tippe, sieht die Seite schon. Abgeschickt wird erst nach deinem zweiten 👍, wenn du die fertige Seite gesehen hast.");
  });

  it("without a value no preview, but the sentence what Alex has to give", async () => {
    const { registry, approvals } = tools();
    const result = await registry.execute("web_form", { url: "https://www.robinsonliste.de/", task: "Eintragen für Werbung per Post.", uses: ["strasse"] }, turn());
    expect(result.ok).toBe(false);
    expect(approvals.requests).toEqual([]);
  });

  it("if Alex named the website with its ending, it starts without a first preview", async () => {
    const { registry, approvals, started } = tools();
    const result = await registry.execute(
      "web_form",
      { url: "https://www.robinsonliste.de/eintragen", task: "In die Robinsonliste für Werbung per Mail eintragen.", uses: ["email"] },
      turn("owner_message", "trag mich bei robinsonliste.de ein"),
    );
    expect(result.ok).toBe(true);
    expect(approvals.requests).toEqual([]);
    expect(started[0]).toMatchObject({ form: { url: "https://www.robinsonliste.de/eintragen", uses: ["email"] } });
  });

  it("a host that counts as an ending itself is the website (httpbin.org, live 2026-10-13)", async () => {
    const { registry, approvals, started } = tools();
    await registry.execute("web_form", { url: "https://httpbin.org/forms/post", task: "Testformular ausfüllen, Name Test.", uses: [] }, turn("owner_message", "füll auf httpbin.org/forms/post das formular aus"));
    expect(approvals.requests).toEqual([]);
    expect(started).toHaveLength(1);
  });

  it("the name without ending proves nothing: robinsonliste.xyz is someone else", async () => {
    for (const [url, words] of [
      ["https://robinsonliste.xyz/", "trag mich in die robinsonliste ein"],
      ["https://robinsonliste.xyz/", "trag mich bei robinsonliste.de ein"],
      ["https://robinsonliste.github.io/", "trag mich bei github.io ein"],
    ] as const) {
      const { registry, approvals, started } = tools();
      await registry.execute("web_form", { url, task: "In die Robinsonliste für Werbung per Mail eintragen.", uses: ["email"] }, turn("owner_message", words));
      expect(approvals.requests).toHaveLength(1);
      expect(started).toEqual([]);
    }
  });

  it("only clean on Alex's message, only public https pages, nothing confidential in the task", async () => {
    const { registry, started } = tools();
    expect((await registry.execute("web_form", { url: "https://a.example/", task: "Kontaktformular ausfüllen bitte.", uses: [] }, turn("task"))).ok).toBe(false);
    expect((await registry.execute("web_form", { url: "https://a.example/", task: "Kontaktformular ausfüllen bitte.", uses: [] }, turn("owner_message", "", ["eine Mail"]))).ok).toBe(false);
    const local = await registry.executeApproved({ id: "a1", tool: "web_form", status: "approved", args: { url: "https://127.0.0.1/x", task: "Kontaktformular ausfüllen bitte.", uses: [] } }, turn("approval"));
    expect(local.ok).toBe(false);
    const leak = await registry.executeApproved(
      { id: "a2", tool: "web_form", status: "approved", args: { url: "https://a.example/", task: "Adresse: Hauptstraße 1 eintragen.", uses: [] } },
      turn("approval"),
    );
    expect(leak.ok).toBe(false);
    expect(leak.text).toContain("confidential (address)");
    expect(started).toEqual([]);
  });
});

describe("web_submit: submitting with a preview from the page", () => {
  it("the preview comes from the held form, with a picture; after 👍 the code submits and closes", async () => {
    const holds = new FormHolds();
    const fake = fakeHeld();
    holds.add(fake.held, fake.session);
    const { registry, approvals } = tools({ holds });
    await registry.execute("web_submit", { id: fake.held.token }, turn("task", "", ["Form on robinsonliste.de"]));
    expect(approvals.requests[0]?.preview).toBe(
      "Soll ich das auf robinsonliste.de abschicken? „Eintragung“\n• Vorname: Max\n• Ich stimme der Datenschutzerklärung zu: angehakt\nKnopf: „Eintragung absenden“",
    );
    expect(approvals.requests[0]?.files).toBe(1);
    expect(fake.submitted).toEqual([]);
    const result = await registry.executeApproved({ id: "a1", tool: "web_submit", status: "approved", args: { id: fake.held.token } }, turn("approval"));
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Ihre Eintragung ist eingegangen.");
    expect(result.text).toContain("<untrusted");
    expect(fake.submitted).toEqual([fake.held.token]);
    expect(fake.closed()).toBe(true);
    expect(holds.get(fake.held.token)).toBeNull();
  });

  it("names every field with a value as a list, empty ones together, unchecked ones not at all", () => {
    const fields = [
      { label: "E-Mail:", value: "max@example.org", state: "text" },
      { label: "Newsletter", value: "", state: "unchecked" },
      { label: "Firma", value: "", state: "text" },
      { label: "", value: "", state: "text" },
      { label: "Datenschutz", value: "", state: "checked" },
      { label: "Passwort", value: "", state: "password" },
    ] as const;
    expect(describeFields(fields)).toEqual(["• E-Mail: max@example.org", "• Datenschutz: angehakt", "• Passwort: [Passwort, ausgeblendet]", "Leer:", "• Firma", "• (ohne Beschriftung)"]);
    // A value that happens to read "nicht angehakt" is content, not a state: it is shown.
    expect(describeFields([{ label: "Notiz", value: "nicht angehakt", state: "text" }])).toEqual(["• Notiz: nicht angehakt"]);
    expect(describeFields([{ label: "Vorname", value: "Max", state: "text" }, { label: "Firma", value: "", state: "text" }])).toEqual(["• Vorname: Max", "Leer: Firma"]);
  });

  it("a form that no longer waits gives no preview and submits nothing", async () => {
    const { registry, approvals } = tools();
    expect((await registry.execute("web_submit", { id: "000000000000" }, turn("task"))).ok).toBe(false);
    expect(approvals.requests).toEqual([]);
    const result = await registry.executeApproved({ id: "a1", tool: "web_submit", status: "approved", args: { id: "000000000000" } }, turn("approval"));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Nothing was submitted");
  });

  it("holds at most two and closes by itself after expiry", async () => {
    vi.useFakeTimers();
    try {
      const holds = new FormHolds(1_000);
      const first = fakeHeld("222222222222");
      holds.add(first.held, first.session);
      holds.add(fakeHeld("333333333333").held, fakeHeld("333333333333").session);
      expect(holds.full).toBe(true);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(holds.size).toBe(0);
      expect(first.closed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("profile_set: only from Alex's words", () => {
  it("keeps what stands there word for word and refuses what was made up", async () => {
    const { registry, profile } = tools({ profile: {} });
    const words = "für formulare: max muster, hauptstraße 1, 12345 musterstadt";
    expect((await registry.execute("profile_set", { vorname: "Max", nachname: "Muster", strasse: "Hauptstraße 1", plz: "12345", ort: "Musterstadt" }, turn("owner_message", words))).ok).toBe(true);
    expect(profile()).toEqual({ vorname: "Max", nachname: "Muster", strasse: "Hauptstraße 1", plz: "12345", ort: "Musterstadt" });
    const invented = await registry.execute("profile_set", { geburtsdatum: "01.01.1990" }, turn("owner_message", words));
    expect(invented.ok).toBe(false);
    expect(profile().geburtsdatum).toBeUndefined();
    expect((await registry.execute("profile_set", { vorname: "Max" }, turn("task"))).ok).toBe(false);
  });
});

/** A real Chrome against a page in memory: reading, marking and submitting run as on the server. */
// The test run sets SERAIN_CHROME_PATH empty (vitest.config.ts); this test only needs a local Chrome, no logins.
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FORM_PAGE = `<!doctype html><html lang="de"><head><title>Widerspruch</title></head><body>
<h1>Widerspruch gegen Werbung</h1>
<form id="f" onsubmit="event.preventDefault(); document.body.textContent = 'Danke. Eingang bestätigt für ' + document.getElementById('mail').value; window.__posted = true;">
<label for="name">Name</label><input id="name" name="name">
<label for="mail">E-Mail</label><input id="mail" name="mail" type="email">
<label><input type="checkbox" id="news" name="news"> Newsletter abonnieren</label>
<label><input type="checkbox" id="ds" name="ds"> Ich habe die Datenschutzerklärung gelesen</label>
<input type="hidden" name="csrf" value="x">
<button type="submit">Widerspruch absenden</button>
</form>
<a href="#" onclick="return false">Kontakt</a>
</body></html>`;

describe.skipIf(!existsSync(CHROME))("form session in a real Chrome", () => {
  let browser: import("playwright-core").Browser;
  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  /** What `launchSession` delivers, slim: snapshot with the same page function, clicking and typing by number. */
  async function launched(): Promise<Launched> {
    const page = await browser.newPage();
    await page.setContent(FORM_PAGE);
    const locate = (id: number) => page.locator(`[data-serain-id="${id}"]`);
    return {
      get page() {
        return page;
      },
      snapshot: () =>
        inPage(page.mainFrame(), collectPage, { attribute: "data-serain-id", maxElements: 80, maxChars: 8_000, maxViewChars: 4_000, maxOptions: 20, startId: 1, payment: PAYMENT_FIELD.source }),
      act: async (action, text) => {
        if (action.op === "click") await locate(action.id).click();
        else if (action.op === "type") await locate(action.id).fill(text ?? "");
      },
      screenshot: async () => ({ jpeg: await page.screenshot({ type: "jpeg" }) }) as never,
      close: () => page.close(),
    } as Launched;
  }

  const values = { name: "Max Muster", email: "max@example.org" };
  const idOf = (snapshot: { elements: Array<{ id: number; label: string }> }, label: string) => snapshot.elements.find((element) => element.label.includes(label))!.id;

  it("types Alex's values through placeholders, shows them masked, blocks submitting and holds with fields from the page", async () => {
    let closed = false;
    const form = openFormSession(await launched(), { secrets: () => [], values, hostAllowed: () => true, close: async () => void (closed = true) });
    let page = await form.look();
    page = await form.act({ op: "type", id: idOf(page, "Name"), text: "{{name}}" });
    page = await form.act({ op: "type", id: idOf(page, "E-Mail"), text: "{{email}}" });
    // The model sees the placeholder, never the value.
    expect(page.elements.find((element) => element.label === "Name")?.value).toBe("{{name}}");
    expect(JSON.stringify(page)).not.toContain("max@example.org");
    page = await form.act({ op: "click", id: idOf(page, "Datenschutzerklärung") });
    await expect(form.act({ op: "click", id: idOf(page, "Widerspruch absenden") })).rejects.toThrow(/Only through form_submit/);
    await expect(form.act({ op: "type", id: idOf(page, "Name"), text: "{{geburtsdatum}}" })).rejects.toThrow(/no value/);
    const held = await form.hold(idOf(page, "Widerspruch absenden"));
    expect(held.button).toBe("Widerspruch absenden");
    expect(held.site).toBeNull();
    expect(held.imageMissing).toBeNull();
    expect(held.fields).toEqual([
      { label: "Name", value: "Max Muster", state: "text" },
      { label: "E-Mail", value: "max@example.org", state: "text" },
      { label: "Newsletter abonnieren", value: "", state: "unchecked" },
      { label: "Ich habe die Datenschutzerklärung gelesen", value: "", state: "checked" },
    ]);
    expect(held.image?.length).toBeGreaterThan(1_000);
    await expect(form.act({ op: "scroll" })).rejects.toThrow(/already waiting/);
    const after = await form.submitHeld(held);
    expect(after).toContain("Eingang bestätigt für {{email}}");
    await form.close();
    expect(closed).toBe(true);
  });

  it("does not submit when a field changed after the preview", async () => {
    const session = await launched();
    const form = openFormSession(session, { secrets: () => [], values, hostAllowed: () => true, close: async () => undefined });
    let page = await form.look();
    page = await form.act({ op: "type", id: idOf(page, "Name"), text: "{{name}}" });
    const held = await form.hold(idOf(page, "Widerspruch absenden"));
    await session.page.fill("#name", "Jemand anderes");
    await expect(form.submitHeld(held)).rejects.toThrow(FormFailure);
    expect(await session.page.evaluate(() => (window as unknown as { __posted?: boolean }).__posted ?? false)).toBe(false);
  });

  it("blocks links that act, shows filled invisible fields and holds nothing that does not fit the preview completely", async () => {
    const session = await launched();
    await session.page.setContent(
      `<html lang="de"><a href="/konto/loeschen?ok=1">Konto löschen</a><button type="button" aria-label="Mehr anzeigen" onclick="window.__deleted = true">Löschen</button>` +
        `<form><label for="a">Name</label><input id="a"><div id="s2" style="display:none"><label for="b">Notiz</label><input id="b" value="aus Schritt 1"></div>` +
        `<button type="submit">Senden</button></form>`,
    );
    const form = openFormSession(session, { secrets: () => [], values, hostAllowed: () => true, close: async () => undefined });
    let page = await form.look();
    await expect(form.act({ op: "click", id: idOf(page, "Konto löschen") })).rejects.toThrow(/Only through form_submit/);
    await expect(form.act({ op: "click", id: idOf(page, "Mehr anzeigen") })).rejects.toThrow(/Only through form_submit/);
    expect(await session.page.evaluate(() => (window as unknown as { __deleted?: boolean }).__deleted ?? false)).toBe(false);
    page = await form.look();
    const held = await form.hold(idOf(page, "Senden"));
    expect(held.fields).toEqual([
      { label: "Name", value: "", state: "text" },
      { label: "Notiz (nicht sichtbar)", value: "aus Schritt 1", state: "text" },
    ]);
    const long = await launched();
    await long.page.setContent(`<form><label for="t">Text</label><textarea id="t">${"x".repeat(500)}</textarea><button type="submit">Senden</button></form>`);
    const longForm = openFormSession(long, { secrets: () => [], values, hostAllowed: () => true, close: async () => undefined });
    const longPage = await longForm.look();
    await expect(longForm.hold(idOf(longPage, "Senden"))).rejects.toThrow(/would not see it completely/);
  });

  it("holds nothing on a page with payment fields", async () => {
    const session = await launched();
    await session.page.setContent(`<form><label for="c">Kartennummer</label><input id="c"><button type="submit">Absenden</button></form>`);
    const form = openFormSession(session, { secrets: () => [], values, hostAllowed: () => true, close: async () => undefined });
    const page = await form.look();
    // The submit on a page with payment fields is money already; the field check behind it would refuse as well.
    await expect(form.hold(idOf(page, "Absenden"))).rejects.toThrow(/looks like money/);
    // Language neutral: a card field without English or German words, only `autocomplete=cc-number`.
    await session.page.setContent(`<html lang="tr"><form><label for="k">Numara</label><input id="k" autocomplete="cc-number"><button type="submit">Gönder</button></form>`);
    const other = openFormSession(session, { secrets: () => [], values, hostAllowed: () => true, close: async () => undefined });
    const otherPage = await other.look();
    expect(otherPage.payment).toBe(true);
    await expect(other.hold(idOf(otherPage, "Gönder"))).rejects.toThrow(/looks like money/);
  });

  it("on a page in another language only what is harmless by structure is clicked without the preview", async () => {
    const session = await launched();
    await session.page.setContent(
      `<html lang="tr"><body><h1>Sipariş</h1><a href="/hakkimizda">Hakkımızda</a>` +
        `<button type="button" onclick="window.__added = true">Sepete ekle</button>` +
        `<button type="button" onclick="window.__bought = true">Hemen al 299 TL</button>` +
        `<form><label for="n">Ad</label><input id="n"><label><input type="checkbox" id="k"> KVKK metnini okudum</label><button type="submit">Gönder</button></form></body></html>`,
    );
    const form = openFormSession(session, { secrets: () => [], values, hostAllowed: () => true, close: async () => undefined });
    let page = await form.look();
    expect(page.lang).toBe("tr");
    await expect(form.act({ op: "click", id: idOf(page, "Sepete ekle") })).rejects.toThrow(/cannot tell/);
    await expect(form.act({ op: "click", id: idOf(page, "Hemen al") })).rejects.toThrow(/looks like money/);
    await expect(form.act({ op: "click", id: idOf(page, "Gönder") })).rejects.toThrow(/Only through form_submit/);
    expect(await session.page.evaluate(() => [(window as unknown as { __added?: boolean }).__added ?? false, (window as unknown as { __bought?: boolean }).__bought ?? false])).toEqual([false, false]);
    // A checkbox is harmless by structure, and the submit goes through the preview as everywhere.
    page = await form.act({ op: "click", id: idOf(page, "KVKK") });
    const held = await form.hold(idOf(page, "Gönder"));
    expect(held.fields).toContainEqual({ label: "KVKK metnini okudum", value: "", state: "checked" });
  });
});
