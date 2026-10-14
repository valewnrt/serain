import { splitIntoBubbles, stripMarkdown } from "../src/text/format.js";
import { MAX_MESSAGES_PER_TURN } from "../src/config/limits.js";
import { owner } from "../src/config/owner.js";
import { classify, type Detector } from "../src/i18n/language.js";
import { findForbiddenOpeners, findForbiddenPhrases } from "../src/agent/style.js";
import { GREETING_MAX_CHARS, LENGTH_MIRROR } from "./config.js";
import type {
  CheckResult,
  ChatCase,
  DatesCase,
  JudgeAnswer,
  JudgeCase,
  ToolsCase,
  TurnRecord,
} from "./types.js";

/**
 * Rule checks (W2: "an explicit, checkable list of what is forbidden and what
 * is mirrored"). Pure functions only: text goes in, passed or not comes out.
 * They are tested and run without network, database or model.
 *
 * What is measured is the **raw** model text, not what would reach the owner
 * after the OutboundGate. The gate repairs markdown; a model that produces
 * markdown has still produced it, and that is exactly what the comparison
 * should see. The one exception is the bubble count: it only comes about in
 * the gate, so this check calculates with the same functions as production.
 *
 * Language-dependent checks know the language of the reply they measure
 * (`ChatCase.language`, else the detected language of the input): filler per
 * language (`src/agent/style.ts`), phrases about not knowing in English and
 * German. Dashes and markdown are forbidden in every language.
 */

// --- Building blocks ----------------------------------------------------------

/** Dashes of every kind, in every language. Project rules, style: "no dashes". */
const DASHES = /[‒–—―]/;

/**
 * Everything except `**bold**`: the style allows that once per message (D48),
 * it arrives as real iMessage formatting. It is counted in `checkBoldSparing`.
 */
const MARKDOWN_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "italic (_…_)", re: /(?<![\w_])_(?=\S)[^_\n]*?\S_(?![\w_])/ },
  { label: "code fence", re: /```/ },
  { label: "inline code", re: /`[^`\n]+`/ },
  { label: "heading", re: /^\s{0,3}#{1,6}\s+\S/m },
  { label: "quote", re: /^\s{0,3}>\s+\S/m },
  { label: "list", re: /^\s{0,3}[-*+]\s+\S/m },
  { label: "numbered list", re: /^\s{0,3}\d+[.)]\s+\S/m },
  { label: "link", re: /\[[^\]\n]+\]\([^)\s]+\)/ },
];

const EMOJI = /\p{Extended_Pictographic}/u;
/**
 * One emoji as a whole, including the variation selector and ZWJ sequences.
 * Without that 👨‍👩‍👧 counted as three emoji and the rule "at most one" would fire
 * wrongly.
 */
const EMOJI_CLUSTER = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;

/**
 * Internal names carry underscores: `send_message`, `forget_fact`, `audit_log`.
 * Chat text never does, so the shape is enough as a marker for everything no
 * tool list knows (tables, columns, functions).
 */
const SNAKE_CASE = /\b[a-zäöü]{2,}(?:_[a-z0-9äöü]+)+\b/gu;

/** Phrases with which a model claims not to know about itself (English and German). */
const CLAIMS_SELF_IGNORANCE =
  /(weiß ich (selbst )?nicht|weiss ich nicht|keine ahnung|kann ich dir nicht sagen|kann ich nicht wissen|kann ich nicht sagen|da kenne? ich mich nicht aus|habe ich keinen einblick|weiß ich leider nicht|i (really )?don['’]?t know|no idea|i can['’]?t (tell|say|know)|i have no (insight|idea|way of knowing)|not sure how i work)/i;

const GERMAN_WORDS =
  /\b(ich|du|dir|dich|nicht|und|ist|das|dass|die|der|den|dem|ein|eine|einen|mit|auf|für|kann|kannst|hab|habe|hast|wir|mal|schon|noch|heute|morgen|gern|gerne|machen|mach|was|wie|wann|warum|ja|nein|bis|dann|weil|aber|bei|von|zu|im|am|über|ohne|mehr|keine|kein|wenn|sag|weiß|geht|gibt)\b/giu;

