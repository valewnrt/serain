import { describe, expect, it, vi } from "vitest";
import { BUDGET_REFRESH_MS, MONTHLY_API_BUDGET_USD } from "../src/config/limits.js";
import { BUDGET_QUESTION, BudgetMonitor, budgetLine, dueWarnings, evaluateBudget, monthKey, type BudgetNotice } from "../src/budget.js";
import { models } from "../src/config/models.js";
import { openRouterModel } from "../src/agent/model.js";
import { turnContext } from "../src/agent/prompt.js";
import { installTranslations } from "../src/i18n/catalog.js";
import { core } from "../src/i18n/messages/core.js";

const fresh: BudgetNotice = { month: "2026-10", throttle: false, exhausted: false };
const OCTOBER = new Date("2026-10-08T12:00:00Z");

describe("budget state", () => {
  it("computes the share from the month total, against API and total cap", () => {
    const status = evaluateBudget({ apiCostUsd: 3.25 });
    expect(status.apiRatio).toBeCloseTo(0.5);
    expect(status.totalRatio).toBeCloseTo(3.25 / 20);
    expect(status.throttled).toBe(false);
    expect(status.apiExhausted).toBe(false);
    expect(status.tasksAllowed).toBe(true);
  });

  it("throttles from 80 % but still allows tasks", () => {
    const status = evaluateBudget({ apiCostUsd: 5.2 });
    expect(status.throttled).toBe(true);
    expect(status.tasksAllowed).toBe(true);
  });

  it("blocks tasks when the API cap is used up, not the chat", () => {
    const status = evaluateBudget({ apiCostUsd: MONTHLY_API_BUDGET_USD });
    expect(status.apiExhausted).toBe(true);
    expect(status.throttled).toBe(true);
    expect(status.tasksAllowed).toBe(false);
  });
});

describe("saving model in the throttled fallback", () => {
  it("takes the saving model for chat and executor, the small roles stay", () => {
    expect(openRouterModel("chat", { throttled: false })).toBe(models.chat.openrouter);
    expect(openRouterModel("chat", { throttled: true })).toBe(models.chat.saver);
    expect(openRouterModel("executor", { throttled: true })).toBe(models.executor.saver);
    expect(openRouterModel("judge", { throttled: true })).toBe(models.judge.openrouter);
    expect(models.chat.saver).not.toBe(models.chat.openrouter);
  });
});

describe("budget in the context", () => {
  it("stays silent below 50 %, unless Alex asks", () => {
    const low = evaluateBudget({ apiCostUsd: 1 });
    expect(budgetLine(low, 4.39, OCTOBER, false)).toBeNull();
    expect(budgetLine(low, 4.39, OCTOBER, true)).toBe(
      "Budget October: $1.00 of $20.00 total cap (5 %), of which paid API $1.00 of $6.50 (15 %); so $5.50 is left for paid things, the API cap allows no more, $4.39 still free at OpenRouter.",
    );
  });

  it("is always there from 50 % and says when throttled or used up", () => {
    expect(budgetLine(evaluateBudget({ apiCostUsd: 3.4 }), null, OCTOBER, false)).toBe(
      "Budget October: $3.40 of $20.00 total cap (17 %), of which paid API $3.40 of $6.50 (52 %); so $3.10 is left for paid things, the API cap allows no more.",
    );
    expect(budgetLine(evaluateBudget({ apiCostUsd: 5.5 }), 1, OCTOBER, false)).toContain("Throttled until the first of the month");
    expect(budgetLine(evaluateBudget({ apiCostUsd: 6.5 }), 0, OCTOBER, false)).toContain("The API cap is reached");
  });

  it("is a line of its own right after the time in the <context>", () => {
    const line = budgetLine(evaluateBudget({ apiCostUsd: 3.4 }), null, OCTOBER, false)!;
    const context = turnContext(OCTOBER, "", [], [line]).split("\n");
    expect(context[1]).toMatch(/^It is now /);
    expect(context[2]).toBe(line);
    expect(turnContext(OCTOBER)).not.toContain("Budget");
  });

  it("recognises questions about costs in German and English, not every \"costs\"", () => {
    for (const text of [
      "wie viel budget hast du noch?",
      "was hast du diesen monat ausgegeben",
      "wie viel guthaben ist bei openrouter",
      "was kostest du mich eigentlich",
      "how much budget is left?",
      "how much do you cost me",
      "what have you spent this month",
      "how many credits are left at openrouter",
    ]) {
      expect(BUDGET_QUESTION.test(text), text).toBe(true);
    }
    for (const text of ["was kostet ein flug nach rom", "erinnere mich an die stromkosten", "kostenlos parken in musterstadt", "what does a flight to rome cost", "remind me about the electricity costs"]) {
      expect(BUDGET_QUESTION.test(text), text).toBe(false);
    }
    // Other languages: no word list; the line still appears from 50 % on.
    expect(BUDGET_QUESTION.test("bütçen ne kadar kaldı")).toBe(false);
  });
});

