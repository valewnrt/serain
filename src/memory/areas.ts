import { MEMORY } from "../config/memory.js";
import { audit } from "../db/audit.js";
import { t, textLanguage } from "../i18n/catalog.js";
import { currentLanguage, currentLocale } from "../i18n/language.js";
import { memory as messages } from "../i18n/messages/memory.js";
import { parseLearned, type LearnedKey } from "./consolidate-rules.js";
import type { MemoryDeps } from "./deps.js";
import { shortDay, validityParts, type FactKind, type ValidityParts } from "./kinds.js";
import type { StoredProcedure } from "./proposal-store.js";
import type { ActiveFact } from "./store.js";
import type { UserModelVersion } from "./user-model.js";

/**
 * Areas of the memory for `show_memory` (package 2 of 2026-10-08, modelled
 * on Persona: me, people, places, dates). A fact's category is chosen freely
 * ("identity", "relationship"), and it does not tell that "born on 03.10." is
 * an anniversary or the address a place. That is why every fact carries an
 * area (`facts.area`, migration 0024): the extraction sets it when writing,
 * facts without one (seed, trimmed rests, everything before the migration)
 * are classified afterwards by the maintenance (`maybeClassifyAreas`). Until
 * then the kind is the fallback (`areaOf`).
 *
 * The data stays where it is: an area is a column, not a rebuild. The area
 * ids are fixed ASCII keys (`agent/playbooks.ts` names them, the database
 * checks them); they are identifiers, never shown as they are. The owner
 * reads the headings of the catalog (`messages/memory.ts`), the model the
 * English names in `SECTION_LABELS`.
 *
 * Facts classified before the keys became English carry German ids (`ich`,
 * `orte`, …). They are read through `areaFromStored` and only ever written
 * in the new form.
 */
export const FACT_AREAS = ["self", "open", "people", "places", "preferences", "anniversaries"] as const;
export type FactArea = (typeof FACT_AREAS)[number];

/** Area ids written before the English keys, for reading stored facts only. */
export const LEGACY_AREAS: Readonly<Record<string, FactArea>> = {
  ich: "self",
  offen: "open",
  personen: "people",
  orte: "places",
  praeferenzen: "preferences",
  jahrestage: "anniversaries",
};

/** The area of a stored row: the current key, a legacy key mapped to it, null for none or anything unknown. */
export function areaFromStored(raw: string | null | undefined): FactArea | null {
  if (!raw) return null;
  if ((FACT_AREAS as readonly string[]).includes(raw)) return raw as FactArea;
  return LEGACY_AREAS[raw] ?? null;
}

/** The stored values that mean these areas, current and legacy, for queries on the `area` column (`area_facts`). */
export function storedAreaKeys(areas: readonly FactArea[]): string[] {
  const legacy = Object.entries(LEGACY_AREAS).filter(([, area]) => areas.includes(area)).map(([key]) => key);
  return [...new Set([...areas, ...legacy])];
}

/** What belongs into an area, for extraction and classification. One sentence per area. */
export const AREA_RULES = [
  "Every fact gets exactly one area (area, a fixed id):",
  "- self: who the user is and what defines them: origin, job, company, education, health, money, history.",
  "- open: what is going on or coming up right now and will be done at some point: projects, plans, intentions, things waiting, a phase.",
  "- people: other people and animals in their life and what holds about them.",
  "- places: places that matter to them: home, office, regular spots, doctors, travel destinations, addresses.",
  "- preferences: what they like or dislike, how they want things, habits, how the assistant should deal with them.",
  "- anniversaries: recurring dates: birthdays (theirs too), anniversaries, wedding anniversaries, dates of death.",
  "If a fact fits several, what it is essentially about counts: a birthday is an anniversary, even if it belongs to a person.",
] as const;

const KIND_FALLBACK: Record<FactKind, FactArea> = {
  identity: "self",
  preference: "preferences",
  situation: "open",
  episode: "self",
};

/** The area of a fact; without a stored area it follows the kind. A legacy id that slipped past the store still counts. */
export function areaOf(fact: { area: FactArea | null; kind: FactKind }): FactArea {
  return areaFromStored(fact.area) ?? KIND_FALLBACK[fact.kind];
}