const ENGLISH_WORDS =
  /\b(the|and|you|your|is|are|to|of|for|with|that|this|it's|i'll|i'm|let|know|can|will|would|should|there|here|what|when|why|about|from|have|has|been|was|were|they|their|we're|don't|doesn't)\b/gi;

/** ä ö ü ß are a strong German signal, even in a two-word sentence. */
const GERMAN_LETTERS = /[äöüßÄÖÜ]/;

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function ok(id: string, passed: boolean, detail?: string): CheckResult {
  return detail === undefined ? { id, passed } : { id, passed, detail };
}

// --- Single rules --------------------------------------------------------------

export function checkNoDashes(text: string): CheckResult {
  const hit = DASHES.test(text);
  return ok("no_dashes", !hit, hit ? "dash in the answer" : undefined);
}

export function checkNoMarkdown(text: string): CheckResult {
  const found = MARKDOWN_PATTERNS.filter((pattern) => pattern.re.test(text)).map((p) => p.label);
  return ok("no_markdown", found.length === 0, found.length ? found.join(", ") : undefined);
}

const BOLD = /\*\*(?=\S)[\s\S]*?\S\*\*/g;

/** Bold at most once per message (style, D48). */
export function checkBoldSparing(messages: ReadonlyArray<{ text: string }>): CheckResult {
  const most = Math.max(0, ...messages.map((message) => countMatches(message.text, BOLD)));
  return ok("bold_sparing", most <= 1, most > 1 ? `${most}× bold in one message` : undefined);
}

/**
 * Filler. Two forms, both from `src/agent/style.ts`, the same lists that stand
 * in the style block of the system prompt: phrases that must not appear
 * anywhere, and words that are filler only as an opener on their own ("Klar!"
 * yes, "klar, mach ich" no). Which lists apply depends on the language of the
 * reply (`lang`, null: all built-in lists); `phrases` replaces the phrase list
 * for tests.
 */
export function checkNoForbiddenPhrases(
  text: string,
  lang: string | null,
  phrases?: readonly string[],
): CheckResult {
  const found = [
    ...(phrases
      ? phrases.filter((phrase) => text.toLowerCase().includes(phrase))
      : findForbiddenPhrases(text, lang)),
    ...findForbiddenOpeners(text, lang).map((word) => `${word}!`),
  ];
  return ok("no_filler", found.length === 0, found.length ? found.join(" | ") : undefined);
}

/**
 * The reply is in the expected language: the language the owner writes in
 * (Serain answers in the owner's language). With a detector (`eld`, as in
 * production) for any language; without one a dependency-free heuristic for
 * English and German only: function words against each other, umlauts count
 * double. Very short replies ("ok", "👍") carry no signal and count as fine;
 * anything else would be a false alarm on exactly the answers we want.
 * `expected` null: the case does not say and the input does not tell.
 */
export function checkLanguage(text: string, expected: string | null, detect?: Detector): CheckResult {
  const trimmed = text.trim();
  if (!trimmed) return ok("language", true);
  if (expected === null) return ok("language", true, "no expected language");
  if (detect) {
    const detection = classify(trimmed, detect);
    if (detection.language === null) return ok("language", true, "too short for a language signal");
    const passed = detection.language === expected;
    return ok("language", passed, passed ? undefined : `${detection.language} instead of ${expected}`);
  }
  if (expected !== "de" && expected !== "en") return ok("language", false, `no detector for ${expected}`);
  const german = countMatches(trimmed, GERMAN_WORDS) + (GERMAN_LETTERS.test(trimmed) ? 2 : 0);
  const english = countMatches(trimmed, ENGLISH_WORDS);
  if (german === 0 && english === 0) return ok("language", true, "too short for a language signal");
  const passed = expected === "de" ? german >= english : english >= german;
  return ok("language", passed, passed ? undefined : `English markers: ${english}, German: ${german}`);
}

