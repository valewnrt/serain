import { t } from "../i18n/catalog.js";
import { mail as text } from "../i18n/messages/mail.js";

/**
 * Series mail (D63, building block E): the same request to many places, each
 * as its own mail. The preview must show every mail in full (D14: concrete,
 * with every value that counts), but should stay readable when ten mails are
 * the same except for the greeting. So the first stands in full and every
 * further one as a difference from it, line by line with the number in the
 * first: what is missing with "−", what is new with "+". From the first and
 * the differences every mail can be read back exactly; if one differs too
 * much, it stands in full. The frame comes from the catalog, the mails stay
 * verbatim.
 */

export interface BatchMail {
  to: string;
  subject: string;
  text: string;
}

/** From this many changed lines on, the comparison is harder to read than the mail itself. */
const MAX_DIFF_LINES = 8;

type Op = { kind: "same" | "removed" | "added"; line: string };

/** Line diff over the longest common subsequence. Mails are short, quadratic is cheap here. */
export function lineDiff(before: readonly string[], after: readonly string[]): Op[] {
  const rows = before.length;
  const cols = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      ops.push({ kind: "same", line: before[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "removed", line: before[i]! });
      i += 1;
    } else {
      ops.push({ kind: "added", line: after[j]! });
      j += 1;
    }
  }
  while (i < rows) ops.push({ kind: "removed", line: before[i++]! });
  while (j < cols) ops.push({ kind: "added", line: after[j++]! });
  return ops;
}

/**
 * How a further mail differs from the first, or null when it must stand in
 * full. Every change names the line of the first mail where it starts;
 * duplicate lines (empty lines, greetings) make an anchor of text ambiguous,
 * a number not.
 */
export function describeDifference(first: string, other: string): string | null {
  const ops = lineDiff(first.split("\n"), other.split("\n"));
  const changed = ops.filter((op) => op.kind !== "same");
  if (changed.length === 0) return t(text.batchSameText);
  if (changed.length > MAX_DIFF_LINES) return null;
  const lines: string[] = [t(text.batchTextExcept)];
  let position = 0;
  let open = false;
  for (const op of ops) {
    if (op.kind === "same") {
      position += 1;
      open = false;
      continue;
    }
    if (!open) {
      lines.push(`  ${t(text.batchLine, { line: position + 1 })}`);
      open = true;
    }
    lines.push(`  ${op.kind === "removed" ? "−" : "+"} ${op.line === "" ? t(text.batchEmptyLine) : op.line}`);
    if (op.kind === "removed") position += 1;
  }
  return lines.join("\n");
}

/** The preview of the whole series, without the sender line and notes. */
export function describeBatch(mails: readonly BatchMail[]): string {
  const [first] = mails;
  if (!first) return "";
  return mails
    .map((mail, index) => {
      const head = [t(text.batchMail, { number: index + 1, to: mail.to }), t(text.batchSubject, { subject: mail.subject })];
      if (index === 0) return [...head, "", mail.text].join("\n");
      const difference = describeDifference(first.text, mail.text);
      return [...head, ...(difference === null ? ["", mail.text] : [difference])].join("\n");
    })
    .join("\n\n");
}