describe("BudgetMonitor", () => {
  function rig(cost: number) {
    let now = OCTOBER;
    const state = { cost };
    const status = vi.fn(async () => evaluateBudget({ apiCostUsd: state.cost }));
    const openRouterLeft = vi.fn(async () => 4.39);
    const monitor = new BudgetMonitor({ status, openRouterLeft, now: () => now });
    return { monitor, status, openRouterLeft, state, advance: (ms: number) => void (now = new Date(now.getTime() + ms)) };
  }

  it("reads at most every five minutes and OpenRouter less often", async () => {
    const h = rig(5.5);
    expect(await h.monitor.throttled()).toBe(true);
    expect(await h.monitor.throttled()).toBe(true);
    expect(h.status).toHaveBeenCalledTimes(1);
    h.advance(BUDGET_REFRESH_MS);
    h.state.cost = 1;
    expect(await h.monitor.throttled()).toBe(false);
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(h.openRouterLeft).toHaveBeenCalledTimes(1);
  });

  it("gives the line from memory without a question, fresh on a question", async () => {
    const h = rig(1);
    expect(await h.monitor.contextLine(false)).toBeNull();
    expect(h.status).not.toHaveBeenCalled();
    expect(await h.monitor.contextLine(true)).toContain("$1.00 of $20.00");
    expect(h.status).toHaveBeenCalledTimes(1);
  });

  it("keeps the old state when reading fails, and does not throttle without a state", async () => {
    const h = rig(5.5);
    h.status.mockRejectedValueOnce(new Error("db gone"));
    expect(await h.monitor.throttled()).toBe(false);
    await h.monitor.refresh();
    h.advance(BUDGET_REFRESH_MS);
    h.status.mockRejectedValueOnce(new Error("db gone"));
    expect(await h.monitor.throttled()).toBe(true);
  });
});

