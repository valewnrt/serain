import { z } from "zod";
import {
  ASIDE_MAX_CHARS,
  ASIDES_MAX,
  BROWSE_MAX_INPUTS,
  BROWSE_TYPE_MAX_CHARS,
  EXECUTOR_REPORT_MAX_CHARS,
  FETCH_MAX_CHARS,
  MAX_SEARCHES_PER_MONTH,
  MEDIA_TOOL_TIMEOUT_MS,
  SANDBOX_CODE_MAX_CHARS,
  SANDBOX_CODE_TIMEOUT_MS,
  SANDBOX_OUTPUT_MAX_CHARS,
  SOURCE_PDF_MAX_BYTES,
  MAX_SCREENSHOT_ATTEMPTS_PER_TASK,
} from "../config/limits.js";
import { describeRun, SandboxError, type Sandbox } from "../sandbox/client.js";
import { monthSearches, recordSearch } from "../db/usage.js";
import { defineTool, type ToolDefinition } from "../agent/tools/types.js";
import { CompanionFailure, CompanionOffline, type Companion } from "../companion/client.js";
import { audit } from "../db/audit.js";
import { describeKinds, type ConfidentialGuard } from "../security/confidential.js";
import { FetchError, fetchPage, htmlToText, pageFacts, withFacts } from "./fetch.js";
import { BlockedAddressError, checkUrl } from "./netguard.js";
import type { SearchProvider } from "./search.js";
import { isPdfAddress, type WebBrowser } from "../browser/index.js";
import { BrowseError } from "../browser/session.js";
import { TypesafeError } from "../browser/typesafe.js";
import { MEDIA_PLATFORM_LABEL, type MediaWatcher } from "../media/watch.js";
import { pdfToText } from "../media/pdf.js";
import { searchVideos, VideoSearchError, type VideoHit } from "../media/search.js";
import { picksSchema, type PickGroup } from "./picks.js";
import { dropUnbackedLinks, previewTarget } from "../security/links.js";
import { owner } from "../config/owner.js";
import { t } from "../i18n/catalog.js";
import { executor as messages } from "../i18n/messages/executor.js";

/**
 * The executor's tools (D4, D16). They deliver foreign content and are
 * therefore `returnsUntrusted`: the registry frames the result and sets the
 * taint before a model sees it (W1).
 *
 * Everything that carries an address or query outside first goes through the
 * protection of confidential values (D29). The task is already checked; here
 * the same protection catches what the executor assembles from parts of the task.
 */

export interface ExecutorToolDeps {
  /** Never optional: without it a URL would go out unchecked (D29). */
  guard: ConfidentialGuard;
  /** Without a provider there is no `web_search` (D2 pattern: capability or no tool). */
  search: SearchProvider | null;
  fetch?: typeof fetchPage;
  /** Without a sandbox there is no `run_code` (D20). */
  sandbox?: Sandbox | null;
  /** Without a companion there is no `mac_browser` (D28). */
  companion?: Companion | null;
  /** Without a browser there is no `web_browse` (D35). */
  browser?: WebBrowser | null;
  /** Without it there is no `media_watch` (D61). */
  media?: MediaWatcher | null;
  /** Resolves when the task is cancelled: a running container then ends with it. */
  cancelled?: Promise<void>;
  /** Receives the result of `finish_task`, with what the code accepts of it. */
  onFinish(report: string, extras: FinishExtras): void;
  /**
   * Receives a screenshot (addendum D48 of 2026-10-08) and returns its id,
   * null if the task may not take any more. Without it: no screenshot.
   */
  onScreenshot?(shot: { jpeg: Buffer; label: string; shows?: string }): string | null;
  /**
   * Keeps a PDF that was read and returns its id (d1), null if the task takes
   * no more. Without it: none.
   */
  onDocument?(doc: { url: string; pdf: Buffer }): string | null;
}

/** A side finding: a sentence and the opened page it stood on. */
export interface Aside {
  text: string;
  url: string;
}