/**
 * The language a chat case expects the reply in: its `language` field, else
 * the language of its input as the detector reads it, else null.
 */
export function expectedLanguage(testCase: Pick<ChatCase, "language" | "input">, detect?: Detector): string | null {
  if (testCase.language) return testCase.language;
  return detect ? classify(testCase.input, detect).language : null;
}

/**
 * Emoji only mirrored (no emoji as long as the owner has not sent any
 * themselves), and then at most one. Tapbacks are exempt, they may come
 * unasked; what is meant is the message text.
 *
 * `noEmoji` applies to greetings and acknowledgements: there even a mirrored
 * emoji is too much. That tightening came with the style step (2026-09-18);
 * before, the check only covered mirroring.
 */
export function checkEmojiMirrored(
  input: string,
  text: string,
  opts: { noEmoji?: boolean } = {},
): CheckResult {
  const userUsed = EMOJI.test(input);
  const count = [...text.matchAll(EMOJI_CLUSTER)].length;
  if (opts.noEmoji) {
    return ok("emoji_mirrored", count === 0, count === 0 ? undefined : "emoji in a greeting or acknowledgement");
  }
  if (count === 0) return ok("emoji_mirrored", true);
  if (!userUsed) return ok("emoji_mirrored", false, `emoji without one from ${owner.name}`);
  return ok("emoji_mirrored", count <= 1, count <= 1 ? undefined : `${count} emoji, one is allowed`);
}

/**
 * No internal names in a message. Two sources, both derived instead of copied:
 * the tool names of this run from the registry, and everything that looks like
 * an internal identifier (snake_case). That way the rule also applies to
 * tables and functions no registry knows.
 */
export function checkNoInternalNames(text: string, toolNames: readonly string[]): CheckResult {
  const found = new Set<string>();
  for (const match of text.toLowerCase().matchAll(SNAKE_CASE)) found.add(match[0]);
  for (const name of toolNames) {
    if (new RegExp(`\\b${name}\\b`, "iu").test(text)) found.add(name.toLowerCase());
  }
  return ok("no_internal_names", found.size === 0, found.size ? [...found].join(", ") : undefined);
}

/**
 * Reply to a greeting. "hi" gets "hi" back: very short, no emoji. A tapback
 * alone counts too, it has zero characters.
 */
export function checkGreetingMirrored(text: string): CheckResult {
  const chars = text.trim().length;
  const tooLong = chars > GREETING_MAX_CHARS;
  const hasEmoji = EMOJI.test(text);
  const passed = !tooLong && !hasEmoji;
  return ok(
    "greeting_mirror",
    passed,
    passed ? undefined : `${chars} characters${hasEmoji ? " and an emoji" : ""}`,
  );
}

/**
 * If the owner asks how Serain works, "I don't know" is the wrong answer.
 * Phase 1: the owner may know how Serain works, and Serain never claims not to
 * know it itself.
 */
export function checkNoFalseIgnorance(text: string): CheckResult {
  const hit = CLAIMS_SELF_IGNORANCE.exec(text);
  return ok("no_false_ignorance", hit === null, hit ? `claims not to know: "${hit[0]}"` : undefined);
}

/**
 * Long answers belong in the thread of the triggering message, split into
 * several bubbles, each one thought. A block of text is the opposite.
 */
export function checkThreadedLongAnswer(record: TurnRecord): CheckResult {
  const threaded = record.toolCalls.some((call) => call.name === "reply_in_thread");
  const bubbles = bubbleCount(record.messages);
  const passed = threaded && bubbles >= 2;
  return ok(
    "thread_reply",
    passed,
    passed ? undefined : `${threaded ? "in the thread" : "without thread"}, ${bubbles} bubble(s)`,
  );
}

/**
 * Length mirroring. Three words don't get three sentences back. Real
 * information questions get a larger frame, otherwise the check punishes
 * exactly the answers the owner is asking for.
 */
