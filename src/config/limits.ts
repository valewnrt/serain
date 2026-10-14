/**
 * All hard limits in one place (D3, D8.8, D10). Whoever wants to change a
 * number changes it here; the rest of the code contains none.
 *
 * The budget caps are the only limits that come from the environment, because
 * they depend on the operator's wallet (`SERAIN_API_BUDGET_USD`, default $20).
 * With the subscription token, Claude calls cost nothing and only the rest over
 * the API is paid; with an API key (the default), every Claude call counts.
 */

import { loadDevVars } from "./dotenv.js";

loadDevVars();

function budgetUsd(name: string, fallback: number, min = Number.MIN_VALUE): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > 10_000) {
    throw new Error(`Env ${name} is not a dollar amount between 0 and 10000: ${raw}`);
  }
  return value;
}

/**
 * Monthly cap for everything paid over the API (Claude with an API key,
 * OpenRouter, Typesafe). Subscription requests cost $0. With an API key, the
 * chat also stops at the cap (`src/budget.ts`). Best create the key in the
 * Anthropic Console and the key at OpenRouter with the same monthly limit: the
 * cap here counts estimates at list price.
 */
export const MONTHLY_API_BUDGET_USD = budgetUsd("SERAIN_API_BUDGET_USD", 20);

/**
 * Fixed monthly costs that do not run over the API (server, channel), as an
 * amount that is always already gone from the total cap. $0 with Photon Free
 * (D38) and a free server.
 */
export const FIXED_MONTHLY_COST_USD = budgetUsd("SERAIN_FIXED_COST_USD", 0, 0);

/** Total cap for Serain, everything included. Default: API cap plus fixed costs. */
export const MONTHLY_BUDGET_USD = budgetUsd("SERAIN_TOTAL_BUDGET_USD", MONTHLY_API_BUDGET_USD + FIXED_MONTHLY_COST_USD);

/**
 * Budget in the context (package 2 of 2026-10-08): from this share of the API
 * or total cap on, the status is a line in the `<context>`; below it, only when
 * the owner asks for it.
 */
export const BUDGET_CONTEXT_RATIO = 0.5;

/**
 * From this share of the API cap on, Serain saves instead of silently blocking
 * at the cap: the paid fallback takes the role's saver model (`models.ts`),
 * heartbeat and morning briefing are off, the owner is told once. At 100 % the
 * paid path is closed as before.
 */
export const BUDGET_THROTTLE_RATIO = 0.8;

/** How old the budget status in memory may be before heartbeat or context read it again. */
export const BUDGET_REFRESH_MS = 5 * 60_000;

/**
 * Turn limits. A derailed tool loop must not spam the owner: after this many
 * messages or tool steps the turn is over, whatever the model still has in
 * mind.
 */
export const MAX_MESSAGES_PER_TURN = 4;
export const MAX_REACTIONS_PER_TURN = 2;
export const MAX_TOOL_STEPS_PER_TURN = 8;
/**
 * If a turn the owner triggered reaches the step limit before they have heard
 * anything from Serain, it does not end silently: there are no more tools, but
 * a message to them still works. This many times the model may still try
 * something else afterwards, then it is over. Live finding 2026-10-05: a voice
 * message with two weeks of working hours, seven events created, ended at the
 * limit on the eighth, and the owner did not get a word.
 *
 * Denied calls count individually (one step can contain several in parallel);
 * the SDK grants at most `WRAP_UP_STEPS` additional model steps.
 */
export const WRAP_UP_DENIALS = 4;
export const WRAP_UP_STEPS = 2;

/**
 * How long a turn waits for a tool at most (registry). Without a limit, a
 * hanging call (IMAP, Mac, database) held the turn and with it the whole
 * conversation queue forever, Serain was mute (fuzzing 2026-10-04). Above the
 * longest regular runtime of a single tool: a tool of a connected service with
 * a second attempt needs up to twice 40 s. Tools with a legitimately longer
 * runtime set `timeoutMs` themselves.
 */
export const TOOL_TIMEOUT_MS = 120_000;
/** Cleaning up the whole mailbox: unsubscribing up to 100 senders, unsubscribe pages in the browser. */
export const MAIL_BULK_TOOL_TIMEOUT_MS = 10 * 60_000;
/**
 * At most this much text of a tool result goes to the model, and at most this
 * much of it into the audit log. A second belt behind the tools' own limits
 * (pages 12,000, mails 6,000, connections 8,000 characters): a tool that
 * forgets them blows neither the context nor the audit log.
 */
export const TOOL_RESULT_MAX_CHARS = 60_000;
export const AUDIT_TEXT_MAX_CHARS = 20_000;
/** An error message of a tool, for the model and for the audit log. */
export const TOOL_ERROR_MAX_CHARS = 2_000;

/**
 * Outbound path. Long answers are split into bubbles (that reads more
 * naturally in iMessage), but never into arbitrarily many. 30 per hour is at
 * most 720 per day, far below Photon's daily limit of 5,000 (D38).
 */
export const MAX_BUBBLE_CHARS = 1_200;
export const MAX_BUBBLES_PER_MESSAGE = 4;
/** An identical message within this window does not go out twice (W23). */
export const OUTBOUND_DEDUPE_WINDOW_MS = 120_000;
export const OUTBOUND_MIN_INTERVAL_MS = 1_000;
export const OUTBOUND_MAX_PER_HOUR = 30;
/**
 * Editing own messages (D48): Apple allows it for 15 minutes and five times
 * per message. One effect per turn: two confetti in a row are none anymore.
 */
export const EDIT_WINDOW_MS = 15 * 60_000;
export const MAX_EDITS_PER_MESSAGE = 5;
export const MAX_EFFECTS_PER_TURN = 1;
/**
 * Values to copy on a message (style round, addendum D23 of 2026-10-08): one
 * bubble each. Three are enough for code, IBAN and amount; an IBAN has at most
 * 34 characters, an address fits into 200 characters.
 */
export const MAX_COPY_VALUES = 3;
export const MAX_COPY_CHARS = 200;

/**
 * Sources as link previews (addendum D48 of 2026-10-08): at most two per turn,
 * across all messages together. Screenshots: at most two per task, as a JPEG of
 * the visible viewport.
 */
export const MAX_LINK_PREVIEWS_PER_TURN = 2;
export const MAX_SCREENSHOTS_PER_TASK = 2;
/**
 * PDFs the executor has read, as a file to the owner (decision of 2026-10-09:
 * not as a link, so that one is not thrown out of iMessage). Only in memory,
 * like screenshots. A restaurant menu came as two PDFs with 0.3 MB together.
 */
