import { CATEGORY, type Listing } from "./directory.js";
import { CONNECTOR_TEMPLATE, connectorPath, ISSUE_NEW, pathOf, REPO, repoFile, SITE_ORIGIN, submitPath, type L, type Lang } from "./site.js";
import { access, actsOf, T } from "./text.js";

/**
 * The Markdown twins of serain.si's pages, for agents (D65): the same texts as
 * the HTML, without the drawn conversations, the shaders and the navigation.
 * Each lies next to its page as `index.md`. Every page points to its twin with
 * `<link rel="alternate" type="text/markdown">`, and the Worker serves it for
 * `Accept: text/markdown` (site/worker/worker.ts). Links point to the HTML
 * pages, the addresses worth citing.
 */

export interface MarkdownMeta {
  lang: Lang;
  /** Absolute URL of the HTML page. */
  url: string;
  /** Absolute URL of the same page in the other language. */
  otherUrl: string;
  title: string;
  description: string;
  updated: string;
}

/** Text that is not ours (community entries) as plain Markdown: one line, no links, no HTML, no emphasis. */
export function mdText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>|#!~]/g, (char) => `\\${char}`);
}

/** The text in the language, or the English one (community entries), as plain Markdown. */
const say = (text: L | { en: string }, lang: Lang) => mdText((text as Partial<L>)[lang] ?? text.en);

const at = (path: string) => `${SITE_ORIGIN}${path}`;
const readme = (lang: Lang) => repoFile(lang === "en" ? "README.md" : "README.de.md");

function document(meta: MarkdownMeta, body: string[]): string {
  const links = [
    `## ${T.mdLinks[meta.lang]}`,
    "",
    `- [GitHub](${REPO})`,
    `- [${T.footerSetup[meta.lang]}](${repoFile("docs/SETUP.md")})`,
    `- [${T.footerArchitecture[meta.lang]}](${repoFile("docs/ARCHITECTURE.md")})`,
    `- [${T.footerSecurity[meta.lang]}](${repoFile("SECURITY.md")})`,
    `- [${T.mdOtherLanguage[meta.lang]}](${meta.otherUrl})`,
  ];
  return [
    "---",
    // JSON strings are valid YAML scalars, whatever the text holds.
    `title: ${JSON.stringify(meta.title)}`,
    `description: ${JSON.stringify(meta.description)}`,
    `canonical: ${meta.url}`,
    `language: ${meta.lang}`,
    `last_updated: ${meta.updated}`,
    "---",
    "",
    ...body,
    "",
    ...links,
    "",
  ].join("\n");
}

/** One line per listing: its page, its summary, its category and what it may do. */
const line = (listing: Listing, lang: Lang) =>
  `- [${mdText(listing.name)}](${at(connectorPath(listing.id, lang))}): ${say(listing.summary, lang)} (${CATEGORY[listing.category][lang]} · ${access(listing, lang)})`;

export function homeMarkdown(meta: MarkdownMeta, listings: readonly Listing[]): string {
  const { lang } = meta;
  return document(meta, [
    "# Serain",
    "",
    `> ${T.homeDescription[lang]}`,
    "",
    `**${T.headline[lang]} ${T.headline2[lang]}** ${T.sub[lang]}`,
    "",
    `## ${T.featuresTitle[lang]}`,
    "",
    ...T.chapters.map((chapter) => `- **${chapter.title[lang]}.** ${chapter.body[lang]}`),
    "",
    `## ${T.securityTitle[lang]}`,
    "",
    T.securityLead[lang],
    "",
    ...T.levels.map((level) => `- \`${level.name}\`: ${level.how[lang]}`),
    "",
    `**${T.killTitle[lang]}** ${T.killBody[lang]} [${T.securityMore[lang]}](${readme(lang)}#${lang === "en" ? "security-model" : "sicherheitsmodell"})`,
    "",
    `## ${T.ownTitle[lang]}`,
    "",
    T.ownLead[lang],
    "",
    T.flow.map((node) => `${node.name[lang]} (${node.sub[lang]})`).join(" → "),
    "",
    `## ${T.connTeaserTitle[lang]}`,
    "",
    T.connTeaser[lang],
    "",
    ...listings.filter((listing) => listing.group !== "community").map((listing) => line(listing, lang)),
    "",
    `[${T.allConnectors[lang]}](${at(pathOf("connectors", lang))}) · [${T.submitOne[lang]}](${at(submitPath(lang))})`,
    "",
    `## ${T.faqTitle[lang]}`,
    "",
    ...T.faq.flatMap((item) => [`### ${item.q[lang]}`, "", item.a[lang], ""]),
    `## ${T.startTitle[lang]}`,
    "",
    T.startLead[lang],
    "",
    "```bash",
    `git clone ${REPO}`,
    "cd serain && pnpm install",
    T.startComment[lang],
    "```",
  ]);
}

