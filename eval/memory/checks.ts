import { OWNER_TIMEZONE } from "../../src/time.js";
import {
  UNKNOWN_MACRO,
  UNKNOWN_VARIANTS,
  V2_STATE_TYPES,
  type AnswerSpec,
  type CheckResult,
  type FactRowSnapshot,
  type MemorySnapshot,
  type StateCheck,
} from "./types.js";

/**
 * The check functions of the memory eval. Pure: a snapshot or a text goes in,
 * passed or not comes out. No model judges here: the
 * blueprint puts the judge at the end, and rules you can read are the
 * more honest first version.
 */

// --- Normalization ---------------------------------------------------------

const UMLAUTS: Array<[RegExp, string]> = [
  [/ä/g, "ae"],
  [/ö/g, "oe"],
  [/ü/g, "ue"],
  [/Ä/g, "Ae"],
  [/Ö/g, "Oe"],
  [/Ü/g, "Ue"],
  [/ß/g, "ss"],
];

/** Spell out umlauts. Applies to text and pattern alike, otherwise "köln" never matches "Koeln". */
export function foldUmlauts(text: string): string {
  let out = text.normalize("NFC");
  for (const [re, replacement] of UMLAUTS) out = out.replace(re, replacement);
  return out;
}

/**
 * Text for comparison: lowercase, umlauts spelled out, typographic characters
 * unified, whitespace collapsed. A model writes "Roter Anker",
 * "roter anker" or "„Roter Anker“"; the same thing is meant.
 */
export function normalize(text: string): string {
  return foldUmlauts(text)
    .toLowerCase()
    .replace(/[„“”"«»‚‘’']/g, "")
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pattern against normalized text. In the pattern only the umlauts are
 * spelled out, it is not lowercased: `\S` and `\D` would otherwise become `\s`
 * and `\d`. Case is handled by the flag.
 */
export function matches(pattern: string, text: string): boolean {
  return new RegExp(foldUmlauts(pattern), "i").test(normalize(text));
}

// --- Date window -----------------------------------------------------------

const OWNER_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: OWNER_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar day in Berlin as YYYY-MM-DD. "Until the end of August" is a local day, not a UTC day. */
export function ownerDay(instant: string | Date): string {
  return OWNER_DAY.format(typeof instant === "string" ? new Date(instant) : instant);
}

function dayNumber(dayString: string): number {
  const [y, m, d] = dayString.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Is the instant at most `toleranceDays` calendar days away from the expected day? */
export function withinDays(actual: string, expectedDay: string, toleranceDays = 3): boolean {
  return Math.abs(dayNumber(ownerDay(actual)) - dayNumber(expectedDay)) <= toleranceDays;
}

// --- Recall ----------------------------------------------------------------

/** 1-based rank of the first hit, or null. */
export function firstRank(ranked: readonly string[], pattern: string): number | null {
  const index = ranked.findIndex((content) => matches(pattern, content));
  return index < 0 ? null : index + 1;
}

export function recallAtK(ranked: readonly string[], pattern: string, k: number): boolean {
  const rank = firstRank(ranked, pattern);
  return rank !== null && rank <= k;
}

export function absenceAtK(ranked: readonly string[], pattern: string, k: number): boolean {
  return !ranked.slice(0, k).some((content) => matches(pattern, content));
}

// --- Follow-up question from forget_fact ------------------------------------

/**
 * The candidates from the follow-up question of `forget_fact`, exactly from the text
 * the model gets too ("<id>: [category] content", one line per fact).
 * The model reads them from there to ask the owner and then delete with `fact_id`;
 * the eval does the same.
 */
export function parseForgetCandidates(text: string): Array<{ id: string; category: string; content: string }> {
  const out: Array<{ id: string; category: string; content: string }> = [];
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}): \[([^\]]*)\] (.+)$/.exec(line.trim());
    if (match) out.push({ id: match[1] as string, category: match[2] as string, content: match[3] as string });
  }
  return out;
}

// --- State -----------------------------------------------------------------

function active(snapshot: MemorySnapshot): FactRowSnapshot[] {
  return snapshot.facts.filter((fact) => fact.supersededBy === null);
}

function quote(facts: readonly FactRowSnapshot[], max = 6): string {
  if (facts.length === 0) return "none";
  const shown = facts.slice(0, max).map((fact) => `"${fact.content}"`);
  return facts.length > max ? `${shown.join("; ")} (+${facts.length - max})` : shown.join("; ");
}

function result(
  id: string,
  kind: string,
  needsV2: boolean,
  passed: boolean,
  detail: string,
): CheckResult {
  return { id, level: 1, kind, needsV2, passed, detail };
}