export const MAX_SOURCE_PDFS_PER_TASK = 3;
export const SOURCE_PDF_MAX_BYTES = 10_000_000;
export const SCREENSHOT_JPEG_QUALITY = 82;
/**
 * Screenshots to look at (style round, 2026-10-09, `src/browser/shot.ts`): the
 * browser session renders at double resolution so that text is sharp on the
 * iPhone; the chosen block gets 20 CSS pixels of room all around. At most 120
 * blocks are up for choice, each with 220 characters of text; Jev has 8 s for
 * it, otherwise the visible viewport is taken. A heading up to 160 px above the
 * block comes along as context, images in the block get 1.5 s to load. Blocks
 * up to eight screens high are up for choice; at most 1,600 px of them go into
 * the image, cut between two entries (a result list shows its beginning).
 */
export const SCREENSHOT_SCALE = 2;
export const SCREENSHOT_PAD = 20;
export const SCREENSHOT_MAX_REGIONS = 120;
export const SCREENSHOT_REGION_CHARS = 220;
/**
 * This much text of what a screenshot shows stays with it in the history
 * (`[file: …] … shows: …`). Live 2026-10-09: the owner asked about the days in
 * the image, and Serain checked other ones twice because it only knew
 * "[file: screenshot]".
 */
export const SCREENSHOT_CONTENT_CHARS = 600;
export const SCREENSHOT_CHOOSE_MS = 8_000;
export const SCREENSHOT_HEADING_GAP = 160;
export const SCREENSHOT_IMAGES_MS = 1_500;
export const SCREENSHOT_MAX_SCREENS = 8;
export const SCREENSHOT_MAX_HEIGHT = 1_600;
/** Empty margin in the block from this width on (a hidden ad slot) is cut off, padding is not. */
export const SCREENSHOT_EMPTY_EDGE = 48;
/**
 * From this share of the viewport on, a fixed element counts as an overlay and
 * is invisible for the capture (addendum D23 of 2026-10-08). A header is far
 * below, an ad interstitial or dimmer well above.
 */
export const SCREENSHOT_OVERLAY_SHARE = 0.25;

/**
 * The owner's tapbacks on Serain's messages (W24, D24). A 👎 on a message from
 * yesterday is no conversation anymore: only something fresh is followed by a
 * correction turn, anything older only lands in the audit log. The message is
 * quoted truncated.
 */
export const FEEDBACK_MAX_AGE_MS = 12 * 3_600_000;
export const FEEDBACK_QUOTE_MAX_CHARS = 300;

/**
 * `give_feedback` (package 2 of 2026-10-08): this many entries per day
 * (wall-clock time), after that the code refuses. The list needs no more, and a
 * prepared page should not be able to flood it.
 */
export const FEEDBACK_MAX_PER_DAY = 5;

/**
 * Typing indicator (D25). While the owner keeps typing after a message, the
 * turn waits: on "typing" until the next signal would be due, on "stopped
 * typing" for the normal debounce window. In total never longer than
 * `TYPING_MAX_HOLD_MS` from the first message.
 */
export const TYPING_HOLD_MS = 10_000;
/**
 * Window in which the owner's messages are bundled into one turn (D50). Was
 * 3 s; since latecomers can replace a turn as long as it has done nothing, the
 * window no longer has to wait for a second message. Photo and caption arrived
 * live 1.4 s apart: the replacement catches that.
 */
export const MESSAGE_DEBOUNCE_MS = 1_000;
export const TYPING_MAX_HOLD_MS = 25_000;

/** Answer length per model call. Also caps the fallback costs. */
export const MAX_OUTPUT_TOKENS = 1_000;

/**
 * Health check (W11). The heartbeat in the process writes one row per
 * component every `HEARTBEAT_INTERVAL_MS`; the watchdog outside the process
 * fires as soon as the last good timestamp is older than
 * `HEALTH_STALE_THRESHOLD_MS` (three missed heartbeats).
 */
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
export const HEALTH_STALE_THRESHOLD_MS = 15 * 60_000;

/**
 * Grace period after the start of `serain.service`. As long as the service has
 * not been running that long, the heartbeat had no chance to write a row at
 * all: "never a heartbeat" is then a restart, not an outage.
 *
 * Without this period every deploy causes false alarms: on 2026-09-18 the
 * watchdog opened three incidents on its first run after migration
 * `0002_health` (`component_status` was still empty), which the restarted
 * process immediately closed and reported to the owner one by one: three
 * messages for a planned restart.
 */
export const HEALTH_STARTUP_GRACE_MS = HEALTH_STALE_THRESHOLD_MS;

/**
 * Only from this duration on is a resolved outage worth a message. Anything
 * shorter is only in the incident log.
 * 10 min is the grace time of the Healthchecks.io check: anything shorter has
 * not alerted anyone outside anyway.
 */
export const INCIDENT_NOTIFY_MIN_DURATION_MS = 10 * 60_000;

/** At most one recovery notice per component within this window. */
export const INCIDENT_NOTIFY_MIN_INTERVAL_MS = 30 * 60_000;

/**
 * Confirmation protocol (D8.3, D14). A preview is valid this long; after that
 * it has expired and a late 👍 triggers nothing. Short enough that a tapback
 * hours later does not start an action the owner no longer has in mind, long
 * enough for "in a sec, i'm in a meeting".
 */
export const APPROVAL_TTL_MS = 30 * 60_000;
/** More open previews at once, nobody can tell apart anymore. */
export const MAX_PENDING_APPROVALS = 3;

/**
 * "yes, but tomorrow at 8" (addendum D14 of 2026-10-08). At the earliest 2 min,
 * otherwise it is "yes"; at the latest 7 days, frozen arguments do not stay
 * right longer. If Serain is not around at the time, it still runs up to
 * 30 min later, after that it is missed: a mail "tomorrow at 8" that goes out at
 * 14:00 is a different mail. At most 5 scheduled at once, at most 3 executed
 * per tick.
 */
export const APPROVAL_LATER_MIN_MS = 2 * 60_000;
export const APPROVAL_LATER_MAX_MS = 7 * 86_400_000;
export const APPROVAL_LATER_GRACE_MS = 30 * 60_000;
export const MAX_SCHEDULED_APPROVALS = 5;
export const APPROVAL_LATER_BATCH = 3;

/**
 * Scheduler (D9). The poller looks for due entries every 30 s; only a handful
 * run per round, so that a backlog after an outage does not hit the owner with
 * twenty messages at once.
 */
export const SCHEDULER_POLL_MS = 30_000;
export const SCHEDULER_BATCH = 3;
/**
 * Delay before the next attempt after a run failed, one per failed attempt;
 * after the last one the run has failed for good. Previously it was three
 * attempts at a 30 s interval: two minutes of channel trouble cost a reminder.
 * This way the scheduler bridges about 80 minutes.
 */
