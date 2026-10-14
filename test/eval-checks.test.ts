import { describe, expect, it } from "vitest";
import {
  bubbleCount,
  checkAdmitsUnknown,
  checkAnyOf,
  checkFirstLine,
  checkBoldSparing,
  checkBubbleCount,
  checkEmojiMirrored,
  checkEndTurn,
  checkLanguage,
  checkGreetingMirrored,
  checkLengthMirrored,
  checkNoDashes,
  checkNoFalseIgnorance,
  checkNoForbiddenPhrases,
  checkNoInternalNames,
  checkNoMarkdown,
  checkNoUnknownTools,
  checkNotContains,
  checkReminderText,
  checkTapbackSuffices,
  checkThreadedLongAnswer,
  judgeMatches,
  passRate,
  runChatChecks,
  runDatesChecks,
  runToolsChecks,
  expectedLanguage,
} from "../eval/checks.js";
import { loadEld } from "../src/i18n/language.js";
import type { ChatCase, DatesCase, JudgeCase, ToolsCase, TurnRecord } from "../eval/types.js";

/**
 * The rule checks are what makes the eval comparison checkable (W2). If they
 * measure wrongly, the whole run is worthless, so a test hangs on every single
 * rule here.
 */

function record(partial: Partial<TurnRecord> = {}): TurnRecord {
  return {
    messages: [],
    reactions: [],
    toolCalls: [],
    unknownTools: [],
    usedTextFallback: false,
    stopReason: null,
    steps: 0,
    ...partial,
  };
}

function said(...texts: string[]): TurnRecord {
  return record({
    messages: texts.map((text) => ({ text, kind: "reply" })),
    toolCalls: [
      ...texts.map((text) => ({ name: "send_message", args: { text }, ok: true })),
      { name: "end_turn", args: {}, ok: true },
    ],
  });
}

describe("Dashes", () => {
  it("lets hyphens through", () => {
    expect(checkNoDashes("mach ich, so gegen 9-10 uhr").passed).toBe(true);
  });

  it("fires on en and em dashes, in any language", () => {
    expect(checkNoDashes("das ist – ehrlich gesagt – zu lang").passed).toBe(false);
    expect(checkNoDashes("kurz — und knapp").passed).toBe(false);
    expect(checkNoDashes("on it — will do").passed).toBe(false);
    expect(checkNoDashes("tamam – yaparım").passed).toBe(false);
  });
});

describe("Markdown", () => {
  it("recognises the usual markers", () => {
    expect(checkNoMarkdown("- erstens\n- zweitens").passed).toBe(false);
    expect(checkNoMarkdown("## überschrift").passed).toBe(false);
    expect(checkNoMarkdown("nimm `npm run dev`").passed).toBe(false);
    expect(checkNoMarkdown("guck hier [rein](https://x.de)").passed).toBe(false);
  });

  it("leaves normal chat text alone", () => {
    expect(checkNoMarkdown("3 * 4 sind 12, snake_case bleibt snake_case").passed).toBe(true);
    expect(checkNoMarkdown("ne, lass mal. ich mach das morgen").passed).toBe(true);
  });

  it("allows bold once per message, not more often (D48)", () => {
    expect(checkNoMarkdown("treffen um **15 uhr**").passed).toBe(true);
    expect(checkBoldSparing([{ text: "treffen um **15 uhr**" }, { text: "und **bring** was mit" }]).passed).toBe(true);
    expect(checkBoldSparing([{ text: "**achtung**: um **15 uhr**" }]).passed).toBe(false);
  });
});

