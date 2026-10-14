import { writeFile } from "node:fs/promises";
import { env } from "../src/config/env.js";
import { runPilot, type BrowserSession } from "../src/browser/pilot.js";
import { openBrowserSession } from "../src/browser/session.js";
import { typesafeClient, type SystemOne } from "../src/browser/typesafe.js";
import { OWNER_TIMEZONE } from "../src/time.js";

/**
 * Benchmark run for `web_browse` against real pages (D35): where does the time go
 * (launch, snapshot, Jev, action), and does the pilot arrive. Runs on the Mac or
 * the server, needs `SERAIN_CHROME_PATH` and `TYPESAFE_API_KEY`.
 *
 *   pnpm browse:bench                all cases
 *   pnpm browse:bench bahn wiki      only cases whose name matches
 *   BENCH_OUT=/path.json …           result additionally as JSON
 *   BENCH_CITY=Leipzig …             place for Wikipedia, map, weather and classifieds (default Hamburg)
 *
 * Public pages and made-up search values only: none of this belongs to the
 * owner. So the bench does not read `OWNER_CITY` (Typesafe does not commit to
 * zero data retention, D3); a place of your own only explicitly via
 * `BENCH_CITY`. Timetables run between fixed large
 * stations that surely exist.
 *
 * The cases are mostly German sites (the pilot was built on them): the goals are
 * English like the executor writes them, the typed values and the expected page
 * text stay in the site's language.
 */

interface Case {
  name: string;
  url: string;
  goal: string;
  inputs: string[];
  /** If this is in the text of the final page, the case counts as solved. The pilot never sees the pattern. */
  expect: RegExp;
}

/** A date in the current timetable: a fixed one would at some point run past the timetable change. In the format the German transit sites show (dd.mm.yyyy). */
const IN_THREE_DAYS = new Date(Date.now() + 3 * 86_400_000).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: OWNER_TIMEZONE });

const CITY = process.env["BENCH_CITY"]?.trim() || "Hamburg";
const CITY_PATTERN = CITY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A local transit line: S-Bahn, regional express or regional train with number. */
const LINE = String.raw`\b(S\s?\d{1,2}|R[EB]\s?\d{1,2})\b`;

/** Connections from Darmstadt Hbf at 8 or 9 o'clock with a line; the page writes the station differently depending on the view. */
const DARMSTADT_MORNING = new RegExp(String.raw`^(?=[\s\S]*Darmstadt( Hbf|[+ ]Hauptbahnhof))(?=[\s\S]*\b0[89]:\d{2}\b[\s\S]*${LINE})`);