export const SCHEDULE_RETRY_DELAYS_MS = [1, 5, 15, 60].map((minutes) => minutes * 60_000);
export const MAX_ACTIVE_SCHEDULES = 50;

/**
 * Missions (D63, building block B). At most ten open: the owner cannot keep
 * more in view either. The next look at the earliest in an hour and at most
 * four times a day, even if a note after a prepared mail wants something else:
 * every wake-up is a model turn. If a woken turn sets nothing, the next look
 * comes by itself after three days; a mission never falls asleep silently.
 * A turn sees the last 30 notes.
 */
export const MISSION_MAX_ACTIVE = 10;
export const MISSION_GOAL_MAX_CHARS = 1_500;
export const MISSION_NOTE_MAX_CHARS = 800;
export const MISSION_MIN_CHECK_MINUTES = 60;
export const MISSION_MAX_CHECK_DAYS = 400;
/**
 * After untrusted content at most 60 days: a prepared reply mail must not be
 * able to put a mission to sleep until next year (security review of
 * 2026-10-13). A GDPR deadline with extension fits in.
 */
export const MISSION_TAINTED_MAX_CHECK_DAYS = 60;
export const MISSION_DEFAULT_CHECK_MS = 3 * 86_400_000;
export const MISSION_WAKES_PER_DAY = 4;
export const MISSION_NOTES_IN_TURN = 30;

/**
 * Forms (D63, building block C). The preview shows at most 40 fields with 400
 * characters each (a free-text field for a complaint fits in, nobody reads
 * more on the phone). After the click the code waits up to 15 s for quiet and
 * returns 2,500 characters of the page afterwards. At most two forms wait at
 * the same time, each as long as its preview plus two minutes: an open Chrome
 * costs memory, and a restart loses them anyway.
 */
export const FORM_FIELDS_MAX = 40;
export const FORM_VALUE_MAX_CHARS = 400;
export const FORM_SETTLE_MS = 15_000;
export const FORM_RESULT_MAX_CHARS = 2_500;
export const FORM_MAX_HELD = 2;
export const FORM_HOLD_GRACE_MS = 2 * 60_000;
/** From this delay on, a reminder says when it was meant for. */
export const SCHEDULE_LATE_NOTE_MS = 10 * 60_000;

/**
 * Executor (D4). A fetch is one page, not a crawl: limited in time, size and
 * what of it goes to the model. Everything that gets through here is untrusted
 * content and costs context.
 */
export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 2_000_000;
export const FETCH_MAX_REDIRECTS = 4;
export const FETCH_MAX_CHARS = 12_000;
/**
 * Structured data of a page (schema.org as JSON-LD, `tel:` links, footer):
 * `htmlToText` throws them away with `script` and `footer`, yet that is where
 * opening hours, phone, final price and whether an event is cancelled are.
 * Untrusted content, so tightly limited: per block, count, depth, and the whole
 * block is taken out of `FETCH_MAX_CHARS`, not added on top.
 */
export const PAGE_FACTS_LD_BLOCK_MAX_CHARS = 64_000;
export const PAGE_FACTS_LD_BLOCKS_MAX = 8;
export const PAGE_FACTS_LD_DEPTH_MAX = 24;
export const PAGE_FACTS_MAX_CHARS = 1_500;
/**
 * PDFs from the web (addendum D20 of 2026-10-09): menus, price lists, official
 * texts. They are read in the sandbox (`pdf_to_text`, at most 40 pages), never
 * in the service. The restaurant menu from the live test had 3.4 MB.
 */
export const FETCH_PDF_MAX_BYTES = 20_000_000;
export const PDF_TO_TEXT_TIMEOUT_MS = 30_000;
/** A PDF with at most three pages goes to the owner as one image per page (`pdf_to_pages`, decision of 2026-10-09). */
export const PDF_PAGES_MAX = 3;
export const PDF_TO_PAGES_TIMEOUT_MS = 30_000;
/**
 * Screenshots per task the executor may attempt, successful or not. Live
 * 2026-10-09: six attempts with the browser for a screenshot of the menu, the
 * task took 3.5 minutes instead of under one.
 */
export const MAX_SCREENSHOT_ATTEMPTS_PER_TASK = 2;

/**
 * Web search. Tavily's free tier gives 1,000 searches per month and does not
 * bill after that, but refuses. Our own cap is below, so that Serain says
 * "search quota is used up" before the provider does it with an error.
 */
export const MAX_SEARCHES_PER_MONTH = 900;
export const SEARCH_MAX_RESULTS = 6;
export const SEARCH_TIMEOUT_MS = 12_000;

/**
 * Background tasks: steps per task, concurrently running ones, total duration.
 * 12 instead of 10 since 2026-10-09: videos of three people plus prices need,
 * per person, a search for their channels and a video search, then page and two
 * PDFs of the menu; with 10 the second PDF was missing in the eval.
 */
export const EXECUTOR_MAX_STEPS = 12;
export const EXECUTOR_MAX_CONCURRENT = 2;
export const EXECUTOR_TIMEOUT_MS = 4 * 60_000;
/**
 * If a task's result turn fails before it has done anything, it runs again
 * once after this pause, with the same report from storage. Previously the
 * finished report was gone, and the owner only got a note that writing it up
 * was stuck.
 */
export const TASK_RESULT_RETRY_MS = 60_000;
/**
 * If a turn on a message from the owner fails before it has done anything with
 * an effect, it runs again by itself once after this pause; the owner is told
 * Serain will try again in 5 min (decision 8 of the style round, addendum D52 of
 * 2026-10-10). The sentence names the number, so it depends on this value.
 */
export const TURN_RETRY_MS = 5 * 60_000;
/**
 * Thorough research (money, health, law; audit 2026-10-05): at least this many
 * primary sources, and in exchange more steps and time. Runs cold, because the
 * step limit belongs to the shape of the prewarmed process (D50).
 */
export const EXECUTOR_THOROUGH_MIN_SOURCES = 5;
export const EXECUTOR_THOROUGH_MAX_STEPS = 18;
export const EXECUTOR_THOROUGH_TIMEOUT_MS = 8 * 60_000;
/**
 * Videos in a task (D61): `media_watch` has its own steps next to the ones
 * above, so that searching for the videos does not use up the watching (live
 * finding 2026-10-09: eight searches for three creators, then no step was left
 * for the first video). From the first video on, the longer time limit applies:
 * measured 4 to 60 s per video, at most `MEDIA_TOOL_TIMEOUT_MS`.
 */
export const EXECUTOR_MAX_WATCHES = 4;
/**
 * The last minute of a task belongs to the report, like the last step (live
 * finding 2026-10-09: three videos watched, report fully written, then the time
 * limit came while the executor was shortening it, and everything was gone).
 * After that the executor only accepts `finish_task`.
 */
