import { t } from "../i18n/catalog.js";
import { forms } from "../i18n/messages/forms.js";

/**
 * The owner's details for forms (D63, part C): name, address, date of birth,
 * phone, mail. The model only knows placeholders like `{{name}}`; the code
 * fills in the value when typing, and every snapshot shows the placeholder
 * again. What the page gets in the end, the owner sees in the preview before
 * submitting, with the real values.
 *
 * The profile is only set from the owner's own words (`profile_set`): no value
 * a model put together from memory or a mail. Mail and phone come without a
 * profile from what the code knows anyway (main mailbox, `OWNER_PHONE`), as
 * long as the owner has not said otherwise.
 *
 * The keys are stored data (`agent_state.owner_profile`) and the placeholders
 * the model writes, so they keep their (German) names.
 */

export const PROFILE_FIELDS = ["vorname", "nachname", "strasse", "plz", "ort", "land", "geburtsdatum", "telefon", "email"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type OwnerProfile = Partial<Record<ProfileField, string>>;

/** What a placeholder means, for the model (tool descriptions and results). */
export const PROFILE_LABELS: Record<ProfileField | "name", string> = {
  vorname: "first name",
  nachname: "last name",
  name: "name",
  strasse: "street and house number",
  plz: "postal code",
  ort: "city",
  land: "country",
  geburtsdatum: "date of birth",
  telefon: "phone",
  email: "email address",
};

const PROFILE_TEXTS = {
  vorname: forms.profileFirstName,
  nachname: forms.profileLastName,
  name: forms.profileName,
  strasse: forms.profileStreet,
  plz: forms.profilePostcode,
  ort: forms.profileCity,
  land: forms.profileCountry,
  geburtsdatum: forms.profileBirthdate,
  telefon: forms.profilePhone,
  email: forms.profileEmail,
} as const satisfies Record<ProfileField | "name", unknown>;

/** What a placeholder means, for the owner (previews), in their language. */
export function profileLabel(field: ProfileField | "name", lang?: string): string {
  return lang ? t(PROFILE_TEXTS[field], {}, lang) : t(PROFILE_TEXTS[field]);
}

export interface ProfileStore {
  load(): Promise<OwnerProfile>;
  save(profile: OwnerProfile): Promise<void>;
}

const PLACEHOLDER = /\{\{\s*([a-zäöü]+)\s*\}\}/gi;

/** Every value a placeholder can have: the stored profile plus mail and phone, which the code knows. */
export function profileValues(profile: OwnerProfile, defaults: { email?: string; telefon?: string }): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of PROFILE_FIELDS) {
    const value = profile[field]?.trim() || (field === "email" ? defaults.email : field === "telefon" ? defaults.telefon : undefined);
    if (value) values[field] = value;
  }
  if (values["vorname"] && values["nachname"]) values["name"] = `${values["vorname"]} ${values["nachname"]}`;
  return values;
}

/** Fills in the values for the placeholders. `missing` names what does not exist; then nothing is typed. */
export function resolvePlaceholders(text: string, values: Readonly<Record<string, string>>): { text: string; missing: string[]; used: string[] } {
  const missing = new Set<string>();
  const used = new Set<string>();
  const resolved = text.replace(PLACEHOLDER, (match, raw: string) => {
    const key = raw.toLowerCase();
    const value = values[key];
    if (value === undefined) {
      missing.add(key);
      return match;
    }
    used.add(key);
    return value;
  });
  return { text: resolved, missing: [...missing], used: [...used] };
}

/**
 * Replaces the owner's values by their placeholders, longest first (the name
 * before the first name). Short values (under three characters) stay: "DE" as
 * a country would otherwise stand in every other word.
 */
export function maskProfile(text: string, values: Readonly<Record<string, string>>): string {
  const entries = Object.entries(values)
    .filter(([, value]) => value.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [key, value] of entries) out = out.split(value).join(`{{${key}}}`);
  return out;
}

/** Does the value stand like this in the owner's words? Spaces and case do not count. */
export function inOwnerWords(value: string, ownerWords: string): boolean {
  const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  const wanted = squash(value);
  return wanted.length > 0 && squash(ownerWords).includes(wanted);
}
