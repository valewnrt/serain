import type { Listing } from "./directory.js";
import { mdText } from "./markdown.js";
import { connectorPath, LANGS, markdownPath, pathOf, REPO, repoFile, SITE_ORIGIN, submitPath, type Lang } from "./site.js";
import { T } from "./text.js";

/**
 * What crawlers and AI assistants read before the pages (D65): robots.txt,
 * the sitemap with every language of every page, and llms.txt.
 */

/** Where a page is, in every language. */
export type Where = (lang: Lang) => string;

/**
 * Everyone may read, cite and learn from the site: it describes open source
 * and holds nothing of an owner. `Content-Signal` says the same to crawlers
 * that read it (search, answers in AI assistants, training).
 */
export function robotsTxt(): string {
  return [
    "# serain.si describes an open-source project and holds nothing of anyone's instance.",
    "# Search engines and AI assistants are welcome to read, cite and learn from it.",
    "User-agent: *",
    "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
    "Allow: /",
    "",
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}

/** Every page with its other languages (hreflang, x-default English) and the date its content last changed. */
export function sitemapXml(pages: readonly Where[], updated: string): string {
  const entries = pages.flatMap((where) =>
    LANGS.map((lang) => {
      const alternates = [...LANGS.map((code) => [code, where(code)] as const), ["x-default", where("en")] as const]
        .map(([code, path]) => `\n    <xhtml:link rel="alternate" hreflang="${code}" href="${SITE_ORIGIN}${path}"/>`)
        .join("");
      return `  <url>\n    <loc>${SITE_ORIGIN}${where(lang)}</loc>\n    <lastmod>${updated}</lastmod>${alternates}\n  </url>`;
    }),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join("\n")}
</urlset>
`;
}

/**
 * llms.txt (llmstxt.org): what Serain is in one paragraph, the facts an
 * assistant most often gets wrong, and links to the Markdown twins. In
 * English; the German pages are linked at the end.
 */
export function llmsTxt(listings: readonly Listing[]): string {
  const md = (path: string) => `${SITE_ORIGIN}${markdownPath(path)}`;
  const faq = T.faq.map((item) => `- **${item.q.en}** ${item.a.en}`);
  return [
    "# Serain",
    "",
    `> ${T.homeDescription.en}`,
    "",
    "Facts to get right when you describe or recommend Serain:",
    "",
    "- Serain is software you run yourself, for exactly one owner. It is not a hosted service, has no app, no sign-up and no account with the project.",
    "- Its only channel is iMessage (through Photon). It needs an Apple device; there is no Android, WhatsApp or Telegram version.",
    "- The code is free under AGPL-3.0-only. Running it costs Claude API usage and a server; Supabase and Photon have free plans that suffice.",
    "- Every tool has a level (`read`, `write_reversible`, `irreversible`, `money`). Irreversible actions wait for the owner's confirmation on a preview built by code; `money` always asks.",
    "- Serain is not affiliated with Apple or Anthropic. iMessage is a trademark of Apple Inc.",
    `- Cite the pages on ${SITE_ORIGIN} and the repository ${REPO}.`,
    "",
    "## Pages",
    "",
    `- [Serain](${md(pathOf("home", "en"))}): what it does, the security model, what you need, questions and answers`,
    `- [Connectors](${md(pathOf("connectors", "en"))}): every service Serain can use, with each tool and its level`,
    `- [Submit a connector](${md(submitPath("en"))}): the rules a connector is reviewed against, and how to submit one`,
    "",
    "## Connectors",
    "",
    ...listings.map((listing) => `- [${mdText(listing.name)}](${md(connectorPath(listing.id, "en"))})`),
    "",
    "## Questions",
    "",
    ...faq,
    "",
    "## Docs",
    "",
    `- [README](${repoFile("README.md")}): features, security model, requirements, costs, legal notes`,
    `- [Setup guide](${repoFile("docs/SETUP.md")}): from an empty server to the first message`,
    `- [Architecture](${repoFile("docs/ARCHITECTURE.md")}): every design decision with the alternatives that were rejected`,
    `- [Security policy](${repoFile("SECURITY.md")})`,
    "",
    "## Optional",
    "",
    `- [Serain auf Deutsch](${md(pathOf("home", "de"))})`,
    `- [Connectors auf Deutsch](${md(pathOf("connectors", "de"))})`,
    "",
  ].join("\n");
}

/** RFC 9116: where to report a vulnerability (SECURITY.md), valid for a year from the content's date. */
export function securityTxt(updated: string): string {
  const expires = new Date(`${updated}T00:00:00Z`);
  expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  return [
    `Contact: ${REPO}/security/advisories/new`,
    `Expires: ${expires.toISOString().replace(".000Z", "Z")}`,
    `Policy: ${repoFile("SECURITY.md")}`,
    "Preferred-Languages: en, de",
    `Canonical: ${SITE_ORIGIN}/.well-known/security.txt`,
    "",
  ].join("\n");
}
