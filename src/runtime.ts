import { join } from "node:path";
import { SIGNALS, signalEmoji } from "./channel/signals.js";
import type { Channel, InboundMessage, InboundReaction, InboundTyping } from "./channel/types.js";
import { env } from "./config/env.js";
import { owner } from "./config/owner.js";
import { MEMORY } from "./config/memory.js";
import { audit, countAuditSince, outboundOrigin, reactionsFor, toolActionsFor, turnRetriesFor, type ToolAction, type TurnRetryMark } from "./db/audit.js";
import { findOutbound, ownerMentionedAddress, recentMessages, storeAttachmentReadings, storeInbound } from "./db/messages.js";
import { feedbackPrompt, reactionMeaning, reactionNote } from "./agent/feedback.js";
import { fileNote, readAttachments, renderReadings, type AttachmentReading, type RenderedAttachments } from "./media/attachments.js";
import { FileShelf } from "./files/shelf.js";
import { describeImage } from "./agent/model.js";
import { checkIngress } from "./security/allowlist.js";
import { detectKillSwitchCommand, KillSwitch } from "./security/killswitch.js";
import { ConversationQueue, type RunControl } from "./security/queue.js";
import {
  ApprovalService,
  decisionFromReaction,
  isRevokeCommand,
  parseDecision,
  type Decision,
  type DecisionVia,
} from "./security/approvals.js";
import { activeGrantKeys, approvalStore } from "./db/approvals.js";
import { mailKeepStore } from "./db/mail-keep.js";
import { selftestTools } from "./agent/tools/selftest.js";
import { scheduleTools } from "./agent/tools/schedule.js";
import { overviewTools } from "./agent/tools/overview.js";
import { feedbackTools } from "./agent/tools/give-feedback.js";
import { missedReminderStore, scheduleStore } from "./db/schedules.js";
import { MissedReminders, reminderText } from "./scheduler/missed.js";
import { Scheduler } from "./scheduler/poller.js";
import type { ScheduleRow } from "./scheduler/store.js";
import { atWallTime, ownerDate, formatWallTime } from "./time.js";
import { cancelTaskTools, taskTools, type RunningTaskInfo } from "./agent/tools/task.js";
import { siteTaskTools } from "./agent/tools/site.js";
import { CodeRequests } from "./sites/codes.js";
import { SiteSessions } from "./sites/session.js";
import { serverVault } from "./sites/vault.js";
import { vaultFileRows, vaultRows } from "./db/vault.js";
import { executorTurnShape, runExecutorTask } from "./executor/run.js";
import type { Aside } from "./executor/tools.js";
import { renderPicks, type PickGroup } from "./executor/picks.js";
import { loadConfidentialGuard } from "./memory/confidential.js";
import type { ConfidentialGuard } from "./security/confidential.js";
import { tavilyProvider, type SearchProvider } from "./executor/search.js";
import { wrapDerived, wrapUntrusted } from "./security/untrusted.js";
import { socketSandbox, type Sandbox } from "./sandbox/client.js";
import { MEDIA_PLATFORM_LABEL, MEDIA_PROXY_SOCKET, mediaDownloadEnabled, mediaWatcher, type MediaWatcher } from "./media/watch.js";
import { startFilterProxy, type FilterProxy } from "./browser/proxy.js";
import { httpCompanion, trackedCompanion, type Companion } from "./companion/client.js";
import { jevBrowser, type WebBrowser } from "./browser/index.js";
import type { Screenshot } from "./browser/screenshot.js";
import { typesafeClient } from "./browser/typesafe.js";
import { pageUnsubscriber } from "./browser/unsubscribe.js";
import { macTools } from "./agent/tools/mac.js";
import { mailTools } from "./agent/tools/mail.js";
import { calendarTools } from "./agent/tools/calendar.js";
import { Integrations } from "./integrations/service.js";
import { parseSealKey } from "./integrations/seal.js";
import { connectServices, type ConnectedServices } from "./integrations/setup.js";
import { integrationState, integrationStore } from "./db/integrations.js";
import { closePg } from "./db/pg.js";
import { revokeGoogle } from "./google/client.js";
import type { GoogleSecret } from "./integrations/types.js";
import { MAIL_TRIGGER_TOOLS, MailTrigger } from "./mail/trigger.js";
import { calendarBusy, calendarCovers } from "./calendar/match.js";
import { CalendarRefs, type TaskPlace } from "./calendar/refs.js";
import { digestMail } from "./mail/digest.js";
import { mailItemStore, mailTriggerState } from "./db/mail-items.js";
import { sentMailStore } from "./db/mail-sent.js";
import { RoutedJudge } from "./agent/judge/index.js";
import { inProbation, sentToday } from "./proactive/heartbeat.js";
import { ProposalService } from "./memory/proposals.js";
import { deriveLesson } from "./memory/lesson.js";
import { procedureTools } from "./agent/tools/procedures.js";
import { BUDGET_QUESTION, BudgetMonitor, budgetStatus, openRouterRemaining } from "./budget.js";
import { monthSearches, recordSearch } from "./db/usage.js";
import {
  EXECUTOR_MAX_CONCURRENT,
  FEEDBACK_MAX_AGE_MS,
  MAX_SEARCHES_PER_MONTH,
  MESSAGE_DEBOUNCE_MS,
  MAIL_TURN_LIMITS,
  PROACTIVE_TURN_LIMITS,
  RECOVERY_MAX_AGE_MS,
  TYPING_HOLD_MS,
  TYPING_MAX_HOLD_MS,
  SITE_CODE_WAIT_MS,
  MAIL_SEND_MAX_FILE_BYTES,
  SCHEDULE_LATE_NOTE_MS,
  TASK_RESULT_RETRY_MS,
  TURN_RETRY_MS,
} from "./config/limits.js";
import { AuditSelftest } from "./health/audit-selftest.js";
import { auditProbe, selftestState } from "./db/audit-probe.js";
import {
  DEFAULT_TURN_LIMITS,
  Preemption,
  Steering,
  TurnState,
  refNote,
  type SteerContent,
  type SteerReport,
  type TurnLimits,
  type PendingPicks,
  type SourcePdf,
  type TurnProgress,
  type TurnOrigin,
  type TurnSetup,
} from "./agent/tools/types.js";
import { silenceTools } from "./agent/tools/silence.js";
import { HEARTBEAT_TOOLS, ProactiveHeartbeat } from "./proactive/heartbeat.js";
import { MAIL_SOURCE } from "./proactive/occasions.js";
import { calendarEvents, heartbeatSignals, heartbeatState } from "./db/proactive.js";
import { watchTools } from "./agent/tools/watch.js";
import { WATCH_TURN_TOOLS, WatchPoller } from "./watch/poller.js";
import { analyzeTools } from "./agent/tools/analyze.js";
import { computeTools } from "./agent/tools/compute.js";
import { calendarSource, DataSources, mailSource } from "./datasets/sources.js";
import { getDomain } from "tldts";
import { formTaskTools } from "./agent/tools/forms.js";
import { BrowseError, launchSession } from "./browser/session.js";
import { profileStore } from "./db/profile.js";
import { FormHolds } from "./forms/holds.js";
import { profileValues } from "./forms/profile.js";
import { FormFailure, openFormSession, type FormSession } from "./forms/session.js";
import type { FormOpener } from "./executor/run.js";
import type { Launched } from "./sites/session.js";
import { missionTools } from "./agent/tools/missions.js";
import { missionStore } from "./db/missions.js";
import { MissionBook } from "./missions/book.js";
import { voiceTools } from "./agent/tools/voice.js";
import { openRouterSpeech } from "./media/speech.js";
import { fileTools, type FilePort } from "./agent/tools/files.js";
import { vaultFileTools } from "./agent/tools/vault.js";
import { serverVaultFiles } from "./files/vault.js";
import { calendarSubject, IntegrationHealth, mailSubject, monitoredCalendar, setupSubject } from "./health/integrations.js";
import { connectorExpiryWarned, integrationIncidents } from "./db/integration-health.js";
import { watcherStore, watchPollerState } from "./db/watchers.js";
import { contactsSource, ownMessagesSource } from "./mail/recipients.js";
import { OutboundGate } from "./outbound.js";
import { claimFirstMessage, helloMessage } from "./hello.js";
import { BudgetExceededError, closeWarmPool, prewarmTurn, type ChatTurn, type TurnShape, type WarmSlot } from "./agent/model.js";
import { runTurn as runAgentTurn, type TurnOutcome } from "./agent/turn.js";
import { messagingTools, type MessagePort } from "./agent/tools/messaging.js";
import { ToolRegistry } from "./agent/tools/registry.js";
import { systemPrompt, turnContext } from "./agent/prompt.js";
import { claimBudgetWarnings } from "./budget.js";
import { memoryTools } from "./agent/tools/memory.js";
import { historyTools } from "./agent/tools/history.js";
import {
  afterMemory,
  afterTurn,
  buildMemoryContext,
  maybeClassifyAreas,
  maybeConsolidate,
  defaultMemoryDeps,
  markQuestionShown,
  renderMemory,
  type MemoryContext,
} from "./memory/index.js";
import { EMPTY_CONTEXT } from "./memory/recall.js";
import { log } from "./log.js";
import { ConnectorService } from "./connectors/service.js";
import { connectorDrivers } from "./connectors/drivers/index.js";
import { connectorInfo } from "./connectors/catalog.js";
import { connectorStore } from "./db/connectors.js";
import { loadVaultKey } from "./vault/sealbox.js";
import { startHeartbeat, type Heartbeat } from "./health/heartbeat.js";
import { markPlannedStop } from "./health/status.js";
import { recordComponentStatus } from "./health/status.js";
import { beginWork, withWork } from "./health/work.js";
import { recoveryStore } from "./db/recovery.js";
import {
  interruptedApprovalPrompt,
  interruptedTaskPrompt,
  interruptedTaskReport,
  recoveredNote,
  retriedNote,
  undeliveredNote,
  restoreInbound,
  type PendingInbound,
  type RunningTask,
} from "./recovery/index.js";
import type { ApprovalRow } from "./security/approvals.js";
import { parseLater, type LaterParse } from "./security/later.js";
import { t, textLanguage } from "./i18n/catalog.js";
import { currentLanguage, currentLocale, loadOwnerLanguage, observeOwnerText } from "./i18n/language.js";
import { security } from "./i18n/messages/security.js";
import { primaryWord } from "./i18n/words.js";
import { describeGrant } from "./agent/tools/grants.js";
import { core } from "./i18n/messages/core.js";

/** Messages within this window are bundled into one turn (D50). */
const DEBOUNCE_MS = MESSAGE_DEBOUNCE_MS;
/**
 * This much history goes into the model per turn. A small context is budget
 * policy (D3). The same number decides when messages fall out of the window and
 * so have to be summarised, which is why it lives in the memory config.
 */
const HISTORY_LIMIT = MEMORY.historyLimit;

interface QueuedMessage {
  kind: "message";
  inbound: InboundMessage;
  storedId: string;
  /** Arrival at the adapter (ms since epoch): the window runs from here, and latency is measured against it (D50). */
  arrivedAt: number;
  /** Caught up after a crash (D52): what the turn needs to know about it. */
  recovered?: string;
  /**
   * Came into a running turn that did not see it any more (D57), and so runs
   * as a turn of its own: what that turn needs to know. Never the owner's word.
   */
  returned?: string;
  /**
   * Follow-up turn (addendum D8.4 of 2026-10-08): the turn on this message read
   * foreign content and was no longer allowed a tool afterwards. What the clean
   * turn needs to know about it. Never the owner's word.
   */
  followUp?: string;
  /**
   * Second run (addendum D52 of 2026-10-10): the first turn on this message
   * failed before it had done anything with an effect. What the turn needs to
   * know about it. Never the owner's word. There is no third run.
   */
  retried?: string;
}

/** Messages whose turn failed and that wait for their second run (addendum D52 of 2026-10-10). */
interface TurnRetry {
  items: QueuedMessage[];
  dueAt: number;
  timer: NodeJS.Timeout;
}

/**
 * A turn that no message from the owner triggered: the result of a confirmed
 * tool, a due appointment, the heartbeat. Runs through the same queue as the
 * owner's messages, so nothing overtakes anything.
 */
export interface TurnEvent {
  kind: "event";
  origin: Exclude<TurnOrigin, "owner_message">;
  /** What the model reads as the trigger. Worded by Serain itself, never raw from outside. */
  incoming: string;
  /**
   * What memory searches for, if not `incoming`. When the trigger is mostly
   * instruction, full-text search finds nothing (all words must match) and the
   * embedding gets diluted: the mail turn of 2026-10-13 did not see the tax
   * advisor although memory had them (addendum D33).
   */
  recallQuery?: string;
  /** Target for reply_in_thread. Empty when there is no matching message. */
  triggerExternalId: string;
  triggerMessageId: string;
  taintSources?: string[];
  /**
   * Short version for when the event falls into a turn with a message of the
   * owner's own (W24): a 👎 followed by "actually meant …" is one turn, not
   * two.
   */
  note?: string;
  /** Narrow toolbox and own limits, e.g. for the heartbeat (D9). */
  toolNames?: readonly string[];
  limits?: TurnLimits;
  /**
   * Who triggered the turn, when the origin alone does not say: the mail
   * trigger and watchers are both `untrusted` but count against different
   * daily caps (D33, D43).
   */
  source?: "mail" | "watch";
  /** Result of this task (D52): only when the turn is through is the task done. */
  taskId?: string;
  /** Pages the executor opened: Serain may pass on links to them (addendum D8.4 of 2026-10-08). */
  openedPages?: string[];
  /** Screenshots from the task, in memory only (addendum D48 of 2026-10-08). */
  screenshots?: Screenshot[];
  /** The list to choose from out of the task, built by the code (addendum D61 of 2026-10-09). */
  picks?: PendingPicks;
  /** PDFs the executor read, in memory only. */
  documents?: SourcePdf[];
  /**
   * The owner is waiting for this turn: the result of their task, even an
   * empty one. The turn may not end silently, and if still no message reaches
   * the owner (model silent, turn fails), the code sends this sentence.
   */
  owedReport?: string;
  /**
   * The task behind a result turn. If the turn fails before it has done
   * anything, it runs once more after `TASK_RESULT_RETRY_MS`
   * (`retryTaskResult`); `retried` means that was already the second run.
   */
  task?: { text: string; site?: string; retried: boolean };
}

/** What the result turn of a task gets besides the lines. Without a report, only what links prove counts. */
interface TaskResultParts {
  sources: string[];
  opened: string[];
  /** Did a report come? Decides what goes along and what the code says when the turn itself sends nothing. */
  reported: boolean;
  screenshots?: Screenshot[];
  picks?: PickGroup;
  documents?: SourcePdf[];
  asides?: Aside[];
  actUrl?: string | null;
}

type QueuedItem = QueuedMessage | TurnEvent;

/** What a crash left behind, read before the channel starts (D52). */
interface Leftover {
  messages: PendingInbound[];
  tasks: RunningTask[];
  approvals: ApprovalRow[];
}

/** A turn that reports something cut off says so and nothing else: no new task, no effect. */
const RECOVERY_REPORT_TOOLS = ["reply_in_thread", "send_message", "end_turn"] as const;

/**
 * The turn flow. Order is safety: allowlist, then persistence and dedupe, then
 * the kill switch, and only after that may any model see anything.
 */
export class Runtime {
  private readonly killSwitch = new KillSwitch();
  private readonly outbound: OutboundGate;
  private readonly queue: ConversationQueue<QueuedItem>;
  private readonly approvals: ApprovalService;
  private readonly tools: ToolRegistry;
  private readonly port: MessagePort;
  private readonly memory = defaultMemoryDeps();
  /** Keeps running after the reply. A shutdown waits for it instead of cutting it off. */
  private readonly pending = new Set<Promise<void>>();
  private heartbeat: Heartbeat | null = null;
  private readonly scheduler: Scheduler;
  private readonly auditSelftest: AuditSelftest;
  private readonly proactive: ProactiveHeartbeat;
  /** Budget state in memory: context line, throttling of heartbeat and overview (addendum D3 of 2026-10-08). */
  private readonly budget = new BudgetMonitor({ status: budgetStatus, openRouterLeft: openRouterRemaining });
  /** Watchers without a model (H2, D43). */
  private readonly watch: WatchPoller;
  /** Report broken access and expiring grants instead of staying silent (audit 2026-10-05). */
  private readonly integrationHealth: IntegrationHealth;
  /** Proposals the owner confirms: lessons from 👎 and approved procedures (V5, H5, D42). */
  private readonly proposals: ProposalService;
  /** Messages whose 👎 or ❓ already got a turn: one per message and meaning. */
  private readonly feedbackSeen = new Set<string>();
  /** Set while the queue has a turn running or waiting (src/health/work.ts). */
  private endTurnWork: (() => void) | null = null;
  /** Running background tasks, each with its cancel (kill switch, shutdown). */
  private readonly tasks = new Set<() => void>();
  /** The same tasks with number and text, for `cancel_task`. Attachments are only in `tasks`. */
  private readonly runningTasks = new Map<string, RunningTaskInfo & { cancel: () => void; byOwner: boolean }>();
  private taskSeq = 0;
  /** Result turns waiting for their second run, each with its cancel (kill switch, shutdown). */
  private readonly resultRetries = new Set<() => void>();
  /**
   * The owner's messages whose turn failed and that run once more after
   * `TURN_RETRY_MS` (addendum D52 of 2026-10-10). At most one group: if the
   * owner writes before, their turn takes them along (`runBatch`). They stay
   * `pending`; a restart finds them again through `turn_retry` in the audit log.
   */
  private turnRetry: TurnRetry | null = null;
  /** A cancel on shutdown is no stop by the owner: the task stays `running` and is reported at start (D52). */
  private stopping = false;
  private readonly search: SearchProvider | null = env.tavilyApiKey
    ? tavilyProvider(env.tavilyApiKey)
    : null;
  /** No helper socket, no sandbox, and without a sandbox neither `run_code` nor attachments (D20). */
  private readonly sandbox: Sandbox | null = env.sandboxSocket ? socketSandbox(env.sandboxSocket) : null;

