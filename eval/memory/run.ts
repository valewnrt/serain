// Must load before everything from `src/`: redirects the Supabase client to a dead address.
import { newLedger, runLedger, SINK_URL, withLedger, type Ledger } from "./sink.js";

import type { PGliteInterface } from "@electric-sql/pglite";
import { judge } from "../../src/agent/judge/index.js";
import { systemPrompt, turnContext } from "../../src/agent/prompt.js";
import { memoryTools } from "../../src/agent/tools/memory.js";
import { messagingTools } from "../../src/agent/tools/messaging.js";
import { ToolRegistry } from "../../src/agent/tools/registry.js";
import { TurnState } from "../../src/agent/tools/types.js";
import { runTurn } from "../../src/agent/turn.js";
import { env } from "../../src/config/env.js";
import { MEMORY } from "../../src/config/memory.js";
import { models } from "../../src/config/models.js";
import type { MemoryContextTurn } from "../../src/memory/context.js";
import type { MemoryDeps } from "../../src/memory/deps.js";
import { embed, type Embedder } from "../../src/memory/embeddings.js";
import { classifyFactAreas, consolidateUserModel, extractFacts, selectForgottenFacts, selectUserModelLines, summarize } from "../../src/memory/extract.js";
import { markerKeyFrom } from "../../src/memory/markers.js";
import { buildMemoryContext, renderMemory } from "../../src/memory/recall.js";
import { rememberOwnerTurn } from "../../src/memory/write.js";
import { RunCapReached } from "../cap.js";
import { spokenText } from "../checks.js";
import { createRecordingPort, RecordingRegistry } from "../port.js";
import { absenceAtK, evaluateAnswer, evaluateState, firstRank, matches, parseForgetCandidates } from "./checks.js";
import { caseDatabase, migratedTemplate } from "./db.js";
import { summarizeUsage } from "./report.js";
import { PgliteMemoryStore } from "./store.js";
import type { CaseResult, CheckResult, Level, MemoryCase, MessageTrace } from "./types.js";

/**
 * One run of the memory eval. Per case:
 *
 * 1. Fresh PGlite database with all migrations, starting state from `seed`.
 * 2. **The real pipeline**, message by message with a set clock:
 *    `rememberOwnerTurn` with the real `judge()` (generative via the subscription, as
 *    in production), the real extraction and real embeddings (OpenRouter). The
 *    history of each message is the messages before it, as in production, where
 *    `runtime.ts` passes the chat history to the write path; it is trimmed
 *    inside, by `renderContextBlock` with `MEMORY.writeContextTurns`.
 *    Delete instructions run through the real tool `forget_fact` in the real
 *    registry, with a turn of origin `owner_message`; afterwards this
 *    message learns nothing, as in production.
 * 3. Level 1: state via SQL. Level 2: `search_facts` for questions in different
 *    wording, at the set time. Level 3: a real chat turn via
 *    `runTurn`, with user model and memory block as in production.
 *
 * Deliberately missing: `rollUpSummaries`. Summaries only arise once
 * at least `MEMORY.summaryMinMessages` messages have dropped out of the history window;
 * no case is that long. Summaries therefore only appear
 * as starting state (forgetting cases), and exactly there it is checked whether
 * `forget_fact` reaches them.
 *
 * The answer turn gets **no** chat history: it stands for a question
 * days later, when the source messages are long out of the window. Otherwise
 * level 3 would measure the context instead of the memory.
 */

export interface MemoryRunOptions {
  cases: readonly MemoryCase[];
  levels: ReadonlySet<Level>;
  repeat: number;
  concurrency: number;
  /** `none`: control without memory: empty memory block, empty user model, level 3 only. */
  control: "none" | null;
  /** Hard cap for the OpenRouter share (embeddings, fallbacks) in dollars. */
  capUsd: number;
  runId: string;
  onCaseDone?: (result: CaseResult, done: number, total: number) => void;
}

export interface MemoryRunOutcome {
  results: CaseResult[];
  abortedAt: string | null;
}

const SUBJECT = "owner";

/** How much OpenRouter the whole run has cost so far, across all parallel cases. */
function spentUsd(): number {
  return runLedger.usage
    .filter((entry) => entry.provider === "openrouter")
    .reduce((sum, entry) => sum + entry.costUsd, 0);
}

function assertBelowCap(capUsd: number): void {
  const spent = spentUsd();
  if (spent >= capUsd) {
    throw new RunCapReached(`Run cap reached: ${spent.toFixed(5)} of ${capUsd.toFixed(2)} $ (OpenRouter)`);
  }
}

