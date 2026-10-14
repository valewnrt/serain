import { systemPrompt, turnContext } from "../src/agent/prompt.js";
import { messagingTools } from "../src/agent/tools/messaging.js";
import { runTurn } from "../src/agent/turn.js";
import { setAuditActor } from "../src/db/audit.js";
import { loadEld, type Detector } from "../src/i18n/language.js";
import { log } from "../src/log.js";
import { aliasOf, anonymize } from "./anonymize.js";
import { RunCap, RunCapReached } from "./cap.js";
import { assertZeroDataRetention, candidateById, SUITE_ROLE } from "./config.js";
import { askJudgeCase, judgeFor } from "./judge.js";
import { questionLabel } from "./judge-map.js";
import { loadSuite } from "./load.js";
import { createRecordingPort, productionToolNames, RecordingRegistry } from "./port.js";
import { judgeMatches, runChatChecks, runDatesChecks, runToolsChecks } from "./checks.js";
import { newRunId, runPaths, writeRun } from "./store.js";
import { scheduleTools } from "../src/agent/tools/schedule.js";
import { mailTools } from "../src/agent/tools/mail.js";
import { taskTools } from "../src/agent/tools/task.js";
import { watchTools } from "../src/agent/tools/watch.js";
import { computeTools } from "../src/agent/tools/compute.js";
import { SandboxError, type Sandbox } from "../src/sandbox/client.js";
import type { PageFetcher } from "../src/watch/read.js";
import type { WatcherRow, WatcherStore } from "../src/watch/types.js";
import { ConfidentialGuard } from "../src/security/confidential.js";
import { evalMailAccount } from "./mailbox.js";
import type { ScheduleRow, ScheduleStore } from "../src/scheduler/store.js";
import type { ChatTurn } from "../src/agent/model.js";
import { addDays, atWallTime, ownerDate } from "../src/time.js";
import type {
  Candidate,
  CaseRun,
  ChatCase,
  EvalMail,
  HistoryTurn,
  DatesCase,
  JudgeCase,
  ModelRoleName,
  RunKey,
  RunManifest,
  SuiteName,
  ToolsCase,
  TurnRecord,
} from "./types.js";

/**
 * The eval run. Three things make it useful:
 *
 * 1. **The same code as production.** `runTurn` from `src/agent/turn.ts`, the
 *    real registry, the real message tools, the real model layer. Only the
 *    channel is a mock (`eval/port.ts`), so that no iMessage ever goes out.
 * 2. **No fallback.** Every candidate is pinned with `pin`. If it fails, that
 *    stands as an error in the result and not as another model's answer.
 * 3. **Two caps.** The monthly cap (D3) applies in the model layer, the run cap
 *    here. Every request is booked in `usage_log` as `eval`.
 *
 * Deliberately **without a user model** in the system prompt: the report is a
 * file the owner might pass on, and personal data has no place in it. What is
 * measured is the style, not the memory.
 *
 * The language check of the chat suite uses the same detector as production
 * (`eld`), loaded once per run, so a case in any language can be checked.
 */

export interface RunOptions {
  suites: SuiteName[];
  candidates: Candidate[];
  capUsd: number;
  /** Only the first N cases per suite. For smoke tests. */
  limit?: number;
  /** Only these case IDs. For the targeted before/after comparison of one rule. */
  only?: readonly string[];
  /** Reference point in time, above all for the `dates` suite. */
  now?: Date;
  runId?: string;
  /** Where the run is written. Default `data/eval/runs`; tests point elsewhere. */
  runsRoot?: string;
}

export interface RunResult {
  runId: string;
  results: CaseRun[];
  manifest: RunManifest;
  key: RunKey;
  /** Where the cases per suite came from. For `chat` the difference that counts. */
  sources: Partial<Record<SuiteName, string>>;
  dir: string;
}