describe("Filler", () => {
  it("finds forbidden phrases regardless of case", () => {
    const result = checkNoForbiddenPhrases("Gerne geschehen! Sag mir einfach Bescheid.", "de");
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("gerne geschehen");
  });

  it("checks the list of the reply's language plus English", () => {
    expect(checkNoForbiddenPhrases("Happy to help! Just let me know.", "en").passed).toBe(false);
    expect(checkNoForbiddenPhrases("Sure! Done.", "en").detail).toBe("sure!");
    // German filler in an English reply is not English filler.
    expect(checkNoForbiddenPhrases("gerne geschehen", "en").passed).toBe(true);
    // A third language: the English assistant sound still counts.
    expect(checkNoForbiddenPhrases("tabii, let me know if you need anything else", "tr").passed).toBe(false);
    // Unknown language: every built-in list.
    expect(checkNoForbiddenPhrases("Klar! mach ich", null).passed).toBe(false);
  });

  it("takes a list of its own", () => {
    expect(checkNoForbiddenPhrases("alles klar", "de", ["alles klar"]).passed).toBe(false);
    expect(checkNoForbiddenPhrases("alles klar", "de", ["hokuspokus"]).passed).toBe(true);
  });
});

describe("Language", () => {
  it("recognises German without a detector", () => {
    expect(checkLanguage("ich hab das schon gemacht, passt", "de").passed).toBe(true);
  });

  it("fires on English when German is expected, and the other way round", () => {
    expect(checkLanguage("sure, let me know if you need anything else from me", "de").passed).toBe(false);
    expect(checkLanguage("sure, let me know if you need anything else from me", "en").passed).toBe(true);
    expect(checkLanguage("ich hab das schon gemacht, passt", "en").passed).toBe(false);
  });

  it("lets too short answers through instead of raising a false alarm", () => {
    expect(checkLanguage("👍", "de").passed).toBe(true);
    expect(checkLanguage("ok", "de").passed).toBe(true);
    expect(checkLanguage("ok", "en").passed).toBe(true);
  });

  it("without a detector fails closed on a third language instead of guessing", () => {
    expect(checkLanguage("yarın akşam saat sekizde rezervasyon yapalım", "tr")).toEqual({
      id: "language",
      passed: false,
      detail: "no detector for tr",
    });
  });

  it("with the production detector checks any language", async () => {
    const detect = await loadEld();
    expect(checkLanguage("yarın akşam saat sekizde rezervasyon yapalım, bence iyi olur", "tr", detect).passed).toBe(true);
    expect(checkLanguage("mañana a las ocho te recuerdo que llames al dentista", "es", detect).passed).toBe(true);
    expect(checkLanguage("morgen um acht erinnere ich dich an den zahnarzt", "es", detect)).toEqual({
      id: "language",
      passed: false,
      detail: "de instead of es",
    });
    expect(checkLanguage("ok 👍", "tr", detect).passed).toBe(true);
  });

  it("takes the case's language, else the input's", async () => {
    const detect = await loadEld();
    expect(expectedLanguage({ input: "hi", language: "de" })).toBe("de");
    expect(expectedLanguage({ input: "hi" })).toBeNull();
    expect(expectedLanguage({ input: "bu arada yarın akşam annemle yemeğe çıkıyoruz" }, detect)).toBe("tr");
    expect(expectedLanguage({ input: "hi" }, detect)).toBeNull();
  });
});

describe("Emoji mirroring", () => {
  it("allows emoji when Alex uses some", () => {
    expect(checkEmojiMirrored("hab den termin verpennt 🙈", "passiert 😅").passed).toBe(true);
  });

  it("forbids emoji without one from the owner", () => {
    expect(checkEmojiMirrored("hab den termin verpennt", "passiert 😅").passed).toBe(false);
  });

  it("does not mind answers without emoji", () => {
    expect(checkEmojiMirrored("hey 👋", "moin").passed).toBe(true);
  });
});

describe("Emoji: at most one, never in a greeting or acknowledgement", () => {
  it("lets exactly one mirrored emoji through", () => {
    expect(checkEmojiMirrored("verpennt 😩", "passiert 😅").passed).toBe(true);
  });

  it("forbids several, even mirrored", () => {
    expect(checkEmojiMirrored("verpennt 😩", "passiert 😅 echt 🙈").passed).toBe(false);
  });

  it("counts a ZWJ emoji as one", () => {
    expect(checkEmojiMirrored("guck mal 👨‍👩‍👧", "süß 👨‍👩‍👧").passed).toBe(true);
  });

  it("does not allow even the mirrored emoji in a greeting or acknowledgement", () => {
    expect(checkEmojiMirrored("moin 🙌", "moin 🙌", { noEmoji: true }).passed).toBe(false);
    expect(checkEmojiMirrored("moin 🙌", "moin", { noEmoji: true }).passed).toBe(true);
  });
});