const CASES: Case[] = [
  { name: "wiki", url: "https://de.wikipedia.org/", goal: `Open the article about ${CITY} and find the population`, inputs: [CITY], expect: /Einwohner/ },
  { name: "bahn", url: "https://www.bahn.de/", goal: "Search train connections from Hamburg Hbf to Berlin Hbf and show the departure times", inputs: ["Hamburg Hbf", "Berlin Hbf"], expect: /\b\d{1,2}:\d{2}\b[\s\S]*(ICE|Umstieg|Dauer)/ },
  // A transit association instead of bahn.de: its own forms, cookie dialogs and the lookup in a frame.
  { name: "rmv", url: "https://www.rmv.de/", goal: "Search a connection from Darmstadt Hauptbahnhof to Frankfurt Hauptbahnhof and show the departure times", inputs: ["Darmstadt Hauptbahnhof", "Frankfurt (Main) Hauptbahnhof"], expect: new RegExp(String.raw`\b\d{1,2}:\d{2}\b[\s\S]*(${LINE}|Umst|Dauer)`) },
  // With date and time: this is how the executor really calls it (live finding 2026-09-20: twenty steps in the calendar).
  { name: "rmvzeit", url: "https://www.rmv.de", goal: `Find the S-Bahn connection lookup from Darmstadt Hauptbahnhof to Frankfurt(Main)Hauptbahnhof on ${IN_THREE_DAYS} from about 07:00, show the first connection`, inputs: ["Darmstadt Hauptbahnhof", "Frankfurt(Main)Hauptbahnhof", IN_THREE_DAYS, "07:00"], expect: new RegExp(String.raw`${IN_THREE_DAYS.replaceAll(".", "\\.")}[\s\S]*0[78]:\d{2}[\s\S]*${LINE}`) },
  // A name with a wrong bracket suffix (live finding 2026-10-10): literally it matches no station, at most stops
  // with "Main" in their name. Darmstadt Hbf is meant; only the search without the bracket finds it.
  { name: "rmvname", url: "https://www.rmv.de", goal: `Search S-Bahn connections from the station Darmstadt(Main) Hauptbahnhof to Frankfurt(Main) Hauptbahnhof on ${IN_THREE_DAYS} from 08:00, with departure, arrival and line`, inputs: ["Darmstadt(Main) Hauptbahnhof", "Frankfurt(Main)Hauptbahnhof", IN_THREE_DAYS, "08:00"], expect: DARMSTADT_MORNING },
  // The same question in the lookup itself: date, hours and minutes in a dialog of their own.
  { name: "rmvalt", url: "https://www.rmv.de/auskunft/bin/jp/query.exe/dn", goal: `Search S-Bahn connections from the station Darmstadt(Main) Hauptbahnhof to Frankfurt(Main) Hauptbahnhof on ${IN_THREE_DAYS} from 08:00, with departure, arrival and line`, inputs: ["Darmstadt(Main) Hauptbahnhof", "Frankfurt(Main)Hauptbahnhof", IN_THREE_DAYS, "08:00"], expect: DARMSTADT_MORNING },
  { name: "dwd", url: "https://www.dwd.de/", goal: "Find the current weather values of the station Hamburg-Fuhlsbüttel under Wetter und Klima vor Ort", inputs: ["Hamburg"], expect: /Hamburg[\s\S]*(°C|hPa|km\/h)/i },
  { name: "github", url: "https://github.com/", goal: "Find the repository microsoft/playwright and read the number of stars", inputs: ["microsoft/playwright"], expect: /playwright[\s\S]*\d+(\.\d+)?k/i },
  { name: "idealo", url: "https://www.idealo.de/", goal: "Find the cheapest price for Sony WH-1000XM5", inputs: ["Sony WH-1000XM5"], expect: /WH-1000XM5[\s\S]*\d+,\d{2}\s*€/ },
  { name: "amazon", url: "https://www.amazon.de/", goal: "Search for Anker USB-C Kabel and show the prices of the results", inputs: ["Anker USB-C Kabel"], expect: /Anker[\s\S]*\d+,\d{2}\s*€/ },
  { name: "hn", url: "https://news.ycombinator.com/", goal: "Open the page with the newest Show HN posts", inputs: [], expect: /Show HN/ },
  { name: "flix", url: "https://www.flixbus.de/", goal: "Search bus connections from Hamburg to München and show departure times with prices", inputs: ["Hamburg", "München"], expect: /\b\d{1,2}:\d{2}\b[\s\S]*€/ },
  { name: "mdn", url: "https://developer.mozilla.org/de/", goal: "Find the documentation for Array.prototype.flatMap", inputs: ["flatMap"], expect: /flatMap\(\)/ },
  { name: "form", url: "https://www.selenium.dev/selenium/web/web-form.html", goal: "In the form, choose the entry Two in Dropdown (select), tick the checkbox Default checkbox and send the form with Submit", inputs: [], expect: /Received|Form submitted/ },
  { name: "ddg", url: "https://duckduckgo.com/", goal: "Search for Playwright ariaSnapshot and show the result list", inputs: ["Playwright ariaSnapshot"], expect: /playwright\.dev/i },
  { name: "klein", url: "https://www.kleinanzeigen.de/", goal: `Search for Fahrrad in ${CITY} and show the listings with prices`, inputs: ["Fahrrad", CITY], expect: /Fahrrad[\s\S]*\d+\s*€/i },
  { name: "tages", url: "https://www.tagesschau.de/", goal: "Open the overview page of the section Wirtschaft", inputs: [], expect: /Wirtschaft[\s\S]*(Börse|Unternehmen|Konjunktur|Finanzen)/ },
  { name: "iframe", url: "https://www.w3schools.com/tags/tryit.asp?filename=tryhtml_select", goal: "In the select list in the result area, choose the entry Audi", inputs: [], expect: /Audi/ },
  { name: "osm", url: "https://www.openstreetmap.org/", goal: `Search for ${CITY} and show the result list`, inputs: [CITY], expect: new RegExp(`${CITY_PATTERN}, `) },
  { name: "chefkoch", url: "https://www.chefkoch.de/", goal: "Search recipes for Kartoffelsuppe and show the result list", inputs: ["Kartoffelsuppe"], expect: /Kartoffelsuppe[\s\S]*(Min\.|Bewertung|Rezepte)/ },
  { name: "ikea", url: "https://www.ikea.com/de/de/", goal: "Search for the shelf Billy and show the prices of the results", inputs: ["Billy Regal"], expect: /BILLY[\s\S]*\d+[,.]\d{2}|BILLY[\s\S]*€/ },
  { name: "wetter", url: "https://www.wetter.com/", goal: `Show the weather for ${CITY} today`, inputs: [CITY], expect: new RegExp(`${CITY_PATTERN}[\\s\\S]*°`) },
  { name: "spiegel", url: "https://www.spiegel.de/", goal: "Open the overview page of the section Wissenschaft", inputs: [], expect: /Wissenschaft[\s\S]*(Mensch|Natur|Technik|Weltall)/ },
  { name: "mvn", url: "https://www.npmjs.com/", goal: "Find the package playwright-core and read the current version number", inputs: ["playwright-core"], expect: /playwright-core[\s\S]*\d+\.\d+\.\d+/ },
  { name: "imdb", url: "https://www.imdb.com/", goal: "Find the film Inception and read the release year", inputs: ["Inception"], expect: /Inception[\s\S]*2010/ },
  { name: "thalia", url: "https://www.thalia.de/", goal: "Search for the book Der Schwarm and show prices", inputs: ["Der Schwarm"], expect: /Schwarm[\s\S]*\d+,\d{2}\s*€/ },
  { name: "paginate", url: "https://news.ycombinator.com/", goal: "Open the second page of the front page (More)", inputs: [], expect: /\b31\./ },
  { name: "so", url: "https://stackoverflow.com/questions", goal: "Show questions with the tag playwright", inputs: ["playwright"], expect: /playwright/i },
];