export function checkLengthMirrored(
  input: string,
  text: string,
  opts: { infoRequest?: boolean } = {},
): CheckResult {
  const factor = opts.infoRequest ? LENGTH_MIRROR.infoFactor : LENGTH_MIRROR.factor;
  const floor = opts.infoRequest ? LENGTH_MIRROR.infoFloorChars : LENGTH_MIRROR.floorChars;
  const allowed = Math.max(floor, input.trim().length * factor);
  const actual = text.trim().length;
  const passed = actual <= allowed;
  return ok(
    "length_mirror",
    passed,
    passed ? undefined : `${actual} characters, ${Math.round(allowed)} would be allowed`,
  );
}

/** How many bubbles would reach the owner? Calculates like the OutboundGate. */
export function bubbleCount(messages: ReadonlyArray<{ text: string }>): number {
  return messages.reduce(
    (sum, message) => sum + splitIntoBubbles(stripMarkdown(message.text)).length,
    0,
  );
}

export function checkBubbleCount(
  messages: ReadonlyArray<{ text: string }>,
  max = MAX_MESSAGES_PER_TURN,
): CheckResult {
  const count = bubbleCount(messages);
  const passed = count <= max;
  return ok("bubble_count", passed, `${count} bubble(s)${passed ? "" : `, ${max} are allowed`}`);
}

/**
 * Tapback instead of a message. For cases in which a 👍 would be the whole
 * answer ("danke dir", "ok, passt"). An extra message is no crash, but exactly
 * the reflex Serain should drop.
 */
export function checkTapbackSuffices(record: TurnRecord): CheckResult {
  const passed = record.reactions.length >= 1 && record.messages.length === 0;
  return ok(
    "tapback_only",
    passed,
    passed
      ? undefined
      : `${record.reactions.length} tapback(s), ${record.messages.length} message(s)`,
  );
}

/** The turn has to end cleanly, not break off at the limit. */
export function checkEndTurn(record: TurnRecord): CheckResult {
  const called = record.toolCalls.some((call) => call.name === "end_turn");
  return ok("end_turn", called, called ? undefined : `stop reason: ${record.stopReason ?? "none"}`);
}

/** No call of a tool that doesn't exist. */
export function checkNoUnknownTools(record: TurnRecord): CheckResult {
  const passed = record.unknownTools.length === 0;
  return ok("no_unknown_tool", passed, passed ? undefined : record.unknownTools.join(", "));
}

// --- Suites ----------------------------------------------------------------------

/** All the text the owner would get to read in this turn. */
export function spokenText(record: TurnRecord): string {
  return record.messages.map((message) => message.text).join("\n");
}

export interface ChatCheckOptions {
  /**
   * Tool names of this run, from the registry. Without them
   * `no_internal_names` checks only the shape (snake_case), not the concrete names.
   */
  toolNames?: readonly string[];
  /** Language detector (`loadEld`). Without it the language check knows only English and German. */
  detect?: Detector;
}

/** None of these may appear in the answer, in any spelling. */
export function checkNotContains(text: string, needles: readonly string[]): CheckResult {
  const haystack = text.toLowerCase();
  const found = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
  return ok("not_contains", found.length === 0, found.join(", ") || undefined);
}

/** Every group has to appear with at least one of its variants. */
export function checkAnyOf(text: string, groups: readonly (readonly string[])[]): CheckResult {
  const haystack = text.toLowerCase();
  const missing = groups.filter(
    (group) => !group.some((variant) => haystack.includes(variant.toLowerCase())),
  );
  return ok("any_of", missing.length === 0, missing.map((group) => group[0]).join(", ") || undefined);
}

/**
 * The answer comes first (V8): in the first sentence of the first message.
 * Readers scan in an F shape, the first words carry the information. Whole
 * words, otherwise "ja" would already hit "jahr".
 */
