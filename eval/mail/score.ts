import { z } from "zod";
import type { Finding } from "../../src/mail/findings.js";
import type { MailCategory } from "../../src/mail/trigger.js";

/**
 * Cases and scoring of the mail eval (addendum to D33 of 2026-10-08). Without network
 * and without a model, so that it runs in `pnpm test`.
 *
 * One question is measured: would the trigger have reported the mail to the owner? Which of the
 * three kinds it is does not count here; the category is still in the result.
 */

const knownSchema = z.object({ key: z.string(), what: z.string(), when: z.string(), from: z.string() });

export const mailCaseSchema = z.object({
  id: z.string().min(1),
  note: z.string().optional(),
  mailbox: z.enum(["main", "secondary", "serain"]).default("main"),
  from: z.string(),
  subject: z.string(),
  text: z.string(),
  /** Attachment names as the adapter delivers them. */
  attachments: z.array(z.string()).default([]),
  /** Bulk mail by header (RFC 2369): the trigger then asks at most about a finding. */
  bulk: z.boolean().default(false),
  /** Machine mail (`Auto-Submitted`, RFC 3834): like `bulk` (addendum to D33 of 2026-10-10). */
  automated: z.boolean().default(false),
  /** Expected finding (addendum to D33 of 2026-10-10). Missing: not scored. */
  finding: z.enum(["booking", "lapse", "none"]).optional(),
  /** Arrival relative to the run. */
  daysAgo: z.number().nonnegative().default(0),
  known: z.array(knownSchema).default([]),
  expected: z.enum(["wichtig", "unwichtig"]),
});

export type MailCase = z.infer<typeof mailCaseSchema>;

export function parseMailCases(raw: unknown): MailCase[] {
  const cases = z.array(mailCaseSchema).parse(raw);
  const ids = new Set<string>();
  for (const testCase of cases) {
    if (ids.has(testCase.id)) throw new Error(`Case "${testCase.id}" duplicated`);
    ids.add(testCase.id);
  }
  return cases;
}

export interface MailCaseResult {
  id: string;
  expected: MailCase["expected"];
  /** `header`: sorted out as bulk mail by header, without a model. */
  category: MailCategory | "header";
  /** 1 minus P(none), as in the audit log. Null for `header` or error. */
  pSomething: number | null;
  source: string | null;
  error: string | null;
  /** What `judge` saw as a finding; null if not asked (no hint in the text). */
  finding?: Finding | null;
  expectedFinding?: Finding | undefined;
}

export const reported = (result: Pick<MailCaseResult, "category">) => result.category !== "none" && result.category !== "header";

export interface MailSummary {
  total: number;
  correct: number;
  /** Reported although unimportant: the interruption that annoys. */
  falseAlarms: string[];
  /** Not reported although important. */
  misses: string[];
  /** Of those, already lost at the header: no rule in the prompt can save that. */
  lostAtHeader: string[];
  errors: string[];
  /** Findings: scored cases, correct ones, and the wrong ones as expected → got. */
  findings: { total: number; correct: number; wrong: string[] };
}

export function summarize(results: readonly MailCaseResult[]): MailSummary {
  const summary: MailSummary = { total: results.length, correct: 0, falseAlarms: [], misses: [], lostAtHeader: [], errors: [], findings: { total: 0, correct: 0, wrong: [] } };
  for (const result of results) {
    if (result.error) {
      summary.errors.push(result.id);
      continue;
    }
    if (result.expectedFinding) {
      const got = result.finding ?? "none";
      summary.findings.total += 1;
      if (got === result.expectedFinding) summary.findings.correct += 1;
      else summary.findings.wrong.push(`${result.id} (${result.expectedFinding} → ${got})`);
    }
    const got = reported(result);
    if (got === (result.expected === "wichtig")) summary.correct += 1;
    else if (got) summary.falseAlarms.push(result.id);
    else {
      summary.misses.push(result.id);
      if (result.category === "header") summary.lostAtHeader.push(result.id);
    }
  }
  return summary;
}