  /** Since when the Mac was unreachable at the last attempt; null if it was reachable or never asked. */
  private macOfflineSince: number | null = null;

  /** No port and token, no Mac companion, and without it neither `mac_*` nor `mac_browser` (D28). */
  private readonly companion: Companion | null =
    env.companionPort !== null && env.companionToken.length >= 32
      ? trackedCompanion(httpCompanion({ port: env.companionPort, token: env.companionToken }), (reachable) => {
          this.macOfflineSince = reachable ? null : (this.macOfflineSince ?? Date.now());
        })
      : null;

  /** No `SERAIN_INTEGRATION_KEY`, no integrations: nothing could be opened (D30). */
  private readonly integrations = new Integrations(
    integrationStore,
    env.integrationKey ? parseSealKey(env.integrationKey) : null,
    { google: (secret) => revokeGoogle(secret as GoogleSecret) },
  );
  /** Connected mailboxes and calendars, filled in `start()`. */
  private services: ConnectedServices = { mail: [], calendar: null, calendarId: null };
  /** Exists only with a connected mailbox (D33). */
  private mailTrigger: MailTrigger | null = null;

  /**
   * Attachments read per message (D21, D50). A superseded turn may already have
   * read them; its successor takes the same result instead of transcribing a
   * voice message twice.
   */
  private readonly readings = new Map<string, Promise<AttachmentReading[]>>();

  /** Files the owner sent, for attaching to a mail (addendum D34 of 2026-10-08). In memory only. */
  private readonly files = new FileShelf();
  /** Own data for `analyze_data` (D63, building block D): mailboxes, calendars, connected services. */
  private readonly dataSources = new DataSources();
  /** Missions over days (D63, building block B), woken through `schedules`. */
  private readonly missions = new MissionBook({ store: missionStore, schedules: scheduleStore });

  /**
   * Watching videos (D61), set in `start()`. YouTube needs only OpenRouter;
   * TikTok, Instagram and X download in the sandbox through the filter proxy on
   * a Unix socket that only `media_fetch` gets handed in.
   */
  private media: MediaWatcher | null = null;
  private mediaProxy: FilterProxy | null = null;

  /** No Chrome and Typesafe key, no `web_browse` (D35). */
  private readonly browser: WebBrowser | null =
    env.typesafeApiKey && env.chromePath
      ? jevBrowser({
          apiKey: env.typesafeApiKey,
          chromePath: env.chromePath,
        })
      : null;

  /**
   * Codes a login is waiting for (D56). The question to the owner is written
   * by the code; `onInbound` intercepts their answer before it is stored.
   */
  private readonly codes = new CodeRequests({
    ask: (site) =>
      this.outbound.sendToOwner(
        t(core.codeRequest, { site, minutes: Math.round(SITE_CODE_WAIT_MS / 60_000) }),
        { kind: "site_code_request", site },
      ),
  });

  /** No vault key and Chrome, no logged-in sessions (D36, D49). */
  private readonly sites: SiteSessions | null =
    env.vaultKey && env.chromePath
      ? new SiteSessions({
          vault: serverVault(vaultRows, env.vaultKey),
          profilesDir: join(env.dataDir, "site-profiles"),
          chromePath: env.chromePath,
          askCode: (site, cancelled) => this.codes.request(site, cancelled),
        })
      : null;

  /** Filled-in forms waiting for the owner's 👍 (D63, building block C); in memory only. */
  private readonly formHolds = new FormHolds();
  /** Web forms need Chrome on the server; logged-in ones the vault as well (D63, building block C). */
  private readonly forms: FormOpener | null = env.chromePath
    ? { holds: this.formHolds, open: (target, cancelled) => this.openForm(target, cancelled) }
    : null;

  /**
   * Connections from the web interface (D51). Needs both keys: the browser
   * seals the way back to the vault key, tokens are sealed with the
   * integration key.
   */
  private readonly connectors: ConnectorService | null;