export const EXECUTOR_WRAP_UP_MS = 60_000;
/** Length of the report. At 3,000 the executor kept shortening a report on three videos until time was up. */
export const EXECUTOR_REPORT_MAX_CHARS = 6_000;
/**
 * Things to choose from as fixed data next to the report (`picks`, addendum D61
 * of 2026-10-09). One ranking had 23 dishes; three creators were asked for.
 */
export const PICK_GROUPS_MAX = 5;
export const PICK_ITEMS_MAX = 30;
/** At most this many bubbles for the list (`OUTBOUND_MAX_PER_HOUR` applies to it too). */
export const PICK_BUBBLES_MAX = 6;
/**
 * Findings on the side (`asides` on `finish_task`): what the executor also saw
 * while researching that flips the answer for the asked-about day or saves the
 * owner a trip. At most two, one sentence each; in the result turn at most half
 * a sentence.
 */
export const ASIDES_MAX = 2;
export const ASIDE_MAX_CHARS = 160;
export const EXECUTOR_WATCH_TIMEOUT_MS = 8 * 60_000;
/**
 * Two-step codes (D56): this long a sign-in waits for the owner's code, and for
 * this long afterwards a late one is still intercepted instead of given to the
 * model. The task's time limit (`EXECUTOR_TIMEOUT_MS`) only starts after the
 * sign-in.
 */
export const SITE_CODE_WAIT_MS = 5 * 60_000;
export const SITE_CODE_LATE_MS = 10 * 60_000;

/**
 * After a crash (D52): an unanswered message from the owner may be this old
 * for the start to still catch up on it. Anything older they have solved
 * otherwise or forgotten; an answer to it would come out of nowhere.
 */
export const RECOVERY_MAX_AGE_MS = 24 * 3_600_000;

/** Audit log self-test (W9): how often it is checked that the log still writes and holds. */
export const AUDIT_SELFTEST_INTERVAL_MS = 7 * 24 * 3_600_000;

/**
 * Heartbeat (D9, W12): Serain wakes itself every hour. The numbers here are the
 * rules of silence that no prompt can soften. Never at night; never in the
 * middle of a conversation; and in the first weeks at most one proactive
 * message per day: staying quiet early is what earns the permission to be
 * useful later.
 */
export const PROACTIVE_INTERVAL_MS = 60 * 60_000;
export const PROACTIVE_QUIET_FROM_HOUR = 22;
export const PROACTIVE_QUIET_UNTIL_HOUR = 8;
export const PROACTIVE_IDLE_MS = 30 * 60_000;
export const PROACTIVE_MAX_PER_DAY = 1;
/**
 * Probation (W12, D26): after every change to the proactive behavior, Serain
 * speaks up only at high priority for this long. A 👎 on a proactive message
 * restarts the period.
 */
export const PROACTIVE_PROBATION_MS = 3 * 24 * 3_600_000;
/** A heartbeat turn: one message, no tapback, few steps. */
export const PROACTIVE_TURN_LIMITS = { maxMessages: 1, maxReactions: 0, maxSteps: 3 } as const;
/**
 * The mail turn like a proactive one, with room for up to two offers from the
 * mail (`calendar_offer`, addendum D33 of 2026-10-10): message, two previews,
 * end. A preview is not a message of the model.
 */
export const MAIL_TURN_LIMITS = { maxMessages: 1, maxReactions: 0, maxSteps: 5 } as const;

/**
 * Sandbox (D8.7, D20). A program is a calculation, not a service: short, small,
 * and only an excerpt of the output goes to the model. The hard caps sit in the
 * helper (`deploy/sandbox/helper.mjs`); these here are tighter or equal.
 */
export const SANDBOX_CODE_TIMEOUT_MS = 20_000;
export const SANDBOX_CODE_MAX_CHARS = 20_000;
export const SANDBOX_OUTPUT_MAX_CHARS = 6_000;

/**
 * Computing in the chat (D58). The owner is waiting for the answer: 15 s
 * instead of 20. At most three files and 24 MB together; the helper's cap is
 * 25 MB including code.
 */
export const COMPUTE_TIMEOUT_MS = 15_000;
export const COMPUTE_MAX_FILES = 3;
export const COMPUTE_MAX_FILE_BYTES = 24 * 1024 * 1024;

/**
 * Analyzing one's own data (D63, building block D). At most four sources per
 * call, one year back (events also one year ahead). Mails only as headers, at
 * most 8 KB each (received chains of large senders get long, the text is
 * missing anyway), at most 3,000 as with cleanup; Gmail fetches every header
 * individually, 600 there, which is about 20 s with 8 parallel fetches.
 * Together it stays below the sandbox cap. 30 s of computing, as much as the
 * helper `compute` allows; loading from the mailbox may take as long as with
 * cleanup.
 */
export const DATA_MAX_INPUTS = 4;
export const DATA_MAX_DAYS = 366;
export const DATA_MAIL_MAX_ROWS = 3_000;
export const DATA_GMAIL_MAX_ROWS = 600;
export const DATA_GMAIL_PARALLEL = 8;
export const DATA_MAIL_HEADER_MAX_BYTES = 8 * 1024;
export const DATA_CALENDAR_MAX_ROWS = 2_000;
export const DATA_MAX_BYTES = 24 * 1024 * 1024;
export const DATA_TIMEOUT_MS = 30_000;

/**
 * Voice messages from Serain (D59). Piper needs about 0.4 s per second of
 * speech plus 2 s startup on the server with two cores; 500 characters are a
 * good 30 s of speech and just under 15 s of waiting. Longer, a voice message
 * is no longer pleasant anyway, and a list belongs in text.
 */
export const VOICE_TEXT_MAX_CHARS = 500;
export const SANDBOX_VOICE_TIMEOUT_MS = 45_000;
/**
 * The voice via OpenRouter (addendum D59): costs per character, so a cap in the
 * code. 20 per day and $1 per month are a multiple of what the owner needs (an
 * answer of 500 characters costs $0.0075), and keep a loop small. Beyond that,
 * Piper speaks locally, for free.
 */
export const SPEECH_API_MAX_PER_DAY = 20;
export const SPEECH_API_MAX_MONTH_USD = 1;
export const SPEECH_API_TIMEOUT_MS = 20_000;
export const SANDBOX_AUDIO_TIMEOUT_MS = 30_000;

/**
 * Attachments (D21). A photo from an iPhone has 2 to 5 MB, a minute of voice
 * message under 1 MB; 12 MB is the sandbox helper's cap. At most two minutes are
 * transcribed (in the helper), and what of it goes to the model is capped like
 * any other context.
 */
