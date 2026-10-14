/**
 * ICU-light: the message syntax of the catalog. Only two constructs:
 *
 * - `{name}`: a placeholder, replaced by its value verbatim.
 * - `{count, plural, =0 {…} one {…} other {…}}`: picks a branch with
 *   `Intl.PluralRules` (exact `=N` first, then the CLDR category of the
 *   language, then `other`). Inside a branch `#` is the number, formatted for
 *   the locale, and placeholders work as everywhere.
 *
 * No escaping: catalog texts never contain literal braces.
 */

export type MessageNode =
  | { kind: "text"; text: string }
  | { kind: "arg"; name: string }
  | { kind: "count" }
  | { kind: "plural"; name: string; branches: Map<string, MessageNode[]> };

export type MessageParams = Readonly<Record<string, string | number>>;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SELECTOR = /^(?:=\d+|zero|one|two|few|many|other)$/;

export class MessageSyntaxError extends Error {
  constructor(source: string, reason: string) {
    super(`Bad message syntax (${reason}): ${source.slice(0, 120)}`);
    this.name = "MessageSyntaxError";
  }
}

const parsed = new Map<string, MessageNode[]>();

/** Parses a message; cached, because the same texts render again and again. */
export function parseMessage(source: string): MessageNode[] {
  const cached = parsed.get(source);
  if (cached) return cached;
  let at = 0;
  const fail = (reason: string): never => {
    throw new MessageSyntaxError(source, `${reason} at ${at}`);
  };
  const skipSpace = (): void => {
    while (at < source.length && /\s/.test(source[at]!)) at += 1;
  };

  const nodes = (inPlural: boolean, inBranch: boolean): MessageNode[] => {
    const out: MessageNode[] = [];
    let text = "";
    const flush = (): void => {
      if (text) out.push({ kind: "text", text });
      text = "";
    };
    while (at < source.length) {
      const char = source[at]!;
      if (char === "}") {
        if (!inBranch) fail("unmatched }");
        break;
      }
      if (char === "#" && inPlural) {
        flush();
        out.push({ kind: "count" });
        at += 1;
        continue;
      }
      if (char === "{") {
        flush();
        out.push(placeholder());
        continue;
      }
      text += char;
      at += 1;
    }
    flush();
    return out;
  };

  const placeholder = (): MessageNode => {
    at += 1; // "{"
    const end = source.slice(at).search(/[,}]/);
    if (end < 0) fail("unclosed {");
    const name = source.slice(at, at + end).trim();
    if (!NAME.test(name)) fail(`bad name "${name}"`);
    at += end;
    if (source[at] === "}") {
      at += 1;
      return { kind: "arg", name };
    }
    at += 1; // ","
    skipSpace();
    if (!source.startsWith("plural", at)) fail("only plural is supported");
    at += "plural".length;
    skipSpace();
    if (source[at] !== ",") fail("expected , after plural");
    at += 1;
    const branches = new Map<string, MessageNode[]>();
    for (;;) {
      skipSpace();
      if (source[at] === "}") {
        at += 1;
        break;
      }
      const match = /^[^\s{}]+/.exec(source.slice(at));
      const selector = match?.[0] ?? "";
      if (!SELECTOR.test(selector)) fail(`bad plural selector "${selector}"`);
      if (branches.has(selector)) fail(`duplicate selector "${selector}"`);
      at += selector.length;
      skipSpace();
      if (source[at] !== "{") fail("expected { after selector");
      at += 1;
      branches.set(selector, nodes(true, true));
      if (source[at] !== "}") fail("unclosed plural branch");
      at += 1;
    }
    if (!branches.has("other")) fail(`plural "${name}" has no other`);
    return { kind: "plural", name, branches };
  };

  // `#` outside a plural is a plain character.
  const result = nodes(false, false);
  if (at !== source.length) fail("trailing text");
  parsed.set(source, result);
  return result;
}

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function rules(locale: string): Intl.PluralRules {
  let found = pluralRules.get(locale);
  if (!found) {
    found = new Intl.PluralRules(locale);
    pluralRules.set(locale, found);
  }
  return found;
}

/**
 * Numbers get the locale's decimal sign and no grouping (`3,5` in German,
 * `2026` stays `2026`). Anything else, such as amounts with a currency, is
 * formatted by the caller and passed as a string.
 */
export function formatNumber(value: number, locale: string): string {
  let found = numberFormats.get(locale);
  if (!found) {
    found = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 20 });
    numberFormats.set(locale, found);
  }
  return found.format(value);
}

/** Plural categories of a language (`one`, `few`, `many`, `other` for Russian). */
export function pluralCategories(locale: string): string[] {
  return [...rules(locale).resolvedOptions().pluralCategories];
}

/** Renders a parsed message. A missing value is a bug in the caller and throws. */
export function formatMessage(source: string, params: MessageParams, locale: string): string {
  const render = (nodes: MessageNode[], count: number | null): string =>
    nodes
      .map((node) => {
        switch (node.kind) {
          case "text":
            return node.text;
          case "count":
            return count === null ? "#" : formatNumber(count, locale);
          case "arg": {
            const value = params[node.name];
            if (value === undefined) throw new Error(`Message needs {${node.name}}: ${source.slice(0, 120)}`);
            return typeof value === "number" ? formatNumber(value, locale) : value;
          }
          case "plural": {
            const value = params[node.name];
            const number = typeof value === "number" ? value : Number(value);
            if (value === undefined || !Number.isFinite(number)) {
              throw new Error(`Message needs a number for {${node.name}}: ${source.slice(0, 120)}`);
            }
            const branch =
              node.branches.get(`=${number}`) ?? node.branches.get(rules(locale).select(number)) ?? node.branches.get("other")!;
            return render(branch, number);
          }
        }
      })
      .join("");
  return render(parseMessage(source), null);
}

/** What a message expects: simple placeholders and plural arguments with their selectors. */
export interface MessageShape {
  args: Set<string>;
  plurals: Array<{ name: string; selectors: string[] }>;
}

export function messageShape(source: string): MessageShape {
  const shape: MessageShape = { args: new Set(), plurals: [] };
  const walk = (nodes: MessageNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "arg") shape.args.add(node.name);
      if (node.kind === "plural") {
        shape.args.add(node.name);
        shape.plurals.push({ name: node.name, selectors: [...node.branches.keys()] });
        for (const branch of node.branches.values()) walk(branch);
      }
    }
  };
  walk(parseMessage(source));
  return shape;
}

/** All plain text of a message, without placeholders and selectors. */
export function messageText(source: string): string {
  const walk = (nodes: MessageNode[]): string =>
    nodes
      .map((node) => (node.kind === "text" ? node.text : node.kind === "plural" ? [...node.branches.values()].map(walk).join(" ") : " "))
      .join("");
  return walk(parseMessage(source));
}