describe("Internal names", () => {
  const tools = ["send_message", "reply_in_thread", "react", "show_memory", "forget_fact", "end_turn"];

  it("finds tool names from the registry", () => {
    expect(checkNoInternalNames("hab forget_fact aufgerufen", tools).passed).toBe(false);
    expect(checkNoInternalNames("schick ich dir per send_message", tools).passed).toBe(false);
  });

  it("also finds names no registry knows", () => {
    // Tables and columns stand in no tool list, but look just the same.
    expect(checkNoInternalNames("steht in der facts-tabelle im audit_log", tools).passed).toBe(false);
  });

  it("leaves normal answers alone", () => {
    expect(checkNoInternalNames("hab ich gelöscht", tools).passed).toBe(true);
    expect(checkNoInternalNames("schick ich dir gleich rüber", tools).passed).toBe(true);
  });
});

describe("Mirroring a greeting", () => {
  it("accepts “hi” and the tapback", () => {
    expect(checkGreetingMirrored("hi").passed).toBe(true);
    expect(checkGreetingMirrored("").passed).toBe(true);
    expect(checkGreetingMirrored("moin, was geht").passed).toBe(true);
  });

  it("fires on an introduction", () => {
    expect(
      checkGreetingMirrored("Hallo Alex! Schön, dass du schreibst. Womit kann ich dir heute helfen?")
        .passed,
    ).toBe(false);
  });

  it("fires on an emoji in the greeting", () => {
    expect(checkGreetingMirrored("moin 👋").passed).toBe(false);
  });
});

describe("Question about the technology", () => {
  it("lets an honest explanation through", () => {
    expect(
      checkNoFalseIgnorance("deine nachricht geht an photon, landet in meiner db und dann im modell")
        .passed,
    ).toBe(true);
  });

  it("fires when Serain claims not to know about itself", () => {
    expect(checkNoFalseIgnorance("keine ahnung, wie ich funktioniere").passed).toBe(false);
    expect(checkNoFalseIgnorance("das kann ich dir nicht sagen").passed).toBe(false);
    expect(checkNoFalseIgnorance("honestly no idea how i work").passed).toBe(false);
    expect(checkNoFalseIgnorance("your message goes to photon, into my db and then to the model").passed).toBe(true);
  });
});

describe("Long answer", () => {
  function longAnswer(tool: string, ...texts: string[]): TurnRecord {
    return record({
      messages: texts.map((text) => ({ text, kind: "reply" })),
      toolCalls: [
        ...texts.map((text) => ({ name: tool, args: { text }, ok: true })),
        { name: "end_turn", args: {}, ok: true },
      ],
    });
  }

  it("wants the thread and several bubbles", () => {
    expect(checkThreadedLongAnswer(longAnswer("reply_in_thread", "eins", "zwei")).passed).toBe(true);
  });

  it("fires on a block without thread", () => {
    expect(checkThreadedLongAnswer(longAnswer("send_message", "eins", "zwei")).passed).toBe(false);
    expect(checkThreadedLongAnswer(longAnswer("reply_in_thread", "alles in einem")).passed).toBe(
      false,
    );
  });
});

describe("Length mirroring", () => {
  it("allows short answers to short inputs", () => {
    expect(checkLengthMirrored("ok", "alles klar").passed).toBe(true);
  });

  it("fires on a lecture in reply to two words", () => {
    const wall = "ja klar, ".repeat(40);
    expect(checkLengthMirrored("ok", wall).passed).toBe(false);
  });

  it("gives real information questions more room", () => {
    const answer = "eine ug haftet beschränkt, ".repeat(12);
    const question = "was ist der unterschied zwischen gmbh und ug";
    expect(checkLengthMirrored(question, answer).passed).toBe(false);
    expect(checkLengthMirrored(question, answer, { infoRequest: true }).passed).toBe(true);
  });
});