/** What `finish_task` delivers next to the report, after the code checked it against the opened pages. */
export interface FinishExtras {
  picks: PickGroup;
  asides: Aside[];
  /** The provider's page where the owner does it themselves; null if none or not opened. */
  actUrl: string | null;
  /** How many entries were dropped because their page was not opened in this task. */
  dropped: number;
}

/** A sentence from the executor: one line, without control characters and without a link (the page stands next to it). */
function asideText(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return dropUnbackedLinks(flat, []).slice(0, ASIDE_MAX_CHARS);
}

/**
 * Only what stands on a page a tool of this task opened
 * (`TurnState.openedPages`), in the form in which it was opened, without
 * tracking (`previewTarget`, addendum D48 of 2026-10-08). An address from the
 * text of a page or a search hit thus never reaches the owner.
 */
export function checkFinishExtras(
  args: { picks?: PickGroup | undefined; asides?: Array<{ text: string; url: string }> | undefined; act_url?: string | undefined },
  opened: readonly string[],
): FinishExtras {
  let dropped = 0;
  const asides: Aside[] = [];
  for (const aside of args.asides ?? []) {
    const url = previewTarget(aside.url, opened);
    const text = asideText(aside.text);
    if (!url || !text) {
      dropped += 1;
      continue;
    }
    if (!asides.some((known) => known.text === text)) asides.push({ text, url });
  }
  const actUrl = args.act_url ? previewTarget(args.act_url, opened) : null;
  if (args.act_url && !actUrl) dropped += 1;
  return { picks: args.picks ?? [], asides, actUrl, dropped };
}

/** How a screenshot went, in one line for the executor. */
export function screenshotLine(taken: { id: string } | { failed: string }): string {
  return "id" in taken
    ? `Screenshot ${taken.id} taken; Serain can send it to ${owner.name}. Name the id in the report.`
    : `No screenshot: ${taken.failed}.`;
}

/** Host of a page for a screenshot's caption, without `www.`. The caption goes to the owner, so the fallback is in their language. */
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return t(messages.website);
  }
}

