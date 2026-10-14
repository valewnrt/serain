import { defineMessages } from "../catalog.js";

/**
 * Fixed texts of forms and logged-in sessions that reach the owner in a
 * preview (D63, part C; addendum D48 of 2026-10-08): the names of the profile
 * fields, the marks on read fields, and why a preview comes without a picture.
 * The frame of the preview itself belongs to `src/agent/tools/forms.ts`.
 */
export const forms = defineMessages({
  profileFirstName: { en: "first name", de: "Vorname", note: "Name of a field of the owner's profile for forms." },
  profileLastName: { en: "last name", de: "Nachname", note: "Name of a field of the owner's profile for forms." },
  profileName: { en: "name", de: "Name", note: "First and last name together, a field of the owner's profile." },
  profileStreet: { en: "street and house number", de: "Straße und Hausnummer", note: "Name of a field of the owner's profile for forms." },
  profilePostcode: { en: "postal code", de: "Postleitzahl", note: "Name of a field of the owner's profile for forms." },
  profileCity: { en: "city", de: "Ort", note: "Name of a field of the owner's profile for forms." },
  profileCountry: { en: "country", de: "Land", note: "Name of a field of the owner's profile for forms." },
  profileBirthdate: { en: "date of birth", de: "Geburtsdatum", note: "Name of a field of the owner's profile for forms." },
  profilePhone: { en: "phone", de: "Telefon", note: "Name of a field of the owner's profile for forms." },
  profileEmail: { en: "email address", de: "Mailadresse", note: "Name of a field of the owner's profile for forms." },
  fieldHidden: {
    en: "{label} (not visible)",
    de: "{label} (nicht sichtbar)",
    note: "{label} is the label of a form field the page filled but does not show; it still goes out with the form.",
  },
  masked: {
    en: "[hidden]",
    de: "[ausgeblendet]",
    note: "Stands in a preview where a password or code of the owner was removed.",
  },
  shotPasswordField: {
    en: "there's a password field on the page",
    de: "auf der Seite steht ein Passwortfeld",
    note: "Why a preview comes without a screenshot of the page.",
  },
  shotCodeField: {
    en: "there's a field for a code on the page",
    de: "auf der Seite steht ein Feld für einen Code",
    note: "Why a preview comes without a screenshot: a field for a login code.",
  },
  shotUnreadable: {
    en: "the page couldn't be checked",
    de: "die Seite ließ sich nicht prüfen",
    note: "Why a preview comes without a screenshot.",
  },
  shotCredentials: {
    en: "login details are on the page",
    de: "auf der Seite stehen Zugangsdaten",
    note: "Why a preview comes without a screenshot.",
  },
  shotCardNumber: {
    en: "a card number is on the page",
    de: "auf der Seite steht eine Kartennummer",
    note: "Why a preview comes without a screenshot: a payment card number.",
  },
});
