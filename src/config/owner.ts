import { loadDevVars } from "./dotenv.js";

/**
 * Who runs Serain and where. Serain has exactly one owner, and everything tied
 * to them (name in prompts and texts, time zone, public holidays, place) comes
 * from here, never as a constant in the code. Deliberately separate from
 * `env.ts`: these values are not secrets, and modules that only need the name
 * should not depend on Photon or database credentials.
 */
loadDevVars();

/** The 16 German states per ISO 3166-2:DE, without prefix. */
export const REGIONS = {
  BW: "Baden-Württemberg",
  BY: "Bayern",
  BE: "Berlin",
  BB: "Brandenburg",
  HB: "Bremen",
  HH: "Hamburg",
  HE: "Hessen",
  MV: "Mecklenburg-Vorpommern",
  NI: "Niedersachsen",
  NW: "Nordrhein-Westfalen",
  RP: "Rheinland-Pfalz",
  SL: "Saarland",
  SN: "Sachsen",
  ST: "Sachsen-Anhalt",
  SH: "Schleswig-Holstein",
  TH: "Thüringen",
} as const;

export type Region = keyof typeof REGIONS;

function read(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function ownerName(): string {
  const value = read("OWNER_NAME");
  if (!value) throw new Error("Env OWNER_NAME is missing. Serain has to know whom it works for (a first name is enough).");
  if (value.length > 40 || !/^\p{L}[\p{L}\p{M} .'-]*$/u.test(value)) {
    throw new Error("Env OWNER_NAME is not a name (letters, spaces, hyphen, apostrophe; at most 40 characters).");
  }
  return value;
}

/**
 * German genitive of a name: "Lenas", but "Max'" and "Fritz'" (ending in s, ß,
 * x, z, tz, ce, as the Duden has it). Only for German texts; English texts use
 * `${owner.name}'s`.
 */
export function genitive(name: string): string {
  return /(s|ß|x|z|ce)$/i.test(name) ? `${name}'` : `${name}s`;
}

function timezone(): string {
  const value = read("OWNER_TIMEZONE");
  if (!value) throw new Error("Env OWNER_TIMEZONE is missing (IANA time zone, e.g. Europe/Berlin, America/New_York). Without it, reminders and events are off.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new Error(`Env OWNER_TIMEZONE is not an IANA time zone (e.g. Europe/Berlin): ${value}`);
  }
  return value;
}

/**
 * The starting language (BCP 47, `OWNER_LANGUAGE`, default `en`). Serain
 * answers in the language the owner writes in (`src/i18n/language.ts`); this
 * only holds until it has seen enough of their messages. `locale` keeps the full
 * tag (`de-AT`) for `Intl`, `language` its base (`de`).
 */
function language(): { language: string; locale: string } {
  const value = read("OWNER_LANGUAGE") || "en";
  let locale: string;
  try {
    [locale = ""] = Intl.getCanonicalLocales(value);
  } catch {
    throw new Error(`Env OWNER_LANGUAGE is not a BCP 47 language tag (e.g. en, de, tr, es-MX): ${value}`);
  }
  const base = new Intl.Locale(locale).language;
  if (!/^[a-z]{2,3}$/.test(base)) {
    throw new Error(`Env OWNER_LANGUAGE has no ISO 639 language (e.g. en, de, tr, es-MX): ${value}`);
  }
  return { language: base, locale };
}

/** Country of residence, ISO 3166-1 alpha-2 (`DE`, `TR`, `US`), or null. */
function country(): string | null {
  const value = read("OWNER_COUNTRY").toUpperCase();
  if (!value) return null;
  if (!/^[A-Z]{2}$/.test(value) || new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(value) === undefined) {
    throw new Error(`Env OWNER_COUNTRY is not an ISO 3166-1 alpha-2 country code (e.g. DE, TR, US): ${value}`);
  }
  return value;
}

function region(residence: string | null): Region | null {
  const value = read("OWNER_REGION").toUpperCase().replace(/^DE-/, "");
  if (!value) return null;
  if (residence !== "DE") {
    throw new Error("Env OWNER_REGION is a German state and needs OWNER_COUNTRY=DE.");
  }
  if (!(value in REGIONS)) {
    throw new Error(`Env OWNER_REGION is not a German state code (${Object.keys(REGIONS).join(", ")}): ${value}`);
  }
  return value as Region;
}

function webOrigin(): string | null {
  const value = read("SERAIN_WEB_ORIGIN").replace(/\/+$/, "");
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Env SERAIN_WEB_ORIGIN is not an address (e.g. https://serain.example.com): ${value}`);
  }
  if (url.protocol !== "https:" || url.origin !== value) {
    throw new Error(`Env SERAIN_WEB_ORIGIN must be a bare https origin, without a path: ${value}`);
  }
  return value;
}

const name = ownerName();
const residence = country();
const spoken = language();

export const owner = {
  /** First name, as Serain addresses the owner and writes about them. */
  name,
  /** German genitive ("Lenas", "Max'") for German texts such as "Lenas Kalender". */
  genitive: genitive(name),
  /** English possessive ("Lena's", "Max's") for English prompts and tool texts. */
  possessive: `${name}'s`,
  /** IANA time zone (`OWNER_TIMEZONE`, required) the owner thinks in. `src/time.ts` computes wall-clock time in it. */
  timezone: timezone(),
  /** Country of residence (`OWNER_COUNTRY`). Public holidays exist only for `DE` so far (`src/holidays.ts`). */
  country: residence,
  /** German state for public holidays (`src/holidays.ts`); without it only the nationwide ones. Only with `country: "DE"`. */
  region: region(residence),
  /** Home town, as the starting point for timetables, weather and searches nearby. Optional. */
  city: read("OWNER_CITY") || null,
  /** Starting language as a base subtag (`en`, `de`, `tr`). The current one is `currentLanguage()` in `src/i18n/language.ts`. */
  language: spoken.language,
  /** The full tag from `OWNER_LANGUAGE` (`de-AT`), for `Intl` while the current language is still this one. */
  locale: spoken.locale,
} as const;

/**
 * Origin of the web interface (D49), e.g. `https://serain.example.com`.
 * Optional: without it there are no connections with a fixed redirect address
 * (bank) and no reference to it in texts to the owner.
 */
export const instance = {
  webOrigin: webOrigin(),
} as const;
