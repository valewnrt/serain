import { describe, expect, it } from "vitest";
import { ConfidentialGuard, describeKinds } from "../src/security/confidential.js";

/**
 * The guard for confidential values (D29). All data here is made up; the IBAN
 * is the public example IBAN of the Bundesbank. The guard depends on country
 * and script, not on the owner's language: German, US, UK, French, Spanish,
 * Turkish, Russian and Finnish data below, in Latin and Arabic-Indic digits.
 */

const USER_MODEL = [
  "## 2. Kontakt und Adressen",
  "- Adresse (privat und Firma): **Dr.-Erika-Beispiel-Weg 7, 12345 Musterstadt am See**",
  "- Handy: **+49 1511 0000042**",
  "- Mail: `alex.test@example.com` — Apple-Konto",
  "## 6. Geld",
  "- Steuernummer **012 345 67890** (seit 01.02.2024), USt-IdNr **DE123456789**.",
  "- Prüfung am 03.04.2025, Kurs 2025-2028, 175 cm, 10 km in 50:00, HRB 654321.",
].join("\n");
const FACTS = ["Alex' Eltern wohnen in der Musterstraße 12a in Beispielhausen.", "Alex läuft seit 2019 regelmäßig."];

const guard = ConfidentialGuard.from([USER_MODEL, ...FACTS]);

describe("ConfidentialGuard", () => {
  it("recognises the address in any spelling, URL-encoded too", () => {
    for (const text of [
      "Fahrzeit mit dem Auto von Dr.-Erika-Beispiel-Weg 7, 12345 Musterstadt nach Mainz, morgen 8 Uhr",
      "von dr. erika beispiel weg 7 nach mainz",
      "Route ab Beispiel-Weg 7 in Musterstadt",
      "https://nominatim.openstreetmap.org/search?q=Dr.-Erika-Beispiel-Weg+7%2C+12345+Musterstadt&format=json",
      "https://geo.example/search?q=7%20Beispiel-Weg%20Musterstadt",
      "https://geo.example/?q=Beispiel-Weg%25207",
      "Blumen an Musterstr. 12 a liefern lassen",
      "MUSTERSTRASSE 12",
      "Muster-Straße Nr. 12",
    ]) {
      expect(guard.check(text), text).toContain("address");
    }
  });

  it("lets town, postal code and other addresses through", () => {
    for (const text of [
      "Fahrzeit mit dem Auto von Musterstadt am See nach Mainz, morgen früh um 8 Uhr",
      "Wetter in 12345 Musterstadt am Wochenende",
      "Öffnungszeiten Restaurant Adler, Kaiserstraße 7, 55116 Mainz",
      "Beispiel-Weg 70 in Berlin",
      "Wanderweg 7 Tage Alpen, Etappe 12",
      "Was kostet ein ICE-Ticket Frankfurt Berlin am 2025-04-03, und was war 2025-2028 geplant?",
      "Laufplan für 10 km unter 50:00 bei 175 cm",
    ]) {
      expect(guard.check(text), text).toEqual([]);
    }
  });

  it("recognises numbers regardless of how the prefix is written and of separators", () => {
    for (const text of [
      "Wem gehört +49 1511 0000042?",
      "0151 100 000 42",
      "0049-1511-0000042",
      "https://lookup.example/?n=015110000042",
      "Finanzamt zur Steuernummer 012/345/67890",
      "USt-Id DE123456789 prüfen",
    ]) {
      expect(guard.check(text), text).toContain("number");
    }
    // Short and public numbers stay free: register number, year, date.
    expect(guard.check("Handelsregister HRB 654321, Eintrag vom 03.04.2025")).toEqual([]);
  });

  it("recognises mail addresses from memory and every valid IBAN", () => {
    expect(guard.check("Steht Alex.Test@Example.com in einem Datenleck?")).toEqual(["email"]);
    expect(guard.check("https://leak.example/check?mail=alex.test%40example.com")).toEqual(["email"]);
    expect(guard.check("Kontakt laut Impressum: info@firma.example")).toEqual([]);
    expect(guard.check("Welche Bank hat DE89 3704 0044 0532 0130 00?")).toEqual(["iban"]);
    expect(guard.check("bank zu de89370400440532013000")).toEqual(["iban"]);
    // Same shape, wrong check digits: no IBAN.
    expect(guard.check("Bestellnummer DE12 9876 5432 1098 7654 32")).toEqual([]);
  });

  it("names the kind of the finding, never the value", () => {
    const kinds = guard.check("Dr.-Erika-Beispiel-Weg 7 und +49 1511 0000042");
    expect(kinds).toEqual(["address", "number"]);
    const label = describeKinds(kinds);
    expect(label).toBe("an address (street and house number) and a phone, account, tax or ID number");
    expect(label).not.toMatch(/Beispiel|0000042/);
  });

  it("counts what it protects, so an empty guard shows", () => {
    expect(ConfidentialGuard.from([]).size).toBe(0);
    expect(ConfidentialGuard.from(["Alex mag Espresso."]).size).toBe(0);
    expect(guard.size).toBeGreaterThanOrEqual(5);
  });
});