/** Schedules only in the memory of this one turn. None of it ever becomes due. */
function memoryScheduleStore(): ScheduleStore {
  const rows: ScheduleRow[] = [];
  return {
    async insert(row) {
      const stored: ScheduleRow = {
        id: `eval-${rows.length + 1}`,
        mode: row.mode,
        text: row.text,
        repeat: row.repeat,
        nextRunAt: row.nextRunAt,
        anchor: row.anchor,
        dueAt: row.nextRunAt,
        attempts: 0,
        createdAt: new Date().toISOString(),
        taintSources: [...row.taintSources],
      };
      rows.push(stored);
      return stored;
    },
    active: async () => [...rows],
    countActive: async () => rows.length,
    due: async () => [],
    claim: async () => false,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => false,
    running: async () => [],
    release: async () => undefined,
  };
}

/** Watchers only in the memory of this one turn. None of them is ever checked. */
function memoryWatcherStore(now: Date): WatcherStore {
  const rows: WatcherRow[] = [];
  return {
    async insert(input) {
      const row: WatcherRow = {
        ...input,
        id: `eval-watch-${rows.length + 1}`,
        status: "active",
        lastCheckedAt: null,
        failures: 0,
        createdAt: now.toISOString(),
      };
      rows.push(row);
      return row;
    },
    active: async () => [...rows],
    countActive: async () => rows.length,
    due: async () => [],
    claim: async () => false,
    update: async () => false,
    cancel: async () => false,
  };
}

/** Kraken always answers with the same rate in the eval; no other address exists. */
const evalQuoteFetcher: PageFetcher = async (url) => {
  if (!url.startsWith("https://api.kraken.com/")) throw new Error("In the eval there is only the rate from Kraken.");
  const text = JSON.stringify({ error: [], result: { XXBTZEUR: { a: ["72108.8", "1", "1.000"], c: ["72113.4", "0.0001"], o: "74360.2" } } });
  return { url, status: 200, contentType: "application/json", title: "", text, truncated: false };
};

const absentSandbox: Sandbox = {
  run: async () => {
    throw new SandboxError("The sandbox does not run in the eval. Answer without a calculation.");
  },
};

function emptyRecord(): TurnRecord {
  return {
    messages: [],
    reactions: [],
    toolCalls: [],
    unknownTools: [],
    usedTextFallback: false,
    stopReason: null,
    steps: 0,
  };
}

/**
 * One turn over the production path. `triggerMessageId` stays empty: there is
 * no row in `messages` for this turn, and the audit then records `null` instead
 * of an invented foreign key.
 */