export const ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024;
export const ATTACHMENT_MAX_PER_TURN = 3;
export const SANDBOX_IMAGE_TIMEOUT_MS = 30_000;
export const SANDBOX_TRANSCRIBE_TIMEOUT_MS = 240_000;
export const TRANSCRIPT_MAX_CHARS = 4_000;
export const IMAGE_DESCRIPTION_MAX_CHARS = 1_500;

/**
 * Watching videos (D61). At most 30 minutes are downloaded (in the helper), the
 * model sees at most the first 15 (`video_compact`). YouTube does not go
 * through the sandbox, and the length cannot be known beforehand; there the
 * model's context caps it (about 3 hours). Measured on 2026-10-08 on the
 * server: download 2 to 4 s, compacting 20 minutes 36 s, watching 15 minutes
 * 62 s, an hour of YouTube 30 to 37 s. The tool stays below the task's time
 * limit (`EXECUTOR_TIMEOUT_MS`).
 */
export const MEDIA_TOOL_TIMEOUT_MS = 210_000;
export const MEDIA_FETCH_TIMEOUT_MS = 90_000;
export const MEDIA_COMPACT_TIMEOUT_MS = 90_000;
export const VIDEO_MODEL_TIMEOUT_MS = 120_000;
export const VIDEO_DESCRIPTION_MAX_CHARS = 8_000;
/** A post without a video: at most this many images (also in `deploy/sandbox/media_fetch.py`). */
export const MEDIA_MAX_IMAGES = 10;
/**
 * Video search on YouTube (addendum D61 of 2026-10-09): the search page carries
 * its hits as JSON in the HTML, measured 1.6 MB from the server. This many hits
 * go to the model.
 */
export const VIDEO_SEARCH_MAX_BYTES = 6_000_000;
export const VIDEO_SEARCH_MAX_HITS = 10;
export const VIDEO_MAX_OUTPUT_TOKENS = 3_000;
/**
 * What a single call can cost at most: a full context of 1M tokens at $0.50
 * plus output. If the monthly total is closer to the cap, no more video runs,
 * instead of blowing the cap with one long video.
 */
export const VIDEO_WORST_CASE_USD = 0.55;

/**
 * Files the owner sends, for passing on by mail (addendum D34 of 2026-10-08).
 * They live only in memory: a day is enough for "send this to mom", ten files
 * and 60 MB keep the process small. Per mail at most three attachments and
 * 12 MB together; base64 makes a good 16 MB of that, below the limit of GMX
 * (20 MB) and Gmail (25 MB).
 */
export const FILE_SHELF_TTL_MS = 24 * 60 * 60_000;
export const FILE_SHELF_MAX_FILES = 10;
export const FILE_SHELF_MAX_BYTES = 60 * 1024 * 1024;
export const MAIL_SEND_MAX_FILES = 3;
export const MAIL_SEND_MAX_FILE_BYTES = 12 * 1024 * 1024;

/**
 * Mail (D31, W3). Tight per call: few mails, few days, truncated text. The
 * source of a mail is capped on fetch, so that a 30 MB attachment does not end
 * up in memory.
 */
export const MAIL_SEARCH_MAX_RESULTS = 10;
export const MAIL_SEARCH_MAX_DAYS = 90;
export const MAIL_READ_MAX_CHARS = 6_000;
export const MAIL_SOURCE_MAX_BYTES = 400_000;
/**
 * Opening attachments of a mail (`mail_attachment`, addendum D31 of
 * 2026-10-12): the same cap as for the owner's attachments (D21). With IMAP the
 * whole mail comes, base64 makes a good 16 out of 12 MB; anything larger is not
 * loaded at all. A PDF goes to the model as text, capped like a mail; a scan
 * without text with at most three pages (`PDF_PAGES_MAX`) is transcribed page
 * by page.
 */
export const MAIL_ATTACHMENT_MAX_BYTES = ATTACHMENT_MAX_BYTES;
export const MAIL_ATTACHMENT_SOURCE_MAX_BYTES = 17 * 1024 * 1024;
export const MAIL_ATTACHMENT_MAX_CHARS = 8_000;
export const MAIL_ATTACHMENT_PAGE_MAX_CHARS = 3_000;
/** Fetch, PDF in the sandbox and looking at up to three pages, one after another. */
export const MAIL_ATTACHMENT_TOOL_TIMEOUT_MS = 180_000;
export const MAIL_MAX_RECIPIENTS = 5;
/** The preview shows the whole text in one bubble (D14, D34), so it stays short. */
export const MAIL_SEND_MAX_CHARS = 2_500;
/**
 * Mail series (D63, building block E): at most ten individual mails with one
 * preview. Nobody reads more carefully in one preview, and a request to twenty
 * places is two previews.
 */
export const MAIL_BATCH_MAX = 10;
/** `mail_code` only sees mails of this age (W17): a code from yesterday is no code anymore. */
export const MAIL_CODE_MAX_AGE_MS = 15 * 60_000;
/** Cleanup (D37): this far back, this many headers, this many senders per preview. */
export const MAIL_CLEANUP_MAX_DAYS = 365;
export const MAIL_CLEANUP_SCAN_MAX = 3_000;
/**
 * Gmail delivers headers only mail by mail (addendum D37 of 2026-10-13) and
 * allows 6,000 units per minute per user (`totalQueryCostPerMinutePerUser`).
 * Measured on 2026-10-13: after 305 to 390 fetches of a mail the minute is
 * full, individually as in a batch, so about 20 units per fetch. Cleanup
 * fetches at most 240 mails per minute, the rest stays for trigger, search and
 * sending; a scan at most 1,000 mails (a good four minutes, below
 * `MAIL_BULK_TOOL_TIMEOUT_MS`). This many side by side, so that a fetch's
 * waiting time does not drag down the pace. The adapter remembers what is
 * already fetched for up to `MAIL_CLEANUP_GMAIL_CACHE` mails: the headers of a
 * Gmail mail never change.
 */