/** The real embedder, with a character counter for the cost log. */
function countingEmbedder(counter: { chars: number }): Embedder {
  return async (texts) => {
    const vectors = await embed(texts);
    counter.chars += texts.reduce((sum, text) => sum + text.length, 0);
    return vectors;
  };
}

function traceFromAudits(ledger: Ledger, messageId: string, trace: MessageTrace): void {
  for (const entry of ledger.audits) {
    if (entry.messageId !== messageId) continue;
    const detail = entry.detail;
    if (entry.event === "memory_gate" && typeof detail["probability"] === "number") {
      trace.gate = detail["probability"];
      trace.gateKept = detail["kept"] === true;
    }
    if (entry.event === "memory_fact" && typeof detail["decision"] === "string") {
      const probability = typeof detail["probability"] === "number" ? ` ${detail["probability"].toFixed(2)}` : "";
      trace.decisions.push(`${detail["decision"]}${probability}`);
    }
    if (entry.event === "memory_conflict") {
      trace.decisions.push(`conflict ${Number(detail["probability"] ?? 0).toFixed(2)}`);
    }
    if (entry.event === "memory_error") {
      trace.decisions.push(`error ${String(detail["stage"] ?? "")}: ${String(detail["reason"] ?? "")}`);
    }
  }
}

interface CaseContext {
  testCase: MemoryCase;
  store: PgliteMemoryStore;
  deps: MemoryDeps;
  clock: { now: Date };
  ledger: Ledger;
  options: MemoryRunOptions;
  iteration: number;
}

async function seed(ctx: CaseContext): Promise<void> {
  const { testCase, store, deps } = ctx;
  const firstAt = Date.parse(testCase.script[0]?.at ?? "");
  // The starting state is older than every message: it was already there.
  const before = new Date(firstAt - 86_400_000).toISOString();
  if (testCase.seed.userModel) {
    await store.seedUserModel(testCase.seed.userModel.base, testCase.seed.userModel.learned, before);
  }
  for (const summary of testCase.seed.summaries) {
    await store.insertSummary({ ...summary, messageCount: 0, embedding: null });
  }
  if (testCase.seed.facts.length > 0) {
    assertBelowCap(ctx.options.capUsd);
    const vectors = await deps.embed(testCase.seed.facts.map((fact) => fact.content));
    for (const [index, fact] of testCase.seed.facts.entries()) {
      await store.seedFact({
        subject: SUBJECT,
        category: fact.category,
        content: fact.content,
        confidence: 0.9,
        // Starting state like a fact before D39: no expiry, identity.
        kind: "identity",
        validFrom: null,
        validUntil: null,
        sourceMessageId: null,
        embedding: vectors[index] ?? null,
        createdAt: fact.at,
      });
    }
  }
}

/** The script through the write path. Returns the trace per message. */
async function playScript(ctx: CaseContext): Promise<MessageTrace[]> {
  const { testCase, store, deps, clock, ledger, options } = ctx;
  const traces: MessageTrace[] = [];
  const context: MemoryContextTurn[] = [];

  for (const message of testCase.script) {
    clock.now = new Date(message.at);
    const trace: MessageTrace = {
      at: message.at,
      from: message.from,
      text: message.text,
      stored: [],
      superseded: 0,
      conflicts: 0,
      decisions: [],
    };
    traces.push(trace);

    if (message.from === "serain") {
      await store.insertMessage("outbound", message.text, message.at);
      context.push({ role: "assistant", content: message.text });
      continue;
    }

    const messageId = await store.insertMessage("inbound", message.text, message.at);
    let blocked = false;

    if (message.forget) {
      // The real tool in the real registry: tier lock, origin check
      // and audit as in production. The `what` stands in the case instead of coming
      // from the model: what is measured is the deleting, not understanding the request.
      const port = createRecordingPort();
      const registry = new ToolRegistry().registerAll(memoryTools({ memory: deps, port }));
      const turn = new TurnState({
        origin: "owner_message",
        triggerExternalId: `eval:${options.runId}:${testCase.id}`,
        triggerMessageId: messageId,
        reactableIds: [],
      });
      assertBelowCap(options.capUsd);
      const result = await registry.execute("forget_fact", { what: message.forget }, turn);
      const candidates = result.ok ? [] : parseForgetCandidates(result.text);
      trace.forget = { what: message.forget, ok: result.ok, text: result.text, ambiguous: candidates.length > 0 };
      blocked = turn.factExtractionBlocked;

      const pick = message.forgetPick;
      const chosen = pick ? candidates.filter((candidate) => matches(pick, candidate.content)) : [];
      if (chosen.length > 0) {
        // The owner answered the follow-up question: a new turn, the same
        // flow as in production, one call per fact meant with the ID from
        // the follow-up question. In the end only what each call catches is deleted.
        const followUp = new TurnState({
          origin: "owner_message",
          triggerExternalId: `eval:${options.runId}:${testCase.id}:pick`,
          triggerMessageId: messageId,
          reactableIds: [],
        });
        const texts: string[] = [];
        let allOk = true;
        for (const candidate of chosen) {
          const next = await registry.execute("forget_fact", { what: message.forget, fact_id: candidate.id }, followUp);
          texts.push(next.text);
          allOk &&= next.ok;
        }
        trace.forget = {
          ...trace.forget,
          ok: allOk,
          text: texts.join(" / "),
          picked: chosen.map((candidate) => candidate.content),
        };
      }
    }

    if (!blocked) {
      assertBelowCap(options.capUsd);
      try {
        const outcome = await rememberOwnerTurn(deps, {
          messageId,
          text: message.text,
          context: [...context],
          subject: SUBJECT,
        });
        trace.stored = outcome.stored.map((fact) => fact.content);
        trace.superseded = outcome.superseded.length;
        trace.conflicts = outcome.conflicts.length;
      } catch (error) {
        if (error instanceof RunCapReached) throw error;
        // Like `afterTurn` in production: a failed write path costs this
        // turn, not the whole run. It goes into the trace instead of the audit log.
        trace.error = (error as Error).message;
      }
    }
    traceFromAudits(ledger, messageId, trace);
    context.push({ role: "user", content: message.text });
  }
  return traces;
}