describe("Bubbles", () => {
  it("counts like the OutboundGate, not like the model", () => {
    const long = ["a".repeat(900), "b".repeat(900)].join("\n\n");
    expect(bubbleCount([{ text: long }])).toBe(2);
  });

  it("fails above the turn limit", () => {
    const messages = Array.from({ length: 5 }, (_unused, index) => ({ text: `nachricht ${index}` }));
    expect(checkBubbleCount(messages).passed).toBe(false);
    expect(checkBubbleCount(messages.slice(0, 3)).passed).toBe(true);
  });
});

describe("End of turn and tools", () => {
  it("requires end_turn", () => {
    expect(checkEndTurn(said("moin")).passed).toBe(true);
    expect(checkEndTurn(record({ stopReason: "step_limit" })).passed).toBe(false);
  });

  it("reports invented tools", () => {
    expect(checkNoUnknownTools(record({ unknownTools: ["web_search"] })).passed).toBe(false);
    expect(checkNoUnknownTools(said("moin")).passed).toBe(true);
  });

  it("wants really only the tapback in tapback cases", () => {
    const tapbackOnly = record({
      reactions: [{ messageId: "eval:1", emoji: "👍" }],
      toolCalls: [{ name: "react", args: {}, ok: true }],
    });
    expect(checkTapbackSuffices(tapbackOnly).passed).toBe(true);
    expect(checkTapbackSuffices({ ...tapbackOnly, messages: [{ text: "gern", kind: "reply" }] }).passed).toBe(
      false,
    );
  });
});