  constructor(private readonly channel: Channel) {
    this.outbound = new OutboundGate(channel, env.ownerPhone);
    this.queue = new ConversationQueue<QueuedItem>({
      debounceMs: DEBOUNCE_MS,
      maxHoldMs: TYPING_MAX_HOLD_MS,
      run: (batch, _key, control) => this.runBatch(batch, control),
      // Nobody pushes events back: the result of a task waits for no window.
      // A 👎 does, the owner's words about it often follow (W24).
      immediate: (item) => item.kind === "event" && item.origin !== "owner_reaction",
      // Only the owner's messages supersede a running turn (D50).
      preempts: (item) => item.kind === "message",
      // From the first waiting entry to the last turn: the window and the step from
      // task to result turn are work a restart would cut off too.
      onBusy: (busy) => {
        if (busy) this.endTurnWork ??= beginWork("turn");
        else {
          this.endTurnWork?.();
          this.endTurnWork = null;
        }
      },
    });
    // Confirmation protocol (D8.3, D14). The preview goes through the same
    // OutboundGate as everything else; the registry only knows the gate interface.
    this.approvals = new ApprovalService({
      store: approvalStore,
      sendPreview: (text, taintSources) =>
        this.outbound.sendToOwnerWithReceipt(
          text,
          { kind: "approval_preview" },
          { allowDuplicate: true, singleBubble: true, taintSources },
        ),
      // The file in the thread below the preview (addendum D34 of 2026-10-08). A preview may
      // repeat itself, so the file below it may too.
      sendPreviewFile: async (file, previewExternalId, taintSources) =>
        (
          await this.outbound.sendFileToOwner(
            file,
            "below the preview",
            { kind: "approval_preview_file" },
            { replyTo: previewExternalId, allowDuplicate: true, maxBytes: MAIL_SEND_MAX_FILE_BYTES, taintSources },
          )
        )?.externalId ?? null,
      // "yes, but tomorrow at 8" (addendum D14 of 2026-10-08): whether a tool may run later, it says itself.
      later: (tool) => this.tools.laterSpec(tool),
      // A 👍 on an expired preview issues it afresh (addendum D8 of 2026-10-10), with its origin.
      definition: (tool) => this.tools.definition(tool),
      previewTaint: async (previewExternalId) => {
        const preview = await findOutbound(env.ownerPhone, previewExternalId);
        return preview ? (preview.taint_sources ?? []) : ["preview of unknown origin"];
      },
    });
    // The kill switch also applies to a turn already under way (D8.2): the
    // registry asks before every tool. `engaged` is this process's state, set
    // the moment "serain stop" arrives.
    this.tools = new ToolRegistry(this.approvals, () => this.killSwitch.engaged);
    // The tools only know this port, the port only the OutboundGate. So the
    // gate stays the only way out, for the model too.
    this.port = {
      canReact: channel.capabilities.reactions,
      canReplyInThread: channel.capabilities.replyThreads,
      canUseEffects: channel.capabilities.effects,
      send: async (text, opts) => {
        const outcome = await this.outbound.trySendToOwner(
          text,
          { kind: opts.kind, ...(opts.origin ? { origin: opts.origin } : {}) },
          {
            ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }),
            taintSources: opts.taintSources,
            ...(opts.effect ? { effect: opts.effect } : {}),
            ...(opts.editable ? { editable: true } : {}),
            ...(opts.verbatim ? { verbatim: true } : {}),
          },
        );
        if (outcome.status !== "duplicate" && outcome.undelivered) opts.onUndelivered?.();
        return outcome.status === "sent";
      },
      react: (messageId, emoji) => this.outbound.react(messageId, emoji),
      ...(channel.capabilities.richLinks
        ? {
            sendLink: async (url: string, opts: { replyTo?: string; origin?: TurnOrigin; taintSources: readonly string[] }) =>
              (await this.outbound.sendLinkToOwner(
                url,
                { kind: "link_preview", ...(opts.origin ? { origin: opts.origin } : {}) },
                {
                  ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }),
                  taintSources: opts.taintSources,
                },
              )) !== null,
          }
        : {}),
      ...(channel.capabilities.edit
        ? {
            edit: (find: string, text: string) => this.outbound.editOwn(find, text, { kind: "edit_message" }),
          }
        : {}),
    };
    this.tools.registerAll(messagingTools(this.port));
    // Files to the owner (.ics, vCard, PDF), only if the channel can send them.
    const filePort: FilePort | null = channel.capabilities.files
      ? {
          sendFile: (file, caption, opts) =>
            this.outbound
              .sendFileToOwner(
                file,
                caption,
                { kind: opts.kind, origin: opts.origin },
                {
                  taintSources: opts.taintSources,
                  ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
                  ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }),
                },
              )
              .then((receipt) => receipt !== null),
        }
      : null;
    this.tools.registerAll(fileTools(filePort));
    // Files from the vault (addendum D49 of 2026-10-08): only the chat, never the executor, only with the vault key.
    if (env.vaultKey) {
      this.tools.registerAll(vaultFileTools({ files: serverVaultFiles(vaultFileRows, env.vaultKey), shelf: this.files, port: filePort }));
    }
    // Voice messages to the owner (D59): spoken in the sandbox, only if the channel can do real voice messages.
    this.tools.registerAll(
      voiceTools({
        sandbox: this.sandbox,
        port: filePort,
        canSend: channel.capabilities.voice,
        // Fish Audio through OpenRouter with ZDR (addendum D59, approved 2026-10-08), Piper as the fallback.
        remote: openRouterSpeech(),
        confidential: () => loadConfidentialGuard(this.memory),
      }),
    );
    // Computing in the chat (D58): the same sandbox as run_code for the executor, with the owner's files from the shelf.
    this.tools.registerAll(computeTools({ sandbox: this.sandbox, shelf: this.files }));
    // Analysing own data (D63, building block D): the same sandbox, the sources come with the integrations.
    this.tools.registerAll(analyzeTools({ sandbox: this.sandbox, sources: this.dataSources }));
    // Memory on request (W6) and real forgetting (W7). Both at level
    // write_reversible, reasoning in D12.
    this.tools.registerAll(memoryTools({ memory: this.memory, port: this.port }));
    // History search (V3, D41): the owner's whole chat, not just the last 20 messages.
    this.tools.registerAll(historyTools({ memory: this.memory, ownerPhone: env.ownerPhone }));
    // Proposals go out the same way as previews: one bubble, because 👍 and a
    // thread reply hang on its channel id, and also word for word, because two
    // identical questions are two questions (D14, D42).
    this.proposals = new ProposalService({
      memory: this.memory,
      deriveLesson,
      send: (text, kind, taintSources) =>
        this.outbound.sendToOwnerWithReceipt(text, { kind }, { allowDuplicate: true, singleBubble: true, taintSources }),
      acknowledge: async (externalId, fallbackText) =>
        void (await this.outbound.acknowledge(externalId, fallbackText, { kind: "proposal_ack" })),
      paused: async () => (await this.killSwitch.load()).engaged,
      lastMessageAt: () => heartbeatSignals.lastMessageAt(),
      sentToday: async () => sentToday(await heartbeatState.load(), new Date()),
      recordSent: () => this.proactive.recordSent(1),
    });
    this.tools.registerAll(procedureTools({ memory: this.memory, proposals: this.proposals }));
    this.tools.registerAll(selftestTools());
    this.tools.registerAll(
      scheduleTools({
        store: scheduleStore,
        cancelApproval: async (id, messageId) => (await this.approvals.cancelScheduled(id, "cancel_schedule", messageId || null)) !== null,
        // Busy times from the heartbeat's interim state; that is created further down, hence a function.
        busyAt: (at) => this.proactive.busyAt(at),
      }),
    );
    // Missions over days (D63, building block B): goal only from the owner's message, woken through the scheduler.
    this.tools.registerAll(missionTools({ book: this.missions }));
    // What Serain lacks, as a list for the owner in the web interface (package 2 of 2026-10-08).
    this.tools.registerAll(feedbackTools({ countToday: () => countAuditSince("feedback", atWallTime(ownerDate(new Date()), 0, 0)) }));
    // What runs in the background, in one overview (package 2 of 2026-10-08). The heartbeat is created further down,
    // hence a function.
    this.tools.registerAll(
      overviewTools({
        schedules: scheduleStore,
        watchers: watcherStore,
        approvals: this.approvals,
        tasks: () => this.runningTaskInfos(),
        morning: () => this.proactive.morningOutlook(),
        paused: async () => (await this.killSwitch.load()).engaged,
        throttled: () => this.budget.throttled(),
        missions: () => this.missions.list(),
      }),
    );
    const search = this.search;
    this.tools.registerAll(
      watchTools({
        store: watcherStore,
        confidential: () => loadConfidentialGuard(this.memory),
        // The same quota as `web_search`, booked before the call.
        ...(search
          ? {
              findPages: async (host: string, query: string) => {
                if ((await monthSearches()) >= MAX_SEARCHES_PER_MONTH) return [];
                await recordSearch(search.name);
                return (await search.search(query, { domains: [host.replace(/^www\./, "")] })).map((hit) => hit.url);
              },
            }
          : {}),
      }),
    );
    this.tools.registerAll(silenceTools());
    if (this.companion) {
      this.tools.registerAll(macTools(this.companion));
    }
    if (this.sites) {
      // Logged-in sessions (D36, D49). Whether the vault knows the site shows at the call.
      this.tools.registerAll(
        siteTaskTools({
          sites: this.sites,
          port: this.port,
          confidential: () => loadConfidentialGuard(this.memory),
          tasks: { precondition: () => this.taskBlocker(), start: (request) => this.track(this.runTask(request)) },
        }),
      );
    }
    // Web forms (D63, building block C): fill in with a preview, submit with a second preview from the page.
    if (this.forms) {
      this.tools.registerAll(
        formTaskTools({
          profile: profileStore,
          defaults: () => this.formDefaults(),
          holds: this.formHolds,
          sites: this.sites ?? { list: async () => [] },
          confidential: () => loadConfidentialGuard(this.memory),
          tasks: { precondition: () => this.taskBlocker(), start: (request) => this.track(this.runTask(request)) },
        }),
      );
    }
    this.tools.registerAll(
      taskTools({
        port: this.port,
        confidential: () => loadConfidentialGuard(this.memory),
        tasks: {
          precondition: () => this.taskBlocker(),
          start: (request) => this.track(this.runTask(request)),
        },
      }),
    );
    this.tools.registerAll(
      cancelTaskTools({
        running: () => this.runningTaskInfos(),
        cancel: (id) => {
          const entry = this.runningTasks.get(id);
          if (!entry) return false;
          entry.byOwner = true;
          entry.cancel();
          return true;
        },
      }),
    );

    const vaultKey = env.vaultKey;
    this.connectors =
      env.integrationKey && vaultKey
        ? new ConnectorService({
            store: connectorStore,
            sealKey: parseSealKey(env.integrationKey),
            vaultKey: (() => {
              let key: ReturnType<typeof loadVaultKey> | null = null;
              return () => (key ??= loadVaultKey(vaultKey));
            })(),
            // The same list the fuzz harness checks (test/fuzz/connectors.test.ts).
            drivers: (clients) =>
              connectorDrivers({
                clients,
                enableBanking:
                  env.enableBankingAppId && env.enableBankingKey && env.enableBankingBank
                    ? {
                        // The name Enable Banking lists the bank under (`pnpm connector bank-check`).
                        aspsp: { name: env.enableBankingBank, country: env.enableBankingCountry },
                        appId: env.enableBankingAppId,
                        privateKey: Buffer.from(env.enableBankingKey, "base64").toString("utf8"),
                      }
                    : null,
              }),
            tools: {
              add: (defs) => void this.tools.registerAll(defs),
              remove: (names) => this.tools.unregister(names),
            },
            data: this.dataSources,
            // New tools, new prompt: the waiting process no longer fits (D50).
            onChange: () => this.prewarmChat(),
          })
        : null;

    this.scheduler = new Scheduler({
      store: scheduleStore,
      // The kill switch stops the scheduler too (D8.2). Fresh from the DB, as for
      // every inbound message.
      paused: async () => (await this.killSwitch.load()).engaged,
      deliver: (row, lateNote) => this.deliverSchedule(row, lateNote),
      // What failed for good follows after the next success at the channel (D15, addendum 2026-10-10).
      missed: new MissedReminders({
        store: missedReminderStore,
        lastDelivered: () => this.outbound.lastDeliveredAt(),
        send: async (text, entry) =>
          (await this.outbound.trySendToOwner(text, { kind: "reminder", schedule_id: entry.scheduleId, missed: true }, { taintSources: entry.taintSources }))
            .status,
      }),
      housekeeping: async () => {
        // Fresh from the DB once per round (D8.2); the steps below check this
        // state (`killSwitch.engaged`) instead of each reading it on its own.
        // What is due for later checks once more by itself (`paused` above).
        await this.killSwitch.load();
        await this.approvals.expireDue();
        await this.runDueApprovals();
        await this.auditSelftest.maybeRun();
        await this.proactive.maybeRun();
        await this.mailTrigger?.maybeRun();
        // After the mail trigger: mail hits from this round go out in the same tick.
        await this.watch.maybeRun();
        await this.integrationHealth.maybeRun();
        await this.consolidateMemory();
        await this.classifyMemoryAreas();
        await this.proposals.maybeOffer();
      },
    });
    this.proactive = new ProactiveHeartbeat({
      state: heartbeatState,
      // The calendar is only connected in start(): hence a function, read on
      // every call. The Mac counts too while it is awake (V4, D46).
      signals: { ...heartbeatSignals, upcomingEvents: calendarEvents(() => this.services.calendar, () => this.companion) },
      // In the scheduler's tick: the state of this round (housekeeping).
      paused: async () => this.killSwitch.engaged,
      throttled: () => this.budget.throttled(),
      fire: (incoming, taintSources) =>
        this.queue.submit(env.ownerPhone, {
          kind: "event",
          origin: "heartbeat",
          incoming,
          triggerExternalId: "",
          triggerMessageId: "",
          // Event titles and acceptances are foreign content (D8.4, D46).
          ...(taintSources.length > 0 ? { taintSources } : {}),
          toolNames: HEARTBEAT_TOOLS,
          limits: PROACTIVE_TURN_LIMITS,
        }),
    });
    this.watch = new WatchPoller({
      store: watcherStore,
      state: watchPollerState,
      // In the scheduler's tick: the state of this round (housekeeping).
      paused: async () => this.killSwitch.engaged,
      confidential: () => loadConfidentialGuard(this.memory),
      fire: (incoming, taintSources, openedPages) =>
        this.queue.submit(env.ownerPhone, {
          kind: "event",
          origin: "untrusted",
          incoming,
          triggerExternalId: "",
          triggerMessageId: "",
          taintSources,
          // Only the page the poller loaded for the hit (addendum D48 of 2026-10-10).
          ...(openedPages.length > 0 ? { openedPages } : {}),
          toolNames: WATCH_TURN_TOOLS,
          limits: PROACTIVE_TURN_LIMITS,
          source: "watch",
        }),
    });
    this.integrationHealth = new IntegrationHealth({
      send: (text, context, options) => this.outbound.sendToOwner(text, context, options?.verbatim ? { verbatim: true } : {}),
      incidents: integrationIncidents,
      connectors: async () =>
        (await connectorStore.connected()).map((row) => {
          const info = connectorInfo(row.id);
          return { id: row.id, name: info?.name ?? row.id, ...(info?.grantName ? { grantName: info.grantName } : {}), expiresAt: row.expiresAt };
        }),
      expiryWarned: connectorExpiryWarned,
      // In the scheduler's tick: the state of this round (housekeeping).
      paused: async () => this.killSwitch.engaged,
    });
    this.auditSelftest = new AuditSelftest({
      probe: auditProbe,
      state: selftestState,
      alert: async (text) => void (await this.outbound.sendToOwner(text, { kind: "audit_selftest" })),
    });
  }

  async start(): Promise<void> {
    // The owner's language (src/i18n/language.ts) before anything can write to them; it never throws.
    await Promise.all([this.killSwitch.load(), loadOwnerLanguage()]);
    await this.budget.refresh();
    await this.setupIntegrations();
    await this.connectors?.start().catch(async (error: unknown) => {
      log.error("Connections not loaded, Serain runs without them:", error);
      await audit("error", { stage: "connector_setup", reason: (error as Error).message });
    });
    // Before the channel: whatever is `pending` now, an earlier process left
    // behind. Messages stored after this belong to this one (D52).
    const leftover = await this.leftoverWork();
    // What the previous process just sent does not go out again right away.
    await this.outbound.restoreRecent();
    // From arrival to the queue it is not a turn yet, but already work: storing and checking take time.
    this.channel.onInbound((message) => withWork("inbound", () => this.onInbound(message)));
    this.channel.onReaction((reaction) => withWork("inbound", () => this.onReaction(reaction)));
    this.channel.onTyping?.((typing) => this.onTyping(typing));
    await this.channel.start();
    await this.channel.waitUntilConnected(30_000);
    this.heartbeat = startHeartbeat(this.channel, this.outbound);
    await this.scheduler.start();
    // After the scheduler: what ran as a wake-up at the crash it has ticked off; a mission without a look gets one here (D63).
    await this.missions.load().catch(async (error: unknown) => {
      log.error("Missions not loaded; wake-ups ask by themselves:", error);
      await audit("error", { stage: "missions_load", reason: (error as Error).message });
    });
    // Before prewarming: whether `media_watch` exists is part of the executor's shape.
    await this.setupMedia();
    // Prewarmed (D50): the first turn after the start waits for no process start.
    this.prewarmChat();
    prewarmTurn("executor", executorTurnShape(this.executorDeps()), { sticky: true });
    await audit("startup", {
      channel: this.channel.name,
      echo_only: env.echoOnly,
      kill_switch: this.killSwitch.engaged,
    });
    await this.resume(leftover);

    // The introduction goes out exactly once, never on every start (W2).
    if (await claimFirstMessage(env.ownerPhone)) {
      const sent = await this.outbound.sendToOwner(helloMessage(), { kind: "hello" });
      await audit("hello", { sent });
    }
  }

  /**
   * What a crash left behind (D52). Read before the channel takes anything new;
   * confirmations that were running get booked as failed on the way. If the
   * database is down, Serain starts without: better one lost reply than none at
   * all any more.
   */
  private async leftoverWork(): Promise<Leftover> {
    const failed = (stage: string) => async (error: unknown) => {
      await audit("error", { stage, reason: (error as Error).message });
      log.error("Leftovers not readable:", error);
      return [];
    };
    const [messages, tasks, approvals] = await Promise.all([
      recoveryStore.pendingInbound(env.ownerPhone).catch(failed("recover_messages")),
      recoveryStore.runningTasks().catch(failed("recover_tasks")),
      this.approvals.failInterrupted().catch(failed("recover_approvals")),
    ]);
    return { messages, tasks, approvals };
  }

  /**
   * Reports what is not caught up, and catches up the owner's messages (D52).
   * Reports first, then messages: so the history of the caught-up turn already
   * shows what was cut off.
   */
  private async resume({ messages, tasks, approvals }: Leftover): Promise<void> {
    for (const approval of approvals) {
      const preview = await findOutbound(env.ownerPhone, approval.previewExternalId).catch(() => null);
      this.queue.submit(env.ownerPhone, {
        kind: "event",
        origin: "approval",
        incoming: interruptedApprovalPrompt(approval),
        triggerExternalId: approval.previewExternalId,
        triggerMessageId: approval.requestMessageId ?? "",
        // As at execution itself: without a readable origin the preview counts as foreign.
        taintSources: preview ? (preview.taint_sources ?? []) : ["preview of unknown origin"],
        toolNames: RECOVERY_REPORT_TOOLS,
      });
    }

    for (const task of tasks) {
      try {
        if (!(await recoveryStore.interruptTask(task.id))) continue;
      } catch (error) {
        await audit("error", { stage: "recover_task", reason: (error as Error).message });
        log.error("Interrupted task not booked:", error);
        continue;
      }
      await audit("task_interrupted", { started_at: task.startedAt, ...(task.site ? { site: task.site } : {}) }, task.triggerMessageId ?? undefined);
      await this.settleTaskAck(task, "failed");
      this.queue.submit(env.ownerPhone, {
        kind: "event",
        origin: "task",
        incoming: interruptedTaskPrompt(task),
        triggerExternalId: task.triggerExternalId,
        triggerMessageId: task.triggerMessageId ?? "",
        toolNames: RECOVERY_REPORT_TOOLS,
        owedReport: interruptedTaskReport(task),
      });
    }

    const oldest = Date.now() - RECOVERY_MAX_AGE_MS;
    const stale = messages.filter((row) => Date.parse(row.createdAt) < oldest);
    if (stale.length > 0) {
      await recoveryStore
        .abandonInbound(stale.map((row) => row.id))
        .then(() => audit("turn_abandoned", { count: stale.length, oldest: stale[0]?.createdAt }))
        .catch((error: unknown) => log.error("Old messages not abandoned:", error));
    }
    const fresh = messages.filter((row) => Date.parse(row.createdAt) >= oldest).map((row) => row.id);
    const [actions, retries] = await Promise.all([this.actionsFor(fresh), this.turnRetriesFor(fresh)]);
    for (const row of messages) {
      if (Date.parse(row.createdAt) < oldest) continue;
      const { message, readings } = restoreInbound(row);
      // The same door as the first time: what is not from the owner does not get through.
      const verdict = checkIngress(message, env.ownerPhone);
      if (!verdict.allowed) {
        await recoveryStore.abandonInbound([row.id]).catch(() => undefined);
        await audit("turn_abandoned", { reason: verdict.reason }, row.id);
        continue;
      }
      if (readings) {
        this.readings.set(row.id, Promise.resolve(readings));
        setTimeout(() => this.readings.delete(row.id), 10 * 60_000).unref();
      }
      // Was waiting for its second run (addendum D52 of 2026-10-10): that comes at the same time as without
      // a restart, and only once. If it was already running when the crash came, this is just a catch-up.
      const retry = retries.get(row.id);
      const done = actions.get(row.id) ?? [];
      if (retry && !retry.ran) {
        await audit("turn_retry", { stage: "recovered", due_at: retry.dueAt }, row.id);
        // Parked at once, not after the loop: a caught-up turn further down then takes it along.
        // If only the reply did not arrive, the first run already had an effect: then with what it did.
        const note = retry.undelivered ? undeliveredNote(message.receivedAt, renderActions(done)) : retriedNote(message.receivedAt);
        this.parkTurnRetry([{ kind: "message", inbound: message, storedId: row.id, arrivedAt: Date.now(), retried: note }], Date.parse(retry.dueAt));
        continue;
      }
      await audit("turn_recovered", { received_at: row.createdAt, actions: done.length }, row.id);
      await this.admit(message, {
        peer: verdict.from,
        storedId: row.id,
        arrivedAt: Date.now(),
        recovered: recoveredNote(message.receivedAt, renderActions(done)),
      });
    }
  }

  /** Turn done (D52). If that fails, the next start catches the message up once more: loudly, not silently. */
  private async settleInbound(ids: readonly string[]): Promise<void> {
    await recoveryStore.settleInbound(ids).catch(async (error: unknown) => {
      await audit("error", { stage: "settle_inbound", reason: (error as Error).message });
      log.error("Turn not booked as done:", error);
    });
  }

  /**
   * Access to services and their tools (D30). If that fails, Serain starts
   * without: a mailbox that cannot be reached should not take the chat down too.
   */
  private async setupIntegrations(): Promise<void> {
    try {
      this.services = await connectServices(this.integrations, (id, error) => this.integrationHealth.record(setupSubject(id), false, error));
    } catch (error) {
      await audit("error", { stage: "integration_setup", reason: (error as Error).message });
      log.error("Integrations not loaded, Serain runs without them:", error);
      return;
    }
    if (this.services.calendar) {
      // Every look at the calendar counts, the heartbeat's too: otherwise a failure there would never show.
      const subject = calendarSubject(this.services.calendarId);
      this.services.calendar = monitoredCalendar(this.services.calendar, (ok, error) => this.integrationHealth.record(subject, ok, error));
      // The calendars to choose from (iCloud) once at start; if that fails, Serain writes into the default one.
      const targets = await this.services.calendar.targets?.().catch((error: unknown) => {
        log.error("Calendar list not readable, Serain writes into the default one:", (error as Error).message);
        return undefined;
      });
      // With the reminder path: a flight from the mail comes with a check-in reminder (addendum D62 of 2026-10-10).
      this.tools.registerAll(calendarTools(this.services.calendar, targets, undefined, { reminders: scheduleStore }));
      this.dataSources.add(calendarSource(this.services.calendar));
    }
    for (const account of this.services.mail) {
      const source = mailSource(account, `mail_${account.id}`);
      if (source) this.dataSources.add(source);
    }
    // One line in the journal: which access this process really loaded. Accounts, never secrets.
    log.info(
      `Integrations: mailboxes ${this.services.mail.map((account) => `${account.id} (${account.address})`).join(", ") || "none"}, ` +
        `calendar ${this.services.calendar?.label ?? "off"}, web_browse ${this.browser ? "on" : "off"}`,
    );
    if (this.services.mail.length === 0) return;
    this.tools.registerAll(
      mailTools({
        accounts: this.services.mail,
        keep: mailKeepStore,
        files: this.files,
        // Only the sandbox opens attachments (addendum D31 of 2026-10-12); without it they stay closed.
        ...(this.sandbox ? { opener: { sandbox: this.sandbox, describeImage } } : {}),
        // "What's open?" from what the mail trigger classified, instead of reading the mailbox again (W3).
        items: mailItemStore,
        // What Serain sends, the code remembers: the trigger always reports the reply to it (addendum D33 of 2026-10-13).
        sent: sentMailStore,
        // Unsubscribe pages only with Chrome on the server; Jev clicks only when the code alone gets no further (D37, addendum 2026-10-03).
        ...(env.chromePath
          ? { cleanup: { openPage: pageUnsubscriber({ chromePath: env.chromePath, jev: env.typesafeApiKey ? typesafeClient(env.typesafeApiKey) : null }) } }
          : {}),
        // Who is already known (addendum D34)? The tool checks mailboxes itself; on top come
        // the owner's own messages and, while the Mac is awake, their contacts.
        recipientSources: [
          ...(this.companion ? [contactsSource(this.companion)] : []),
          ownMessagesSource((address) => ownerMentionedAddress(env.ownerPhone, address)),
        ],
      }),
    );
    const calendar = this.services.calendar;
    this.mailTrigger = new MailTrigger({
      accounts: this.services.mail,
      items: mailItemStore,
      state: mailTriggerState,
      cursor: {
        load: async (id) => ((await integrationState(id))?.["cursor"] as Record<string, unknown> | undefined) ?? null,
        save: (id, cursor) => this.integrations.saveState(id, { cursor }),
      },
      // Jev first (W31): mail is bulk, a verdict there takes milliseconds instead of a minute
      // on the primary model (measured 2026-09-20: 2 min 23 s for one mail). Through OpenRouter with ZDR (D3),
      // never directly at Typesafe. If Jev fails, the generative backend takes over, with an audit entry.
      judge: new RoutedJudge(["jev", "generative"]),
      digest: digestMail,
      // The next two weeks' events as known things (W14): "your appointment was moved"
      // is recognised only by someone who knows the appointment.
      ...(calendar
        ? {
            upcoming: async () => {
              const now = new Date();
              const { entries } = await calendar.list({ from: now.toISOString(), to: new Date(now.getTime() + 14 * 86_400_000).toISOString(), limit: 12 });
              return entries.map((entry) => ({
                key: `cal:${entry.id}`,
                what: entry.title,
                when: entry.allDay ? entry.start : formatWallTime(new Date(entry.start)),
                from: entry.guests.join(", ") || "own calendar",
              }));
            },
            calendarHas: (span) => calendarCovers(calendar, span),
            calendarBusy: (span) => calendarBusy(calendar, span),
          }
        : {}),
      // In the scheduler's tick: the state of this round (housekeeping).
      paused: async () => this.killSwitch.engaged,
      inProbation: async () => inProbation(await heartbeatState.load(), new Date()),
      sent: sentMailStore,
      health: (account, ok, error) => this.integrationHealth.record(mailSubject(account), ok, error),
      // Every new mail also to the watchers (D43), before the classifier: the shipping mail is mostly bulk mail.
      onNewMail: (accountId, mail) => this.watch.onNewMail(accountId, mail),
      fire: (incoming, recallQuery) =>
        this.queue.submit(env.ownerPhone, {
          kind: "event",
          origin: "untrusted",
          incoming,
          recallQuery,
          triggerExternalId: "",
          triggerMessageId: "",
          taintSources: [MAIL_SOURCE],
          toolNames: MAIL_TRIGGER_TOOLS,
          limits: MAIL_TURN_LIMITS,
          source: "mail",
        }),
    });
  }

  private async setupMedia(): Promise<void> {
    if (!env.openrouterApiKey) return;
    let downloads: Sandbox | null = null;
    if (this.sandbox && env.mediaProxyDir && mediaDownloadEnabled()) {
      try {
        this.mediaProxy = await startFilterProxy({ socketPath: join(env.mediaProxyDir, MEDIA_PROXY_SOCKET) });
        downloads = this.sandbox;
      } catch (error) {
        // Without the proxy the sandbox downloads nothing; YouTube still works.
        log.error("Proxy for videos not started:", error);
        await audit("error", { stage: "media_proxy", reason: (error as Error).message });
      }
    }
    this.media = mediaWatcher({ downloads });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.heartbeat?.stop();
    await this.scheduler.stop();
    await this.connectors?.stop();
    this.cancelTasks();
    await this.formHolds.dropAll("shutdown");
    // Stays `pending`: the next start finds the second run through the audit log (addendum D52 of 2026-10-10).
    this.takeTurnRetry();
    await this.queue.drain();
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled(this.services.mail.map((account) => account.close()));
    await this.channel.stop();
    await this.mediaProxy?.close();
    closeWarmPool();
    // After the heartbeat, so no tick overwrites the note right away: the
    // watchdog should recognise this stop as intended and open no incident
    // (false alarm of 2026-09-18, see src/health/status.ts).
    await markPlannedStop();
    await audit("shutdown", {});
    await closePg();
  }

  /** Runs for every inbound message before anything else happens. */
  private async onInbound(message: InboundMessage): Promise<void> {
    const arrivedAt = Date.now();
    // 1. Allowlist. Foreign messages reach neither the model nor storage.
    const verdict = checkIngress(message, env.ownerPhone);
    if (!verdict.allowed) {
      // Deliberately without content: foreign messages are not archived.
      await audit("inbound_rejected", {
        reason: verdict.reason,
        from: verdict.from,
        channel: message.channel,
        external_id: message.externalId,
        chars: message.text.length,
      });
      log.warn(`Message from ${verdict.from} dropped (${verdict.reason})`);
      return;
    }

    // 1b. A code a login is waiting for (D56). Intercepted before storing: only
    // a placeholder is in `messages`, the code never reaches the model or the
    // history.
    if (message.attachments.length === 0 && this.codes.matches(message.text)) {
      await this.onCode(message);
      return;
    }

    // 2. Persistence and dedupe in one step: the unique constraint decides.
    let storedId: string;
    try {
      const result = await storeInbound(message);
      if (!result.stored) {
        await audit("inbound_duplicate", {
          external_id: message.externalId,
          channel: message.channel,
        });
        log.debug(`Duplicate message ${message.externalId} dropped`);
        return;
      }
      storedId = result.message.id;
    } catch (error) {
      await audit("error", { stage: "store_inbound", reason: (error as Error).message });
      log.error("Inbound not stored, turn aborted:", error);
      return;
    }
    await this.admit(message, { peer: verdict.from, storedId, arrivedAt, recovered: null });
  }

  /**
   * The owner's answer to the question for a code (D56). What is stored is a
   * placeholder instead of text and raw data, so dedupe and history are right;
   * the audit names the site, never the code. A tapback acknowledges it.
   */
  private async onCode(message: InboundMessage): Promise<void> {
    const waiting = this.codes.waiting;
    let storedId: string;
    try {
      const result = await storeInbound({
        ...message,
        text: `[Code for a login${waiting ? ` at ${waiting}` : ""}, entered by the system and not readable]`,
        raw: { redacted: "site_code" },
      });
      if (!result.stored) return;
      storedId = result.message.id;
    } catch (error) {
      // Without storing no dedupe; the code still only goes into the field, never to the model.
      await audit("error", { stage: "store_code", reason: (error as Error).message });
      storedId = "";
    }
    const delivery = this.codes.deliver(message.text);
    await audit("site_code", { site: delivery?.site ?? null, late: delivery?.late ?? null }, storedId || undefined);
    if (storedId) await this.settleInbound([storedId]);
    // The stop already ended the request; stopped means silent, also for the answer to a late code.
    if ((await this.killSwitch.load()).engaged) return;
    if (!delivery || delivery.late) {
      await this.outbound.sendToOwner(
        delivery ? t(core.codeLateAt, { site: delivery.site }) : t(core.codeLate),
        { kind: "site_code_late" },
      );
      return;
    }
    await this.outbound.acknowledge(message.externalId, t(core.codeEntered), { kind: "site_code_ack" });
  }

  /**
   * From here on the message is stored and `pending` (D52). The same steps run
   * for a message whose turn a crash cut off: a "serain stop" or a "yes" in the
   * thread may have been left behind too.
   */
  private async admit(
    message: InboundMessage,
    { peer, storedId, arrivedAt, recovered }: { peer: string; storedId: string; arrivedAt: number; recovered: string | null },
  ): Promise<void> {
    // The owner's language, before the kill switch and decisions, so their replies already use it.
    // The switch happens synchronously; saving it is not waited for (D50), a failure is only logged.
    if (recovered === null && message.text) {
      void observeOwnerText(message.text).catch((error: unknown) => log.warn("Owner language not saved:", (error as Error).message));
    }
    if (await this.outsideTurn(message, storedId, recovered !== null)) {
      await this.settleInbound([storedId]);
      return;
    }

    // 6. Only now into the conversation queue.
    this.queue.submit(
      peer,
      { kind: "message", inbound: message, storedId, arrivedAt, ...(recovered ? { recovered } : {}) },
      arrivedAt,
    );
    // While the window runs (D50): fetch the memory for this message already,
    // and check whether the waiting process still fits.
    if (message.attachments.length === 0) this.recallAhead(message.text);
    this.prewarmChat();
  }

  /** Steps 3 to 5b. True means: handled without a turn. */
  private async outsideTurn(message: InboundMessage, storedId: string, recovered: boolean): Promise<boolean> {
    // 3. Kill switch, by regex, outside the model (D8.2). The state is read
    // fresh, so a restart or a second process does not lift the stop silently.
    // Next to the audit entry, not after it: two independent round trips to
    // the database (D50).
    const [, state] = await Promise.all([
      recovered ? undefined : audit("inbound", { chars: message.text.length, attachments: message.attachments.length }, storedId),
      this.killSwitch.load(),
    ]);
    const command = detectKillSwitchCommand(message.text);
    // The acknowledgement is a 👍 on the owner's own message, not a sentence:
    // they know what they wrote. If the channel cannot do the tapback, the text
    // version goes out; a kill switch without feedback would not be all right.
    if (command === "engage") {
      await this.killSwitch.engage("codeword");
      // Nothing open may fire after the stop, nothing running keep running.
      const { cancelled } = await this.approvals.cancelAll("kill_switch");
      this.codes.cancelAll();
      // A form waiting for a 👍 closes too (D63): nobody submits it after this.
      await this.formHolds.dropAll("kill_switch");
      // What was running, before it is cancelled: the owner should know they will get no answer to it.
      const stopped = this.runningTaskInfos();
      this.cancelTasks();
      await this.dropTurnRetry();
      await this.outbound.acknowledge(message.externalId, t(security.killEngaged, { resume: primaryWord("resume") }), {
        kind: "kill_switch_ack",
        command,
      });
      if (stopped.length > 0) {
        await this.outbound.sendToOwner(stoppedTasksNote(stopped), { kind: "kill_switch_ack", command, tasks: stopped.length });
      }
      // What was scheduled is cancelled, not paused (addendum D14 of 2026-10-08). The owner should know.
      if (cancelled > 0) {
        await this.outbound.sendToOwner(t(security.killScheduledCancelled, { count: cancelled }), { kind: "kill_switch_ack", command, cancelled });
      }
      return true;
    }
    if (command === "release") {
      if (!state.engaged) {
        await this.outbound.acknowledge(message.externalId, t(security.killNotEngaged), {
          kind: "kill_switch_ack",
          command,
          was_engaged: false,
        });
        return true;
      }
      await this.killSwitch.release("codeword");
      await this.outbound.acknowledge(message.externalId, t(security.killReleased), {
        kind: "kill_switch_ack",
        command,
      });
      return true;
    }
    if (state.engaged) {
      // Stopped means silent. Replying would only burn the message budget.
      await audit("kill_switch", { skipped: true, since: state.since }, storedId);
      log.warn("Kill switch engaged, message not handled");
      return true;
    }

    // 4. Revoking all standing approvals (W4). By regex like the kill switch,
    // outside the model.
    if (isRevokeCommand(message.text)) {
      // Read beforehand which ones they were: the text version of the acknowledgement names them. Unreadable only means without a list.
      let grants: string[] = [];
      try {
        grants = await activeGrantKeys();
      } catch (error) {
        log.warn("Standing approvals not readable before the revoke:", (error as Error).message);
      }
      await this.approvals.revokeGrants("codeword");
      await this.outbound.acknowledge(message.externalId, revokedNote(grants), {
        kind: "approval_revoke_ack",
      });
      return true;
    }

    // 5. Reply in the thread of a preview (D8.3). Only a message that is a
    // decision as a whole counts; everything else is conversation and goes to
    // the model as usual.
    const decision = message.replyToExternalId ? parseDecision(message.text) : null;
    if (decision) {
      const handled = await this.onDecision({
        previewExternalId: message.replyToExternalId,
        decision,
        via: "thread_reply",
        decisionMessageId: storedId,
        ackExternalId: message.externalId,
      });
      if (handled) return true;
    }
    // "yes, but tomorrow at 8" (addendum D14 of 2026-10-08): also by regex, only as a whole message.
    const later = message.replyToExternalId && !decision ? parseLater(message.text, new Date()) : null;
    if (later && (await this.onLater(message.replyToExternalId, later, storedId))) return true;

    // 5b. Reply in the thread of a proposal question (D42), after the previews:
    // those take precedence. Numbers, "all", "none" are decided by the code,
    // everything else is conversation.
    if (
      message.replyToExternalId &&
      (await this.proposals.onReply({
        offerExternalId: message.replyToExternalId,
        text: message.text,
        decisionMessageId: storedId,
        ackExternalId: message.externalId,
      }))
    ) {
      return true;
    }
    return false;
  }

  /**
   * The owner is typing (D25). If a message of theirs is already in the buffer,
   * the turn waits for the next one instead of answering in the middle of
   * their sentence. The signal is fleeting: no audit, no storage, no model. The
   * allowlist applies anyway, or a stranger could delay Serain's replies.
   */
  private onTyping(typing: InboundTyping): void {
    if (!checkIngress({ from: typing.from, isGroup: false }, env.ownerPhone).allowed) return;
    this.queue.hold(env.ownerPhone, typing.started ? TYPING_HOLD_MS : DEBOUNCE_MS);
  }

  /**
   * Inbound tapback. The same order as for messages: allowlist, then kill
   * switch, only then meaning. Today a tapback has exactly one: 👍 or 👎 on an
   * open preview.
   */
  private async onReaction(reaction: InboundReaction): Promise<void> {
    const verdict = checkIngress({ from: reaction.from, isGroup: false }, env.ownerPhone);
    if (!verdict.allowed) {
      await audit("inbound_rejected", {
        kind: "reaction",
        reason: verdict.reason,
        from: verdict.from,
        channel: reaction.channel,
      });
      log.warn(`Tapback from ${verdict.from} dropped (${verdict.reason})`);
      return;
    }
    // Photon does not report withdrawn tapbacks (D38). They would be no
    // decision and no revoke anyway: what was confirmed may already have run.
    await audit("inbound_reaction", {
      external_id: reaction.messageId,
      emoji: reaction.emoji,
    });

    const state = await this.killSwitch.load();
    if (state.engaged) {
      await audit("kill_switch", { skipped: true, kind: "reaction", since: state.since });
      return;
    }
    const decision = decisionFromReaction(reaction.emoji);
    if (decision) {
      const handled = await this.onDecision({
        previewExternalId: reaction.messageId,
        decision,
        via: "tapback",
        decisionMessageId: null,
        ackExternalId: "",
      });
      if (handled) return;
      // 👍 or 👎 on a proposal question (D42), after the previews.
      if (await this.proposals.onReaction(reaction.messageId, reaction.emoji)) return;
    }
    await this.onFeedback(reaction);
  }

  /**
   * A tapback that is no decision on a preview (W24, D24). 👎 and ❓ on a fresh
   * message of Serain's own get a turn of origin `owner_reaction`; everything
   * else is an acknowledgement and shows in the next turn's history through the
   * audit log.
   */
  private async onFeedback(reaction: InboundReaction): Promise<void> {
    const meaning = reactionMeaning(reaction.emoji);
    if (meaning === "note") return;
    const seenKey = `${reaction.messageId}:${meaning}`;
    if (this.feedbackSeen.has(seenKey)) return;

    let target: Awaited<ReturnType<typeof findOutbound>>;
    try {
      target = await findOutbound(env.ownerPhone, reaction.messageId);
    } catch (error) {
      log.error("Target of the tapback not readable:", error);
      return;
    }
    // Only on own, fresh messages: a 👎 on a message of the owner's own or on
    // something from yesterday is no conversation.
    if (!target || !target.body) return;
    if (Date.now() - new Date(target.created_at).getTime() > FEEDBACK_MAX_AGE_MS) return;

    this.feedbackSeen.add(seenKey);
    if (this.feedbackSeen.size > 200) this.feedbackSeen.delete(this.feedbackSeen.values().next().value as string);
    if (meaning === "correction") {
      this.outbound.forbidRepeat(target.body);
      // A 👎 on something Serain sent on its own: the benefit is not proven,
      // the probation starts over (W12, D26).
      const origin = await outboundOrigin(target.id).catch(() => null);
      if (origin === "heartbeat" || origin === "untrusted") await this.proactive.restartProbation().catch(() => undefined);
      // The owner's next own words about it may become a proposal (V5, D42).
      this.proposals.noteCorrection({ messageId: target.id, body: target.body, taintSources: target.taint_sources ?? [] });
    }
    await audit("reaction_feedback", { meaning, emoji: reaction.emoji, external_id: reaction.messageId }, target.id);
    // If the message was derived from foreign content, it is framed in the
    // trigger, and the correction turn carries the taint: its whole occasion is
    // this text (D8.4). If the tapback falls into a message of the owner's own,
    // the framing stays, as in the history.
    const taintSources = target.taint_sources ?? [];
    this.queue.submit(env.ownerPhone, {
      kind: "event",
      origin: "owner_reaction",
      incoming: feedbackPrompt(meaning, reaction.emoji, target.body, taintSources),
      note: reactionNote(reaction.emoji, target.body, taintSources),
      triggerExternalId: reaction.messageId,
      triggerMessageId: target.id,
      ...(taintSources.length > 0 ? { taintSources: [...taintSources] } : {}),
    });
  }

  /**
   * The owner has decided. On approval exactly what was stored runs, then a
   * turn of its own words the result. Returns false when the signal belongs to
   * no open preview.
   */
  private async onDecision(signal: {
    previewExternalId: string;
    decision: Decision;
    via: DecisionVia;
    decisionMessageId: string | null;
    ackExternalId: string;
  }): Promise<boolean> {
    const outcome = await this.approvals.decide(signal);
    if (outcome.kind === "none") return false;
    // Expired (addendum D8 of 2026-10-10): the fresh preview is already out, nothing runs.
    if (outcome.kind === "reissued") return true;
    if (outcome.kind === "expired") {
      await this.outbound.sendToOwner(outcome.text, { kind: "approval_expired_ack" }, { replyTo: signal.previewExternalId, allowDuplicate: true });
      return true;
    }

    if (outcome.kind === "denied" || outcome.kind === "cancelled") {
      // Their 👎 is the whole conversation already. A typed "no" gets a 👍 as
      // acknowledgement, nothing else.
      if (signal.ackExternalId) {
        await this.outbound.acknowledge(signal.ackExternalId, t(core.deniedAck), {
          kind: "approval_denied_ack",
        });
      }
      return true;
    }

    await this.runApproved(outcome.approval, `${owner.name} confirmed this preview: "${outcome.approval.preview}"`);
    return true;
  }

  /**
   * Runs a claimed confirmation, exactly with the stored arguments, and gives
   * the result to a turn of its own (D14). The same way after a 👍 and at the
   * time of a scheduled confirmation.
   */
  private async runApproved(approval: ApprovalRow, headline: string): Promise<void> {
    const exec = new TurnState({
      origin: "approval",
      triggerExternalId: approval.previewExternalId,
      triggerMessageId: approval.requestMessageId ?? "",
      reactableIds: [],
    });
    const result = await this.tools.executeApproved(approval, exec);
    await this.approvals.complete(approval, result);
    await this.reportApproval(approval, exec.taintSources, [
      headline,
      `The tool ${approval.tool} then ran. Result (${result.ok ? "ok" : "failed"}):`,
      result.text,
      `Tell ${owner.name} in one sentence what came out of it.`,
    ]);
  }

  /**
   * The turn that tells the owner the result of a confirmation. The preview is
   * in its trigger; if the requesting turn had seen foreign content, its
   * arguments derive from it (D8.4).
   */
  private async reportApproval(approval: ApprovalRow, execTaint: readonly string[], lines: string[]): Promise<void> {
    const preview = await findOutbound(env.ownerPhone, approval.previewExternalId).catch((error: unknown) => {
      log.error("Origin of the preview not readable:", error);
      return null;
    });
    this.queue.submit(env.ownerPhone, {
      kind: "event",
      origin: "approval",
      incoming: lines.join("\n"),
      triggerExternalId: approval.previewExternalId,
      triggerMessageId: approval.requestMessageId ?? "",
      // If the origin is not readable, the preview counts as foreign: fail closed.
      taintSources: [...execTaint, ...(preview ? (preview.taint_sources ?? []) : ["preview of unknown origin"])],
    });
  }

  /**
   * The owner wrote "yes, but tomorrow at 8" in the thread of a preview
   * (addendum D14 of 2026-10-08). If the preview belongs to nothing open, it is
   * no decision (false), and the message goes on as conversation. Otherwise
   * the code answers in the thread: the resolved time or why it does not work.
   */
  private async onLater(previewExternalId: string, parse: LaterParse, decisionMessageId: string): Promise<boolean> {
    // The preview's origin travels along, for the overview and the result turn. Unreadable means foreign.
    const preview = await findOutbound(env.ownerPhone, previewExternalId).catch(() => null);
    const outcome = await this.approvals.scheduleLater({
      previewExternalId,
      parse,
      decisionMessageId,
      taintSources: preview ? (preview.taint_sources ?? []) : ["preview of unknown origin"],
    });
    if (outcome.kind === "none") return false;
    await this.outbound.sendToOwner(outcome.text, { kind: "approval_later_ack", outcome: outcome.kind }, { replyTo: previewExternalId, allowDuplicate: true });
    return true;
  }

  /**
   * Scheduled confirmations that are due, in the scheduler's tick. Never with
   * the kill switch pulled (then they are cancelled anyway). What was missed
   * never runs, but the owner hears about it.
   */
  private async runDueApprovals(): Promise<void> {
    if (this.killSwitch.engaged) return;
    for (const due of await this.approvals.dueLater()) {
      const planned = due.approval.executeAt ? formatWallTime(new Date(due.approval.executeAt)) : "later";
      if (due.kind === "missed") {
        await this.reportApproval(due.approval, [], [
          `${owner.name} had scheduled this preview for ${planned}: "${due.approval.preview}"`,
          `Serain was not running at that time; now it is ${Math.round(due.lateMs / 60_000)} min too late, so the tool ${due.approval.tool} did not run and will not run any more.`,
          `Tell ${owner.name} that in one sentence. If they still want it, it needs a new preview.`,
        ]);
        continue;
      }
      const late = due.lateMs > SCHEDULE_LATE_NOTE_MS ? ` (${Math.round(due.lateMs / 60_000)} min late, Serain was not running at the time)` : "";
      await this.runApproved(due.approval, `${owner.name} confirmed this preview and scheduled it for ${planned}${late}: "${due.approval.preview}"`);
    }
  }

  /**
   * Nightly consolidation of the user model (H1, D40). Runs along in the
   * scheduler's tick and only does something once a night. Through the chain
   * of the memory follow-up, so it never runs next to a fact writer; stopped by
   * the kill switch like everything else that asks a model by itself.
   */
  private consolidating = false;
  /** When facts without an area were last sorted in (package 2 of 2026-10-08). */
  private areasCheckedAt = 0;

  /**
   * Sort facts without an area in: seed, shortened leftovers, everything from before 0024.
   * At most once an hour, in the chain of the follow-up, never in the turn.
   */
  private async classifyMemoryAreas(): Promise<void> {
    if (Date.now() - this.areasCheckedAt < MEMORY.areaIntervalMs) return;
    this.areasCheckedAt = Date.now();
    try {
      if (this.killSwitch.engaged) return;
      const { more } = await afterMemory(() => maybeClassifyAreas(this.memory));
      // A full batch: the rest comes in the next tick, not only in an hour.
      if (more) this.areasCheckedAt = 0;
    } catch (error) {
      await audit("memory_error", { stage: "areas", reason: (error as Error).message });
      log.error("Areas not sorted in:", error);
    }
  }

  private async consolidateMemory(): Promise<void> {
    if (this.consolidating) return;
    this.consolidating = true;
    try {
      if (this.killSwitch.engaged) return;
      await afterMemory(() => maybeConsolidate(this.memory));
    } catch (error) {
      await audit("memory_error", { stage: "consolidation", reason: (error as Error).message });
      log.error("Consolidation failed:", error);
    } finally {
      this.consolidating = false;
    }
  }

  /** Can a task run right now (W22)? Null means yes. */
  private async taskBlocker(): Promise<string | null> {
    if (this.tasks.size >= EXECUTOR_MAX_CONCURRENT) {
      return "Two tasks are already running; the next one can start only when one is done.";
    }
    try {
      const budget = await budgetStatus();
      if (!budget.tasksAllowed) return "The API budget for this month is used up; tasks are off until the first of the month.";
    } catch (error) {
      log.error("Budget not readable, task does not run:", error);
      return "I can't read my budget right now.";
    }
    return null;
  }

  private cancelTasks(): void {
    for (const cancel of this.tasks) cancel();
    for (const cancel of this.resultRetries) cancel();
  }

  /**
   * A background task (D4). Runs next to the queue so the owner can keep
   * writing meanwhile; only the result goes through the queue again, as a turn
   * of origin `task` and tainted from the start.
   */
  private async runTask(request: {
    task: string;
    triggerExternalId: string;
    triggerMessageId: string;
    guard: ConfidentialGuard;
    /** Logged-in session at this site instead of research on the web (D36). */
    site?: string;
    /** The 🔍 sits on the triggering message; it becomes ✅ or, if no report came, ❌. */
    acked?: boolean;
    /** Money, health, law: at least five primary sources (`run_task`). */
    thorough?: boolean;
    /** Place of an appointment, only for the executor; never in `tasks`, the audit or the result turn (addendum D54). */
    place?: TaskPlace;
    /** Fill in a form (D63, building block C). */
    form?: { url?: string; site?: string; uses: string[] };
  }): Promise<void> {
    let cancel: () => void = () => undefined;
    let wasCancelled = false;
    const cancelled = new Promise<void>((resolve) => {
      cancel = () => {
        wasCancelled = true;
        resolve();
      };
    });
    this.tasks.add(cancel);
    const running = {
      id: String((this.taskSeq += 1)),
      task: request.task,
      ...(request.site ? { site: request.site } : {}),
      startedAt: new Date(),
      cancel,
      byOwner: false,
    };
    this.runningTasks.set(running.id, running);
    const endWork = beginWork("task");
    // The result comes back as a turn of its own (D16); its process is already waiting until then (D50).
    if (!request.site) prewarmTurn("task_result", this.turnShape("task"));
    // So a crash does not swallow it without a trace (D52). If it cannot be
    // recorded, it runs anyway: the research is not to blame for the database.
    const taskId = await recoveryStore
      .startTask({
        task: request.task,
        ...(request.site ? { site: request.site } : {}),
        triggerMessageId: request.triggerMessageId,
        triggerExternalId: request.triggerExternalId,
        acked: request.acked === true,
      })
      .catch(async (error: unknown) => {
        await audit("error", { stage: "task_store", reason: (error as Error).message }, request.triggerMessageId);
        log.error("Task not stored, runs without crash protection:", error);
        return null;
      });
    await audit(
      "task_started",
      {
        chars: request.task.length,
        search: this.search !== null,
        sandbox: this.sandbox !== null,
        companion: this.companion !== null,
        browser: this.browser !== null,
        media: this.media !== null,
        ...(request.site ? { site: request.site } : {}),
        ...(request.thorough ? { thorough: true } : {}),
        ...(request.place ? { place: true } : {}),
      },
      request.triggerMessageId,
    );
    try {
      const outcome = await runExecutorTask(
        {
          task: request.task,
          triggerMessageId: request.triggerMessageId,
          guard: request.guard,
          cancelled,
          ...(request.site ? { site: request.site } : {}),
          ...(request.thorough ? { thorough: true } : {}),
          ...(request.place ? { place: request.place } : {}),
          ...(request.form ? { form: request.form } : {}),
        },
        { ...this.executorDeps(), sites: this.sites, forms: this.forms },
      );
      if (wasCancelled) {
        await this.onTaskCancelled(taskId, request.triggerMessageId, running.byOwner);
        return;
      }
      await this.settleTaskAck(request, outcome.report ? "done" : "failed");
      this.submitTaskResult(
        request,
        taskId,
        [
          outcome.protocol,
          // Error messages can carry text of the page, so framed and separate from the protocol.
          ...(outcome.failures.length > 0 ? [wrapUntrusted(outcome.failures.join("\n"), "error messages of the tools")] : []),
          outcome.report
            ? wrapUntrusted(outcome.report, "report of the executor")
            : `The executor delivered no report. Tell ${owner.name} that nothing came out of it instead of answering from your own knowledge.`,
          "Only what is in the protocol failed. If the report names further errors, they did not happen:",
          `then the matter is only unverified, and that is how you tell ${owner.name}.`,
          // From the code, not the executor: the id of the held form (D63, building block C).
          ...(outcome.held
            ? [
                `The form is filled in and waiting. Call web_submit with id "${outcome.held.token}" now; the code builds the preview with`,
                `every field and a picture of the page. Before that, tell ${owner.name} in one sentence at most that it is coming.`,
              ]
            : []),
        ],
        {
          sources: outcome.sources,
          opened: outcome.opened,
          reported: outcome.report.trim().length > 0,
          screenshots: outcome.screenshots,
          picks: outcome.picks,
          documents: outcome.documents,
          asides: outcome.asides,
          actUrl: outcome.actUrl,
        },
      );
    } catch (error) {
      if (wasCancelled) {
        await this.onTaskCancelled(taskId, request.triggerMessageId, running.byOwner);
        return;
      }
      await audit("error", { stage: "task", reason: (error as Error).message }, request.triggerMessageId);
      log.error("Task failed:", error);
      await this.settleTaskAck(request, "failed");
      this.submitTaskResult(request, taskId, [`The task failed: ${(error as Error).message}`], { sources: [], opened: [], reported: false });
    } finally {
      this.tasks.delete(cancel);
      this.runningTasks.delete(running.id);
      endWork();
    }
  }

  /**
   * Stopped by the owner (kill switch or `cancel_task`): done. On shutdown,
   * though, it stays `running` and is reported at the next start (D52);
   * "cancelled (stop)" in the history would be wrong then.
   */
  private async onTaskCancelled(taskId: string | null, triggerMessageId: string, byOwner = false): Promise<void> {
    if (this.stopping && !byOwner) {
      log.info("Task cut off by shutdown, will be reported at start");
      return;
    }
    await audit("task_cancelled", byOwner ? { by: "cancel_task" } : {}, triggerMessageId);
    if (taskId) await this.finishTask(taskId, "cancelled");
  }

  private async finishTask(taskId: string, status: "done" | "cancelled"): Promise<void> {
    await recoveryStore.finishTask(taskId, status).catch(async (error: unknown) => {
      // If it stays `running`, the next start reports it as interrupted: wrong, but loud.
      await audit("error", { stage: "task_finish", reason: (error as Error).message });
      log.error("Task not finished:", error);
    });
  }

  /** The 🔍 becomes ✅ or ❌; in iMessage a new tapback replaces the old one of the same sender. */
  private async settleTaskAck(request: { triggerExternalId: string; acked?: boolean }, signal: "done" | "failed"): Promise<void> {
    if (request.acked) await this.port.react(request.triggerExternalId, SIGNALS[signal]);
  }

  private submitTaskResult(
    request: { task: string; triggerExternalId: string; triggerMessageId: string; site?: string },
    taskId: string | null,
    lines: string[],
    parts: TaskResultParts,
  ): void {
    const { sources, opened, reported } = parts;
    // Without a report a screenshot mostly shows the wrong page, and the model does not see it:
    // then there is none (addendum D23 of 2026-10-08, seen live: the overview of the whole country instead of the town).
    const screenshots = reported ? (parts.screenshots ?? []) : [];
    const chosen = parts.picks ?? [];
    const rendered = reported && chosen.length > 0 ? renderPicks(chosen) : null;
    const picks: PendingPicks | null = rendered ? { ...rendered, sent: false } : null;
    const documents = reported ? (parts.documents ?? []) : [];
    // The executor code checked both against the opened pages (`checkFinishExtras`).
    const asides = reported ? (parts.asides ?? []) : [];
    const actUrl = reported ? (parts.actUrl ?? null) : null;
    // Only if the turn can read the calendar: otherwise the line would be a request without a tool.
    const calendar = this.tools.listFor({ origin: "task" }).some((tool) => tool.name === "calendar_events");
    this.queue.submit(env.ownerPhone, {
      kind: "event",
      origin: "task",
      incoming: [
        `Your background task is done: "${request.task}"`,
        ...lines,
        // Addresses come from the pages themselves, so framed (addendum D48 of 2026-10-08).
        ...(opened.length > 0
          ? [wrapUntrusted(opened.join("\n"), "Opened pages (a link or a preview may only go there)")]
          : []),
        // Decision of 2026-10-09: not as a link but really the PDFs, so nobody gets thrown out of iMessage.
        ...(documents.length > 0
          ? [
              `PDFs the executor read that you can send with send_file (kind document): ${documents
                .map((doc) => {
                  const host = new URL(doc.url).hostname.replace(/^www\./, "");
                  const form = doc.pages ? `, comes as ${doc.pages.length === 1 ? "one image" : `${doc.pages.length} images, one per page`}` : "";
                  return `${doc.id} (${doc.name}.pdf from ${host}${form})`;
                })
                .join(", ")}. If the answer comes from them, send ${owner.name} all of them that belong to it (a map from`,
              "two PDFs is two) instead of a preview. What comes as an image you call that too, not a file or a PDF.",
            ]
          : []),
        ...(screenshots.length > 0
          ? [
              `Screenshots you can send with send_file (kind screenshot): ${screenshots
                .map((shot) => `${shot.id} (${shot.origin === "site" ? `session at ${shot.label}` : shot.label})`)
                .join(", ")}.`,
              // What it shows comes from the page, so framed: that way Serain knows what the owner is about to see.
              ...screenshots
                .filter((shot) => shot.origin === "web" && shot.shows)
                .map((shot) => wrapUntrusted(shot.shows!, `what screenshot ${shot.id} shows`)),
            ]
          : []),
        // Addendum D61 of 2026-10-09: the code builds the list, the model only writes the sentence before it.
        ...(picks
          ? [
              wrapUntrusted(picks.bubbles.join("\n\n"), `list to choose from that the system sends ${owner.name} verbatim`),
              "The system sends this list itself, right after your first message. Your message comes before it: one or",
              "two sentences, and what stayed open or failed. You do not write the things from the list again.",
            ]
          : []),
        // Side findings: the executor saw them, the code checked their page. Protocol, not style.
        ...(asides.length > 0
          ? [
              wrapUntrusted(asides.map((aside) => `- ${aside.text} (${aside.url})`).join("\n"), "on the side, what the executor saw while researching"),
              "On the side is not the answer. If a finding fits the question, you add at most half a sentence after the answer,",
              "with the page it was on. If it does not fit, you leave it out; it never gets a message of its own.",
            ]
          : []),
        ...(actUrl
          ? [
              wrapUntrusted(actUrl, `page of the provider where ${owner.name} does it themselves (opened by the executor, nothing bought or submitted)`),
              `If you give ${owner.name} the link to act on, as a preview or in the text, it is this page.`,
            ]
          : []),
        ...(reported && calendar
          ? [
              `If the result names a concrete day with a time at which ${owner.name} would be somewhere themselves (appointment, departure, pickup,`,
              "event), you look at exactly that window with calendar_events. You mention only a real overlap,",
              "in half a sentence; nothing else.",
            ]
          : []),
        ...(reported
          ? [
              `Values from the page that ${owner.name} would type out (phone number, address, order or case number) you pass`,
              "through copy on reply_in_thread or send_message.",
            ]
          : []),
        `Write ${owner.name} the result with reply_in_thread, short and in your tone. What stayed open or`,
        "failed, you say too.",
        // Style round (addendum D23 of 2026-10-08): preview and screenshot unasked, generously.
        // One of the two, the screenshot comes first (either a link or a screenshot).
        ...(screenshots.length > 0
          ? [`You send ${owner.name} the screenshot along, without a preview, unless it does not show what it is about.`]
          : documents.length > 0
            ? ["If the answer comes not from the PDFs but from a page, you send that as a preview along (links)."]
            : opened.length > 0
              ? [`You send the most important opened page as a preview along (links), unless it gives ${owner.name} nothing.`]
              : []),
      ].join("\n"),
      triggerExternalId: request.triggerExternalId,
      triggerMessageId: request.triggerMessageId,
      // Even without a source: a report of the executor is never the owner's word.
      taintSources: sources.length > 0 ? sources : ["executor"],
      ...(opened.length > 0 ? { openedPages: opened } : {}),
      ...(screenshots.length > 0 ? { screenshots } : {}),
      ...(picks ? { picks } : {}),
      ...(documents.length > 0 ? { documents } : {}),
      ...(taskId ? { taskId } : {}),
      task: { text: request.task, ...(request.site ? { site: request.site } : {}), retried: false },
      owedReport: owedReport(reported, request.site),
    });
  }

  /**
   * A due schedule (D9). A reminder goes out verbatim, without a model; a task
   * becomes a turn of origin `schedule`. Throws if the reminder did not go out,
   * so the poller tries again.
   */
  private async deliverSchedule(row: ScheduleRow, lateNote: string | null): Promise<void> {
    if (row.mode === "mission") {
      const wake = await this.missions.wake(row);
      if (!wake) return;
      await audit("mission_wake", { mission: row.text, tainted: wake.taintSources.length > 0 });
      this.queue.submit(env.ownerPhone, {
        kind: "event",
        origin: "schedule",
        incoming: wake.incoming,
        recallQuery: wake.recallQuery,
        triggerExternalId: "",
        triggerMessageId: "",
        ...(wake.taintSources.length > 0 ? { taintSources: wake.taintSources } : {}),
      });
      return;
    }
    if (row.mode === "reminder") {
      const outcome = await this.outbound.trySendToOwner(
        reminderText(row.text, lateNote ? new Date(row.dueAt) : null, new Date()),
        { kind: "reminder", schedule_id: row.id },
        { taintSources: row.taintSources },
      );
      // The same words just went out: a restart between sending and ticking off (`Scheduler.start`).
      // The owner has it, so it is delivered; a new attempt would only run into the block again.
      if (outcome.status === "failed") throw new Error("Reminder did not go out");
      return;
    }
    this.queue.submit(env.ownerPhone, {
      kind: "event",
      origin: "schedule",
      incoming: [
        `Scheduled task that ${owner.name} created on ${formatWallTime(new Date(row.createdAt))}` +
          `${lateNote ? ` (was meant for ${lateNote}, runs late)` : ""}:`,
        row.text,
      ].join("\n"),
      triggerExternalId: "",
      triggerMessageId: "",
      ...(row.taintSources.length > 0 ? { taintSources: [...row.taintSources] } : {}),
    });
  }

  /**
   * A batch from the queue: first the owner's messages as one turn, then every
   * event on its own. As long as the message turn has done nothing the owner
   * sees or that stays, a straggler message may supersede it (D50); then the
   * whole batch belongs to the next turn, events included.
   */
  private async runBatch(batch: QueuedItem[], control?: RunControl<QueuedItem>): Promise<void> {
    const fresh = batch.filter((item): item is QueuedMessage => item.kind === "message");
    // If a message is waiting for its second run, it goes into this turn instead of getting one of its own
    // five minutes later (addendum D52 of 2026-10-10). The second run is then this one.
    const absorbed = fresh.length > 0 ? this.takeTurnRetry() : null;
    for (const item of absorbed?.items ?? []) await audit("turn_retry", { stage: "again", into: fresh.at(-1)?.storedId }, item.storedId);
    const messages = [...(absorbed?.items.filter((item) => !fresh.some((other) => other.storedId === item.storedId)) ?? []), ...fresh];
    // A 👎 followed right away by the owner's own words about it is one turn:
    // the tapback goes as a note into the message turn instead of starting a
    // second one next to it that tries the same correction again.
    const folded = (item: QueuedItem): item is TurnEvent =>
      item.kind === "event" && item.origin === "owner_reaction" && messages.length > 0;
    if (messages.length > 0) {
      const preemption = new Preemption();
      // If the turn can no longer be superseded, it reads the owner's new message itself (D57).
      const steers: SteerSlot = { steering: new Steering(), items: new Map() };
      control?.setPreempter(() => preemption.cancel());
      control?.setSteerer((item) => item.kind === "message" && this.offerSteer(steers, item));
      try {
        await this.runMessageTurn(
          messages,
          batch.filter(folded).flatMap((event) => (event.note ? [event.note] : [])),
          preemption,
          steers,
          (items) => control?.giveBack(items),
        );
      } finally {
        control?.setPreempter(null);
        control?.setSteerer(null);
      }
      if (control?.preempted) {
        // The queue gives the successor only its own batch; the ones taken along wait again, and it takes them along.
        if (absorbed) this.parkTurnRetry(absorbed.items, absorbed.dueAt);
        return;
      }
    }
    for (const item of batch) {
      if (item.kind === "event" && !folded(item)) await this.runEventTurn(item);
    }
  }

  /**
   * The owner writes into a running turn that can no longer be superseded
   * (D57). Allowlist, kill switch, decision and code interception are already
   * behind the message, as for any other (`admit`). The turn reads it as soon
   * as its attachments are read; a voice message only after transcription.
   * Caught-up messages (D52) never run like this.
   */
  private offerSteer(steers: SteerSlot, item: QueuedMessage): boolean {
    if (item.recovered || item.retried || !steers.steering.offer(item.storedId, item.inbound.externalId, item.arrivedAt)) return false;
    steers.items.set(item.storedId, item);
    this.readSteer(item).then(
      (content) => steers.steering.ready(item.storedId, content),
      (error: unknown) => {
        // Gets its own turn; that one reads again and says what did not work.
        log.error("Pushed-in message not readable:", error);
        steers.steering.fail(item.storedId);
      },
    );
    return true;
  }

  private async readSteer(item: QueuedMessage): Promise<SteerContent> {
    const message = messageParts(item.inbound.text, await this.readBatchAttachments([item]));
    return { ownerWords: message.ownWords, text: message.parts.join("\n"), taintSources: message.taintSources };
  }

  private async runMessageTurn(
    batch: QueuedMessage[],
    reactionNotes: string[],
    preemption: Preemption,
    steers: SteerSlot,
    giveBack: (items: QueuedMessage[]) => void,
  ): Promise<void> {
    const last = batch[batch.length - 1];
    if (!last) return;
    // What was pushed into this turn (D57), settled once as soon as the model is done.
    let steered: { seen: SteerReport[]; unseen: SteerReport[] } | null = null;
    const closeSteering = () => (steered ??= steers.steering.close());
    const startedAt = Date.now();
    const peer = last.inbound.from;
    const typed = batch
      .map((item) => item.inbound.text)
      .filter((text) => text.length > 0)
      .join("\n");

    // The history is a pure read of our own database: it runs alongside the
    // kill-switch query (D50). Whatever reaches a model or a service comes only
    // after it.
    const ids = batch.map((item) => item.storedId);
    const historyAhead = this.buildHistory(peer, ids);
    historyAhead.catch(() => undefined);

    // Between acceptance and turn lies the debounce window. If "serain stop"
    // came in that time, this turn does not run any more (live test 2026-09-20:
    // a queued turn still created a reminder 4 s after the stop).
    const halted = await this.killSwitch.load();
    if (halted.engaged) {
      await audit("kill_switch", { skipped: true, kind: "queued_turn", since: halted.since }, last.storedId);
      await this.settleInbound(ids);
      return;
    }

    // Read and "typing" run alongside the preparation, not before it (D50):
    // two round trips to Photon the turn need not wait for.
    const presence = Promise.all([
      this.channel.capabilities.readReceipts ? this.channel.markRead(peer).catch(() => undefined) : undefined,
      this.channel.capabilities.typing ? this.channel.typing(peer, true).catch(() => undefined) : undefined,
    ]).then(() => undefined);

    let preempted = false;
    let followUp: { tools: string[]; items: QueuedMessage[] } | null = null;
    // Whether the turn did anything with an effect: only otherwise may it run again after an error (addendum D52 of 2026-10-10).
    const progress: TurnProgress = { committed: false };
    let retrying = false;
    try {
      if (env.echoOnly) {
        await this.outbound.sendToOwner(`Echo: ${typed || "(attachments only)"}`, { kind: "echo" });
        return;
      }

      // Attachments become text before the turn (D21). A voice message is the
      // owner's words and belongs to `ownWords`; an image is foreign content, is
      // framed and sets the turn's taint.
      const message = messageParts(typed, await this.readBatchAttachments(batch));
      const ownWords = message.ownWords;
      const incoming = [
        ...message.parts,
        ...reactionNotes,
        ...batch.flatMap((item) => (item.recovered ? [item.recovered] : [])),
        ...batch.flatMap((item) => (item.retried ? [item.retried] : [])),
        ...batch.flatMap((item) => (item.returned ? [item.returned] : [])),
        ...batch.flatMap((item) => (item.followUp ? [item.followUp] : [])),
      ]
        .filter(Boolean)
        .join("\n");
      if (!incoming) {
        log.info("Turn without text and without attachment, nothing to do");
        return;
      }

      const [history, context] = await Promise.all([historyAhead, this.recall(ownWords || incoming)]);
      if (preemption.isCancelled) {
        preempted = true;
        return;
      }
      const modelStartedAt = Date.now();
      let outcome: TurnOutcome;
      try {
        outcome = await this.runModel({
          context,
          history,
          incoming,
          warm: "chat",
          setup: {
            // A message from the owner that passed the allowlist (D8.4).
            origin: "owner_message",
            triggerExternalId: last.inbound.externalId,
            triggerMessageId: last.storedId,
            reactableIds: batch.map((item) => item.inbound.externalId).filter(Boolean),
            ownerWords: ownWords,
            ...(message.taintSources.length > 0 ? { taintSources: message.taintSources } : {}),
            preemption,
            steering: steers.steering,
            // Follow up once, never in a circle.
            followUp: !batch.some((item) => item.followUp),
            progress,
          },
          timing: {
            waitMs: Math.round(startedAt - Math.min(...batch.map((item) => item.arrivedAt))),
            prepMs: Math.round(modelStartedAt - startedAt),
            arrivedAt: last.arrivedAt,
            modelStartedAt,
          },
        });
      } finally {
        // From here on the turn takes nothing more in, not even while it still tells the owner "stuck".
        closeSteering();
      }
      if (outcome.preempted) {
        preempted = true;
        return;
      }
      // What the model saw pushed in are the owner's words in this turn (D57).
      const seen = closeSteering().seen;
      // The reply did not arrive (in full) (addendum D52 of 2026-10-13): then nothing is done, not even
      // what was pushed in. Learning happens only in the second run, otherwise twice from the same words.
      if (progress.undelivered && (await this.onUndelivered([...batch, ...seen.flatMap((steer) => steers.items.get(steer.id) ?? [])]))) {
        retrying = true;
        return;
      }
      if (outcome.deferred.length > 0) {
        // The clean turn reads the same messages, the pushed-in ones too (addendum D8.4 of 2026-10-08).
        const note = followUpNote(outcome.deferred);
        followUp = {
          tools: outcome.deferred,
          items: [...batch, ...seen.flatMap((steer) => steers.items.get(steer.id) ?? [])].map((item) => ({
            kind: "message" as const,
            inbound: item.inbound,
            storedId: item.storedId,
            arrivedAt: Date.now(),
            followUp: note,
          })),
        };
      }
      // A follow-up turn reads the attachments again, from the cache.
      if (!followUp) for (const item of batch) this.readings.delete(item.storedId);
      // Each message is learned from once: not again in the follow-up turn (addendum D8.4 of 2026-10-08).
      const freshItems = batch.filter((item) => !item.followUp);
      const freshWords =
        freshItems.length === batch.length
          ? ownWords
          : messageParts(
              freshItems.map((item) => item.inbound.text).filter((text) => text.length > 0).join("\n"),
              await this.readBatchAttachments(freshItems),
            ).ownWords;
      const words = [freshWords, ...seen.map((steer) => steer.content?.ownerWords ?? "")].filter(Boolean).join("\n");
      const lastId = seen.at(-1)?.id ?? last.storedId;
      // The open question was in the prompt; whether Serain really asked it
      // could only be known with another model verdict. Showing it once and
      // ticking it off is better than repeating it every turn.
      await markQuestionShown(this.memory, context.question);
      // The same history the model saw also goes into memory: without it,
      // "nah, actually, now and then" cannot be resolved (D13).
      // Learning only from the owner's own words, typed or spoken. What was on
      // an image never writes into memory (D8.4, D13).
      if (words) {
        this.track(this.learn(words, lastId, outcome.factExtractionBlocked, history));
        // If this follows a 👎, it may become a proposal (V5, D42): through the
        // same chain, never next to the fact writer, and not in a turn that just
        // forgot something.
        const correction = this.proposals.takeCorrection();
        if (correction && !outcome.factExtractionBlocked) {
          const input = { correction, text: words, messageId: lastId };
          this.track(afterMemory(() => this.proposals.learnFromCorrection(input)));
        }
      }
      await this.warnAboutBudget();
    } catch (error) {
      retrying = await this.onMessageTurnError(error, batch, progress);
    } finally {
      const { seen, unseen } = closeSteering();
      // What the turn did not see any more runs right after it as a turn of its own (D57).
      // Before that the follow-up turn: it belongs to the messages that came earlier.
      giveBack([
        ...(followUp?.items ?? []),
        ...unseen.flatMap((steer) => {
          const item = steers.items.get(steer.id);
          return item ? [{ ...item, returned: RETURNED_NOTE }] : [];
        }),
      ]);
      if (preempted) {
        // The successor starts at once and does not wait for Photon (live: 1.5 s
        // for read receipt and "typing"); "typing" stays on.
        this.track(presence);
        await audit("turn_preempted", { messages: batch.length }, last.storedId);
      } else {
        await presence;
        if (this.channel.capabilities.typing) await this.channel.typing(peer, false).catch(() => undefined);
        // Answered, failed (the owner knows) or deliberately nothing to do: nothing left to catch up (D52).
        // That includes what the model saw pushed in (D57). With a follow-up turn everything
        // stays open until it is through; a crash in between catches it up. The same with a
        // second run after an error (addendum D52 of 2026-10-10).
        if (followUp) {
          await audit("turn_follow_up", { tools: followUp.tools, messages: followUp.items.length }, last.storedId);
        } else if (!retrying) {
          for (const steer of seen) this.readings.delete(steer.id);
          await this.settleInbound([...ids, ...seen.map((steer) => steer.id)]);
        }
        for (const steer of seen) {
          await audit("turn_steered", { into: last.storedId, wait_ms: steer.seenAt === null ? null : steer.seenAt - steer.arrivedAt }, steer.id);
        }
      }
      for (const steer of unseen) {
        await audit("turn_steer_returned", { from: last.storedId, delivered: steer.delivered }, steer.id);
      }
      this.prewarmChat();
    }
  }

  /**
   * Reads the attachments of a batch (D21) and attaches what was read to the
   * stored messages, so later turns see it in the history. If something fails,
   * it is a note in the turn: Serain then says what it could not open.
   */
  private async readBatchAttachments(batch: QueuedMessage[]) {
    const all: AttachmentReading[] = [];
    for (const item of batch) {
      if (item.inbound.attachments.length === 0) continue;
      let reading = this.readings.get(item.storedId);
      if (!reading) {
        reading = this.readItemAttachments(item);
        this.readings.set(item.storedId, reading);
        // An attachment no turn ever picks up (kill switch) does not lie around forever.
        setTimeout(() => this.readings.delete(item.storedId), 10 * 60_000).unref();
      }
      all.push(...(await reading));
    }
    return renderReadings(all);
  }

  /** Read a message's attachments and store what was read on it. */
  private async readItemAttachments(item: QueuedMessage): Promise<AttachmentReading[]> {
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    this.tasks.add(cancel);
    const endWork = beginWork("attachment");
    try {
      const readings = await readAttachments(item.inbound.attachments, {
        sandbox: this.sandbox,
        shelf: this.files,
        fetchAttachment: (attachment, maxBytes) => this.channel.fetchAttachment(attachment, maxBytes),
        describeImage,
        cancelled,
        onRead: (info) => audit("attachment", info, item.storedId),
      });
      // A voice message is the owner's words: its transcript, without the marker, counts for their language like typed text.
      for (const reading of readings) {
        if (reading.status === "read" && reading.kind === "voice" && reading.text) {
          void observeOwnerText(reading.text).catch((error: unknown) => log.warn("Owner language not saved:", (error as Error).message));
        }
      }
      const stored = readings.flatMap((reading): Array<Record<string, unknown>> =>
        reading.status === "read"
          ? [{ kind: reading.kind, text: reading.text }]
          : reading.status === "file"
            ? [{ kind: "file", ...reading.file }]
            : [],
      );
      if (stored.length > 0) {
        const spoken = renderReadings(readings).ownerText;
        await storeAttachmentReadings(item.storedId, {
          attachments: stored,
          ...(item.inbound.text.length === 0 && spoken ? { body: spoken } : {}),
        }).catch((error: unknown) => log.error("Attachment readings not stored:", error));
      }
      return readings;
    } finally {
      this.tasks.delete(cancel);
      endWork();
    }
  }

  /**
   * A turn without a message from the owner. Three differences from the normal
   * turn: the kill switch is checked here (for messages that already happens at
   * ingress), the origin is never `owner_message`, and nothing is learned:
   * facts come only from the owner's own words (D8.4, D13).
   */
  private async runEventTurn(event: TurnEvent): Promise<void> {
    const state = await this.killSwitch.load();
    if (state.engaged) {
      await audit("kill_switch", { skipped: true, kind: event.origin, since: state.since });
      if (event.taskId) await this.finishTask(event.taskId, "cancelled");
      return;
    }
    let retrying = false;
    try {
      retrying = (await this.runEventModel(event)) === "retry";
    } finally {
      // Done, even if it failed: the error is in the audit log (D52). Unless it runs again right away.
      if (event.taskId && !retrying) await this.finishTask(event.taskId, "done");
    }
  }

  /** "retry": the result turn failed before it did anything and runs again right away (`retryTaskResult`). */
  private async runEventModel(event: TurnEvent): Promise<"retry" | void> {
    if (env.echoOnly) return;
    // Only a result turn the owner is waiting for gets a second run.
    const progress: TurnProgress | null = event.task && !event.task.retried && event.owedReport ? { committed: false } : null;
    try {
      const [history, context] = await Promise.all([
        this.buildHistory(env.ownerPhone, []),
        this.recall(event.recallQuery ?? event.incoming),
      ]);
      const outcome = await this.runModel({
        context,
        history,
        incoming: event.incoming,
        incomingSpeaker: "Event",
        // The result of a task already got its process at the start (D50).
        ...(event.origin === "task" && !event.toolNames && !event.limits ? { warm: "task_result" as const } : {}),
        setup: {
          origin: event.origin,
          triggerExternalId: event.triggerExternalId,
          triggerMessageId: event.triggerMessageId,
          reactableIds: [],
          ...(event.taintSources ? { taintSources: event.taintSources } : {}),
          ...(event.openedPages ? { openedPages: event.openedPages } : {}),
          ...(event.screenshots ? { screenshots: event.screenshots } : {}),
          ...(event.picks ? { picks: event.picks } : {}),
          ...(event.documents ? { documents: event.documents } : {}),
          ...(event.toolNames ? { toolNames: event.toolNames } : {}),
          ...(event.limits ? { limits: event.limits } : {}),
          ...(event.owedReport ? { reportOwed: true } : {}),
          ...(progress ? { progress } : {}),
        },
      });
      if (event.origin === "heartbeat") await this.proactive.recordSent(outcome.messagesSent);
      if (event.source === "mail") await this.mailTrigger?.recordSent(outcome.messagesSent);
      // A preview is an answer too: after "waiting for your 👍" (e.g. a form, D63) no fixed sentence follows.
      if (outcome.messagesDelivered === 0 && (outcome.previewsSent ?? 0) === 0) await this.reportForTurn(event, "silent");
      await this.sendLeftoverPicks(event);
      await this.warnAboutBudget();
    } catch (error) {
      // An event that fails does not report itself: the owner asked nothing.
      // It is in the audit log. Unless they are waiting for it (`owedReport`).
      await this.onTurnError(error, event.triggerMessageId, false);
      // If the turn has done nothing yet (no tool with an effect, so no message either), a second run
      // repeats nothing: then the report stays in memory and gets its turn again shortly.
      if (progress && !progress.committed && !(error instanceof BudgetExceededError) && !this.killSwitch.engaged && !this.stopping) {
        this.track(this.retryTaskResult(event));
        return "retry";
      }
      await this.reportForTurn(event, "error");
      await this.sendLeftoverPicks(event);
    }
  }

  /**
   * The second run of a failed result turn, after `TASK_RESULT_RETRY_MS`.
   * Until then the task stays `running` (D52) and shows in `cancel_task` and
   * `overview`; kill switch, `cancel_task` and shutdown end the wait. If the
   * second run fails too, the fixed sentence comes as before.
   */
  private async retryTaskResult(event: TurnEvent): Promise<void> {
    const task = event.task;
    if (!task) return;
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<"cancelled">((resolve) => {
      cancel = () => resolve("cancelled");
    });
    this.resultRetries.add(cancel);
    const running = { id: String((this.taskSeq += 1)), task: task.text, ...(task.site ? { site: task.site } : {}), startedAt: new Date(), cancel, byOwner: false };
    this.runningTasks.set(running.id, running);
    // The report is only in memory: a deploy should not cut it off in the middle of the wait.
    const endWork = beginWork("task");
    let timer: NodeJS.Timeout | undefined;
    const due = new Promise<"due">((resolve) => {
      timer = setTimeout(() => resolve("due"), TASK_RESULT_RETRY_MS);
    });
    await audit("task_result_retry", { stage: "waiting", ms: TASK_RESULT_RETRY_MS }, event.triggerMessageId || undefined);
    try {
      if ((await Promise.race([due, cancelled])) === "cancelled") {
        await this.onTaskCancelled(event.taskId ?? null, event.triggerMessageId, running.byOwner);
        return;
      }
    } finally {
      clearTimeout(timer);
      this.resultRetries.delete(cancel);
      this.runningTasks.delete(running.id);
      endWork();
    }
    await audit("task_result_retry", { stage: "again" }, event.triggerMessageId || undefined);
    if (!task.site) prewarmTurn("task_result", this.turnShape("task"));
    this.queue.submit(env.ownerPhone, { ...event, task: { ...task, retried: true } });
  }

  /**
   * The owner's messages wait for their second run (addendum D52 of 2026-10-10).
   * If a group is already there, they are merged; due is then the later time.
   */
  private parkTurnRetry(items: QueuedMessage[], dueAt: number): void {
    const waiting = this.takeTurnRetry();
    const all = [...(waiting?.items ?? []), ...items.filter((item) => !waiting?.items.some((other) => other.storedId === item.storedId))];
    const due = Math.max(dueAt, waiting?.dueAt ?? 0);
    const timer = setTimeout(() => void this.fireTurnRetry(), Math.max(0, due - Date.now()));
    // Does not keep the process alive: a restart finds the second run through the audit log.
    timer.unref();
    this.turnRetry = { items: all, dueAt: due, timer };
  }

  /** Takes the waiting group out and stops its clock. */
  private takeTurnRetry(): TurnRetry | null {
    const waiting = this.turnRetry;
    if (!waiting) return null;
    clearTimeout(waiting.timer);
    this.turnRetry = null;
    return waiting;
  }

  /** Time is up: the same messages through the queue once more, with the note that it is the second run. */
  private async fireTurnRetry(): Promise<void> {
    const waiting = this.takeTurnRetry();
    if (!waiting) return;
    for (const item of waiting.items) await audit("turn_retry", { stage: "again" }, item.storedId);
    for (const item of waiting.items) this.queue.submit(env.ownerPhone, { ...item, arrivedAt: Date.now() });
    this.prewarmChat();
  }

  /**
   * "serain stop" (D8.2): stopped means silent, the second run too. The
   * messages are done with that, like every one the kill switch leaves (D52).
   */
  private async dropTurnRetry(): Promise<void> {
    const waiting = this.takeTurnRetry();
    if (!waiting) return;
    const ids = waiting.items.map((item) => item.storedId);
    await audit("kill_switch", { skipped: true, kind: "turn_retry", messages: ids.length });
    await this.settleInbound(ids);
  }

  /** Which of these messages wait for a second run (`turn_retry` in the audit log). Unreadable means: none. */
  private async turnRetriesFor(messageIds: string[]): Promise<Map<string, TurnRetryMark>> {
    try {
      return await turnRetriesFor(messageIds);
    } catch (error) {
      // Then the start catches them up like every leftover message, without another run: rather one too few.
      log.error("Second runs not readable:", error);
      return new Map();
    }
  }

  /**
   * The list to choose from, when the turn sent no message that took it along
   * (addendum D61 of 2026-10-09): it is the result, it does not get lost with a
   * silent or failed turn.
   */
  private async sendLeftoverPicks(event: TurnEvent): Promise<void> {
    const picks = event.picks;
    if (!picks || picks.sent || this.killSwitch.engaged) return;
    picks.sent = true;
    let sent = 0;
    for (const bubble of picks.bubbles) {
      const ok = await this.outbound.sendToOwner(
        bubble,
        { kind: "picks", origin: event.origin },
        {
          ...(event.triggerExternalId ? { replyTo: event.triggerExternalId } : {}),
          taintSources: event.taintSources ?? [],
          verbatim: true,
        },
      );
      if (ok) sent += 1;
    }
    await audit("task_picks_fallback", { bubbles: picks.bubbles.length, sent }, event.triggerMessageId || undefined);
  }

  /**
   * The turn for a task result sent the owner nothing. Then the code says so,
   * in a fixed sentence in the thread of the question: a task that ends
   * silently cannot be told apart, for the owner, from one that is still
   * running (in the persona eval, 2 of 5 ended empty, without a word).
   */
  private async reportForTurn(event: TurnEvent, reason: "silent" | "error"): Promise<void> {
    if (!event.owedReport) return;
    // "serain stop" in the middle of the turn: the registry silenced it, and the code does not talk past it (D8.2).
    if (this.killSwitch.engaged) return;
    const sent = await this.outbound.sendToOwner(
      event.owedReport,
      { kind: "task_report_fallback", reason },
      event.triggerExternalId ? { replyTo: event.triggerExternalId } : {},
    );
    await audit("task_report_fallback", { reason, sent }, event.triggerMessageId || undefined);
    log.warn(`Task result did not reach ${owner.name} (${reason}), fixed notice ${sent ? "sent" : "did not go out either"}`);
  }

  private async runModel(input: {
    context: MemoryContext;
    history: ChatTurn[];
    incoming: string;
    incomingSpeaker?: string;
    setup: TurnSetup;
    warm?: WarmSlot;
    /** Message turns only: how long the owner has been waiting (D50). */
    timing?: { waitMs: number; prepMs: number; arrivedAt: number; modelStartedAt: number };
  }): Promise<TurnOutcome> {
    const calendarRefs = this.calendarRefsFor(input.setup);
    const outcome = await runAgentTurn(
      { registry: this.tools, port: this.port },
      {
        system: this.systemFor(input.context.userModel),
        context: turnContext(
          new Date(),
          renderMemory(input.context),
          this.disruptions(),
          await this.budgetNotes(input),
          calendarRefs.contextLines(),
          this.missions.contextLines(),
        ),
        history: input.history,
        incoming: input.incoming,
        ...(input.incomingSpeaker ? { incomingSpeaker: input.incomingSpeaker } : {}),
        setup: calendarRefs.size > 0 ? { ...input.setup, calendarRefs } : input.setup,
        ...(input.warm ? { warm: input.warm } : {}),
      },
    );
    const timing = input.timing;
    await audit(
      "model_call",
      {
        origin: input.setup.origin,
        provider: outcome.provider,
        model: outcome.model,
        cost_usd: outcome.costUsd,
        messages: outcome.messagesSent,
        reactions: outcome.reactionsSent,
        steps: outcome.steps,
        stop_reason: outcome.stopReason,
        // Where the time went (D50), in milliseconds. `reply` is what the owner experiences:
        // from their last message to the first reply, tapback or preview.
        latency: {
          ...(timing ? { wait: timing.waitMs, prep: timing.prepMs } : {}),
          ...(outcome.latency
            ? { warm: outcome.latency.warm, first_token: outcome.latency.firstTokenMs, model: outcome.latency.totalMs }
            : {}),
          first_visible: outcome.firstVisibleMs,
          ...(timing && outcome.firstVisibleMs !== null
            ? { reply: Math.round(timing.modelStartedAt + outcome.firstVisibleMs - timing.arrivedAt) }
            : {}),
        },
      },
      input.setup.triggerMessageId,
    );
    await recordComponentStatus("model", "ok", {
      provider: outcome.provider,
      model: outcome.model,
    });
    return outcome;
  }

  private mailSelf(): { mailSelf?: { id: string; address: string } } {
    const own = this.services.mail.find((account) => account.serains);
    return own ? { mailSelf: { id: own.id, address: own.address } } : {};
  }

  /**
   * The budget state as a line in the `<context>`: from 50 % always, below that
   * only when the owner asks about costs themselves (addendum D3 of 2026-10-08).
   */
  private async budgetNotes(input: { incoming: string; setup: TurnSetup }): Promise<string[]> {
    const asked = input.setup.origin === "owner_message" && BUDGET_QUESTION.test(input.incoming);
    const line = await this.budget.contextLine(asked);
    return line ? [line] : [];
  }

  /**
   * Appointments with a place as an id for the `<context>` (addendum D54 of 2026-10-10), from the heartbeat's
   * interim state, without a query (D50). Only in turns that start clean and have `run_task`: the owner's message
   * and a scheduled task. All others could not use the place anyway.
   */
  private calendarRefsFor(setup: TurnSetup): CalendarRefs {
    if (setup.origin !== "owner_message" && setup.origin !== "schedule") return CalendarRefs.empty;
    if ((setup.taintSources ?? []).length > 0) return CalendarRefs.empty;
    if (setup.toolNames && !setup.toolNames.includes("run_task")) return CalendarRefs.empty;
    const entries = this.proactive.upcoming();
    return entries ? CalendarRefs.from(entries, new Date()) : CalendarRefs.empty;
  }

  /** Running tasks with the numbers `cancel_task` and `overview` name. */
  private runningTaskInfos(): RunningTaskInfo[] {
    return [...this.runningTasks.values()].map(({ id, task, site, startedAt }) => ({ id, task, startedAt, ...(site ? { site } : {}) }));
  }

  /** The system prompt: rules, style, protocol, user model and what is connected right now. */
  private systemFor(userModel: string): string {
    return systemPrompt(userModel, {
      web: true,
      mac: this.companion !== null,
      media: (this.media?.platforms ?? []).map((platform) => MEDIA_PLATFORM_LABEL[platform]),
      mail: this.services.mail.filter((account) => !account.serains).map((account) => account.address),
      ...this.mailSelf(),
      mailAttachments: this.tools.get("mail_attachment") !== undefined,
      mailCleanup: this.services.mail.filter((account) => account.cleanup).map((account) => account.address),
      ...(this.services.calendar ? { calendar: this.services.calendar.label } : {}),
      connectors: this.connectors?.promptLines() ?? [],
      unconnected: this.connectors?.unconnectedNames() ?? [],
      compute: this.tools.get("compute") !== undefined,
      analyze: this.tools.get("analyze_data") !== undefined,
      missions: this.tools.get("mission_start") !== undefined,
      voice: this.tools.get("send_voice") !== undefined,
    });
  }

  /**
   * What is disrupted right now, for the `<context>` (audit 2026-10-05): access
   * whose last fetch failed, and the Mac if it was not there at the last
   * attempt. From this process's memory, without a query: the turn does not wait for it (D50).
   */
  private disruptions(): string[] {
    const lines = this.integrationHealth.failing();
    if (this.companion && this.macOfflineSince !== null) {
      const minutes = Math.max(1, Math.round((Date.now() - this.macOfflineSince) / 60_000));
      lines.push(`${owner.possessive} Mac has been unreachable for at least ${minutes} min (lid closed or no network). What comes from the Mac works again only once it is awake.`);
    }
    return lines;
  }

  /** The shape of a turn of this origin with default limits, for the warm pool (D50). */
  private turnShape(origin: TurnOrigin, userModel = this.lastUserModel): TurnShape {
    return {
      role: "chat",
      system: this.systemFor(userModel),
      tools: this.tools.listFor({ origin }),
      maxSteps: DEFAULT_TURN_LIMITS.maxSteps,
    };
  }

  /** The user model read last. Changes at most at night (D40). */
  private lastUserModel = "";

  /**
   * Keeps a process ready for the owner's next message (D50). Cheap when one
   * with the same shape is already waiting: the user model comes from the cache.
   */
  private prewarmChat(): void {
    void this.memory.store
      .userModel()
      .then((userModel) => {
        this.lastUserModel = userModel;
        prewarmTurn("chat", this.turnShape("owner_message", userModel), { sticky: true });
      })
      .catch((error: unknown) => log.warn("Warm pool: user model not readable:", (error as Error).message));
  }

  /** Mail and phone the code knows without a profile (D63, building block C). */
  private formDefaults(): { email?: string; telefon?: string } {
    const primary = this.services.mail.find((account) => !account.serains);
    return { ...(primary ? { email: primary.address } : {}), telefon: env.ownerPhone };
  }

  /**
   * Opens a form (D63, building block C): public ones pinned to the website of
   * the start address, logged-in ones to the hosts of the vault entry. The
   * session only gets the values the owner released with `web_form`.
   */
  private async openForm(target: { url?: string; site?: string; uses: readonly string[] }, cancelled: Promise<void>): Promise<FormSession> {
    const all = profileValues(await profileStore.load(), this.formDefaults());
    const values = Object.fromEntries(target.uses.flatMap((key) => (all[key] ? [[key, all[key]]] : [])));
    if (target.site) {
      if (!this.sites) throw new FormFailure("failed", "Logged-in sessions are not set up on the server (vault key missing).");
      const raw = await this.sites.openRaw(target.site, { cancelled });
      if (raw.login !== "done" && raw.login !== "no_form") {
        await raw.close();
        throw new FormFailure("failed", raw.login === "no_code" ? "The login wanted a code, and none came." : "The login did not go through.");
      }
      return openFormSession(raw.launched, { secrets: () => raw.secrets, values, hostAllowed: (hostname) => raw.hostAllowed(hostname), site: target.site, close: () => raw.close() });
    }
    if (!target.url || !env.chromePath) throw new FormFailure("bad_request", "No address.");
    const start = new URL(target.url).hostname;
    // Private suffixes count as a website of their own: on `github.io` every subdomain is someone else.
    const site = (hostname: string) => getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
    const website = site(start);
    const allowed = (hostname: string) => site(hostname) === website;
    let launched: Launched;
    try {
      launched = await launchSession(target.url, env.chromePath, { allowNavigation: allowed });
    } catch (error) {
      if (error instanceof BrowseError) throw new FormFailure("failed", error.message);
      throw error;
    }
    return openFormSession(launched, { secrets: () => [], values, hostAllowed: allowed, close: () => launched.close() });
  }

  private executorDeps() {
    return { search: this.search, sandbox: this.sandbox, companion: this.companion, browser: this.browser, media: this.media };
  }

  private async onTurnError(error: unknown, messageId: string, tellOwner: boolean): Promise<void> {
    if (error instanceof BudgetExceededError) {
      if (tellOwner) {
        await this.outbound.sendToOwner(t(core.budgetTurn), { kind: "budget" });
      }
      return;
    }
    await audit("error", { stage: "turn", reason: (error as Error).message }, messageId);
    log.error("Turn failed:", error);
    if (tellOwner) await this.outbound.sendToOwner(t(core.turnFailed), { kind: "error" });
  }

  /**
   * A turn on a message of the owner failed (decision 8 of the style round,
   * addendum D52 of 2026-10-10). If it did nothing with an effect (`progress`:
   * no tool except pure read tools, no message, no tapback, no preview), it
   * runs once more by itself after `TURN_RETRY_MS`, and the message stays
   * `pending`. Otherwise, and the second time, as before: the owner hears it,
   * the message is done. True means: a second run is coming.
   */
  private async onMessageTurnError(error: unknown, batch: readonly QueuedMessage[], progress: TurnProgress): Promise<boolean> {
    const last = batch[batch.length - 1]!;
    if (this.killSwitch.engaged) {
      // "serain stop" came in the middle of the turn: stopped means silent, also for "stuck" (D8.2).
      await audit("error", { stage: "turn", reason: (error as Error).message, kill_switch: true }, last.storedId);
      log.error("Turn failed, kill switch pulled:", error);
      return false;
    }
    const retryable =
      !progress.committed &&
      !(error instanceof BudgetExceededError) &&
      !this.stopping &&
      // Only a first run: not after a second, not after a crash (the interrupted turn may already
      // have done something) and not in the follow-up turn (the turn before already answered).
      batch.every((item) => !item.retried && !item.recovered && !item.followUp);
    if (!retryable) {
      await this.onTurnError(error, last.storedId, true);
      return false;
    }
    await audit("error", { stage: "turn", reason: (error as Error).message, retry: true }, last.storedId);
    log.error("Turn failed, a second run follows:", error);
    const dueAt = Date.now() + TURN_RETRY_MS;
    // The marker first, then the sentence: a restart in between still finds the second run.
    for (const item of batch) await audit("turn_retry", { stage: "waiting", due_at: new Date(dueAt).toISOString(), ms: TURN_RETRY_MS }, item.storedId);
    this.parkTurnRetry(
      batch.map((item) => ({ kind: "message" as const, inbound: item.inbound, storedId: item.storedId, arrivedAt: item.arrivedAt, retried: retriedNote(item.inbound.receivedAt) })),
      dueAt,
    );
    await this.outbound.sendToOwner(t(core.turnRetry, { minutes: Math.round(TURN_RETRY_MS / 60_000) }), { kind: "error", retry: true });
    return true;
  }

  /**
   * The reply of a turn on a message of the owner did not arrive (in full): the
   * channel broke off on the second attempt too (addendum D52 of 2026-10-13). A
   * first run runs once more after `TURN_RETRY_MS`, with what it already did;
   * what arrived is in the history. The messages stay `pending` until then,
   * across a restart too. The owner gets no sentence about it: it would go
   * over the same broken line. Otherwise (second run, catch-up, kill switch,
   * shutdown) the message is done as before. True means: a second run is
   * coming.
   */
  private async onUndelivered(items: readonly QueuedMessage[]): Promise<boolean> {
    const last = items[items.length - 1]!;
    const firstRun = items.every((item) => !item.retried && !item.recovered && !item.followUp);
    if (!firstRun || this.killSwitch.engaged || this.stopping) {
      await audit("turn_undelivered", { messages: items.length, first_run: firstRun }, last.storedId);
      log.error(`Reply did not reach ${owner.name}, no further run`);
      return false;
    }
    const dueAt = Date.now() + TURN_RETRY_MS;
    const actions = await this.actionsFor(items.map((item) => item.storedId));
    for (const item of items) {
      await audit("turn_retry", { stage: "waiting", reason: "undelivered", due_at: new Date(dueAt).toISOString(), ms: TURN_RETRY_MS }, item.storedId);
    }
    log.warn(`Reply did not reach ${owner.name}, a second run follows`);
    this.parkTurnRetry(
      items.map((item) => ({
        kind: "message" as const,
        inbound: item.inbound,
        storedId: item.storedId,
        arrivedAt: item.arrivedAt,
        retried: undeliveredNote(item.inbound.receivedAt, renderActions(actions.get(item.storedId) ?? [])),
      })),
      dueAt,
    );
    return true;
  }

  /**
   * Context building from memory (D6). If it fails, the turn runs without:
   * Serain is dumber then, but not mute.
   */
  private async recall(incoming: string): Promise<MemoryContext> {
    const ahead = this.recalled.get(incoming);
    if (ahead) {
      this.recalled.delete(incoming);
      return ahead;
    }
    return this.recallNow(incoming);
  }

  /**
   * Memory ahead of time (D50): recall needs an embedding, the longest stretch
   * before the model. For a message without attachment its text is fixed at
   * acceptance already; if the turn consists of exactly that message, the
   * result is ready when the window runs out. Otherwise it expires unused.
   */
  private readonly recalled = new Map<string, Promise<MemoryContext>>();
  private recallAhead(text: string): void {
    if (!text || this.recalled.has(text)) return;
    this.recalled.set(text, this.recallNow(text));
    setTimeout(() => this.recalled.delete(text), 30_000).unref();
  }

  private async recallNow(incoming: string): Promise<MemoryContext> {
    try {
      return await buildMemoryContext(this.memory, { incoming });
    } catch (error) {
      await audit("memory_error", { stage: "recall", reason: (error as Error).message });
      log.error("Memory not readable, turn runs without it:", error);
      return EMPTY_CONTEXT;
    }
  }

  /**
   * Learning after the turn (D6, D8.4). Runs asynchronously because the owner
   * should not wait for their reply, and only on the owner's own text:
   * untrusted content never writes into memory.
   *
   * `history` is the history of this conversation: the owner's own messages
   * and Serain's own replies. It serves understanding, not as a source: facts
   * still come only from `incoming`. Replies Serain wrote after foreign content
   * (`fromUntrusted`) the write path sees only as placeholders (D8.4, D13
   * addendum 2026-10-02).
   */
  private async learn(
    incoming: string,
    messageId: string,
    blocked: boolean,
    history: ChatTurn[],
  ): Promise<void> {
    if (blocked) {
      // The turn just forgot something. Learning from the same message again
      // would bring back what was deleted right away.
      await audit("memory_gate", { kept: false, reason: "forget_turn" }, messageId);
      return;
    }
    await afterTurn({ deps: this.memory, messageId, text: incoming, context: history });
  }

  /** Keeps track of follow-up work so `stop()` can wait for it. */
  private track(work: Promise<void>): void {
    const endWork = beginWork("followup");
    const tracked = work
      .catch((error: unknown) => {
        log.error("Follow-up failed:", error);
      })
      .finally(() => {
        this.pending.delete(tracked);
        endWork();
      });
    this.pending.add(tracked);
  }

  /**
   * Budget notice after the turn (D3): throttled from 80 % and used up at 100 %, once a month each.
   * Runs after the reply so a notice never blocks the turn itself.
   */
  private async warnAboutBudget(): Promise<void> {
    // After every turn: the next context and the heartbeat see the new state.
    await this.budget.refresh();
    for (const warning of await claimBudgetWarnings()) {
      await audit("budget_warning", { kind: warning.kind });
      await this.outbound.sendToOwner(warning.text, { kind: "budget_warning" });
    }
  }

  /**
   * Context per turn fresh from the DB (D4). The messages that just came in
   * are already in `messages` and are taken out here so they do not land in
   * the prompt twice. By id, not as the last N: a caught-up message (D52) is
   * older than what Serain still sent before the crash.
   *
   * What Serain *did* belongs to the history too. A turn of 👍 and
   * `set_reminder` leaves nothing in `messages`; without the note the owner's
   * request looks unanswered in the next turn, and the model does it once more
   * (live test 2026-09-20: one reminder created four times). The actions come
   * from the audit log, only from tools of this registry, never from those
   * that deliver foreign content.
   */
  private async buildHistory(peer: string, incomingIds: readonly string[]): Promise<ChatTurn[]> {
    const incoming = new Set(incomingIds);
    const rows = await recentMessages(peer, HISTORY_LIMIT + incoming.size);
    const withoutIncoming = rows.filter((row) => !incoming.has(row.id)).slice(-HISTORY_LIMIT);
    const [actions, tapbacks] = await Promise.all([
      this.actionsFor(withoutIncoming.filter((row) => row.direction === "inbound").map((row) => row.id)),
      this.tapbacksFor(
        withoutIncoming.flatMap((row) => (row.direction === "outbound" && row.external_id ? [row.external_id] : [])),
      ),
    ]);
    const history: ChatTurn[] = [];
    for (const row of withoutIncoming) {
      // A message Serain wrote after foreign content is derived from it (D8.4,
      // addendum 2026-10-02). It is framed in the history and marked for the
      // memory's write path; the turn itself stays clean, otherwise one mail
      // notice would paralyse every conversation after it.
      const taintSources = row.direction === "outbound" ? (row.taint_sources ?? []) : [];
      const body = taintSources.length > 0 && row.body ? wrapDerived(row.body, taintSources) : row.body;
      history.push({
        role: row.direction === "inbound" ? ("user" as const) : ("assistant" as const),
        content: [body, ...renderStoredAttachments(row.attachments)].filter(Boolean).join("\n"),
        // When it was said: the model path turns that into time markers (finding 2026-10-09, `src/agent/timeline.ts`).
        ...(row.created_at ? { at: row.created_at } : {}),
        ...(taintSources.length > 0 ? { fromUntrusted: true } : {}),
      });
      const note = renderActions(actions.get(row.id) ?? []);
      if (note) history.push({ role: "assistant", content: note });
      // The owner's tapbacks on this message (W24): their reaction, so their role.
      for (const emoji of (row.external_id && tapbacks.get(row.external_id)) || []) {
        history.push({ role: "user", content: reactionNote(emoji) });
      }
    }
    return history;
  }

  private async tapbacksFor(externalIds: string[]): Promise<Map<string, string[]>> {
    try {
      return await reactionsFor(externalIds);
    } catch (error) {
      log.error("Tapbacks for the history not readable:", error);
      return new Map();
    }
  }

  private async actionsFor(messageIds: string[]): Promise<Map<string, ToolAction[]>> {
    const byMessage = new Map<string, ToolAction[]>();
    const tools = this.tools
      .list()
      .filter((def) => !def.returnsUntrusted && !SPOKEN_TOOLS.has(def.name))
      .map((def) => def.name);
    try {
      for (const action of await toolActionsFor(messageIds, tools)) {
        byMessage.set(action.messageId, [...(byMessage.get(action.messageId) ?? []), action]);
      }
    } catch (error) {
      // Without notes Serain is more forgetful, but not mute.
      log.error("Actions for the history not readable:", error);
    }
    return byMessage;
  }
}