async function runChatLikeCase(
  candidate: Candidate,
  runId: string,
  suite: SuiteName,
  input: string,
  history: readonly HistoryTurn[],
  now: Date,
  options: {
    speaker?: string | undefined;
    mailbox?: readonly EvalMail[] | undefined;
    memory?: string | undefined;
    web?: boolean;
    /** Watchers over a store in the process, rates from a fixed answer (style round, addendum to D23 of 2026-10-08). */
    watch?: boolean;
    /** `compute` with a sandbox that is not there: measured is only whether the turn has things calculated. */
    compute?: boolean;
  } = {},
): Promise<{ record: TurnRecord; costUsd: number }> {
  const { speaker, mailbox, memory, web = false } = options;
  const port = createRecordingPort();
  const registry = new RecordingRegistry(port.record);
  registry.registerAll(messagingTools(port));
  if (options.watch) {
    registry.registerAll(watchTools({ store: memoryWatcherStore(now), confidential: async () => ConfidentialGuard.from([]), fetch: evalQuoteFetcher, now: () => now }));
  }
  if (options.compute) registry.registerAll(computeTools({ sandbox: absentSandbox }));
  // Reminders belong to the style (D23: a sentence, not a keyword). The store
  // is a mock in the process: an eval run never sets up a real schedule.
  registry.registerAll(scheduleTools({ store: memoryScheduleStore(), now: () => now }));
  // Mail cases: the real reading mail tools over a mailbox in memory.
  // `mail_send` stays out: the registry accepts irreversible tools only with the
  // confirmation protocol (D8.3), and the eval doesn't have it.
  const mail = mailbox ? evalMailAccount(mailbox, now) : null;
  if (mail) {
    registry.registerAll(mailTools({ accounts: [mail], now: () => now }).filter((tool) => tool.level === "read"));
  }

  // Research cases: the real `run_task` with acknowledgement, but without an executor behind it.
  if (web) {
    registry.registerAll(
      taskTools({
        port,
        tasks: { precondition: async () => null, start: () => undefined },
        confidential: async () => ConfidentialGuard.from([]),
      }),
    );
  }

  const externalId = `eval:${runId}:${suite}`;
  const outcome = await runTurn(
    { registry, port },
    {
      role: candidate.role as ModelRoleName,
      system: systemPrompt("", { web, ...(mail ? { mail: [mail.address] } : {}), ...(options.compute ? { compute: true } : {}) }),
      context: turnContext(now, memory),
      history: history.map((turn) => historyTurn(turn, now)),
      incoming: input,
      ...(speaker ? { incomingSpeaker: speaker } : {}),
      setup: {
        // The eval replays the owner's own messages (D8.4).
        origin: "owner_message",
        triggerExternalId: externalId,
        triggerMessageId: "",
        reactableIds: [externalId],
      },
      pin: {
        provider: candidate.provider,
        model: candidate.model,
        usageDetail: { eval: suite, run: runId, candidate: candidate.id },
        ...(candidate.thinking ? { thinking: candidate.thinking } : {}),
      },
    },
  );

  port.record.usedTextFallback = outcome.usedTextFallback;
  port.record.stopReason = outcome.stopReason;
  port.record.steps = outcome.steps;
  return { record: port.record, costUsd: outcome.costUsd };
}

/** A history turn from the case, with a point in time relative to the run. */
export function historyTurn(turn: HistoryTurn, now: Date): ChatTurn {
  if (!turn.at) return { role: turn.role, content: turn.content };
  const [hour, minute] = turn.at.time.split(":").map(Number);
  const day = addDays(ownerDate(now), -turn.at.daysAgo);
  return { role: turn.role, content: turn.content, at: atWallTime(day, hour ?? 0, minute ?? 0).toISOString() };
}