export function connectorsMarkdown(meta: MarkdownMeta, listings: readonly Listing[]): string {
  const { lang } = meta;
  const groups = (["integration", "connection", "community"] as const).flatMap((group) => {
    const items = listings.filter((listing) => listing.group === group);
    return [
      `## ${T.groups[group].title[lang]}`,
      "",
      T.groups[group].sub[lang],
      "",
      ...(items.length ? items.map((listing) => line(listing, lang)) : [`${T.communityEmpty[lang]} [${T.submitOne[lang]}](${at(submitPath(lang))})`]),
      "",
    ];
  });
  return document(meta, [`# ${T.navConnectors[lang]}`, "", `> ${T.connLead[lang]}`, "", ...groups, `[${T.submitTitle[lang]}](${at(submitPath(lang))})`]);
}

export function connectorMarkdown(meta: MarkdownMeta, listing: Listing): string {
  const { lang } = meta;
  const community = listing.group === "community";
  const by = community ? `[@${mdText(listing.author!)}](https://github.com/${listing.author})` : "Serain";
  const connect = community
    ? [`${T.communityConnect[lang]} [${T.instanceGuide[lang]}](${repoFile("docs/INSTANCE.md")})`]
    : [[listing.connect?.[lang], listing.command ? `\`${listing.command}\`` : undefined].filter(Boolean).join(" ")];
  const tools = listing.tools?.length
    ? [
        `## ${T.toolsTitle[lang]} (${listing.tools.length})`,
        "",
        `| ${T.toolName[lang]} | ${T.toolLabel[lang]} | ${T.mdLevel[lang]} |`,
        "|---|---|---|",
        ...listing.tools.map((tool) => `| \`${tool.name}\` | ${say(tool.label, lang)} | ${(tool.level === "read" ? T.levelRead : T.levelWrite)[lang]} |`),
        "",
      ]
    : [];
  const more = community
    ? // directory() admits only https sources without spaces, quotes or angle brackets.
      [`- [${T.source[lang]}](<${listing.source}>)`, `- [${T.review[lang]} #${listing.issue}](${REPO}/issues/${listing.issue})`]
    : [`- [${T.setupGuide[lang]}](${repoFile("docs/SETUP.md")})`];
  return document(meta, [
    `# ${mdText(listing.name)}`,
    "",
    `> ${say(listing.summary, lang)}`,
    "",
    `- ${T.metaCategory[lang]}: ${CATEGORY[listing.category][lang]}`,
    `- ${T.metaGroup[lang]}: ${T.groups[listing.group].title[lang]}`,
    `- ${T.metaAccess[lang]}: ${access(listing, lang)}`,
    `- ${T.metaBy[lang]}: ${by}`,
    "",
    `## ${T.actsTitle[lang]}`,
    "",
    actsOf(listing, lang),
    "",
    `## ${T.connectTitle[lang]}`,
    "",
    ...connect,
    "",
    ...tools,
    `${T.trust[lang]}${community ? ` ${T.trustCommunity[lang]}` : ""}`,
    "",
    `- [${T.allConnectors[lang]}](${at(pathOf("connectors", lang))})`,
    ...more,
  ]);
}

export function submitMarkdown(meta: MarkdownMeta): string {
  const { lang } = meta;
  return document(meta, [
    `# ${T.submitTitle[lang]}`,
    "",
    `> ${T.submitLead[lang]}`,
    "",
    `## ${T.steps.start[lang]}`,
    "",
    T.rulesLead[lang],
    "",
    ...T.rules.map((rule) => `- ${rule[lang]}`),
    "",
    `[${T.howBuild[lang]}](${repoFile("docs/INSTANCE.md")})`,
    "",
    `## ${T.submitButton[lang]}`,
    "",
    `[${T.mdSubmitForm[lang]}](${ISSUE_NEW}?template=${CONNECTOR_TEMPLATE})`,
    "",
    T.submitNote[lang],
    "",
    `## ${T.afterTitle[lang]}`,
    "",
    ...T.after.map((item, index) => `${index + 1}. **${item.title[lang]}.** ${item.text[lang]}`),
  ]);
}