/**
 * Images and files of earlier messages in the history (D21). Images framed as
 * at the first reading: what was on an image stays foreign content, three
 * turns later too. The taint, though, only applies to the turn that got the
 * image, just as a research result does not block later turns. A file shows
 * with its id, so "send that to mum" still works a message later (addendum
 * D34 of 2026-10-08); whether it is still on the shelf, `mail_send` says.
 */
function renderStoredAttachments(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((entry) => {
    const reading = entry as { kind?: unknown; text?: unknown; id?: unknown; name?: unknown; size?: unknown };
    if (reading.kind === "image" && typeof reading.text === "string") return [wrapUntrusted(reading.text, ownerImageSource())];
    if (reading.kind === "file" && typeof reading.id === "string" && typeof reading.name === "string" && typeof reading.size === "number") {
      return [fileNote({ id: reading.id, name: reading.name, size: reading.size })];
    }
    return [];
  });
}

/** What was pushed into a running turn (D57), with the messages themselves for giving back. */
interface SteerSlot {
  steering: Steering;
  items: Map<string, QueuedMessage>;
}

/** The taint source of an image the owner sent: what is on it is foreign content (D8.4, D21). */
function ownerImageSource(): string {
  return `image from ${owner.name}`;
}

/** What a turn reads about a message its predecessor did not see any more (D57). Never the owner's word. */
const RETURNED_NOTE =
  "[This message came while you were still on your previous reply, and you did not read it there any more. " +
  "What you already wrote and did there is in the history.]";