describe("Suites", () => {
  it("chat checks style and adds the tapback check only when needed", () => {
    const plain: ChatCase = { id: "c1", input: "moin" };
    const withTapback: ChatCase = { id: "c2", input: "danke dir", tapbackSuffices: true };
    const ids = runChatChecks(plain, said("moin")).map((check) => check.id);
    expect(ids).not.toContain("tapback_only");
    expect(runChatChecks(withTapback, said("gerne")).map((c) => c.id)).toContain("tapback_only");
  });

  it("chat always checks internal names, unless Alex asks about the technology", () => {
    const plain: ChatCase = { id: "c3", input: "vergiss das" };
    const technical: ChatCase = { id: "c4", input: "wie funktionierst du", technicalQuestion: true };
    const answer = said("hab forget_fact benutzt");
    const names = ["forget_fact"];

    const normal = runChatChecks(plain, answer, { toolNames: names });
    expect(normal.find((check) => check.id === "no_internal_names")?.passed).toBe(false);

    const asked = runChatChecks(technical, answer, { toolNames: names }).map((check) => check.id);
    expect(asked).not.toContain("no_internal_names");
    expect(asked).toContain("no_false_ignorance");
  });

  it("chat adds greeting and thread checks only to the fitting cases", () => {
    const greeting: ChatCase = { id: "c5", input: "hi", greeting: true };
    const long: ChatCase = { id: "c6", input: "erklär mal ausführlich", longAnswer: true };
    expect(runChatChecks(greeting, said("hi")).map((c) => c.id)).toContain("greeting_mirror");
    expect(runChatChecks(long, said("eins")).map((c) => c.id)).toContain("thread_reply");
    expect(runChatChecks(greeting, said("hi")).map((c) => c.id)).not.toContain("thread_reply");
  });

  it("tools compares against the hard expectation", () => {
    const testCase: ToolsCase = {
      id: "t1",
      input: "danke",
      expect: { messages: { min: 0, max: 0 }, reactions: { min: 1, max: 1 } },
    };
    const wrong = runToolsChecks(testCase, said("gerne geschehen"));
    expect(wrong.find((check) => check.id === "expect_messages")?.passed).toBe(false);
    expect(wrong.find((check) => check.id === "expect_reactions")?.passed).toBe(false);
  });

  it("tools reports forbidden tools", () => {
    const testCase: ToolsCase = { id: "t2", input: "such mal", expect: { forbiddenTools: ["web_search"] } };
    const withSearch = record({
      toolCalls: [
        { name: "web_search", args: {}, ok: true },
        { name: "end_turn", args: {}, ok: true },
      ],
    });
    expect(
      runToolsChecks(testCase, withSearch).find((check) => check.id === "no_forbidden_tool")?.passed,
    ).toBe(false);
  });

  it("tools requires mandatory tools", () => {
    const testCase: ToolsCase = { id: "t3", input: "was hat tibber geschickt", expect: { requiredTools: ["mail_search"] } };
    const asked = record({ toolCalls: [{ name: "send_message", args: {}, ok: true }, { name: "end_turn", args: {}, ok: true }] });
    const searched = record({ toolCalls: [{ name: "mail_search", args: { from: "tibber" }, ok: true }, { name: "end_turn", args: {}, ok: true }] });
    const check = (run: ReturnType<typeof record>) =>
      runToolsChecks(testCase, run).find((item) => item.id === "required_tool");
    expect(check(asked)).toEqual({ id: "required_tool", passed: false, detail: "missing: mail_search" });
    expect(check(searched)?.passed).toBe(true);
  });

  it("tools: after a started task no message says “done”", () => {
    const testCase: ToolsCase = { id: "t4", input: "find raus wann der wertstoffhof aufhat", web: true, expect: { requiredTools: ["run_task"] } };
    const started = (text: string) =>
      record({
        messages: [{ text, kind: "reply" }],
        toolCalls: [{ name: "run_task", args: {}, ok: true }, { name: "end_turn", args: {}, ok: true }],
      });
    const check = (run: TurnRecord) => runToolsChecks(testCase, run).find((item) => item.id === "no_done_before_result");
    expect(check(started("Erledigt, schau ich nach"))?.passed).toBe(false);
    expect(check(started("hab ich nachgeschaut, samstags 9 bis 13 Uhr"))?.passed).toBe(false);
    expect(check(started("schau ich nach, sag dir, wenn ich fertig bin"))?.passed).toBe(true);
    expect(check(started("I've checked, saturdays 9 to 1"))?.passed).toBe(false);
    expect(check(started("on it, i'll tell you once i know"))?.passed).toBe(true);
    // Without a task, "erledigt" is a normal answer.
    expect(runToolsChecks(testCase, said("erledigt")).map((item) => item.id)).not.toContain("no_done_before_result");
  });

  it("dates checks content and honesty", () => {
    const testCase: DatesCase = {
      id: "d1",
      input: "welcher tag ist heute",
      expect: { anyOf: [["Freitag"]], notContains: ["Montag"] },
    };
    const right = runDatesChecks(testCase, said("heute ist Freitag"));
    expect(right.every((check) => check.passed)).toBe(true);
    const wrong = runDatesChecks(testCase, said("heute ist Montag"));
    expect(wrong.some((check) => !check.passed)).toBe(true);
  });

  it("dates recognises an honest admission", () => {
    expect(checkAdmitsUnknown("keine ahnung, das liegt nach meinem stand").passed).toBe(true);
    expect(checkAdmitsUnknown("no idea, that's after my knowledge cutoff").passed).toBe(true);
    expect(checkAdmitsUnknown("argentinien hat gewonnen").passed).toBe(false);
  });
});