describe("notices to Alex", () => {
  it("stays silent below 80 %", () => {
    expect(dueWarnings(evaluateBudget({ apiCostUsd: 5.0 }), fresh, "2026-10")).toEqual([]);
  });

  it("says once from 80 % that Serain is saving", () => {
    const warnings = dueWarnings(evaluateBudget({ apiCostUsd: 5.3 }), fresh, "2026-10");
    expect(warnings.map((warning) => warning.kind)).toEqual(["throttle"]);
    expect(warnings[0]?.text).toBe("82 % vom api-budget sind weg (5,30 $ von 6,50 $). bis zum ersten spar ich: kleineres ersatzmodell, kein morgenblick, nichts von mir aus.");
    expect(dueWarnings(evaluateBudget({ apiCostUsd: 6.0 }), { ...fresh, throttle: true }, "2026-10")).toEqual([]);
  });

  it("says once at 100 % that it is used up, even when the throttling was skipped", () => {
    expect(dueWarnings(evaluateBudget({ apiCostUsd: 6.5 }, "oauth"), fresh, "2026-10")).toEqual([
      { kind: "exhausted", text: "api-budget für den monat ist durch (6,50 $). bis zum ersten läuft nur noch der chat übers abo, aufträge gehen nicht." },
    ]);
    expect(dueWarnings(evaluateBudget({ apiCostUsd: 6.5 }), { ...fresh, throttle: true }, "2026-10").map((warning) => warning.kind)).toEqual(["exhausted"]);
    expect(dueWarnings(evaluateBudget({ apiCostUsd: 6.6 }), { ...fresh, throttle: true, exhausted: true }, "2026-10")).toEqual([]);
  });

  it("says with an API key or only OpenRouter that the chat stops until the first too", () => {
    for (const claude of ["api_key", null] as const) {
      const status = evaluateBudget({ apiCostUsd: 6.5 }, claude);
      expect(status.chatStops).toBe(true);
      expect(dueWarnings(status, fresh, "2026-10")).toEqual([
        { kind: "exhausted", text: "api-budget für den monat ist durch (6,50 $). bis zum ersten geht nichts mehr, was geld kostet, auch der chat nicht." },
      ]);
      expect(budgetLine(status, null, OCTOBER, false)).toContain("no tasks and no chat until the first of the month.");
    }
    expect(evaluateBudget({ apiCostUsd: 6.5 }, "oauth").chatStops).toBe(false);
    expect(budgetLine(evaluateBudget({ apiCostUsd: 6.5 }, "oauth"), null, OCTOBER, false)).toContain("the chat runs on the subscription.");
  });

  it("starts over in a new month, even without a stored state", () => {
    const old: BudgetNotice = { month: "2026-09", throttle: true, exhausted: true };
    expect(dueWarnings(evaluateBudget({ apiCostUsd: 5.4 }), old, "2026-10")).toHaveLength(1);
    expect(dueWarnings(evaluateBudget({ apiCostUsd: 5.4 }), null, "2026-10")).toHaveLength(1);
  });
});

describe("notices in other languages", () => {
  it("renders in English with English amounts", () => {
    expect(dueWarnings(evaluateBudget({ apiCostUsd: 5.3 }), fresh, "2026-10", "en")[0]?.text).toBe(
      "82% of the api budget is gone ($5.30 of $6.50). until the first i'm saving: smaller fallback model, no morning look, nothing on my own.",
    );
    expect(dueWarnings(evaluateBudget({ apiCostUsd: 6.5 }, "oauth"), fresh, "2026-10", "en")[0]?.text).toBe(
      "api budget for the month is used up ($6.50). until the first only the chat runs, on the subscription, tasks don't work.",
    );
  });

  it("uses a translated catalog with the locale's amounts, and English before it exists", () => {
    expect(dueWarnings(evaluateBudget({ apiCostUsd: 5.3 }), fresh, "2026-10", "tr")[0]?.text).toMatch(/^82% of the api budget is gone \(\$5\.30 of \$6\.50\)/);
    installTranslations("tr", {
      [core.budgetThrottle.en]: "api bütçesinin {percent} kadarı gitti ({cap} içinden {spent}). ayın birine kadar tasarruf ediyorum: daha küçük yedek model, sabah özeti yok, kendiliğimden hiçbir şey yok.",
    });
    const text = dueWarnings(evaluateBudget({ apiCostUsd: 5.3 }), fresh, "2026-10", "tr")[0]?.text ?? "";
    const percent = new Intl.NumberFormat("tr", { style: "percent", maximumFractionDigits: 0 }).format(0.82).replace(/\u00a0/g, " ");
    const usd = (value: number) => new Intl.NumberFormat("tr", { style: "currency", currency: "USD" }).format(value).replace(/\u00a0/g, " ");
    expect(text).toBe(`api bütçesinin ${percent} kadarı gitti (${usd(6.5)} içinden ${usd(5.3)}). ayın birine kadar tasarruf ediyorum: daha küçük yedek model, sabah özeti yok, kendiliğimden hiçbir şey yok.`);
  });
});

describe("monthKey", () => {
  it("uses UTC, matching the month window in usage_log", () => {
    expect(monthKey(new Date("2026-09-01T00:30:00Z"))).toBe("2026-09");
    expect(monthKey(new Date("2026-12-31T23:00:00Z"))).toBe("2026-12");
  });
});
