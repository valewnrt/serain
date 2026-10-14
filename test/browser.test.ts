import { describe, expect, it, vi } from "vitest";

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
const usage: Array<Record<string, unknown>> = [];
vi.mock("../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown>) => void audits.push({ event, detail }),
}));
vi.mock("../src/db/usage.js", () => ({
  recordModelUsage: async (entry: Record<string, unknown>) => void usage.push(entry),
  monthSearches: async () => 0,
  recordSearch: async () => undefined,
}));

const { runPilot, actionSpace, offeredClick } = await import("../src/browser/pilot.js");
const { valueForField, typedValue, dateLike } = await import("../src/browser/values.js");
const { browserLocale, narrower } = await import("../src/browser/session.js");
const { typesafeClient, TypesafeError } = await import("../src/browser/typesafe.js");
const { jevBrowser } = await import("../src/browser/index.js");
const { executorTools } = await import("../src/executor/tools.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { ConfidentialGuard } = await import("../src/security/confidential.js");
type PageSnapshot = import("../src/browser/pilot.js").PageSnapshot;
type PilotAction = import("../src/browser/pilot.js").PilotAction;
type ActHelp = import("../src/browser/pilot.js").ActHelp;
type SystemOneAnswer = import("../src/browser/typesafe.js").SystemOneAnswer;
type SystemOneQuestion = import("../src/browser/typesafe.js").SystemOneQuestion;
type ShotPicker = import("../src/browser/shot.js").ShotPicker;

const base = { view: "", scroll: { up: false, down: true }, lang: "de" };
const START: PageSnapshot = {
  ...base,
  url: "https://auskunft.example/",
  title: "Auskunft",
  text: "Verbindung suchen",
  view: "Verbindung suchen",
  elements: [
    { id: 1, kind: "input", label: "Von", formHasSubmit: true },
    { id: 2, kind: "select", label: "Klasse", value: "2. Klasse", options: ["1. Klasse", "2. Klasse"] },
    { id: 3, kind: "button", label: "Suchen" },
    { id: 4, kind: "link", label: "Werbung", host: "ads.example" },
  ],
};
const RESULTS: PageSnapshot = { ...base, url: "https://auskunft.example/ergebnis", title: "Ergebnis", text: "ICE 698 ab 07:02, an 07:41", view: "ICE 698 ab 07:02, an 07:41", elements: [] };

/** A session from a sequence of pages: every effective action turns one page further. */
function session(pages: PageSnapshot[], failOn: (action: PilotAction) => Error | false = () => false) {
  let index = 0;
  const acts: Array<{ action: PilotAction; text?: string }> = [];
  let closed = false;
  return {
    acts,
    closed: () => closed,
    api: {
      snapshot: async () => pages[Math.min(index, pages.length - 1)]!,
      act: async (action: PilotAction, text?: string) => {
        const failure = failOn(action);
        if (failure) throw failure;
        acts.push({ action, ...(text === undefined ? {} : { text }) });
        index += 1;
        return undefined;
      },
      // Like `captureShot`: one block with the page's text is offered; if a strict picker chooses nothing, there is no picture.
      screenshot: async (picker?: ShotPicker) => {
        if (closed) throw new Error("already closed");
        const page = pages[Math.min(index, pages.length - 1)]!;
        const chosen = picker ? await picker.choose([{ id: 0, where: "in_view", width: 800, height: 400, x: 0, y: 0, text: page.view, content: page.view }]) : null;
        if (!chosen && picker?.strict) throw new Error("the page does not show what was asked");
        return { jpeg: Buffer.from(`jpeg:${page.url}`), ...(chosen ? { shows: page.view } : {}) };
      },
      close: async () => void (closed = true),
    },
  };
}

interface Beat {
  /** Ranking of the operations. */
  op: string[];
  /** Ranking of the targets, the same for all target questions. */
  target?: string[];
  /** Field id → chosen value (`v0`, `v1`, `none`). Without: the last given value. */
  values?: Record<number, string>;
  confidence?: number;
  goal?: number;
  stuck?: number;
  /** Jev's judgement on every block offered for the screenshot: does it show what was asked? */
  shot?: number;
}

/** A scripted Jev: per step the rankings and the two estimates. */
function scriptedJev(script: Beat[]) {
  const calls: Array<{ state: Record<string, unknown>; questions: Record<string, SystemOneQuestion> }> = [];
  const choice = (rank: string[], confidence = 0.9): SystemOneAnswer => ({
    type: "choice",
    choice: rank[0] ?? "none",
    probabilities: Object.fromEntries(rank.map((option, position) => [option, 1 / (position + 2)])),
    confidence,
  });
  return {
    calls,
    jev: {
      ask: async (state: unknown, questions: Record<string, SystemOneQuestion>): Promise<Record<string, SystemOneAnswer>> => {
        const beat = script[Math.min(calls.length, script.length - 1)]!;
        calls.push({ state: state as Record<string, unknown>, questions });
        const answers: Record<string, SystemOneAnswer> = {};
        for (const [name, question] of Object.entries(questions)) {
          if (name === "operation") answers[name] = choice(beat.op);
          else if (name === "goal_met") answers[name] = { type: "noul", noul: beat.goal ?? 0.1 };
          else if (name === "stuck") answers[name] = { type: "noul", noul: beat.stuck ?? 0.05 };
          else if (/^b\d+$/.test(name) && question.type === "noul") {
            if (beat.shot !== undefined) answers[name] = { type: "noul", noul: beat.shot };
          }
          else if (name.startsWith("value_") && question.type === "choice") {
            const last = Object.keys(question.criteria).filter((option) => option !== "none").at(-1)!;
            answers[name] = choice([beat.values?.[Number(name.slice(6))] ?? last], beat.confidence);
          } else if (question.type === "choice") {
            const offered = Object.keys(question.criteria);
            const wanted = (beat.target ?? []).filter((option) => offered.includes(option));
            answers[name] = choice([...wanted, ...offered.filter((option) => !wanted.includes(option))]);
          }
        }
        return answers;
      },
    },
  };
}

const deps = (jev: ReturnType<typeof scriptedJev>["jev"], overrides: Partial<Parameters<typeof runPilot>[2]> = {}) => ({
  jev,
  inputs: ["Mainz Hbf", "Frankfurt Hbf"] as readonly string[],
  ...overrides,
});
const space = (page: PageSnapshot, inputs: readonly string[] = ["Mainz Hbf"]) => actionSpace(page, "ziel", { inputs, canGoBack: false, history: [] });
const criteriaOf = (question: SystemOneQuestion | undefined) => Object.keys((question as { criteria: Record<string, unknown> }).criteria);

describe("questions from the page (D35)", () => {
  it("asks in one request for operation, target per operation, value per field, goal reached and stuck", () => {
    const { questions } = space(START);
    expect(Object.keys(questions)).toEqual(["operation", "value_1", "click_target", "type_target", "select_target", "goal_met", "stuck"]);
    expect(criteriaOf(questions["operation"])).toEqual(["CLICK", "TYPE_TEXT", "TYPE_AND_SUBMIT", "SELECT", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"]);
    expect(criteriaOf(questions["click_target"])).toEqual(["3", "4"]);
    // One target per list entry, except the one already chosen.
    expect(criteriaOf(questions["select_target"])).toEqual(["2:0"]);
    expect(criteriaOf(questions["value_1"])).toEqual(["v0", "none"]);
    expect(JSON.stringify((questions["click_target"] as { criteria: unknown }).criteria)).toContain("ads.example");
  });

  it("offers typing only with values, back only after a navigation, Enter only in filled fields", () => {
    expect(criteriaOf(space(START, []).questions["operation"])).not.toContain("TYPE_TEXT");
    expect(criteriaOf(actionSpace(START, "ziel", { inputs: [], canGoBack: true, history: [] }).questions["operation"])).toContain("BACK");
    const filled = { ...START, elements: [{ id: 1, kind: "input" as const, label: "Von", value: "Mainz Hbf" }] };
    expect(criteriaOf(space(filled).questions["operation"])).toContain("PRESS_ENTER");
    expect(criteriaOf(space(START).questions["operation"])).not.toContain("PRESS_ENTER");
  });

  it("offers nothing that looks like buying or paying (D8)", () => {
    const shop = { ...START, elements: [{ id: 1, kind: "button" as const, label: "Jetzt kaufen" }, { id: 2, kind: "button" as const, label: "In den Warenkorb" }, { id: 3, kind: "link" as const, label: "Details" }] };
    expect(criteriaOf(space(shop).questions["click_target"])).toEqual(["3"]);
  });

  it("consents nowhere and signs up nowhere, but reads the calendar (repro 2026-10-09, calendio.pro)", () => {
    const booking = {
      ...START,
      elements: [
        { id: 1, kind: "button" as const, label: "Sa, 10.10. — nichts frei, Warteschlange möglich" },
        { id: 2, kind: "button" as const, label: "Keine passende Zeit? Auf die Warteschlange setzen" },
        { id: 3, kind: "button" as const, role: "checkbox", label: "Ich habe die AGB und die Datenschutzerklärung gelesen und bin damit einverstanden" },
        { id: 4, kind: "button" as const, role: "switch", label: "Ein freier Termin soll sofort verbindlich gebucht werden" },
        { id: 5, kind: "button" as const, label: "Nächste Woche" },
        { id: 6, kind: "button" as const, label: "Alle ablehnen" },
      ],
    };
    expect(criteriaOf(space(booking).questions["click_target"])).toEqual(["1", "5", "6"]);
  });

  it("stays below Jev's limit of 255 options per question", () => {
    const elements = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, kind: "link" as const, label: `Link ${index + 1}` }));
    expect(criteriaOf(space({ ...START, elements }).questions["click_target"])).toHaveLength(255);
  });
});