describe("ConfidentialGuard outside Germany (fail closed in any language)", () => {
  it("recognises phone numbers in national and international form of any country", () => {
    const cases: Array<[string, string[]]> = [
      // US: stored internationally, written nationally, and the other way round.
      ["Cell: +1 415 555 0123", ["(415) 555-0123", "415.555.0123", "1-415-555-0123", "call 4155550123"]],
      ["Office (415) 555-0199", ["+1 415 555 0199", "tel:+14155550199"]],
      // Turkey, with the trunk zero.
      ["Cep: 0500 000 01 23", ["+90 500 000 01 23", "905000000123"]],
      // Russia: the national trunk prefix is an 8, not a zero.
      ["Телефон 8 900 000-01-23", ["+7 900 000 01 23", "79000000123"]],
      // Malta: a short national number behind a three-digit country code.
      ["+356 2100 0123", ["2100 0123"]],
      // Arabic-Indic digits, stored and checked.
      ["الهاتف ٠٥٠٠ ٠٠٠ ٠١ ٢٣", ["+90 500 000 01 23"]],
      ["+90 500 000 01 23", ["٠٥٠٠٠٠٠٠١٢٣", "０５００ ０００ ０１ ２３"]],
    ];
    for (const [stored, texts] of cases) {
      const guard = ConfidentialGuard.from([stored]);
      for (const text of texts) expect(guard.check(text), `${stored} / ${text}`).toContain("number");
    }
    // A different number of the same shape is not the stored one.
    expect(ConfidentialGuard.from(["+1 415 555 0123"]).check("(212) 555-0187")).toEqual([]);
  });

  it("recognises addresses written the English way (number first, street word after)", () => {
    const guard = ConfidentialGuard.from(["I live at 221B Baker Street, London NW1 6XE.", "Office: 1600 Pennsylvania Ave NW, Washington"]);
    for (const text of [
      "route from 221b baker street to heathrow",
      "Baker Street 221B",
      "https://maps.example/?q=221B%20Baker%20St",
      "1600 Pennsylvania Avenue",
    ]) {
      expect(guard.check(text), text).toContain("address");
    }
    for (const text of ["Baker Street station opening hours", "221 Baker Street", "Pennsylvania Avenue 16"]) {
      expect(guard.check(text), text).toEqual([]);
    }
  });

  it("recognises French, Spanish and Turkish street words around the number", () => {
    const guard = ConfidentialGuard.from(["Adresse: 12 rue de la Paix, 75002 Paris", "Dirección: Calle Mayor 5, Madrid", "Ev: Atatürk Cad. No: 12, Kadıköy"]);
    for (const text of ["12 rue de la paix", "Rue de la Paix 12", "calle mayor 5", "Mayor, 5", "ataturk caddesi no 12", "Atatürk Cad. 12"]) {
      expect(guard.check(text), text).toContain("address");
    }
    for (const text of ["rue de la Paix in Paris", "calle mayor 50", "Atatürk Cad. 120"]) {
      expect(guard.check(text), text).toEqual([]);
    }
  });

  it("finds an address by its postal code in a language without street words (language-neutral)", () => {
    const guard = ConfidentialGuard.from(["Osoite: Mannerheimintie 12, 00100 Helsinki", "Adres: Kerkstraat 8, 1017 GC Amsterdam"]);
    expect(guard.check("taksi Mannerheimintie 12")).toContain("address");
    expect(guard.check("12 Mannerheimintie, Helsinki")).toContain("address");
    expect(guard.check("Kerkstraat 8 Amsterdam")).toContain("address");
    expect(guard.check("Mannerheimintie 120")).toEqual([]);
  });
});