export function checkFirstLine(record: TurnRecord, groups: readonly (readonly string[])[]): CheckResult {
  const firstLine = (record.messages[0]?.text ?? "").split("\n")[0] ?? "";
  const firstSentence = (/^.*?[.!?](\s|$)/.exec(firstLine)?.[0] ?? firstLine).toLowerCase();
  const has = (variant: string) =>
    new RegExp(`(^|[^\\p{L}])${variant.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u").test(firstSentence);
  const missing = groups.filter((group) => !group.some(has));
  return ok("first_line", missing.length === 0, missing.map((group) => group[0]).join(", ") || undefined);
}

/** Exactly one reminder, and its text is a sentence that stands on its own (D23). */
export function checkReminderText(
  record: TurnRecord,
  expect: { minWords: number; notStartsWith?: readonly string[] },
): CheckResult {
  const reminders = record.toolCalls.filter((call) => call.name === "set_reminder" && call.ok);
  if (reminders.length !== 1) {
    return ok("reminder_text", false, `${reminders.length} reminders instead of one`);
  }
  const text = String(reminders[0]?.args["text"] ?? "").trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  const opener = (expect.notStartsWith ?? []).find((prefix) =>
    text.toLowerCase().startsWith(prefix.toLowerCase()),
  );
  const passed = words >= expect.minWords && opener === undefined;
  return ok("reminder_text", passed, passed ? undefined : `“${text}”`);
}

export function runChatChecks(
  testCase: ChatCase,
  record: TurnRecord,
  options: ChatCheckOptions = {},
): CheckResult[] {
  const text = spokenText(record);
  const language = expectedLanguage(testCase, options.detect);
  // Greetings and acknowledgements can't take even a mirrored emoji.
  const noEmoji = testCase.greeting === true || testCase.tapbackSuffices === true;
  const checks: CheckResult[] = [
    checkNoDashes(text),
    checkNoMarkdown(text),
    checkBoldSparing(record.messages),
    checkNoForbiddenPhrases(text, language),
    checkLanguage(text, language, options.detect),
    checkEmojiMirrored(testCase.input, text, noEmoji ? { noEmoji } : {}),
    checkBubbleCount(record.messages),
    checkEndTurn(record),
    checkNoUnknownTools(record),
  ];
  // Mirroring length holds per rule 1 "longer only when the owner explicitly
  // wants something detailed", and that is exactly what the `longAnswer` cases
  // are. There `thread_reply` plus the bubble limit apply instead; measuring
  // mirroring against the question would punish the request in the case itself.
  if (!testCase.longAnswer) {
    checks.push(
      checkLengthMirrored(
        testCase.input,
        text,
        testCase.infoRequest === undefined ? {} : { infoRequest: testCase.infoRequest },
      ),
    );
  }
  if (testCase.notContains?.length) checks.push(checkNotContains(text, testCase.notContains));
  if (testCase.anyOf?.length) checks.push(checkAnyOf(text, testCase.anyOf));
  if (testCase.firstLineAnyOf?.length) checks.push(checkFirstLine(record, testCase.firstLineAnyOf));
  if (testCase.reminderText) checks.push(checkReminderText(record, testCase.reminderText));
  if (testCase.tapbackSuffices) checks.push(checkTapbackSuffices(record));
  if (testCase.greeting) checks.push(checkGreetingMirrored(text));
  if (testCase.longAnswer) checks.push(checkThreadedLongAnswer(record));
  if (testCase.technicalQuestion) {
    // Here the names are explicitly allowed; instead it is measured that
    // Serain doesn't pretend not to know how it works.
    checks.push(checkNoFalseIgnorance(text));
  } else {
    checks.push(checkNoInternalNames(text, options.toolNames ?? []));
  }
  return checks;
}

function inRange(value: number, range: { min: number; max: number } | undefined): boolean {
  if (!range) return true;
  return value >= range.min && value <= range.max;
}

/**
 * Phrases that pass something off as done before the change ran: "erledigt"
 * or "done" while the task is still running. "wenn ich fertig bin" ("when I'm
 * done") is no claim and does not fall under it.
 */
const CLAIMS_DONE =
  /\b(erledigt|done|(ist|bin|sind) fertig|hab(e)?( ich)?( es| das| dir)? (gefunden|nachgeschaut|nachgesehen|rausgefunden|erledigt|gemacht)|(i['’]ve|i have) (found|looked|checked|figured|done|sorted)|(it['’]s|that['’]s|all) (sorted|finished))\b/i;

/**
 * If the turn started a background task, the result is not there yet: no
 * message of this turn may pass it off as done.
 */
export function checkNoDoneBeforeResult(record: TurnRecord): CheckResult {
  const claims = record.messages.filter((message) => CLAIMS_DONE.test(message.text));
  return ok("no_done_before_result", claims.length === 0, claims.map((message) => message.text).join(" | ") || undefined);
}

export function runToolsChecks(testCase: ToolsCase, record: TurnRecord): CheckResult[] {
  const expect = testCase.expect;
  const checks: CheckResult[] = [checkNoUnknownTools(record)];
  if (record.toolCalls.some((call) => (call.name === "run_task" || call.name === "run_site_task") && call.ok)) {
    checks.push(checkNoDoneBeforeResult(record));
  }

  if (expect.messages) {
    const count = record.messages.length;
    checks.push(
      ok(
        "expect_messages",
        inRange(count, expect.messages),
        `${count} instead of ${expect.messages.min}–${expect.messages.max}`,
      ),
    );
  }
  if (expect.reactions) {
    const count = record.reactions.length;
    checks.push(
      ok(
        "expect_reactions",
        inRange(count, expect.reactions),
        `${count} instead of ${expect.reactions.min}–${expect.reactions.max}`,
      ),
    );
  }
  if (expect.threadReply !== undefined) {
    const used = record.toolCalls.some((call) => call.name === "reply_in_thread");
    checks.push(
      ok("expect_thread_reply", used === expect.threadReply, used ? "in the thread" : "without thread"),
    );
  }
  if (expect.forbiddenTools?.length) {
    const used = record.toolCalls
      .map((call) => call.name)
      .filter((name) => expect.forbiddenTools?.includes(name));
    checks.push(ok("no_forbidden_tool", used.length === 0, used.join(", ") || undefined));
  }
  if (expect.requiredTools?.length) {
    const called = new Set(record.toolCalls.map((call) => call.name));
    const missing = expect.requiredTools.filter((name) => !called.has(name));
    checks.push(ok("required_tool", missing.length === 0, missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined));
  }
  if (expect.reactionEmoji?.length) {
    const set = new Set(record.reactions.map((reaction) => reaction.emoji));
    const missing = expect.reactionEmoji.filter((emoji) => !set.has(emoji));
    checks.push(ok("reaction_emoji", missing.length === 0, missing.length > 0 ? `missing: ${missing.join(" ")}, set: ${[...set].join(" ") || "nothing"}` : undefined));
  }
  if (expect.exactBubble !== undefined) {
    const found = record.messages.some((message) => message.text.trim() === expect.exactBubble);
    checks.push(ok("exact_bubble", found, found ? undefined : record.messages.map((message) => message.text).join(" | ")));
  }
  if (expect.firstMessageStartsWith !== undefined) {
    const first = record.messages[0]?.text ?? "";
    const passed = first.toLowerCase().startsWith(expect.firstMessageStartsWith.toLowerCase());
    checks.push(ok("first_message", passed, passed ? undefined : first.slice(0, 120)));
  }
  if (expect.toolArgsAnyOf) {
    const { tool, anyOf } = expect.toolArgsAnyOf;
    const args = record.toolCalls.filter((call) => call.name === tool).map((call) => JSON.stringify(call.args).toLowerCase());
    const passed = args.some((text) => anyOf.some((variant) => text.includes(variant.toLowerCase())));
    checks.push(ok("tool_args", passed, passed ? undefined : args.join(" | ").slice(0, 200) || `no ${tool}`));
  }
  if (expect.endTurn !== false) checks.push(checkEndTurn(record));
  checks.push(checkBubbleCount(record.messages));
  return checks;
}

/**
 * Phrases with which a model honestly says "I don't know", in English and
 * German. Deliberately broad: what is measured is whether it admits the limit,
 * not how elegantly.
 */
const ADMITS_UNKNOWN =
  /(weiß ich nicht|weiss ich nicht|keine ahnung|kann ich nicht wissen|kann ich dir nicht sagen|nicht sicher|müsste ich nachschauen|muss ich nachschauen|kein internet|keinen zugriff|kann ich nicht nachsehen|liegt nach meinem|stand meines wissens|könnte veraltet sein|nicht aktuell|weiß ich ehrlich nicht|i don['’]?t know|no idea|not sure|i['’]d have to (check|look)|i can['’]?t (check|look it up|know)|no (internet|access)|after my (knowledge|training)|as of my (knowledge|last)|(could|might) be out of date|not up to date)/i;

export function checkAdmitsUnknown(text: string): CheckResult {
  const passed = ADMITS_UNKNOWN.test(text);
  return ok("admits_unknown", passed, passed ? undefined : "guesses instead of admitting it doesn't know");
}

export function runDatesChecks(testCase: DatesCase, record: TurnRecord): CheckResult[] {
  const text = spokenText(record);
  const haystack = text.toLowerCase();
  const checks: CheckResult[] = [checkEndTurn(record), checkNoUnknownTools(record)];

  for (const [index, group] of (testCase.expect.anyOf ?? []).entries()) {
    const hit = group.some((variant) => haystack.includes(variant.toLowerCase()));
    checks.push(ok(`expect_contains_${index + 1}`, hit, hit ? undefined : `missing: ${group.join(" / ")}`));
  }
  if (testCase.expect.notContains?.length) {
    const found = testCase.expect.notContains.filter((needle) =>
      haystack.includes(needle.toLowerCase()),
    );
    checks.push(ok("expect_not_contains", found.length === 0, found.join(", ") || undefined));
  }
  if (testCase.expect.admitsUnknown) checks.push(checkAdmitsUnknown(text));
  return checks;
}

// --- judge ------------------------------------------------------------------

/**
 * Compares the memory judge's answer with the expectation. Pure function, so
 * the suite is checkable even without a connected judge.
 */
export function judgeMatches(testCase: JudgeCase, answer: JudgeAnswer): CheckResult {
  const expected = testCase.expected;
  if (answer.kind !== expected.kind) {
    return ok("judge_answer", false, `answer type ${answer.kind}, expected ${expected.kind}`);
  }
  if (expected.kind === "boolean" && answer.kind === "boolean") {
    const passed = answer.value === expected.value;
    return ok("judge_answer", passed, passed ? undefined : `${answer.value} instead of ${expected.value}`);
  }
  if (expected.kind === "choice" && answer.kind === "choice") {
    const alsoOk = testCase.tolerance.kind === "alsoOk" ? testCase.tolerance.ids : [];
    const passed = answer.value === expected.value || alsoOk.includes(answer.value);
    return ok(
      "judge_answer",
      passed,
      passed ? undefined : `${answer.value ?? "null"} instead of ${expected.value ?? "null"}`,
    );
  }
  if (expected.kind === "score" && answer.kind === "score") {
    const slack = testCase.tolerance.kind === "plusMinus" ? testCase.tolerance.value : 0;
    const passed = Math.abs(answer.value - expected.value) <= slack;
    return ok(
      "judge_answer",
      passed,
      passed ? undefined : `${answer.value} instead of ${expected.value} ± ${slack}`,
    );
  }
  return ok("judge_answer", false, "unknown answer shape");
}

/** Share of passed checks. Basis for the ranking and the regression comparison. */
export function passRate(checks: readonly CheckResult[]): number {
  if (checks.length === 0) return 1;
  return checks.filter((check) => check.passed).length / checks.length;
}