/** Level 1 for a case. A sentinel check is fanned out into one check per layer. */
export function evaluateState(checks: readonly StateCheck[], snapshot: MemorySnapshot): CheckResult[] {
  const out: CheckResult[] = [];
  const live = active(snapshot);

  checks.forEach((check, index) => {
    const id = `L1.${index + 1}.${check.type}`;
    const needsV2 = check.needsV2 ?? V2_STATE_TYPES.has(check.type);

    switch (check.type) {
      case "fact_present": {
        const hits = live.filter((fact) => matches(check.pattern, fact.content));
        out.push(
          result(id, check.type, needsV2, hits.length > 0, hits.length > 0
            ? `hits: ${quote(hits)}`
            : `/${check.pattern}/ not among the active facts: ${quote(live)}`),
        );
        return;
      }
      case "fact_absent": {
        const pool = check.includeSuperseded ? snapshot.facts : live;
        const allowIf = check.allowIf;
        const hits = pool.filter(
          (fact) => matches(check.pattern, fact.content) && !(allowIf && matches(allowIf, fact.content)),
        );
        out.push(
          result(id, check.type, needsV2, hits.length === 0, hits.length === 0
            ? `/${check.pattern}/ nowhere`
            : `still there: ${quote(hits)}`),
        );
        return;
      }
      case "superseded": {
        const all = snapshot.facts.filter((fact) => matches(check.pattern, fact.content));
        const stillActive = all.filter((fact) => fact.supersededBy === null);
        const replaced = all.filter((fact) => fact.supersededBy !== null);
        const passed = replaced.length > 0 && stillActive.length === 0;
        out.push(
          result(id, check.type, needsV2, passed, passed
            ? `superseded: ${quote(replaced)}`
            : all.length === 0
              ? `/${check.pattern}/ was never stored`
              : `still active: ${quote(stillActive)}`),
        );
        return;
      }
      case "fact_count": {
        const learned = live.filter((fact) => !fact.seeded);
        out.push(
          result(id, check.type, needsV2, learned.length <= check.max,
            `${learned.length} learned facts (at most ${check.max}): ${quote(learned)}`),
        );
        return;
      }
      case "kind": {
        const hits = live.filter((fact) => matches(check.pattern, fact.content));
        const passed = hits.length > 0 && hits.every((fact) => fact.kind === check.kind);
        out.push(
          result(id, check.type, needsV2, passed, hits.length === 0
            ? `/${check.pattern}/ not stored`
            : `kind ${hits.map((fact) => fact.kind).join(", ")}, expected ${check.kind}`),
        );
        return;
      }
      case "valid_until":
      case "valid_from": {
        const hits = live.filter((fact) => matches(check.pattern, fact.content));
        const field = check.type === "valid_until" ? "validUntil" : "validFrom";
        const values = hits.map((fact) => fact[field]);
        const passed =
          hits.length > 0 &&
          values.every((value) =>
            check.date === null ? value === null : value !== null && withinDays(value, check.date),
          );
        out.push(
          result(id, check.type, needsV2, passed, hits.length === 0
            ? `/${check.pattern}/ not stored`
            : `${check.type} = ${values.map((value) => (value ? ownerDay(value) : "null")).join(", ")}, expected ${check.date ?? "null"} ±3 days`),
        );
        return;
      }
      case "sentinel_absent": {
        const needle = normalize(check.sentinel);
        const layers: Array<[string, string[]]> = [
          ["facts", snapshot.facts.map((fact) => fact.content)],
          ["summaries", snapshot.summaries],
          [
            "user_model",
            snapshot.userModels.flatMap((version) => [version.base, version.learned]),
          ],
          ["open_questions", snapshot.openQuestions],
        ];
        for (const [layer, texts] of layers) {
          const found = texts.filter((text) => normalize(text).includes(needle)).length;
          out.push(
            result(`${id}.${layer}`, `sentinel:${layer}`, needsV2, found === 0, found === 0
              ? `"${check.sentinel}" not in ${layer}`
              : `"${check.sentinel}" still in ${found} row(s) of ${layer}`),
          );
        }
        return;
      }
    }
  });
  return out;
}

// --- Answer ----------------------------------------------------------------

/** Replace `@unbekannt` with the fixed abstention list. */
export function expandVariants(group: readonly string[]): string[] {
  return group.flatMap((variant) => (variant === UNKNOWN_MACRO ? [...UNKNOWN_VARIANTS] : [variant]));
}

/** Level 3: required groups and forbidden words, both normalized. */
export function evaluateAnswer(spec: AnswerSpec, text: string): CheckResult[] {
  const haystack = normalize(text);
  const out: CheckResult[] = [];
  spec.anyOf.forEach((group, index) => {
    const variants = expandVariants(group);
    const hit = variants.find((variant) => haystack.includes(normalize(variant)));
    out.push({
      id: `L3.anyOf.${index + 1}`,
      level: 3,
      kind: "answer_any_of",
      needsV2: false,
      passed: hit !== undefined,
      detail: hit ? `contains "${hit}"` : `none of: ${group.join(" | ")}`,
    });
  });
  if (spec.notContains.length > 0) {
    const found = spec.notContains.filter((needle) => haystack.includes(normalize(needle)));
    out.push({
      id: "L3.notContains",
      level: 3,
      kind: "answer_not_contains",
      needsV2: false,
      passed: found.length === 0,
      detail: found.length === 0 ? "nothing forbidden" : `contains: ${found.join(", ")}`,
    });
  }
  return out;
}