async function recallChecks(ctx: CaseContext): Promise<CheckResult[]> {
  const { testCase, store, deps, clock, options } = ctx;
  const out: CheckResult[] = [];
  for (const [index, check] of testCase.recall.entries()) {
    clock.now = new Date(check.at);
    assertBelowCap(options.capUsd);
    // Like `buildMemoryContext`: without an embedding, full text remains.
    let embedding: number[] | null = null;
    try {
      embedding = (await deps.embed([check.query]))[0] ?? null;
    } catch {
      embedding = null;
    }
    const hits = await store.searchFacts({ subject: SUBJECT, embedding, query: check.query, limit: MEMORY.recallLimit, now: deps.now().toISOString() });
    const ranked = hits.map((hit) => hit.content);
    const top = ranked
      .slice(0, 5)
      .map((content, rank) => `${rank + 1}. ${content}`)
      .join(" | ");
    const needsV2 = check.needsV2 ?? false;

    if (check.type === "recall") {
      const rank = firstRank(ranked, check.pattern);
      for (const k of check.k) {
        out.push({
          id: `L2.${index + 1}.recall@${k}`,
          level: 2,
          kind: `recall@${k}`,
          needsV2,
          passed: rank !== null && rank <= k,
          detail: `"${check.query}" → rank ${rank ?? "–"} for /${check.pattern}/ · ${top || "no hits"}`,
        });
      }
    } else {
      out.push({
        id: `L2.${index + 1}.absence@${check.k}`,
        level: 2,
        kind: `absence@${check.k}`,
        needsV2,
        passed: absenceAtK(ranked, check.pattern, check.k),
        detail: `"${check.query}" → /${check.pattern}/ at rank ${firstRank(ranked, check.pattern) ?? "–"} · ${top || "no hits"}`,
      });
    }
  }
  return out;
}

/** A real chat turn as in production, only with a dummy as the channel. */
async function answerTurn(
  ctx: CaseContext,
): Promise<{ checks: CheckResult[]; answer: NonNullable<CaseResult["answer"]> }> {
  const { testCase, deps, clock, options } = ctx;
  const spec = testCase.answer;
  if (!spec) return { checks: [], answer: { question: "", text: "", tools: [], stopReason: null } };
  clock.now = new Date(spec.at);
  assertBelowCap(options.capUsd);

  let userModel = "";
  let memory = "";
  if (options.control === null) {
    const context = await buildMemoryContext(deps, { incoming: spec.question, subject: SUBJECT });
    userModel = context.userModel;
    memory = renderMemory(context);
  }

  const port = createRecordingPort();
  const registry = new RecordingRegistry(port.record);
  registry.registerAll(messagingTools(port));
  registry.registerAll(memoryTools({ memory: deps, port }));
  const externalId = `eval:${options.runId}:${testCase.id}:${ctx.iteration}`;
  const outcome = await runTurn(
    { registry, port },
    {
      role: "chat",
      system: systemPrompt(userModel, { web: false }),
      context: turnContext(clock.now, memory),
      history: [],
      incoming: spec.question,
      setup: {
        origin: "owner_message",
        triggerExternalId: externalId,
        triggerMessageId: "",
        reactableIds: [externalId],
      },
      // Pinned to the chat role's subscription model: no silent switch to
      // a paid fallback, and the comparison always measures the same model.
      pin: {
        provider: "subscription",
        model: models.chat.subscription,
        usageDetail: { eval: "memory", run: options.runId, case: testCase.id },
      },
    },
  );
  const text = spokenText(port.record);
  return {
    checks: evaluateAnswer(spec, text),
    answer: {
      question: spec.question,
      text,
      tools: port.record.toolCalls.map((call) => call.name),
      stopReason: outcome.stopReason,
    },
  };
}