/**
 * What the follow-up turn reads about the owner's message (addendum D8.4 of
 * 2026-10-08). Never the owner's word. Only tool names: the arguments of the
 * blocked call were chosen by a model that had read foreign content.
 */
function followUpNote(tools: readonly string[]): string {
  return (
    "[You already answered this message just now, that is in the history. There " +
    tools.join(", ") +
    " did not work any more because you had read foreign content before. Catch up on only that now, first, " +
    "before you read anything that delivers foreign content. What is already answered you do not answer again.]"
  );
}

/** What the model reads of the owner's messages (D21): their words, framed images, notes on attachments. */
function messageParts(typed: string, attachments: RenderedAttachments): { ownWords: string; parts: string[]; taintSources: string[] } {
  // A voice message is the owner's words; an image is foreign content and sets the taint.
  const ownWords = [typed, attachments.ownerText].filter(Boolean).join("\n");
  return {
    ownWords,
    parts: [ownWords, ...attachments.untrusted.map((text) => wrapUntrusted(text, ownerImageSource())), ...attachments.notes].filter(Boolean),
    taintSources: attachments.untrusted.length > 0 ? [ownerImageSource()] : [],
  };
}

/**
 * What the kill switch cancelled of running tasks, as a sentence to the owner
 * (style round, addendum D23 of 2026-10-10): "the research was cancelled too."
 */