describe("judge comparison", () => {
  const booleanCase: JudgeCase = {
    id: "j1",
    message: "ich trink keinen kaffee mehr",
    question: { kind: "boolean", prompt: "merkenswert?" },
    expected: { kind: "boolean", value: true },
    tolerance: { kind: "exact" },
  };

  it("compares boolean exactly", () => {
    expect(judgeMatches(booleanCase, { kind: "boolean", value: true }).passed).toBe(true);
    expect(judgeMatches(booleanCase, { kind: "boolean", value: false }).passed).toBe(false);
  });

  it("accepts allowed alternatives for choice", () => {
    const testCase: JudgeCase = {
      id: "j2",
      message: "hab ne neue tastatur",
      question: { kind: "choice", prompt: "ersetzt was?", options: [{ id: "f1", text: "x" }] },
      expected: { kind: "choice", value: "none" },
      tolerance: { kind: "alsoOk", ids: [null] },
    };
    expect(judgeMatches(testCase, { kind: "choice", value: "none" }).passed).toBe(true);
    expect(judgeMatches(testCase, { kind: "choice", value: null }).passed).toBe(true);
    expect(judgeMatches(testCase, { kind: "choice", value: "f1" }).passed).toBe(false);
  });

  it("applies the tolerance for score", () => {
    const testCase: JudgeCase = {
      id: "j3",
      message: "allergisch gegen nüsse",
      question: { kind: "score", prompt: "wichtig?", min: 1, max: 5 },
      expected: { kind: "score", value: 5 },
      tolerance: { kind: "plusMinus", value: 1 },
    };
    expect(judgeMatches(testCase, { kind: "score", value: 4 }).passed).toBe(true);
    expect(judgeMatches(testCase, { kind: "score", value: 3 }).passed).toBe(false);
  });

  it("rejects an answer of the wrong shape", () => {
    expect(judgeMatches(booleanCase, { kind: "score", value: 1 }).passed).toBe(false);
  });
});

describe("passRate", () => {
  it("counts passed checks", () => {
    expect(passRate([{ id: "a", passed: true }, { id: "b", passed: false }])).toBe(0.5);
    expect(passRate([])).toBe(1);
  });
});

describe("Style rules from the live tests (D23)", () => {
  it("notices when Serain follows up on a question that was left lying", () => {
    expect(checkNotContains("alles gute an ihn! und was war jetzt mit dem Paket?", ["paket"]).passed).toBe(false);
    expect(checkNotContains("hab ich mir gemerkt, samstag", ["paket", "neunerns"]).passed).toBe(true);
  });

  it("requires the contradiction and both figures in the answer", () => {
    const groups = [["widerspr", "was anderes"], ["03:31"], ["07:02"]];
    expect(checkAnyOf("erster direkter fährt gegen 07:02", groups).passed).toBe(false);
    expect(checkAnyOf("die quellen widersprechen sich: 03:31 oder 07:02", groups).passed).toBe(true);
  });

  it("does not accept a keyword or the opener “Erinnerung:” as a reminder", () => {
    const expectation = { minWords: 3, notStartsWith: ["erinnerung"] };
    const reminder = (text: string) =>
      record({ toolCalls: [{ name: "set_reminder", args: { text }, ok: true }] });
    expect(checkReminderText(reminder("paket"), expectation).passed).toBe(false);
    expect(checkReminderText(reminder("Erinnerung: heute ans paket denken"), expectation).passed).toBe(false);
    expect(checkReminderText(reminder("denk ans paket, liegt bei der post"), expectation).passed).toBe(true);
    expect(checkReminderText(record(), expectation).passed).toBe(false);
  });
});

describe("Answer first (V8)", () => {
  const record = (texts: string[]) =>
    ({ messages: texts.map((text) => ({ text, kind: "send_message" })), reactions: [], toolCalls: [], unknownTools: [], usedTextFallback: false, stopReason: null, steps: 1 }) as unknown as Parameters<typeof checkFirstLine>[0];

  it("checks only the first line of the first message", () => {
    expect(checkFirstLine(record(["ja, lohnt sich\nbei 240 € im monat"]), [["lohnt"]]).passed).toBe(true);
    expect(checkFirstLine(record(["kommt drauf an\nam ende lohnt es sich"]), [["lohnt"]]).passed).toBe(false);
    expect(checkFirstLine(record(["rechnen wir mal", "lohnt sich"]), [["lohnt"]]).passed).toBe(false);
    // Only the first sentence, and only whole words.
    expect(checkFirstLine(record(["rechnen wir. lohnt sich"]), [["lohnt"]]).passed).toBe(false);
    expect(checkFirstLine(record(["im jahr sparst du viel"]), [["ja"]]).passed).toBe(false);
  });
});
