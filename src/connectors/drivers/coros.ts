import { z } from "zod";
import { owner } from "../../config/owner.js";
import { remoteTool } from "../tools.js";
import { mcpOAuthDriver, type ClientRegistry } from "./mcp-oauth.js";

/**
 * COROS through the official MCP server (D51), EU region (mcp.coros.com
 * redirects by region; we address the EU directly so the resource matches the
 * token; accounts in another region need their address there). Read-only:
 * Serain does not get the provider's writing tools (creating plans and
 * workouts).
 *
 * COROS writes dates as yyyyMMdd; the model gives YYYY-MM-DD as everywhere
 * else, the conversion is here. Sleep counts toward the day of waking up.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").describe("Day as YYYY-MM-DD.");
const compact = (value: string | undefined) => (value ? value.replaceAll("-", "") : null);
const days = (max: number, fallback: number) => z.number().int().min(1).max(max).optional().describe(`The last this many days, default ${fallback}.`);
const SLEEP_NOTE = "Sleep counts toward the day of waking up: \"last night\" is today.";

export const COROS_TOOLS = [
  remoteTool({
    name: "coros_daily_health",
    remote: "queryDailyHealthData",
    description: `Daily values from COROS: steps, calories, stress, sleep quality and duration, heart rate overview. ${SLEEP_NOTE}`,
    schema: { days: days(30, 7) },
  }),
  remoteTool({
    name: "coros_sleep",
    remote: "querySleepOverview",
    description: `Sleep from COROS: score, duration, deep, light and REM share, awake phases, naps. ${SLEEP_NOTE}`,
    schema: { days: days(30, 7), from: day.optional(), to: day.optional() },
    map: (args) => ({ ...(args.days ? { days: args.days } : {}), ...(args.from ? { startDate: compact(args.from) } : {}), ...(args.to ? { endDate: compact(args.to) } : {}) }),
  }),
  remoteTool({
    name: "coros_sleep_hrv",
    remote: "querySleepHrv",
    description: `HRV during sleep with COROS' own assessment (average, normal range, baseline). Use the assessment, do not compute it yourself. ${SLEEP_NOTE}`,
    schema: { days: days(7, 7), from: day.optional(), to: day.optional() },
    map: (args) => ({ startDate: compact(args.from), endDate: compact(args.to), days: args.days ?? (args.from ? null : 7) }),
  }),
  remoteTool({
    name: "coros_recovery",
    remote: "queryRecoveryStatus",
    description: "Recovery now: percent, level, when fully recovered.",
    schema: {},
  }),
  remoteTool({
    name: "coros_resting_hr",
    remote: "queryRestingHeartRate",
    description: "Resting heart rate per day.",
    schema: { days: days(30, 7) },
  }),
  remoteTool({
    name: "coros_stress",
    remote: "queryStressLevel",
    description: "Average stress per day.",
    schema: { days: days(30, 7) },
  }),
  remoteTool({
    name: "coros_training_load",
    remote: "queryTrainingLoadAssessment",
    description: "Training load: short and long term, ratio, COROS' comment per day. For \"am I training too much or too little\".",
    schema: { days: days(30, 7) },
  }),
  remoteTool({
    name: "coros_fitness",
    remote: "queryFitnessAssessmentOverview",
    description: "VO2max, running level, threshold pace and predictions for 5 km to marathon.",
    schema: {},
  }),
  remoteTool({
    name: "coros_activities",
    remote: "querySportRecords",
    description:
      "Search activities from COROS: period, sport, distance, duration. Returns labelId and sportType for coros_activity. " +
      "Sports as codes: running 100 to 103, hiking 104, cycling 200 to 205, swimming 300 and 301, strength 402, walking 900; without one, all.",
    schema: {
      from: day.optional().describe("Start, default 7 days ago."),
      to: day.optional().describe("End, default today."),
      sports: z.array(z.number().int().min(100).max(65535)).max(20).optional().describe("COROS sport codes."),
      min_km: z.number().min(0).max(1000).optional(),
      max_km: z.number().min(0).max(1000).optional(),
      min_minutes: z.number().int().min(0).max(10_000).optional(),
      max_minutes: z.number().int().min(0).max(10_000).optional(),
      limit: z.number().int().min(1).max(50).optional().describe("At most this many, default 20."),
    },
    map: (args) => ({
      startDate: compact(args.from),
      endDate: compact(args.to),
      sportTypeCodes: args.sports && args.sports.length > 0 ? args.sports : null,
      minDistanceKm: args.min_km ?? null,
      maxDistanceKm: args.max_km ?? null,
      minDurationMinutes: args.min_minutes ?? null,
      maxDurationMinutes: args.max_minutes ?? null,
      maxAveragePace: null,
      locationKeyword: null,
      limit: args.limit ?? 20,
    }),
  }),
  remoteTool({
    name: "coros_activity",
    remote: "getActivityDetail",
    description: "One activity in detail: heart rate, pace, elevation, cadence. labelId and sportType from coros_activities.",
    schema: {
      label_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe("labelId from coros_activities."),
      sport_type: z.number().int().min(100).max(65535).describe("sportType from coros_activities."),
    },
    map: (args) => ({ labelId: args.label_id, sportType: args.sport_type }),
  }),
  remoteTool({
    name: "coros_schedule",
    remote: "queryTrainingSchedule",
    description: "Planned workouts from COROS training plans, default the current week (Monday to Sunday).",
    schema: { from: day.optional(), to: day.optional() },
    map: (args) => ({ ...(args.from ? { startDate: compact(args.from) } : {}), ...(args.to ? { endDate: compact(args.to) } : {}) }),
  }),
];

export const COROS = {
  id: "coros",
  url: "https://mcpeu.coros.com/mcp",
  issuer: "https://mcpeu.coros.com",
  scope: "mcp.tools offline_access",
} as const;

export function corosDriver(deps: { clients: ClientRegistry; fetch?: typeof fetch }) {
  return mcpOAuthDriver(
    {
      ...COROS,
      tools: COROS_TOOLS,
      promptLine:
        `coros_* read ${owner.name}'s data from their COROS watch: sleep, HRV, recovery, resting heart rate, stress, training load, activities, ` +
        "planned workouts. Read-only. Ask narrowly: the period in question.",
    },
    deps,
  );
}
