/**
 * Whether the client prefers Markdown to HTML: `text/markdown` with a weight
 * above zero and at least that of `text/html` (or of `*\/*` when it names no
 * HTML). Agents send `Accept: text/markdown, text/html;q=0.9, …`; browsers
 * never name Markdown.
 */
export function prefersMarkdown(accept: string | null): boolean {
  const weights = new Map<string, number>();
  for (const part of (accept ?? "").split(",")) {
    const [type, ...params] = part.split(";").map((value) => value.trim().toLowerCase());
    if (!type) continue;
    const q = params.find((param) => param.startsWith("q="));
    const weight = q ? Number(q.slice(2)) : 1;
    weights.set(type, Number.isFinite(weight) ? weight : 0);
  }
  const markdown = weights.get("text/markdown") ?? 0;
  const html = weights.get("text/html") ?? weights.get("text/*") ?? weights.get("*/*") ?? 0;
  return markdown > 0 && markdown >= html;
}