describe("what the pilot is offered on pages in other languages (fail closed, D8)", () => {
  const foreignSpace = (page: PageSnapshot) => actionSpace(page, "ziel", { inputs: ["İstanbul"], canGoBack: false, history: [], foreign: true });
  const turkish: PageSnapshot = {
    ...START,
    lang: "tr",
    elements: [
      { id: 1, kind: "button", label: "Sepete ekle" },
      { id: 2, kind: "button", label: "Hemen al 299 TL" },
      { id: 3, kind: "link", label: "Hakkımızda", target: "/hakkimizda" },
      { id: 4, kind: "link", label: "Ürün 1.299,00 TL", target: "/urun/42" },
      { id: 5, kind: "link", label: "Onayla", target: "/siparis/confirm" },
      { id: 6, kind: "button", label: "Ara", submits: true, target: "/arama" },
      { id: 7, kind: "button", label: "Rezervasyon", submits: true, target: "/booking" },
      { id: 8, kind: "button", role: "checkbox", label: "Sadece direkt seferler" },
      { id: 9, kind: "button", role: "gridcell", label: "Cumartesi 10" },
      { id: 10, kind: "button", role: "switch", label: "Bağlayıcı olarak rezerve et" },
      { id: 11, kind: "button", label: "Daha fazla", state: "collapsed" },
    ],
  };

  it("offers links to ordinary pages, search submits and view controls, nothing that may buy or act", () => {
    expect(criteriaOf(foreignSpace(turkish).questions["click_target"])).toEqual(["3", "6", "8", "9", "11"]);
  });

  it("on an English or German page the word lists decide, plus language-neutral money", () => {
    // The same Turkish labels read as English or German: the lists know none of the words, so all are offered.
    // That is why the page's language decides first.
    const german = { ...turkish, lang: "de" };
    expect(criteriaOf(space(german).questions["click_target"])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
    // A checkout target or a submit on a page with payment fields is money on every page.
    const checkout = { ...START, payment: true, elements: [{ id: 1, kind: "link" as const, label: "Weiter", target: "/checkout" }, { id: 2, kind: "button" as const, label: "Weiter", submits: true }, { id: 3, kind: "link" as const, label: "Hilfe", target: "/hilfe" }] };
    expect(criteriaOf(space(checkout).questions["click_target"])).toEqual(["3"]);
  });

  it("never presses Enter on a page with payment fields", () => {
    const pay = { ...START, payment: true, elements: [{ id: 1, kind: "input" as const, label: "Gutscheincode", value: "X1" }] };
    const operations = criteriaOf(space(pay).questions["operation"]);
    expect(operations).not.toContain("PRESS_ENTER");
    expect(operations).not.toContain("TYPE_AND_SUBMIT");
  });

  it("decides the language per snapshot in a run: a Turkish page gets the closed offer", async () => {
    const page: PageSnapshot = { ...turkish, text: "Sepete ekle, hemen satın al, ücretsiz kargo ile kapınızda", view: "Sepete ekle, hemen satın al, ücretsiz kargo ile kapınızda" };
    const j = scriptedJev([{ op: ["DONE"], goal: 0.95 }]);
    await runPilot(session([page]).api, "ziel", deps(j.jev));
    expect(criteriaOf(j.calls[0]!.questions["click_target"])).toEqual(["3", "6", "8", "9", "11"]);
    expect(offeredClick({ id: 1, kind: "button", label: "Sepete ekle" }, {}, true)).toBe(false);
    expect(offeredClick({ id: 1, kind: "button", label: "Sepete ekle" }, {}, false)).toBe(true);
  });
});

describe("the browser's language", () => {
  it("follows the owner's language, with their country as region when the tag has none", () => {
    expect(browserLocale("de", "DE")).toBe("de-DE");
    expect(browserLocale("tr", "DE")).toBe("tr-DE");
    expect(browserLocale("en", null)).toBe("en");
    expect(browserLocale("de-AT", "DE")).toBe("de-AT");
    expect(browserLocale("not a tag", "DE")).toBe("en");
  });
});

describe("the pilot: Jev judges, the code owns the flow (D35)", () => {
  it("types the value Jev chooses from the given ones and stops as soon as the goal is on the page", async () => {
    const s = session([START, RESULTS]);
    const j = scriptedJev([{ op: ["TYPE_AND_SUBMIT", "CLICK"] }, { op: ["DONE"], goal: 0.95 }]);
    const result = await runPilot(s.api, "erste Verbindung morgen früh", deps(j.jev));
    expect(result.outcome).toBe("goal_met");
    expect(result.goalProbability).toBe(0.95);
    expect(result.page).toBe(RESULTS);
    expect(s.acts).toEqual([{ action: { op: "type", id: 1, submit: true }, text: "Frankfurt Hbf" }]);
    expect(result.steps).toEqual(['type "Frankfurt Hbf" in "Von" + Enter']);
    // The text comes from a choice in the same request, not from a language model and not from a second call.
    expect(j.calls).toHaveLength(2);
  });

  it("fills further empty fields in the same step when Jev is sure of the value", async () => {
    const form: PageSnapshot = { ...START, elements: [{ id: 1, kind: "input", label: "Von", formHasSubmit: true }, { id: 2, kind: "input", label: "Nach", formHasSubmit: true }, { id: 3, kind: "button", label: "Suchen" }] };
    const s = session([form, form, RESULTS]);
    const j = scriptedJev([{ op: ["TYPE_TEXT"], target: ["1"], values: { 1: "v0", 2: "v1" } }, { op: ["DONE"], goal: 0.95 }]);
    await runPilot(s.api, "ziel", deps(j.jev));
    expect(s.acts).toEqual([
      { action: { op: "type", id: 1, submit: false }, text: "Mainz Hbf" },
      { action: { op: "type", id: 2, submit: false }, text: "Frankfurt Hbf" },
    ]);
    expect(j.calls).toHaveLength(2);
  });

  it("sets date and time in native fields itself, without asking Jev, and then asks as usual", async () => {
    const form: PageSnapshot = {
      ...START,
      elements: [
        { id: 1, kind: "input", label: "Von", value: "Mainz Hbf", formHasSubmit: true },
        { id: 2, kind: "input", role: "time", label: "Uhrzeit anpassen", value: "23:48" },
        { id: 3, kind: "input", role: "date", label: "Datum anpassen", value: "2026-09-20" },
        { id: 4, kind: "button", label: "Suchen" },
      ],
    };
    const s = session([form, form, form, RESULTS]);
    const j = scriptedJev([{ op: ["CLICK"], target: ["4"] }, { op: ["DONE"], goal: 0.95 }]);
    const result = await runPilot(s.api, "ziel", deps(j.jev, { inputs: ["Mainz Hbf", "21.09.2026", "04:00"] }));
    expect(s.acts).toEqual([
      { action: { op: "type", id: 3, submit: false }, text: "21.09.2026" },
      { action: { op: "type", id: 2, submit: false }, text: "04:00" },
      { action: { op: "click", id: 4 } },
    ]);
    // Two fields set, one click: Jev was asked only once for that, then once more on the result page.
    expect(j.calls).toHaveLength(2);
    expect(result.outcome).toBe("goal_met");
  });

  it("sets date and time in part fields and date text fields itself too (repro 2026-10-10, bahn.de and rmv.de)", async () => {
    // bahn.de: day, month, year, hours, minutes as fields of their own; the month is right already.
    const dialog: PageSnapshot = {
      ...START,
      elements: [
        { id: 1, kind: "input", role: "spinbutton", label: "Tag", value: "10" },
        { id: 2, kind: "input", role: "spinbutton", label: "Monat", value: "10" },
        { id: 3, kind: "input", role: "spinbutton", label: "Jahr", value: "2026" },
        { id: 4, kind: "input", role: "spinbutton", label: "Stunden", value: "15" },
        { id: 5, kind: "input", role: "spinbutton", label: "Minuten", value: "41" },
        { id: 6, kind: "button", label: "Übernehmen" },
      ],
    };
    const s = session([dialog, dialog, dialog, dialog, RESULTS]);
    const j = scriptedJev([{ op: ["CLICK"], target: ["6"] }, { op: ["DONE"], goal: 0.95 }]);
    await runPilot(s.api, "ziel", deps(j.jev, { inputs: ["Musterstadt", "13.10.2026", "08:00"] }));
    expect(s.acts).toEqual([
      { action: { op: "type", id: 1, submit: false }, text: "13" },
      { action: { op: "type", id: 4, submit: false }, text: "08" },
      { action: { op: "type", id: 5, submit: false }, text: "00" },
      { action: { op: "click", id: 6 } },
    ]);
    expect(j.calls).toHaveLength(2);

    // rmv.de: a text field "Datum" with a date in it; written in its format.
    const hafas: PageSnapshot = { ...START, elements: [{ id: 1, kind: "input", label: "Datum", value: "10.10.26" }, { id: 2, kind: "input", label: "Update profile" }, { id: 3, kind: "button", label: "Übernehmen" }] };
    const t = session([hafas, RESULTS]);
    await runPilot(t.api, "ziel", deps(scriptedJev([{ op: ["DONE"], goal: 0.95 }]).jev, { inputs: ["13.10.2026"] }));
    expect(t.acts[0]).toEqual({ action: { op: "type", id: 1, submit: false }, text: "13.10.26" });
  });

  it("lets Jev decide with the goal which suggestion is meant (repro 2026-10-10, \"Musterstadt(Main)\")", async () => {
    const asked: Array<{ typed: string; field: string; rows: readonly string[]; picked: number | null }> = [];
    const rows = ["Main-Therme, Musterstadt", "Musterstadt(Taunus)"];
    let index = 0;
    const pages = [START, RESULTS];
    const api = {
      snapshot: async () => pages[Math.min(index, pages.length - 1)]!,
      act: async (action: PilotAction, text?: string, help?: ActHelp) => {
        if (action.op === "type" && help?.chooseSuggestion) {
          const picked = await help.chooseSuggestion(text ?? "", "Start", rows);
          asked.push({ typed: text ?? "", field: "Start", rows, picked });
        }
        index += 1;
        return undefined;
      },
      close: async () => undefined,
    };
    // The question about the suggestion comes while typing, so as a second call.
    const j = scriptedJev([{ op: ["TYPE_TEXT"] }, { op: ["DONE"], target: ["s1"], goal: 0.95 }]);
    await runPilot(api, "Verbindungen vom Bahnhof Musterstadt(Main)", deps(j.jev, { inputs: ["Musterstadt(Main)"] }));
    expect(asked).toEqual([{ typed: "Musterstadt(Main)", field: "Start", rows, picked: 1 }]);
    const question = j.calls.find((call) => "suggestion" in call.questions)!.questions["suggestion"]!;
    expect(criteriaOf(question)).toEqual(["s0", "s1", "none"]);
    expect(JSON.stringify(question.instructions)).toContain("Verbindungen vom Bahnhof Musterstadt(Main)");

    // "none" means: choose nothing.
    const none = scriptedJev([{ op: ["TYPE_TEXT"] }, { op: ["DONE"], target: ["none"], goal: 0.95 }]);
    asked.length = 0;
    index = 0;
    await runPilot(api, "ziel", deps(none.jev, { inputs: ["Musterstadt(Main)"] }));
    expect(asked[0]?.picked).toBeNull();
  });

  it("presses Enter right away when no field waits any more and nothing visible submits", async () => {
    const lone: PageSnapshot = { ...START, elements: [{ id: 1, kind: "input", label: "Search or jump to" }, { id: 2, kind: "button", label: "Search syntax tips" }] };
    const s = session([lone, RESULTS]);
    await runPilot(s.api, "ziel", deps(scriptedJev([{ op: ["TYPE_TEXT"] }, { op: ["DONE"], goal: 0.9 }]).jev, { inputs: ["microsoft/playwright"] }));
    expect(s.acts[0]?.action).toEqual({ op: "type", id: 1, submit: true });
  });

  it("does not take a DONE without a reached goal: the next best operation gets its turn", async () => {
    const s = session([START, RESULTS]);
    const result = await runPilot(s.api, "ziel", deps(scriptedJev([{ op: ["DONE", "CLICK"], target: ["3"], goal: 0.02 }, { op: ["DONE"], goal: 0.6 }]).jev));
    expect(s.acts.map((entry) => entry.action)).toEqual([{ op: "click", id: 3 }]);
    expect(result).toMatchObject({ outcome: "done", goalProbability: 0.6 });
  });

  it("stops when the run is stuck, but not before the third step", async () => {
    const pages = [START, { ...START, url: "https://auskunft.example/2" }, { ...START, url: "https://auskunft.example/3" }];
    const s = session(pages);
    const result = await runPilot(s.api, "ziel", deps(scriptedJev([{ op: ["CLICK"], target: ["3"], stuck: 0.97 }]).jev));
    expect(result.outcome).toBe("stuck");
    expect(s.acts).toHaveLength(2);
  });

  it("lets the pilot operate a check page too, instead of stopping on address or text", async () => {
    const j = scriptedJev([{ op: ["CLICK"], target: ["3"] }, { op: ["DONE"], goal: 0.95 }]);
    const s = session([{ ...START, url: "https://auskunft.example/captcha", title: "Verify you are human", text: "Access denied", view: "Access denied", status: 403 }, RESULTS]);
    const result = await runPilot(s.api, "ziel", deps(j.jev));
    expect(result.outcome).toBe("goal_met");
    expect(j.calls).toHaveLength(2);
    expect(s.acts.map((entry) => entry.action)).toEqual([{ op: "click", id: 3 }]);
  });

  it("waits for a check page that moves on by itself, and only gives up after that", async () => {
    const check: PageSnapshot = { ...START, title: "Just a moment...", elements: [] };
    const passes = session([check, check, RESULTS]);
    expect((await runPilot(passes.api, "ziel", deps(scriptedJev([{ op: ["DONE"], goal: 0.95 }]).jev))).outcome).toBe("goal_met");
    expect(passes.acts.map((entry) => entry.action.op)).toEqual(["wait", "wait"]);
    const stays = session([check]);
    // The test session turns a page with every action; here it stays on the check page.
    const j = scriptedJev([{ op: ["BLOCKED"], stuck: 0.95 }]);
    expect((await runPilot(stays.api, "ziel", deps(j.jev))).outcome).toBe("stuck");
    expect(j.calls).toHaveLength(1);
    expect(stays.acts).toHaveLength(8);
  });

  it("takes the next best after an action without effect instead of repeating it", async () => {
    // The page does not change on the first click: START twice, then the result.
    const s = session([START, START, RESULTS]);
    const j = scriptedJev([{ op: ["CLICK"], target: ["4", "3"] }, { op: ["CLICK"], target: ["4", "3"] }, { op: ["DONE"], goal: 0.9 }]);
    const result = await runPilot(s.api, "ziel", deps(j.jev));
    expect(s.acts.map((entry) => entry.action)).toEqual([{ op: "click", id: 4 }, { op: "click", id: 3 }]);
    expect(result.outcome).toBe("goal_met");
    // Jev sees what was already tried and had no effect.
    expect(j.calls[1]?.state["recent_actions"]).toEqual([{ action: 'click "Werbung"', page_changed: false }]);
  });

  it("survives a failed action and writes it into the steps", async () => {
    const s = session([START, RESULTS], (action) => action.op === "click" && action.id === 4 && new Error("locator.click: Timeout 2000ms exceeded.\nCall log: …"));
    const j = scriptedJev([{ op: ["CLICK"], target: ["4", "3"] }, { op: ["CLICK"], target: ["4", "3"] }, { op: ["DONE"], goal: 0.9 }]);
    const result = await runPilot(s.api, "ziel", deps(j.jev));
    expect(result.steps[0]).toBe('click "Werbung" failed: locator.click: Timeout 2000ms exceeded.');
    expect(result.steps[1]).toBe('click "Suchen"');
  });

  it("looks again when the element is gone instead of giving up the action", async () => {
    let failed = false;
    const stale = Object.assign(new Error("The element is no longer on the page."), { name: "StaleElementError" });
    const s = session([START, RESULTS], () => (failed ? false : ((failed = true), stale)));
    const result = await runPilot(s.api, "ziel", deps(scriptedJev([{ op: ["CLICK"], target: ["3"] }, { op: ["CLICK"], target: ["3"] }, { op: ["DONE"], goal: 0.9 }]).jev));
    expect(s.acts.map((entry) => entry.action)).toEqual([{ op: "click", id: 3 }]);
    expect(result.steps).toEqual(['click "Suchen"']);
  });

  it("allows the same action on the same address at most twice", async () => {
    // The visible text changes, the address does not: every action "has an effect", and still the run goes in circles.
    const pages = Array.from({ length: 10 }, (_, index) => ({ ...START, view: `Stand ${index}`, elements: [START.elements[2]!] }));
    const s = session(pages);
    const result = await runPilot(s.api, "ziel", deps(scriptedJev([{ op: ["CLICK"], target: ["3"] }]).jev, { inputs: [] }));
    expect(s.acts).toHaveLength(2);
    expect(result.outcome).toBe("stuck");
  });

  it("gives up after four ineffective actions in a row instead of using up all steps", async () => {
    const many: PageSnapshot = { ...START, elements: Array.from({ length: 8 }, (_, index) => ({ id: index + 1, kind: "button" as const, label: `Knopf ${index + 1}` })) };
    const s = session([many]);
    const result = await runPilot(s.api, "ziel", deps(scriptedJev([{ op: ["CLICK", "SCROLL_DOWN"] }]).jev));
    expect(result.outcome).toBe("stuck");
    expect(s.acts).toHaveLength(4);
  });

  it("ends at the step limit and at the time limit", async () => {
    const loop = Array.from({ length: 40 }, (_, index) => ({ ...START, url: `https://auskunft.example/${index}` }));
    const stepped = await runPilot(session(loop).api, "ziel", deps(scriptedJev([{ op: ["SCROLL_DOWN"] }]).jev));
    expect(stepped.outcome).toBe("step_limit");
    expect(stepped.steps).toHaveLength(20);
    let clock = 0;
    const timed = await runPilot(session(loop).api, "ziel", deps(scriptedJev([{ op: ["SCROLL_DOWN"] }]).jev, { now: () => (clock += 40_000) }));
    expect(timed.outcome).toBe("timeout");
  });

  it("sends Jev only the visible part, the values, the elements and the last steps", async () => {
    const j = scriptedJev([{ op: ["DONE"], goal: 0.9 }]);
    await runPilot(session([{ ...START, text: "die ganze Seite, zwölftausend Zeichen" }]).api, "erste Verbindung", deps(j.jev));
    expect(j.calls[0]?.state).toMatchObject({ page: { url: START.url, title: "Auskunft", text: "Verbindung suchen" }, values: ["Mainz Hbf", "Frankfurt Hbf"], recent_actions: [] });
    expect(JSON.stringify(j.calls[0]?.state)).not.toContain("zwölftausend");
  });
});

describe("broken sub-address", () => {
  it("starts once from the website's home page and says so in the steps", async () => {
    const broken: PageSnapshot = { ...base, url: "https://auskunft.example/de/auskunft-1067828", title: "", text: "503 Service Unavailable", view: "503 Service Unavailable", elements: [], status: 503 };
    const opened: string[] = [];
    const sessions = [session([broken]), session([START, RESULTS])];
    const browser = jevBrowser({
      apiKey: "k",
      chromePath: "/nirgends",
      jev: scriptedJev([{ op: ["CLICK"], target: ["3"] }, { op: ["DONE"], goal: 0.92 }]).jev,
      open: async (url) => (opened.push(url), sessions[opened.length - 1]!.api),
    });
    const result = await browser.browse("https://auskunft.example/de/auskunft-1067828", "erste Verbindung", []);
    expect(opened).toEqual(["https://auskunft.example/de/auskunft-1067828", "https://auskunft.example/"]);
    expect(sessions[0]!.closed()).toBe(true);
    expect(result.outcome).toBe("goal_met");
    expect(result.steps[0]).toBe("Address answered with 503, starting from https://auskunft.example/");
  });

  it("tries the home page on an HTTP 403 on a sub-page too", async () => {
    const wall: PageSnapshot = { ...base, url: "https://shop.example/suche?q=x", title: "403", text: "403 Forbidden", elements: [], status: 403 };
    const opened: string[] = [];
    const sessions = [session([wall]), session([START, RESULTS])];
    const browser = jevBrowser({ apiKey: "k", chromePath: "/nirgends", jev: scriptedJev([{ op: ["CLICK"], target: ["3"] }, { op: ["DONE"], goal: 0.95 }]).jev, open: async (url) => (opened.push(url), sessions[opened.length - 1]!.api) });
    expect((await browser.browse("https://shop.example/suche?q=x", "ziel", [])).outcome).toBe("goal_met");
    expect(opened).toEqual(["https://shop.example/suche?q=x", "https://shop.example/"]);
    expect(sessions[0]!.closed()).toBe(true);
  });
});

describe("repeated browser tasks", () => {
  it("opens the same host again after an unsuccessful session, also after a redirect", async () => {
    const wall: PageSnapshot = { ...base, url: "https://www.shop.example/kontakt/access-error", title: "Fehler", text: "Fehler 751", view: "Fehler 751", elements: [], status: 200 };
    const opened: string[] = [];
    const sessions = [session([wall]), session([RESULTS]), session([RESULTS])];
    const browser = jevBrowser({ apiKey: "k", chromePath: "/nirgends", jev: scriptedJev([{ op: ["BLOCKED"] }, { op: ["DONE"], goal: 0.95 }]).jev, open: async (url) => (opened.push(url), sessions[opened.length - 1]!.api) });
    expect((await browser.browse("https://shop.example/", "ziel", [])).outcome).toBe("stuck");
    expect((await browser.browse("https://shop.example/suche", "ziel", [])).outcome).toBe("goal_met");
    expect((await browser.browse("https://www.shop.example/", "ziel", [])).outcome).toBe("goal_met");
    expect(opened).toEqual(["https://shop.example/", "https://shop.example/suche", "https://www.shop.example/"]);
    expect(sessions.every((entry) => entry.closed())).toBe(true);
  });
});

describe("values for fields", () => {
  it("rewrites a German date for a date field, and only for that", () => {
    expect(valueForField("21.09.2026", "date")).toBe("2026-09-21");
    expect(valueForField("1.9.2026", "date")).toBe("2026-09-01");
    expect(valueForField("21.09.2026", "")).toBe("21.09.2026");
    expect(valueForField("4:00", "time")).toBe("04:00");
    expect(typedValue("04:00 Uhr")).toEqual({ kind: "time", value: "04:00" });
    expect(typedValue("21.09.26")).toEqual({ kind: "date", value: "2026-09-21" });
    expect(typedValue("Mainz Hbf")).toBeNull();
    expect(typedValue("25:00")).toBeNull();
  });

  it("writes a date in the format already in the field", () => {
    expect(dateLike("2026-10-13", "10.10.2026")).toBe("13.10.2026");
    expect(dateLike("2026-10-13", "1.9.26")).toBe("13.10.26");
    expect(dateLike("2026-10-13", "2026-10-10")).toBe("2026-10-13");
    expect(dateLike("2026-10-13", "10. Oktober 2026")).toBe("13.10.2026");
  });

  it("shortens a search without a meant suggestion like a human, numbers never", () => {
    expect(narrower("Musterstadt(Main)")).toEqual(["Musterstadt"]);
    expect(narrower("Frankfurt(Main)Hbf")).toEqual(["Frankfurt Hbf", "Frankfurt"]);
    expect(narrower("Berlin Hbf")).toEqual(["Berlin"]);
    expect(narrower("München")).toEqual([]);
    expect(narrower("13.10.2026")).toEqual([]);
  });
});

describe("Typesafe client", () => {
  const body = { model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1_000_000, output_tokens: 20 } };
  const client = (response: () => Response, seen: Array<{ url: string; init: RequestInit }> = []) =>
    typesafeClient("ts-key-0123456789", (async (url: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(url), init });
      return response();
    }) as typeof fetch);

  it("sends state, pinned model and questions, and books the cost against the monthly cap", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    usage.length = 0;
    const answers = await client(() => new Response(JSON.stringify(body)), seen).ask({ a: 1 }, { q: { type: "noul", instructions: "?" } });
    expect(answers["q"]).toEqual({ type: "noul", noul: 0.9 });
    expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(seen[0]?.init.headers).get("authorization")).toBe("Bearer ts-key-0123456789");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ state: { a: 1 }, model: "jev-1.13.0", questions: { q: { type: "noul", instructions: "?" } } });
    expect(usage[0]).toMatchObject({ provider: "typesafe", role: "browser", costUsd: 0.042 });
  });

  it("takes no answer that does not fit the contract", async () => {
    const ask = (response: () => Response) => client(response).ask({}, { q: { type: "noul", instructions: "?" } });
    await expect(ask(() => new Response("nope", { status: 500 }))).rejects.toThrow(TypesafeError);
    await expect(ask(() => new Response(JSON.stringify({ ...body, answers: { q: { type: "noul", noul: 7 } } })))).rejects.toThrow(/unknown format/);
    await expect(ask(() => new Response(JSON.stringify({ ...body, answers: {} })))).rejects.toThrow(/did not answer/);
  });
});