interface Timing {
  launchMs: number;
  snapshotMs: number[];
  jevMs: number[];
  actMs: number[];
}

function timed(session: BrowserSession, jev: SystemOne, timing: Timing): { session: BrowserSession; jev: SystemOne } {
  const clock = async <T>(bucket: number[], run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await run();
    } finally {
      bucket.push(Date.now() - started);
    }
  };
  return {
    session: {
      snapshot: () => clock(timing.snapshotMs, () => session.snapshot()),
      act: (action, text, help) => clock(timing.actMs, () => session.act(action, text, help)),
      close: () => session.close(),
    },
    jev: { ask: (state, questions) => clock(timing.jevMs, () => jev.ask(state, questions)) },
  };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

async function main(): Promise<void> {
  const apiKey = env.typesafeApiKey;
  const chromePath = env.chromePath;
  if (!apiKey || !chromePath) throw new Error("TYPESAFE_API_KEY and SERAIN_CHROME_PATH must be set.");
  const filters = process.argv.slice(2);
  const cases = filters.length > 0 ? CASES.filter((entry) => filters.some((filter) => entry.name.includes(filter))) : CASES;
  const rows: Array<Record<string, unknown>> = [];

  for (const entry of cases) {
    const timing: Timing = { launchMs: 0, snapshotMs: [], jevMs: [], actMs: [] };
    const started = Date.now();
    let row: Record<string, unknown>;
    try {
      const raw = await openBrowserSession(entry.url, chromePath);
      timing.launchMs = Date.now() - started;
      const wrapped = timed(raw, typesafeClient(apiKey), timing);
      try {
        const top = (answer: unknown) =>
          Object.entries((answer as { probabilities?: Record<string, number> })?.probabilities ?? {})
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([option, probability]) => `${option}=${probability.toFixed(2)}`)
            .join(" ");
        const trace = process.env["BENCH_TRACE"]
          ? (answers: Record<string, unknown>, page: { url: string; view: string }) =>
              console.error(`  ${page.url.slice(0, 60)} [${page.view.slice(0, Number(process.env["BENCH_TRACE"]) || 0).replace(/\n/g, " / ")}] | ${Object.entries(answers).map(([name, answer]) => `${name}: ${(answer as { noul?: number }).noul?.toFixed(2) ?? top(answer)}`).join(" | ")}`)
          : undefined;
        // Like `jevBrowser.browse`: a case may fail, but not hang the benchmark run.
        const hung = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hangs: no answer after 110 s")), 110_000).unref());
        const result = await Promise.race([runPilot(wrapped.session, entry.goal, { jev: wrapped.jev, inputs: entry.inputs, ...(trace ? { trace } : {}) }), hung]);
        row = {
          name: entry.name,
          solved: entry.expect.test(result.page.text),
          outcome: result.outcome,
          goal: Math.round(result.goalProbability * 100),
          totalMs: Date.now() - started,
          launchMs: timing.launchMs,
          snapshotMs: sum(timing.snapshotMs),
          jevMs: sum(timing.jevMs),
          jevCalls: timing.jevMs.length,
          actMs: sum(timing.actMs),
          steps: result.steps,
          endUrl: result.page.url,
          ...(process.env["BENCH_VERBOSE"] ? { actEach: timing.actMs, snapshotEach: timing.snapshotMs, jevEach: timing.jevMs, view: result.page.view.slice(0, 1_500), elements: result.page.elements.map((element) => `${element.id} ${element.kind} ${element.label}`).slice(0, 60) } : {}),
        };
      } finally {
        await raw.close();
      }
    } catch (error) {
      row = { name: entry.name, solved: false, outcome: "error", totalMs: Date.now() - started, error: (error as Error).message.split("\n")[0] };
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }

  const solved = rows.filter((row) => row["solved"]).length;
  console.log(`\n${solved}/${rows.length} solved, together ${Math.round(sum(rows.map((row) => Number(row["totalMs"]))) / 1000)} s`);
  if (process.env["BENCH_OUT"]) await writeFile(process.env["BENCH_OUT"], JSON.stringify(rows, null, 2));
}

await main();
process.exit(0);