export const MAIL_CLEANUP_GMAIL_PER_MINUTE = 240;
export const MAIL_CLEANUP_GMAIL_SCAN_MAX = 1_000;
export const MAIL_CLEANUP_GMAIL_PARALLEL = 4;
export const MAIL_CLEANUP_GMAIL_CACHE = 2 * MAIL_CLEANUP_SCAN_MAX;
/** A whole mailbox in one preview: the owner approves once, not in rounds (2026-09-21). */
export const MAIL_CLEANUP_MAX_SENDERS = 100;
export const MAIL_CLEANUP_LIST_SENDERS = 100;
/** `spam` hits any address, not just bulk mail: few per preview, and always named individually. */
export const MAIL_CLEANUP_MAX_SPAM = 12;
/** Senders without list headers get their own rows, so that they do not crowd out the newsletters. */
export const MAIL_CLEANUP_LIST_OTHERS = 15;
/** In the spam folder every sender counts individually: the one real mail is the one that occurs only once. */
export const MAIL_CLEANUP_LIST_SPAM = 60;
export const MAIL_SPAM_MAX_RESCUE = 12;
/** This many senders in the spam folder `mail_senders` checks for whether the owner has already corresponded with them (addendum D37 of 2026-10-10). */
export const MAIL_SPAM_CORRESPONDENCE_CHECKS = 25;
export const UNSUBSCRIBE_TIMEOUT_MS = 15_000;
/** At most this many unsubscribe pages one `mail_cleanup` opens (addendum D37 of 2026-10-03): up to 105 s each, two side by side. */
export const MAIL_UNSUBSCRIBE_PAGES_MAX = 10;

/**
 * Mail trigger (D33, W14). Checked every minute, at most 10 new mails per
 * round; notified in bundles, at the earliest every 15 min (D9) and at most
 * five times a day.
 */
export const MAIL_POLL_INTERVAL_MS = 60_000;
export const MAIL_POLL_BATCH = 10;
export const MAIL_CLASSIFY_MAX_CHARS = 1_500;
/** At most this many attachment names `judge` sees (addendum D33 of 2026-10-08). */
export const MAIL_CLASSIFY_MAX_ATTACHMENTS = 10;
export const MAIL_KNOWN_ITEMS = 12;
export const MAIL_KNOWN_MAX_AGE_MS = 45 * 24 * 3_600_000;
/**
 * "What is open?" (`mail_open_items`): this far back by default and at most
 * (like the trigger's known items), and this many entries one call reads. More
 * than 40 open items are no longer information, but a mailbox.
 */
export const MAIL_OPEN_DEFAULT_DAYS = 14;
export const MAIL_OPEN_MAX_DAYS = 45;
export const MAIL_OPEN_MAX_ITEMS = 40;
/** This many of the mails waiting on the owner `mail_open_items` checks for a reply from them (addendum D33 of 2026-10-10). */
export const MAIL_OPEN_REPLY_CHECKS = 10;
export const MAIL_NOTIFY_MIN_INTERVAL_MS = 15 * 60_000;
export const MAIL_NOTIFY_MAX_PER_DAY = 5;
export const MAIL_NOTIFY_BUNDLE = 5;
/** For this long a reply to a mail Serain sent counts as a reply for the owner (addendum D33 of 2026-10-13). */
export const MAIL_SENT_REPLY_MAX_AGE_MS = 45 * 24 * 3_600_000;
/** Below this confidence of the classifier a mail counts as "nothing" (D33). */
export const MAIL_CLASSIFY_MIN_CONFIDENCE = 0.6;
/**
 * Findings from the mail (addendum D33 of 2026-10-10). An event from a booking
 * mail only counts up to this far ahead and this long (a week of vacation yes,
 * an annual subscription no). An offer for the calendar is valid as long as a
 * preview the owner does not see right away: until the next evening.
 */
export const FINDING_EVENT_MAX_DAYS_AHEAD = 400;
export const FINDING_EVENT_MAX_HOURS = 21 * 24;
export const CALENDAR_OFFER_TTL_MS = 24 * 3_600_000;
/** This close a calendar event has to be to the found one to count as "already in there". */
export const FINDING_CALENDAR_MATCH_MS = 90 * 60_000;

/** Calendar (D32, D54, W3): a time range, never the whole calendar. As with the Mac companion (D28). */
export const CALENDAR_LIST_MAX_DAYS = 31;
export const CALENDAR_LIST_MAX_EVENTS = 50;
/** A series (`repeat`) reaches at most this far; a year of lectures fits, "forever" does not. */
export const CALENDAR_REPEAT_MAX_DAYS = 366;
/**
 * Finding a time (`calendar_free`): at most three suggestions, so that the
 * other side chooses instead of reads; at most two weeks, and this many events
 * are read, so that no gap depends on a truncated event.
 */
export const CALENDAR_FREE_MAX_SLOTS = 3;
export const CALENDAR_FREE_MAX_DAYS = 14;
export const CALENDAR_FREE_MAX_EVENTS = 250;
/** This much lead time the earliest suggestion has. */
export const CALENDAR_FREE_LEAD_MS = 2 * 3_600_000;
/** iCloud over CalDAV (D54): one request, not the whole turn. */
export const CALDAV_TIMEOUT_MS = 20_000;
/** The list of calendars rarely changes; otherwise every query costs a round of PROPFIND. */
export const CALDAV_CALENDAR_CACHE_MS = 10 * 60_000;
/** At most this many occurrences of a series are expanded, even without an end (RRULE per minute). */
export const CALDAV_MAX_OCCURRENCES = 5_000;

/**
 * Browser with Jev as the pilot (D35). Since the rebuild, a step costs about
 * one second (Jev 0.4 s, action and waiting 0.3 to 1 s), so twenty steps are
 * cheaper than twelve used to be. The thresholds are those of the pattern
 * (jev-browser) and depend on the pinned model version.
 */
export const BROWSE_MAX_STEPS = 20;
/** This many ineffective or failed actions in a row, then the run counts as stuck. */
export const BROWSE_MAX_FUTILE = 4;
export const BROWSE_TIMEOUT_MS = 90_000;
/** This much later than the pilot, the hard limit around the whole call kicks in, in case a single step never returns. */
export const BROWSE_HARD_MARGIN_MS = 15_000;
/** A click that does not take after two seconds will not take this way; then the click comes without pre-check. Covered elements are not up for choice at all. */
export const BROWSE_ACTION_TIMEOUT_MS = 2_000;
export const BROWSE_MAX_ELEMENTS = 200;
/** Embedded frames that belong to the snapshot. Ad frames are small and drop out by the minimum size. */
export const BROWSE_MAX_FRAMES = 4;
/** Options per select list. Jev knows at most 255 options per question; all lists of a page share one. */
export const BROWSE_MAX_OPTIONS = 40;
/** Text of the visible viewport that goes to Jev. Unnecessary state lowers the hit rate (Typesafe, notes on jev-1.13). */
export const BROWSE_STATE_TEXT_CHARS = 4_000;
export const BROWSE_GOAL_THRESHOLD = 0.85;
export const BROWSE_STUCK_THRESHOLD = 0.85;
/** A `DONE` from the pilot only counts if it considers the goal at least half reached; otherwise the next best action is taken. */
export const BROWSE_DONE_MIN_GOAL = 0.5;
/** From this confidence on, the pilot fills further empty fields in the same step instead of asking again per field. */
export const BROWSE_FILL_CONFIDENCE = 0.8;
/** For this many fields in the viewport the pilot also asks which value belongs in them. */
export const BROWSE_MAX_VALUE_FIELDS = 6;
export const BROWSE_TYPE_MAX_CHARS = 120;
/** This many values a task may hand over for typing: start, destination, date, time and some slack. */
export const BROWSE_MAX_INPUTS = 8;
/** After an action, wait until the page is quiet and nothing loads anymore, at most this long. Usually 0.3 s. */
export const BROWSE_SETTLE_MS = 4_000;
/**
 * Requests to a third-party website (banners, tracking) only count as loading
 * this long after an action, counted from the action; on first load in full
 * (that is often where the cookie dialog of a third-party service comes from).
 * On rmv.de, requests to `rmv.trm.digital` stayed open after every click and
 * held the action for the full 4 s each time (2026-10-02). Content from a
 * third-party API (a search at a service provider) is there within this time.
 */