export function executorTools(deps: ExecutorToolDeps): ToolDefinition[] {
  const fetchImpl = deps.fetch ?? fetchPage;
  const sandboxForPdf = deps.sandbox ?? null;
  /** Only the sandbox reads PDFs (D20); without it `web_fetch` refuses them. */
  const readPdf = sandboxForPdf
    ? async (body: Buffer): Promise<string> => {
        const read = await pdfToText(sandboxForPdf, body, deps.cancelled);
        if (read.ok) return read.text;
        throw new FetchError(
          read.reason === "timeout"
            ? "The PDF could not be read in time."
            : read.reason === "empty"
              ? "The PDF contains no readable text (probably only images)."
              : "The PDF could not be read.",
          "pdf_unreadable",
        );
      }
    : null;
  /** Null if the value may go out. The message names the kind, never the value, and `source` stays empty. */
  const leak = async (tool: string, outbound: string, what: string, triggerMessageId: string) => {
    const kinds = deps.guard.check(outbound);
    if (kinds.length === 0) return null;
    await audit("tool_denied", { tool, reason: "confidential", kinds }, triggerMessageId);
    return {
      ok: false,
      text:
        `Not executed: ${what} contains ${describeKinds(kinds)}. Personal data does not leave the server. ` +
        "Take only the town, or write in the report what stays open because of that.",
    };
  };
  const tools: ToolDefinition[] = [
    defineTool({
      name: "web_fetch",
      description:
        "Fetches exactly one public web page and returns its text. No login, no " +
        (readPdf ? "forms. PDFs (menus, price lists) come as text, without images. " : "forms, no PDFs. ") +
        "The URL never carries personal data.",
      level: "read",
      returnsUntrusted: true,
      opensPages: true,
      schema: { url: z.string().trim().min(8).max(2_000) },
      async run(args, turn) {
        const blocked = await leak("web_fetch", args.url, "the URL", turn.triggerMessageId);
        if (blocked) return blocked;
        try {
          const page = await fetchImpl(args.url, readPdf ? { readPdf } : {});
          // Structured data before the text, within the same limit: opening hours, phone, final price.
          const body = withFacts(page.facts, page.text);
          const head = [
            `Status ${page.status}`,
            page.title ? `Title: ${page.title}` : "",
            page.truncated || body.cut ? "(truncated)" : "",
          ]
            .filter(Boolean)
            .join(" | ");
          const documents = page.documents?.length
            ? `\n\nPDFs on the page (readable with web_fetch):\n${page.documents.map((doc) => doc.label ? `- ${doc.label}: ${doc.url}` : `- ${doc.url}`).join("\n")}`
            : "";
          // The PDF itself stays there for the owner (decision of 2026-10-09: the menu as a file, not as a link).
          const kept = page.pdf && page.status < 400 && page.pdf.length <= SOURCE_PDF_MAX_BYTES ? deps.onDocument?.({ url: page.url, pdf: page.pdf }) : null;
          const keptLine = kept ? `PDF ${kept} kept; Serain can send it to ${owner.name} as a file.\n` : "";
          return { ok: page.status < 400, text: `${keptLine}${head}\n\n${body.text}${documents}`, source: page.url };
        } catch (error) {
          if (error instanceof FetchError || error instanceof BlockedAddressError) {
            return { ok: false, text: error.message, source: args.url };
          }
          return { ok: false, text: `Fetch failed: ${(error as Error).message}`, source: args.url };
        }
      },
    }),
  ];

  const search = deps.search;
  if (search) {
    tools.push(
      defineTool({
        name: "web_search",
        description:
          "Searches the web and returns hits with title, URL and excerpt. For current matters and everything " +
          `you do not know for sure. The search query never carries personal data about ${owner.name}.`,
        level: "read",
        returnsUntrusted: true,
        schema: { query: z.string().trim().min(2).max(300) },
        async run(args, turn) {
          const blocked = await leak("web_search", args.query, "the search query", turn.triggerMessageId);
          if (blocked) return blocked;
          if ((await monthSearches()) >= MAX_SEARCHES_PER_MONTH) {
            return { ok: false, text: "The search quota for this month is used up." };
          }
          // Book before the call: a search that was counted and fails is
          // cheaper than one that ran and is recorded nowhere.
          await recordSearch(search.name);
          const hits = await search.search(args.query);
          if (hits.length === 0) return { ok: true, text: "No hits.", source: `Search: ${args.query}` };
          return {
            ok: true,
            text: hits
              .map((hit, index) => `${index + 1}. ${hit.title}\n${hit.url}\n${hit.snippet}`)
              .join("\n\n"),
            source: `Search: ${args.query}`,
          };
        },
      }),
    );
  }

  const sandbox = deps.sandbox;
  if (sandbox) {
    tools.push(
      defineTool({
        name: "run_code",
        description:
          "Runs a short program in an isolated sandbox and returns its output. " +
          "For calculating, transforming and evaluating data you already have. No network, no files from " +
          "outside, no packages except the standard library, at most 20 seconds. The program must print " +
          "the result (print or console.log).",
        level: "read",
        // Program output is foreign content: the program processes what the
        // executor read on the web.
        returnsUntrusted: true,
        schema: {
          language: z.enum(["python", "node"]),
          code: z.string().min(1).max(SANDBOX_CODE_MAX_CHARS),
        },
        async run(args) {
          try {
            const result = await sandbox.run({
              job: args.language,
              input: Buffer.from(args.code, "utf8"),
              timeoutMs: SANDBOX_CODE_TIMEOUT_MS,
              ...(deps.cancelled ? { cancelled: deps.cancelled } : {}),
            });
            return { ...describeRun(result, SANDBOX_OUTPUT_MAX_CHARS), source: `Sandbox (${args.language})` };
          } catch (error) {
            if (error instanceof SandboxError) return { ok: false, text: error.message, source: "Sandbox" };
            throw error;
          }
        },
      }),
    );
  }

  const companion = deps.companion;
  if (companion) {
    tools.push(
      defineTool({
        name: "mac_browser",
        description:
          `Renders a public web page with a real browser on ${owner.name}'s Mac and returns its text. ` +
          "Only if web_fetch fails on the page (403, empty JavaScript page): slower, and the page sees " +
          `${owner.name}'s connection. No login, no forms. Only works while the Mac is awake. The URL never carries ` +
          "personal data.",
        level: "read",
        returnsUntrusted: true,
        opensPages: true,
        schema: { url: z.string().trim().min(8).max(2_000) },
        async run(args, turn) {
          const blocked = await leak("mac_browser", args.url, "the URL", turn.triggerMessageId);
          if (blocked) return blocked;
          // The same check as for web_fetch, before the address leaves the
          // server. The Mac checks it again and filters every connection of the
          // browser: its local network is the one more worth protecting.
          const verdict = checkUrl(args.url);
          if (!verdict.ok) return { ok: false, text: verdict.reason, source: args.url };
          try {
            const page = await companion.call("browser_render", { url: verdict.url.toString() }, 40_000);
            const { title, text } = htmlToText(page.html);
            const { text: shown, cut } = withFacts(pageFacts(page.html), text);
            const head = [title ? `Title: ${title}` : "", page.truncated || cut ? "(truncated)" : ""]
              .filter(Boolean)
              .join(" | ");
            return { ok: shown.trim().length > 0, text: [head, shown || "The page has no readable text."].filter(Boolean).join("\n\n"), source: page.url };
          } catch (error) {
            if (error instanceof CompanionOffline) {
              return { ok: false, text: `${owner.name}'s Mac is not reachable right now. Take another way or write it in the report.`, source: args.url };
            }
            if (error instanceof CompanionFailure) return { ok: false, text: error.message, source: args.url };
            throw error;
          }
        },
      }),
    );
  }

  const browser = deps.browser;
  if (browser) {
    let screenshotAttempts = 0;
    const OUTCOMES: Record<string, string> = {
      goal_met: "The pilot considers the goal reached.",
      done: "The pilot stopped; whether the goal is reached you have to check in the text.",
      stuck: "The pilot got stuck (login wall, dialog or loop).",
      blocked: `This address rejects automated browsers. Do not try the same address again; another website for the same information yes (the regional transit authority instead of bahn.de). If nothing helps, the report says that ${owner.name} has to open it themselves.`,
      step_limit: "Step limit reached, goal not surely reached.",
      timeout: "Time limit reached.",
      failed: "The pilot could not decide.",
    };
    tools.push(
      defineTool({
        name: "web_browse",
        description:
          "Operates a public web page with a real browser: click, fill in search fields and forms, " +
          "page through, in a few steps towards a goal. For pages where reading alone is not enough " +
          "(journey planner, availability, filters, search forms). Give in inputs every value that is to be typed. " +
          "A call usually takes 5 to 15 seconds, so only if web_fetch is not enough. No login, " +
          "no purchase, no personal data: goal and url only carry what may be public. What comes back is the " +
          "text of the page where the browser stopped, and its steps.",
        level: "read",
        returnsUntrusted: true,
        opensPages: true,
        schema: {
          url: z.string().trim().min(8).max(2_000).describe("Start page."),
          goal: z.string().trim().min(8).max(400).describe("What is to be found or set on the page, concretely."),
          inputs: z
            .array(z.string().trim().min(1).max(BROWSE_TYPE_MAX_CHARS))
            .max(BROWSE_MAX_INPUTS)
            .default([])
            .describe("Every value to be typed into a field, one by one and exactly like this: start, destination, date, time, search term. Without values the browser types nothing."),
          screenshot: z
            .boolean()
            .default(false)
            .describe("true only if the task asks for a screenshot: at the end the part of the page where the browser stops that fits the goal is captured (the forecast, the connections, the hits)."),
        },
        async run(args, turn) {
          // Headless Chrome shows a PDF as a grey area (live 2026-10-09); web_fetch can read it.
          if (isPdfAddress(args.url)) {
            return { ok: false, text: `web_fetch reads a PDF; in the browser Chrome does not show it. ${owner.name} gets the PDF itself, it needs no screenshot of it.` };
          }
          // Everything the page gets to see goes through the filter first (D29): address, goal and every value to type.
          const blocked =
            (await leak("web_browse", args.url, "the URL", turn.triggerMessageId)) ??
            (await leak("web_browse", args.goal, "the goal", turn.triggerMessageId)) ??
            (await leak("web_browse", args.inputs.join("\n"), "a value to type", turn.triggerMessageId));
          if (blocked) return blocked;
          // Live 2026-10-09: six attempts at a screenshot, 3.5 minutes instead of under one. After that the browser runs
          // anyway, just without a screenshot: a refused call cost a step live, and the information was missing.
          const spent = args.screenshot && screenshotAttempts >= MAX_SCREENSHOT_ATTEMPTS_PER_TASK;
          const wantShot = args.screenshot && !spent && Boolean(deps.onScreenshot);
          if (wantShot) screenshotAttempts += 1;
          try {
            const result = await browser.browse(args.url, args.goal, args.inputs, { screenshot: wantShot });
            const shown = result.page.text.slice(0, FETCH_MAX_CHARS);
            let shot = "";
            if (args.screenshot) {
              const taken = result.screenshot;
              const id = taken
                ? (deps.onScreenshot?.({ jpeg: taken.jpeg, label: hostLabel(result.page.url), ...(taken.shows ? { shows: taken.shows } : {}) }) ?? null)
                : null;
              shot = screenshotLine(
                id
                  ? { id }
                  : {
                      failed: !deps.onScreenshot
                        ? "not possible in this task"
                        : spent
                          ? `there are no more than ${MAX_SCREENSHOT_ATTEMPTS_PER_TASK} attempts per task; write in the report that there is none`
                          : (result.screenshotFailed ?? "there are already enough for this task"),
                    },
              );
            }
            return {
              ok: result.outcome === "goal_met" || result.outcome === "done",
              source: result.page.url,
              text: [
                `${OUTCOMES[result.outcome] ?? result.outcome} (goal reached: ${Math.round(result.goalProbability * 100)} %)`,
                `Steps: ${result.steps.length > 0 ? result.steps.join(" → ") : "none"}`,
                `Page: ${result.page.title} | ${result.page.url}`,
                ...(shot ? [shot] : []),
                "",
                shown || "The page has no readable text.",
              ].join("\n"),
            };
          } catch (error) {
            if (error instanceof BrowseError || error instanceof TypesafeError) return { ok: false, text: error.message, source: args.url };
            return { ok: false, text: `Browser failed: ${(error as Error).message.split("\n")[0]}`, source: args.url };
          }
        },
      }),
    );
  }

  const media = deps.media;
  if (media) {
    const where = media.platforms.map((platform) => MEDIA_PLATFORM_LABEL[platform]).join(", ").replace(/, ([^,]*)$/, " and $1");
    tools.push(
      defineTool({
        name: "video_search",
        description:
          "Searches videos on YouTube and returns up to ten hits with title, channel, age, length and views. " +
          "For YouTube videos instead of web_search: there date and length are missing, and many videos are missing entirely. The " +
          `search query never carries personal data about ${owner.name}.`,
        level: "read",
        returnsUntrusted: true,
        schema: { query: z.string().trim().min(2).max(200) },
        async run(args, turn) {
          const blocked = await leak("video_search", args.query, "the search query", turn.triggerMessageId);
          if (blocked) return blocked;
          const source = `YouTube search: ${args.query}`;
          try {
            const hits = await searchVideos(args.query, fetchImpl);
            if (hits.length === 0) return { ok: true, text: "No videos found.", source };
            // Reactions to the back, under a line of their own: as a mark alone the executor overlooked them
            // in the live test and took the reaction in second place instead of the own visit (2026-10-09).
            const line = (hit: VideoHit, index: number) =>
              [
                `${index + 1}. ${hit.title}`,
                [hit.channel, hit.published, hit.length, hit.views].filter(Boolean).join(" | "),
                ...(hit.snippet ? [`Description: ${hit.snippet}`] : []),
                hit.url,
              ].join("\n");
            const own = hits.filter((hit) => !hit.reaction);
            const reactions = hits.filter((hit) => hit.reaction);
            return {
              ok: true,
              text: [
                ...own.map(line),
                ...(reactions.length > 0
                  ? [`Reactions to other videos (per description, not a visit of their own):\n\n${reactions.map((hit, index) => line(hit, own.length + index)).join("\n\n")}`]
                  : []),
              ].join("\n\n"),
              source,
            };
          } catch (error) {
            if (error instanceof VideoSearchError || error instanceof FetchError || error instanceof BlockedAddressError) {
              return { ok: false, text: error.message, source };
            }
            return { ok: false, text: `YouTube search failed: ${(error as Error).message.split("\n")[0]}`, source };
          }
        },
      }),
      defineTool({
        name: "media_watch",
        description:
          `Watches a video or a post on ${where}, with picture and sound (for an image post or a ` +
          "photo series the images), and returns a detailed description: what it is about, what one sees, what " +
          "is said (verbatim), text in the picture. For every " +
          "link to these platforms instead of web_fetch, which sees nothing there. Exactly the address that stands in the task. " +
          "Takes 10 seconds to two minutes; one call per video is enough, the description is in the result afterwards." +
          (media.downloadOff ? " Links to TikTok, Instagram or X here too: the result says why it does not work there." : ""),
        level: "read",
        returnsUntrusted: true,
        opensPages: true,
        timeoutMs: MEDIA_TOOL_TIMEOUT_MS,
        schema: { url: z.string().trim().min(8).max(2_000) },
        async run(args, turn) {
          const blocked = await leak("media_watch", args.url, "the URL", turn.triggerMessageId);
          if (blocked) return blocked;
          return media.watch(args.url, deps.cancelled);
        },
      }),
    );
  }

  tools.push(
    defineTool({
      name: "finish_task",
      description:
        "Ends the task and returns the result to Serain. Always call it last, " +
        "even if you found nothing: then exactly that stands in the report.",
      level: "read",
      endsTurn: true,
      schema: {
        report: z
          .string()
          .trim()
          .min(1)
          .max(EXECUTOR_REPORT_MAX_CHARS)
          .describe(`Result in bullet points, in ${owner.name}'s language: what you found, with a URL per statement, and what stayed open.`),
        picks: picksSchema,
        asides: z
          .array(
            z.object({
              text: z.string().trim().min(1).max(ASIDE_MAX_CHARS).describe("One sentence: what you saw on the side and for which day it applies."),
              url: z.string().trim().min(8).max(2_000).describe("The page you opened in this task and on which it stands."),
            }),
          )
          .max(ASIDES_MAX)
          .optional()
          .describe(
            `Only what tips the answer for the day asked about or saves ${owner.name} a trip (disruption, replacement service, public holiday, ` +
              "school holidays, company holidays, sold out, registration required, delivery time, final price higher than shown) and is not already the " +
              "answer. Nothing merely interesting. Without an opened page an entry is dropped.",
          ),
        act_url: z
          .string()
          .trim()
          .min(8)
          .max(2_000)
          .optional()
          .describe(
            "If one can do something with the result (buy, book, reserve, get an appointment, cancel, register): the provider's " +
              "page where one does it, as you opened it at the end. Without an opened page it is dropped.",
          ),
      },
      async run(args, turn) {
        const extras = checkFinishExtras(args, turn.openedPages);
        // The task ends here; a hint to the model would change nothing any more. What was dropped stands in `task_finished`.
        deps.onFinish(args.report, extras);
        return { ok: true, text: "Task finished." };
      },
    }),
  );
  return tools;
}