export function stoppedTasksNote(tasks: readonly { site?: string }[]): string {
  // Parts and list in the language the sentence really renders in (English until a translation is there).
  const lang = textLanguage(security.stoppedTasks);
  const research = tasks.filter((task) => !task.site).length;
  const parts = [
    ...(research > 0 ? [t(security.stoppedResearch, { count: research }, lang)] : []),
    ...tasks.flatMap((task) => (task.site ? [t(security.stoppedSession, { site: task.site }, lang)] : [])),
  ];
  const joined = new Intl.ListFormat(currentLocale(lang), { type: "conjunction" }).format(parts);
  return t(security.stoppedTasks, { tasks: joined, count: tasks.length }, lang);
}

/**
 * Text version of the receipt for "serain revoke" (style round, addendum D23
 * of 2026-10-10): which standing approvals are gone, in the owner's language.
 * The keys only name recipients the owner confirmed with "yes always";
 * `describeGrant` renders them (old plain-text keys verbatim).
 */
export function revokedNote(grants: readonly string[], lang: string = currentLanguage()): string {
  const used = textLanguage(security.revokedList, lang);
  return grants.length > 0
    ? t(security.revokedList, { grants: grants.map((grant) => describeGrant(grant, used)).join(", ") }, used)
    : t(security.revoked, undefined, lang);
}