export async function runEval(options: RunOptions): Promise<RunResult> {
  const now = options.now ?? new Date();
  const runId = options.runId ?? newRunId(now);
  const cap = new RunCap(options.capUsd);

  if (options.candidates.some((candidate) => candidate.provider === "openrouter")) {
    // D3: no paid call without Zero Data Retention.
    assertZeroDataRetention();
  }

  // Eval turns run through the same registry as real ones and therefore write
  // real audit entries. The actor makes them distinguishable (D8.6).
  setAuditActor("eval");

  const key = anonymize(options.candidates, runId);
  const results: CaseRun[] = [];
  const manifest: RunManifest = {
    runId,
    startedAt: now.toISOString(),
    suites: options.suites,
    candidateIds: options.candidates.map((candidate) => candidate.id),
    capUsd: cap.capUsd,
    spentUsd: 0,
  };

  let aborted: string | null = null;
  const sources: Partial<Record<SuiteName, string>> = {};
  // Local, no network, about 100 ms: only when the chat suite runs.
  const detect: Detector | undefined = options.suites.includes("chat") ? await loadEld() : undefined;

  outer: for (const suite of options.suites) {
    const data = loadSuite(suite, { now });
    sources[suite] = data.source;
    const wanted = options.only?.length
      ? data.cases.filter((entry) => options.only?.includes(entry.id))
      : data.cases;
    const cases = options.limit ? wanted.slice(0, options.limit) : wanted;
    log.info(`Suite ${suite}: ${cases.length} cases, source ${data.source}`);

    for (const testCase of cases) {
      for (const candidate of options.candidates) {
        if (SUITE_ROLE[suite] !== candidate.role) continue;
        const blocked = cap.blockedReason();
        if (blocked) {
          aborted = blocked;
          log.error(`Run aborted: ${blocked}`);
          break outer;
        }

        const started = Date.now();
        const shown =
          suite === "judge"
            ? `${(testCase as JudgeCase).message}\n\n→ ${questionLabel((testCase as JudgeCase).question)}`
            : (testCase as ChatCase | ToolsCase | DatesCase).input;
        const base = {
          caseId: testCase.id,
          suite,
          input: shown,
          ...(testCase.note === undefined ? {} : { note: testCase.note }),
          alias: aliasOf(key, candidate.id),
          candidateId: candidate.id,
        };

        try {
          cap.assertOpen();
          if (suite === "judge") {
            const judgeCase = testCase as JudgeCase;
            if (!candidate.judgeBackends) {
              throw new Error(`Candidate "${candidate.id}" has no judge backends`);
            }
            const { answer, raw, costUsd } = await askJudgeCase(
              judgeFor(candidate.judgeBackends),
              judgeCase,
            );
            cap.record(costUsd);
            results.push({
              ...base,
              ok: true,
              judge: raw,
              checks: [judgeMatches(judgeCase, answer)],
              record: {
                ...emptyRecord(),
                messages: [
                  { text: `${JSON.stringify(answer)} · ${JSON.stringify(raw)}`, kind: "judge_answer" },
                ],
              },
              costUsd,
              latencyMs: Date.now() - started,
            });
            continue;
          }

          const input = (testCase as ChatCase | ToolsCase | DatesCase).input;
          const history = (testCase as ChatCase | ToolsCase).history ?? [];
          const { record, costUsd } = await runChatLikeCase(
            candidate,
            runId,
            suite,
            input,
            history,
            now,
            suite === "tools"
              ? {
                  mailbox: (testCase as ToolsCase).mailbox,
                  memory: (testCase as ToolsCase).memory,
                  web: (testCase as ToolsCase).web === true,
                  watch: (testCase as ToolsCase).watch === true,
                  compute: (testCase as ToolsCase).compute === true,
                }
              : { speaker: (testCase as ChatCase).speaker, memory: (testCase as ChatCase).memory },
          );
          cap.record(costUsd);

          const checks =
            suite === "chat"
              ? runChatChecks(testCase as ChatCase, record, { toolNames: productionToolNames(), ...(detect ? { detect } : {}) })
              : suite === "tools"
                ? runToolsChecks(testCase as ToolsCase, record)
                : runDatesChecks(testCase as DatesCase, record);

          results.push({
            ...base,
            ok: true,
            record,
            checks,
            costUsd,
            latencyMs: Date.now() - started,
          });
          log.debug(`${suite}/${testCase.id} · ${base.alias} · ${costUsd.toFixed(4)} $`);
        } catch (error) {
          if (error instanceof RunCapReached) {
            aborted = error.message;
            log.error(`Run aborted: ${error.message}`);
            break outer;
          }
          const reason = (error as Error).message;
          log.error(`${suite}/${testCase.id} · ${base.alias} failed: ${reason}`);
          results.push({
            ...base,
            ok: false,
            error: reason,
            checks: [],
            costUsd: 0,
            latencyMs: Date.now() - started,
          });
        }
      }
    }
  }

  setAuditActor("serain");
  manifest.spentUsd = cap.spentUsd;
  if (aborted) manifest.abortedAt = aborted;

  const paths = options.runsRoot ? runPaths(runId, options.runsRoot) : runPaths(runId);
  writeRun(paths, manifest, key, results);
  return { runId, results, manifest, key, sources, dir: paths.dir };
}

export function resolveCandidates(ids: readonly string[]): Candidate[] {
  return ids.map((id) => {
    const candidate = candidateById(id);
    if (!candidate) throw new Error(`Unknown candidate "${id}". \`pnpm eval --list\` shows all.`);
    return candidate;
  });
}