describe("web_browse in the executor", () => {
  const guard = ConfidentialGuard.from(["Alex wohnt in der Musterstraße 12, 12345 Musterstadt"]);
  const turn = () => new TurnState({ origin: "task", triggerExternalId: "", triggerMessageId: "m1", reactableIds: [] });

  function setup() {
    const s = session([START, RESULTS]);
    const opened: string[] = [];
    const browser = jevBrowser({
      apiKey: "k",
      chromePath: "/nirgends",
      jev: scriptedJev([{ op: ["CLICK"], target: ["3"] }, { op: ["DONE"], goal: 0.92 }]).jev,
      open: async (url) => (opened.push(url), s.api),
    });
    const registry = new ToolRegistry().registerAll(executorTools({ guard, search: null, browser, onFinish: () => undefined }));
    return { registry, s, opened };
  }

  it("exists only with a browser", () => {
    const names = (browser: ReturnType<typeof setupBrowser> | null) =>
      executorTools({ guard, search: null, browser, onFinish: () => undefined }).map((def) => def.name);
    expect(names(null)).not.toContain("web_browse");
    expect(names(setupBrowser())).toContain("web_browse");
  });

  it("delivers page and steps as untrusted content and closes the session", async () => {
    const { registry, s } = setup();
    const t = turn();
    const result = await registry.execute("web_browse", { url: "https://auskunft.example/", goal: "erste Verbindung morgen früh nach Mainz" }, t);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("<untrusted");
    expect(result.text).toContain("goal reached: 92 %");
    expect(result.text).toContain("ICE 698 ab 07:02");
    expect(t.taintSources).toEqual(["https://auskunft.example/ergebnis"]);
    expect(s.closed()).toBe(true);
  });

  it("takes a screenshot at the end on request and passes it on with an id (addendum D48 of 2026-10-08)", async () => {
    const s = session([START, RESULTS]);
    const shots: Array<{ jpeg: Buffer; label: string }> = [];
    const browser = jevBrowser({
      apiKey: "k",
      chromePath: "/nirgends",
      jev: scriptedJev([{ op: ["CLICK"], target: ["3"] }, { op: ["DONE"], goal: 0.92 }]).jev,
      open: async () => s.api,
    });
    const registry = new ToolRegistry().registerAll(
      executorTools({ guard, search: null, browser, onFinish: () => undefined, onScreenshot: (shot) => (shots.push(shot), shots.length <= 1 ? "s1" : null) }),
    );
    const result = await registry.execute("web_browse", { url: "https://auskunft.example/", goal: "erste Verbindung morgen früh nach Mainz", screenshot: true }, turn());
    expect(result.text).toContain("Screenshot s1 taken");
    // Without a chosen block the visible part, plus what the pilot last read on it.
    expect(shots).toEqual([{ jpeg: Buffer.from("jpeg:https://auskunft.example/ergebnis"), label: "auskunft.example", shows: RESULTS.view }]);
    expect(s.closed()).toBe(true);
    // Without a request none.
    const plain = await setup().registry.execute("web_browse", { url: "https://auskunft.example/", goal: "erste Verbindung morgen früh nach Mainz" }, turn());
    expect(plain.text).not.toContain("Screenshot");
  });

  it("takes no screenshot of a PDF in the page's viewer (live 2026-10-09: toolbar, half a page)", async () => {
    const s = session([START, { ...RESULTS, url: "https://auskunft.example/menu/karte.pdf" }]);
    const shots: Array<{ jpeg: Buffer; label: string }> = [];
    const browser = jevBrowser({
      apiKey: "k",
      chromePath: "/nirgends",
      jev: scriptedJev([{ op: ["CLICK"], target: ["3"] }, { op: ["DONE"], goal: 0.92 }]).jev,
      open: async () => s.api,
    });
    const registry = new ToolRegistry().registerAll(
      executorTools({ guard, search: null, browser, onFinish: () => undefined, onScreenshot: (shot) => (shots.push(shot), "s1") }),
    );
    const result = await registry.execute("web_browse", { url: "https://auskunft.example/", goal: "die Karte zeigen", screenshot: true }, turn());
    expect(result.text).toContain("No screenshot: the page is a PDF; read it with web_fetch");
    expect(shots).toEqual([]);
  });

  it("opens no PDF in the browser and tries at most two screenshots per task (live 2026-10-09)", async () => {
    let opened = 0;
    const asked: boolean[] = [];
    const browser = {
      browse: async (_url: string, _goal: string, _inputs: readonly string[], options?: { screenshot?: boolean }) => {
        opened += 1;
        asked.push(Boolean(options?.screenshot));
        return { outcome: "stuck" as const, steps: [], page: { url: "https://auskunft.example/", title: "T", text: "x", elements: [] } as never, goalProbability: 0.02 };
      },
    };
    const registry = new ToolRegistry().registerAll(executorTools({ guard, search: null, browser, onFinish: () => undefined, onScreenshot: () => "s1" }));
    const pdf = await registry.execute("web_browse", { url: "https://restaurant.example/menu/karte.pdf", goal: "Screenshot der Karte", screenshot: true }, turn());
    expect(pdf).toMatchObject({ ok: false });
    expect(pdf.text).toContain("web_fetch reads a PDF");
    for (let i = 0; i < 2; i += 1) await registry.execute("web_browse", { url: "https://auskunft.example/", goal: "Screenshot vom Menü", screenshot: true }, turn());
    // The third runs anyway, only without a screenshot (live 2026-10-09: a refused call, and the information was missing).
    const third = await registry.execute("web_browse", { url: "https://auskunft.example/", goal: "Screenshot vom Menü", screenshot: true }, turn());
    expect(third.text).toContain("No screenshot: there are no more than 2 attempts per task");
    expect(third.text).toContain("x");
    expect(opened).toBe(3);
    expect(asked).toEqual([true, true, false]);
  });

  it("takes no screenshot when the pilot is stuck (live 2026-10-09: grey PDF area to Alex)", async () => {
    const s = session([START]);
    const shots: Array<{ jpeg: Buffer; label: string }> = [];
    const browser = jevBrowser({
      apiKey: "k",
      chromePath: "/nirgends",
      jev: scriptedJev([{ op: ["CLICK"], target: ["3"], stuck: 0.97 }]).jev,
      open: async () => s.api,
    });
    const registry = new ToolRegistry().registerAll(
      executorTools({ guard, search: null, browser, onFinish: () => undefined, onScreenshot: (shot) => (shots.push(shot), "s1") }),
    );
    const result = await registry.execute("web_browse", { url: "https://auskunft.example/", goal: "erste Verbindung morgen früh nach Mainz", screenshot: true }, turn());
    expect(result.ok).toBe(false);
    expect(result.text).toContain("No screenshot: the page does not show what was asked");
    expect(shots).toEqual([]);
  });

  it("takes a screenshot when the pilot is stuck but the page shows the answer (live 2026-10-09, calendio.pro)", async () => {
    const full: PageSnapshot = { ...START, view: "Sa, 10.10. — nichts frei. An diesem Tag ist nichts mehr frei." };
    const s = session([full]);
    const shots: Array<{ jpeg: Buffer; label: string }> = [];
    const browser = jevBrowser({
      apiKey: "k",
      chromePath: "/nirgends",
      jev: scriptedJev([{ op: ["CLICK"], target: ["3"], stuck: 0.97, shot: 0.9 }]).jev,
      open: async () => s.api,
    });
    const registry = new ToolRegistry().registerAll(
      executorTools({ guard, search: null, browser, onFinish: () => undefined, onScreenshot: (shot) => (shots.push(shot), "s1") }),
    );
    const result = await registry.execute("web_browse", { url: "https://auskunft.example/", goal: "freie Termine am Samstag", screenshot: true }, turn());
    expect(result.text).toContain("Screenshot s1 taken");
    // What it shows goes along: Serain should know what Alex sees.
    expect(shots).toEqual([{ jpeg: Buffer.from("jpeg:https://auskunft.example/"), label: "auskunft.example", shows: full.view }]);
  });

  it("opens no browser when goal or URL carry something confidential (D29)", async () => {
    const { registry, opened } = setup();
    const result = await registry.execute("web_browse", { url: "https://auskunft.example/", goal: "Route ab Musterstraße 12 nach Mainz" }, turn());
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Personal data does not leave the server");
    // A value to type goes through the filter first too: otherwise the page would get it in its form.
    const typed = await registry.execute("web_browse", { url: "https://auskunft.example/", goal: "Route nach Mainz suchen", inputs: ["Musterstraße 12", "Mainz"] }, turn());
    expect(typed.ok).toBe(false);
    expect(typed.text).toContain("a value to type");
    expect(opened).toEqual([]);
  });
});

function setupBrowser() {
  return jevBrowser({ apiKey: "k", chromePath: "/nirgends", jev: { ask: async () => ({}) }, open: async () => session([START]).api });
}