export const BROWSE_THIRD_PARTY_MS = 1_000;
/** An element that is gone after typing is searched for this briefly (Wikipedia swaps the search field). */
export const BROWSE_FIELD_RECHECK_MS = 300;
/** Without new nodes for this long, the page counts as quiet. */
export const BROWSE_QUIET_MS = 200;
/** If nothing happens at all after a click or input, wait this long for the first reaction: pages often load the code for it later. */
export const BROWSE_GRACE_MS = 700;
/** A single call into the page (snapshot, counting, measuring a frame) may take this long. Usually 5 to 100 ms. */
export const BROWSE_PAGE_CALL_MS = 3_000;
/** The same for embedded frames: whoever does not answer in this time does not belong to the snapshot. */
export const BROWSE_FRAME_CALL_MS = 800;
/** This long a field with a suggestion list waits after typing for the first entries. */
export const BROWSE_SUGGEST_MS = 1_200;
/** If an action loads scripts, this much time passes after they arrive until they run and rebuild the page (github.com: 0.4 s). */
export const BROWSE_HYDRATE_MS = 500;
/** The action "wait", when results are visibly still loading. */
export const BROWSE_WAIT_MS = 800;

/**
 * Watchers (H2, D43). Fixed types, checked in code, a model turn only on a
 * hit. Fetched rarely and little: every 30 min one page per watcher, at most two
 * fetches per round of the 30 s poller, so that ten watchers are never ten
 * fetches at once. One that is unreadable after five errors in a row (anchor
 * gone, 404, wrong answer) counts as broken and signs off once. Transient errors
 * (network, timeout, 5xx, 429) do not count for that: they stretch the interval
 * up to at most one hour, and only after a day of uninterrupted failure does the
 * watcher give up.
 */
export const WATCH_URL_INTERVAL_MS = 30 * 60_000;
export const WATCH_FETCHES_PER_ROUND = 2;
/** This many due watchers one round looks at (fetches, expiry, deferred hits). */
export const WATCH_DUE_BATCH = 10;
/** A claimed watcher is locked for other rounds this long; if the process dies in the middle, it is due again afterwards. */
export const WATCH_CLAIM_LEASE_MS = 5 * 60_000;
export const WATCH_MAX_FAILURES = 5;
/** Longest interval between two fetches while a source is temporarily not answering. */
export const WATCH_BACKOFF_MAX_MS = 60 * 60_000;
/** This long a watcher may go without a single successful fetch before it signs off. */
export const WATCH_GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
export const WATCH_MAX_ACTIVE = 10;
export const WATCH_DEFAULT_DAYS = 14;
export const WATCH_MAX_DAYS = 60;
/** A cap of its own next to the heartbeat's: the owner was waiting for these hits, but not for twenty a day. */
export const WATCH_MAX_HITS_PER_DAY = 6;
/** The number has to be this close behind the anchor, otherwise it belongs to something else. */
export const WATCH_ANCHOR_WINDOW_CHARS = 120;
/**
 * If `watch_create` finds nothing at the given address, the code searches for
 * the anchor on the same host and tries this many hits (D43, addendum). Each
 * costs a fetch; three are enough if the search fits at all.
 */
export const WATCH_RESOLVE_CANDIDATES = 3;
/** The watched section behind the anchor for `status_changes`. */
export const WATCH_SECTION_CHARS = 300;
/** A new section only counts if it still looks that way on the next fetch; that one then comes earlier. */
export const WATCH_CONFIRM_DELAY_MS = 5 * 60_000;
/** This much of the changed section the hit turn gets to read, framed as untrusted content. */
export const WATCH_INCOMING_SECTION_CHARS = 400;
/** Remembered mail IDs per watcher, so that the same mail never reports twice. */
export const WATCH_SEEN_MAIL_IDS = 20;
/** This many matching mails a deferred hit collects before it summarizes them until the morning. */
export const WATCH_PENDING_MAILS = 5;

/**
 * Delivery as a health component (D44). Photon's stream can stand while every
 * message fails ("Target not allowed" after a number change, Spectrum's
 * delivery bug from August). Counted is what the channel throws on sending;
 * delivery is unhealthy at three failures in a row or at least half of at least
 * four attempts within the window. It only becomes healthy again with a
 * success, not through silence.
 */
export const DELIVERY_WINDOW_MS = 30 * 60_000;
export const DELIVERY_MAX_CONSECUTIVE_FAILURES = 3;
export const DELIVERY_RATIO_MIN_ATTEMPTS = 4;
export const DELIVERY_MAX_FAILURE_RATIO = 0.5;
/** Failure reason in the audit log and `component_status`: Photon's reasons are short, a stack trace is not. */
export const DELIVERY_REASON_MAX_CHARS = 200;

/**
 * Recipient check in the preview of `mail_send` (addendum D34, V6). Each source
 * gets at most this long; whoever takes longer counts as "not checkable", so
 * that the preview never hangs on a hanging mailbox or a sleeping Mac.
 */
export const RECIPIENT_CHECK_TIMEOUT_MS = 5_000;
/** This far back the mailbox searches for mails from and to the address. */
export const RECIPIENT_HISTORY_DAYS = 3 * 365;
/** This many hits a source checks closely: IMAP and PostgREST only search for substrings. */
export const RECIPIENT_VERIFY_MAX = 20;
/**
 * How old the first mail from a domain has to be at least for Serain to link
 * its home page after a confirmed mail (addendum D8.4 of 2026-10-12). A freshly
 * registered phisher's domain the owner has never written to.
 */
export const KNOWN_SENDER_MIN_AGE_DAYS = 30;
/** This many hits per folder the mailbox checks closely for that: IMAP only searches for substrings. */
export const KNOWN_SENDER_CHECK_MAX = 10;