/** The kinds whose facts fall into these areas without a stored area (for `area_facts`, like `areaOf`). */
export function kindsFallingInto(areas: readonly FactArea[]): FactKind[] {
  return (Object.keys(KIND_FALLBACK) as FactKind[]).filter((kind) => areas.includes(KIND_FALLBACK[kind]));
}

/**
 * Classifies facts without an area afterwards, one model call for at most
 * `MEMORY.areaBatch` facts. Runs in the maintenance, never in the turn. What
 * the model does not classify stays empty and comes up again in the next run.
 *
 * `more`: the batch was full and classified something, so probably more is
 * waiting. Then the next one runs right away instead of an hour later.
 */
export async function maybeClassifyAreas(deps: MemoryDeps): Promise<{ classified: number; more: boolean }> {
  const pending = await deps.store.unclassifiedFacts(MEMORY.areaBatch);
  if (pending.length === 0) return { classified: 0, more: false };
  const areas = await deps.classifyAreas({ facts: pending.map((fact) => fact.content) });
  const updates = pending.flatMap((fact, index) => {
    const area = areas[index];
    return area ? [{ id: fact.id, area }] : [];
  });
  if (updates.length > 0) await deps.store.setFactAreas(updates);
  await audit("memory_areas", { pending: pending.length, classified: updates.length });
  return { classified: updates.length, more: pending.length === MEMORY.areaBatch && updates.length > 0 };
}

/** A section in `show_memory`: the six areas and the approved procedures (D42). */
export type MemorySection = FactArea | "procedures";

export const SECTION_ORDER: readonly MemorySection[] = [...FACT_AREAS, "procedures"];

/** The English name of each section, for texts to the model (tool results). The owner reads `SECTION_HEADINGS`. */
export const SECTION_LABELS: Record<MemorySection, string> = {
  self: "me",
  open: "open",
  people: "people",
  places: "places",
  preferences: "preferences",
  anniversaries: "anniversaries",
  procedures: "procedures",
};

const SECTION_HEADINGS = {
  self: messages.sectionSelf,
  open: messages.sectionOpen,
  people: messages.sectionPeople,
  places: messages.sectionPlaces,
  preferences: messages.sectionPreferences,
  anniversaries: messages.sectionAnniversaries,
  procedures: messages.sectionProcedures,
} as const satisfies Record<MemorySection, unknown>;

/** Case, accents and "ß" do not matter, independent of any locale: "Präferenzen", "praeferenzen" and "PRAFERENZEN" compare equal. */
function fold(text: string): string {
  return text.trim().toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/ß/g, "ss").replace(/\s+/g, " ");
}

/**
 * Names of a section the model may pass (`show_memory` with `area`): the id,
 * the English name, singular forms, and the German ids and headings from
 * before the keys and texts were English ("orte", "Präferenzen", "Abläufe").
 */
const SECTION_ALIASES: Record<MemorySection, readonly string[]> = {
  self: ["self", "me", "myself", "ich"],
  open: ["open", "offen"],
  people: ["people", "person", "personen"],
  places: ["places", "place", "orte", "ort"],
  preferences: ["preferences", "preference", "praeferenzen", "praeferenz", "präferenzen", "präferenz"],
  anniversaries: ["anniversaries", "anniversary", "birthdays", "birthday", "jahrestage", "jahrestag"],
  procedures: ["procedures", "procedure", "ablaeufe", "ablauf", "abläufe"],
};

const SECTION_BY_ALIAS = new Map<string, MemorySection>(
  (Object.entries(SECTION_ALIASES) as Array<[MemorySection, readonly string[]]>).flatMap(([section, aliases]) =>
    aliases.map((alias) => [fold(alias), section] as const),
  ),
);

/** A section from the model's or the owner's words ("people", "Personen", "Präferenzen", "procedure"). Null when none fits. */
export function parseSection(raw: string): MemorySection | null {
  return SECTION_BY_ALIAS.get(fold(raw)) ?? null;
}

/** An area from the model's or the owner's words; like `parseSection`, without the procedures. */
export function parseArea(raw: string): FactArea | null {
  const section = parseSection(raw);
  return section && section !== "procedures" ? section : null;
}

/**
 * One entry of `show_memory`, as data; `renderMemoryLines` writes it in the
 * owner's language. **Said** means: the fact comes from a message of the owner
 * (`source_message_id`); a confirmed lesson and an approved procedure too.
 * **Inferred** means: Serain did not get it from the owner in the chat but
 * from the seed (`memory:push`, compiled from their notes) or from the
 * nightly consolidation. `at` is when Serain learned it.
 */