async function runCase(
  template: PGliteInterface,
  testCase: MemoryCase,
  iteration: number,
  options: MemoryRunOptions,
): Promise<CaseResult> {
  const ledger = newLedger();
  const counter = { chars: 0 };
  const started = Date.now();
  const base = {
    caseId: testCase.id,
    category: testCase.category,
    holdout: testCase.holdout,
    negative: testCase.negative,
    iteration,
    control: options.control !== null,
  };

  return withLedger(ledger, async () => {
    const db = await caseDatabase(template);
    const clock = { now: new Date(testCase.script[0]?.at ?? Date.now()) };
    const store = new PgliteMemoryStore(db, () => clock.now);
    const deps: MemoryDeps = {
      store,
      judge: judge(),
      embed: countingEmbedder(counter),
      extractFacts,
      summarize,
      selectLines: selectUserModelLines,
      selectFacts: selectForgottenFacts,
      consolidate: consolidateUserModel,
      classifyAreas: classifyFactAreas,
      // A separate key for the eval: markers for forgotten facts work as in production.
      markerKey: markerKeyFrom("serain-memory-eval"),
      now: () => clock.now,
    };
    const ctx: CaseContext = { testCase, store, deps, clock, ledger, options, iteration };
    const checks: CheckResult[] = [];
    let trace: MessageTrace[] = [];
    let answer: CaseResult["answer"];
    let snapshot: CaseResult["snapshot"];

    try {
      if (options.control === null) {
        await seed(ctx);
        trace = await playScript(ctx);
        snapshot = await store.snapshot(SUBJECT);
        if (options.levels.has(1)) checks.push(...evaluateState(testCase.state, snapshot));
        if (options.levels.has(2)) checks.push(...(await recallChecks(ctx)));
      }
      if (options.levels.has(3) && testCase.answer) {
        const turn = await answerTurn(ctx);
        checks.push(...turn.checks);
        answer = turn.answer;
      }
      return {
        ...base,
        ok: true,
        checks,
        trace,
        ...(answer ? { answer } : {}),
        ...(snapshot ? { snapshot } : {}),
        usage: summarizeUsage(ledger, counter.chars),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof RunCapReached) throw error;
      return {
        ...base,
        ok: false,
        error: (error as Error).message,
        checks,
        trace,
        ...(snapshot ? { snapshot } : {}),
        usage: summarizeUsage(ledger, counter.chars),
        durationMs: Date.now() - started,
      };
    } finally {
      await db.close();
    }
  });
}

export async function runMemoryEval(options: MemoryRunOptions): Promise<MemoryRunOutcome> {
  // Second belt next to `sink.ts`: if the Supabase client points to anything
  // other than the dummy, not a single case starts.
  if (env.supabaseUrl !== SINK_URL) {
    throw new Error("Memory eval: Supabase does not point to the dummy. Aborting before anything is written.");
  }

  const template = await migratedTemplate();
  const queue: Array<{ testCase: MemoryCase; iteration: number }> = [];
  for (let iteration = 1; iteration <= options.repeat; iteration += 1) {
    for (const testCase of options.cases) {
      if (options.control !== null && !testCase.answer) continue;
      queue.push({ testCase, iteration });
    }
  }

  const total = queue.length;
  const results: CaseResult[] = [];
  let abortedAt: string | null = null;

  async function worker(): Promise<void> {
    while (abortedAt === null) {
      const next = queue.shift();
      if (!next) return;
      try {
        const result = await runCase(template, next.testCase, next.iteration, options);
        results.push(result);
        options.onCaseDone?.(result, results.length, total);
      } catch (error) {
        if (!(error instanceof RunCapReached)) throw error;
        abortedAt ??= error.message;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, total)) }, () => worker()));
  } finally {
    await template.close();
  }
  return { results, abortedAt };
}