/**
 * Proactive occasions and morning briefing (V4, H3). The code detects
 * occasions from calendar and mail commitments, a model runs only on a hit
 * (D19). The rules of silence from above still apply; only the new numbers are
 * here.
 *
 * The calendar is read at most every ten minutes on the scheduler's clock (one
 * request, seven days), in between the heartbeat computes on the cached state.
 * Ten minutes of delay do not matter with 90 minutes of lead time, and 144
 * requests a day are far below Google's quota.
 */
export const CALENDAR_POLL_MS = 10 * 60_000;
/**
 * The cached state may be at most this old for `set_reminder` to name busy
 * times from it. Throttled, the heartbeat no longer reads; a state from
 * yesterday knows no event that has been moved or cancelled since.
 */
export const BUSY_VIEW_MAX_AGE_MS = 60 * 60_000;
/** This far ahead events count as an occasion (travel, change) and for the snapshot. */
export const CALENDAR_LOOKAHEAD_DAYS = 7;
/**
 * Events with a location that the chat sees as a reference in the `<context>`
 * (addendum D54 of 2026-10-10): the next ones, at most this many, only from the
 * heartbeat's cached state and only as far ahead as it.
 */
export const CALENDAR_REFS_MAX = 12;
/** This long the location of an event that goes to the executor may be; longer is no location anymore. */
export const CALENDAR_REF_LOCATION_MAX_CHARS = 200;
/** Lead time for "you need to leave": an event with a location that begins within this time. */
export const TRAVEL_LEAD_MS = 90 * 60_000;
/**
 * High priority may exceed the daily cap once. A missed deadline or an event
 * that is suddenly an hour earlier tomorrow morning should not fail because an
 * ordinary message already went out at noon. Only once, because "high" can
 * follow from untrusted content: whoever invites the owner and moves the event
 * ten times gets at most two messages a day out of it.
 */
export const PROACTIVE_HIGH_EXTRA_PER_DAY = 1;
/** A due date from a mail that lies further away is a reading error of the model, not a deadline. */
export const DUE_MAX_DAYS = 400;
/**
 * Own calendar change (`calendar_update`): the calendar is faster than the
 * entry in the audit log. This much earlier than the last confirmed state of an
 * event an own change still counts.
 */
export const OWN_EDIT_MARGIN_MS = 5 * 60_000;
/**
 * Morning briefing: 30 min before the first event with a time, not before
 * 06:30, not after 08:00, without an event at 08:00. After 10:00 it is no
 * morning briefing anymore: if the process was gone in the morning, it is
 * skipped for the day instead of being made up at noon. Travel only counts until
 * 10:00, later the heartbeat takes over with its 90 minutes of lead time.
 */
export const MORNING_LEAD_MS = 30 * 60_000;
export const MORNING_EARLIEST = { hour: 6, minute: 30 } as const;
export const MORNING_LATEST = { hour: 8, minute: 0 } as const;
export const MORNING_EXPIRES_HOUR = 10;
export const MORNING_TRAVEL_BEFORE_HOUR = 10;
/** This many events of the day the model sees in the morning briefing; titles and locations truncated. */
export const MORNING_MAX_EVENTS = 12;
export const OCCASION_TEXT_MAX_CHARS = 120;

/**
 * Prewarmed model processes (D50). The Agent SDK starts its own CLI process per
 * request; the start costs about 0.6 s on the Mac and takes about 250 MB. At
 * most this many processes wait for their turn at the same time, and none
 * waits longer than the maximum age, after that it is replaced.
 */
export const MODEL_WARM_MAX = 3;
export const MODEL_WARM_MAX_AGE_MS = 20 * 60_000;
/** This long a process may take for its initialization. */
export const MODEL_WARM_INIT_TIMEOUT_MS = 30_000;

/**
 * Connections from the web interface (D51). Server and web interface only meet
 * in the database; this often the server checks whether the owner wants to
 * connect or disconnect something right now. A query over a partial index that
 * almost always finds nothing. Idle every 10 s (the web interface waits 20 s for
 * the first step), after a round with work every 2 s for the duration of an
 * authorization, so that the way back from the provider arrives right away.
 * Runs over Postgres (`src/db/pg.ts`), not over PostgREST: until 2026-10-11,
 * every 2 s meant 43,000 PostgREST requests a day, the largest item in
 * Supabase's logs.
 */
export const CONNECTOR_POLL_MS = 2_000;

/**
 * At most this long a query over the direct connection (`src/db/pg.ts`) may
 * take. After that the connection is discarded and rebuilt: a hanging pooler
 * must not stop the scheduler's clock.
 */
export const DB_QUERY_TIMEOUT_MS = 15_000;
export const CONNECTOR_IDLE_POLL_MS = 10_000;
/** A tool of a connected service may take this long; an image analysis at the provider can take 25 s. */
export const CONNECTOR_TOOL_TIMEOUT_MS = 40_000;
/** This much text from a tool result the model sees. */
export const CONNECTOR_RESULT_MAX_CHARS = 8_000;
/**
 * Bank (D51): a balance read counts as fresh this long. Whether and how strictly
 * the bank limits requests is written nowhere; if it refuses, Serain does not
 * ask for this long (without the bank's `Retry-After`; Enable Banking recommends
 * 6 hours) and answers from the last state.
 */
export const BANK_CACHE_MS = 15 * 60_000;
export const BANK_BLOCK_MS = 6 * 60 * 60_000;
/** This far back Serain reads transactions, and at most this many one call shows. */
export const BANK_HISTORY_DAYS = 90;
export const BANK_MAX_TRANSACTIONS = 40;
/** Balances per account: the interface knows six kinds, more is no information anymore. */
export const BANK_MAX_BALANCES = 8;

/**
 * Files to the owner (.ics, vCard, PDF), generated in code. A PDF from 20,000
 * characters of text has about 10 pages and 60 KB; the limits only catch
 * outliers.
 */
export const FILE_MAX_BYTES = 1_000_000;
export const FILE_PDF_MAX_CHARS = 20_000;
export const FILE_PDF_MAX_PAGES = 20;

/**
 * Reporting broken credentials (src/health/integrations.ts). Only once no
 * access has worked for this long: IMAP servers and iCloud have short hiccups,
 * and the mail trigger catches up on what it missed in that time.
 */
export const INTEGRATION_DOWN_AFTER_MS = 20 * 60_000;
/** From here on, a disrupted credential is in the `<context>` of every turn; a single hiccup is not. */
export const INTEGRATION_DISRUPTED_AFTER_MS = 5 * 60_000;
/** Advance warning before an authorization expires (D51, bank after at most 180 days), checked once per hour. */
export const CONNECTOR_EXPIRY_WARN_MS = 7 * 86_400_000;
export const CONNECTOR_EXPIRY_CHECK_MS = 60 * 60_000;