/**
 * The fixed sentence when the turn on a task result sends the owner nothing
 * (`owedReport`). Wording from the style round; `site` is the logged-in site.
 */
export function owedReport(reported: boolean, site: string | undefined): string {
  if (reported) return site ? t(core.taskReportStuckAt, { site }) : t(core.taskReportStuck);
  return site ? t(core.taskNothingAt, { site }) : t(core.taskNothing);
}

/** Tools whose effect is in the history as a message anyway, plus the end of the turn. */
const SPOKEN_TOOLS = new Set(["send_message", "reply_in_thread", "send_voice", "end_turn"]);

/** One line per turn, in square brackets: Serain's note to itself, never text to the owner. */
export function renderActions(actions: readonly ToolAction[]): string {
  const parts = actions.map((action) => {
    // Since the style round (addendum D23 of 2026-10-08) the model picks a signal; older entries carry the emoji.
    if (action.tool === "react") return `Tapback ${signalEmoji(action.args["signal"]) ?? String(action.args["emoji"] ?? "")}`.trim();
    // Only the first line: that holds the fact, after it come instructions
    // that applied to the turn back then.
    const line = (action.result.split("\n")[0] ?? "").trim();
    // The sentence is shortened, never the id: half an id is a whole one for
    // the model, and it deletes into nothing with it (live finding 2026-10-13).
    const note = action.ref ? refNote(action.ref) : "";
    const fact = note && line.endsWith(note) ? line.slice(0, -note.length) : line;
    return `${action.tool}${action.ok ? "" : " (failed)"}: ${fact.slice(0, 160)}${note}`;
  });
  return parts.length > 0 ? `[done: ${parts.join(" | ")}]` : "";
}