export interface MemoryLine {
  section: MemorySection;
  /** What Serain knows, verbatim as stored; for a procedure its title. */
  content: string;
  origin: "said" | "inferred";
  at: string;
  /** When a fact holds (D39); null without a limit. */
  validity: ValidityParts | null;
  /** A procedure's trigger and steps, verbatim. */
  procedure?: { trigger: string; steps: string };
}

/**
 * How the consolidation's sections fall into the areas. "When to act, when
 * to ask" and "how to write" are both how the owner wants things.
 */
const LEARNED_AREAS: Record<LearnedKey, FactArea> = {
  who: "self",
  current: "open",
  when_to_act: "preferences",
  how_to_write: "preferences",
};

/**
 * Everything `show_memory` shows, as entries with area, origin and date
 * (provenance, D6). Expired facts are not shown by the caller, they no longer
 * hold (D39).
 *
 * The owner's base text is not part of it: it is their own document, 15,000
 * characters long, and belongs in the web interface, not in iMessage.
 */
export function memoryLines(input: {
  facts: readonly ActiveFact[];
  learned: Pick<UserModelVersion, "learned" | "createdAt"> | null;
  procedures: readonly StoredProcedure[];
  now: Date;
}): MemoryLine[] {
  const lines: MemoryLine[] = [];
  const sorted = [...input.facts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const fact of sorted) {
    lines.push({
      section: areaOf(fact),
      content: fact.content,
      origin: fact.sourceMessageId ? "said" : "inferred",
      at: fact.createdAt,
      validity: validityParts(fact, input.now),
    });
  }
  if (input.learned) {
    const sections = parseLearned(input.learned.learned);
    for (const [key, items] of Object.entries(sections) as Array<[LearnedKey, string[]]>) {
      for (const content of items) {
        lines.push({ section: LEARNED_AREAS[key], content, origin: "inferred", at: input.learned.createdAt, validity: null });
      }
    }
  }
  for (const procedure of input.procedures) {
    lines.push({
      section: "procedures",
      content: procedure.title,
      origin: "said",
      at: procedure.createdAt,
      validity: null,
      procedure: { trigger: procedure.trigger, steps: procedure.body.trim() },
    });
  }
  return lines;
}

/** The validity of an entry for the owner: "bis 30.11.2026", "until 11/30/2026". */
function validityText(validity: ValidityParts, locale: string, lang: string): string {
  const day = (date: Date) => shortDay(date, locale);
  const { start, until } = validity;
  if (start && until) {
    return t(start.kind === "on" ? messages.validOnUntil : messages.validFromUntil, { from: day(start.day), until: day(until) }, lang);
  }
  if (start) return t(start.kind === "on" ? messages.validOn : messages.validFrom, { day: day(start.day) }, lang);
  return until ? t(messages.validUntil, { day: day(until) }, lang) : "";
}

function lineText(line: MemoryLine, locale: string, lang: string): string {
  const day = shortDay(new Date(line.at), locale);
  if (line.procedure) {
    // The origin goes behind the title, not behind the last step.
    const head = t(messages.procedureLine, { title: line.content, trigger: line.procedure.trigger, day }, lang);
    return [head, line.procedure.steps].filter(Boolean).join("\n");
  }
  const validity = line.validity ? validityText(line.validity, locale, lang) : "";
  const said = line.origin === "said";
  if (validity) return t(said ? messages.lineSaidValid : messages.lineInferredValid, { content: line.content, day, validity }, lang);
  return t(said ? messages.lineSaid : messages.lineInferred, { content: line.content, day }, lang);
}

/**
 * The entries of one or more sections as text for the owner, in fixed order,
 * in the owner's language (the frame; the content stays as stored).
 */
export function renderMemoryLines(lines: readonly MemoryLine[], lang: string = currentLanguage()): string {
  // One language for frame and dates: English until the catalog of `lang` is there.
  const used = textLanguage(messages.lineSaid, lang);
  const locale = currentLocale(used);
  return SECTION_ORDER.flatMap((section) => {
    const own = lines.filter((line) => line.section === section);
    if (own.length === 0) return [];
    return [[t(SECTION_HEADINGS[section], {}, used), ...own.map((line) => `- ${lineText(line, locale, used)}`)].join("\n")];
  }).join("\n\n");
}
