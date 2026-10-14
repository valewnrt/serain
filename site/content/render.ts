import { CHAPTER_CHATS, HERO, KILL, LEVEL_CHATS, phone, thread } from "./chats.js";
import { COMMUNITY, type CommunityConnector } from "./community.js";
import { CATEGORY, directory, type Group, type Listing, type Tool } from "./directory.js";
import { llmsTxt, robotsTxt, securityTxt, sitemapXml, type Where as Address } from "./crawlers.js";
import { esc } from "./html.js";
import { imprintPage, privacyPage, type Imprint, type LegalPage } from "./legal.js";
import { connectorMarkdown, connectorsMarkdown, homeMarkdown, legalMarkdown, submitMarkdown, type MarkdownMeta } from "./markdown.js";
import { directoryGraph, homeGraph, jsonLd, subpageGraph, type Node, type PageMeta } from "./schema.js";
import { CONNECTOR_TEMPLATE, connectorPath, imprintPath, INDEXNOW_KEY, ISSUE_NEW, markdownPath, privacyPath, submitPath, LANGS, pathOf, REPO, repoFile, SITE_ORIGIN, type L, type Lang, type Page } from "./site.js";
import { access, actsOf, T } from "./text.js";

export { esc };

/**
 * The pages of serain.si, rendered at build time (D65). One script and one
 * stylesheet from the own origin; the pages are complete without the script.
 * Every text comes in English and German; whatever is not ours (community
 * entries) goes through `esc`.
 */

export interface Assets {
  css: string;
  js: string;
  font: string;
  dusk: string;
  dusk960: string;
  night: string;
  night960: string;
  /** The social preview per language (site/og.ts), 1200 × 630. */
  og: Record<Lang, string>;
  /** Path of a file in site/images/logos. */
  logo(file: string): string;
  /** Day the site's content last changed (YYYY-MM-DD, from git in site/build.ts): the sitemap's lastmod and the pages' dateModified. */
  updated: string;
  /** Contact data for the imprint and the privacy notice, from `.dev.vars` (site/legal.ts). */
  imprint: Imprint;
}

/** The text in the language, or English with a `lang` mark when there is no translation (community entries). */
function say(text: L | { en: string }, lang: Lang): string {
  const own = (text as Partial<L>)[lang];
  return own !== undefined ? esc(own) : `<span lang="en">${esc(text.en)}</span>`;
}

/** Inline `code` and *emphasis* in our own texts, after escaping. */
const rich = (text: L, lang: Lang) =>
  esc(text[lang])
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

const GITHUB = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
const BACK = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8H4M7.5 4.5 4 8l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PLUS = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const CROSS = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const ARROW = `<svg class="icon arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const other = (lang: Lang): Lang => (lang === "en" ? "de" : "en");
const OG_LOCALE: Record<Lang, string> = { en: "en_US", de: "de_DE" };
const readme = (lang: Lang) => repoFile(lang === "en" ? "README.md" : "README.de.md");

/** Where a page is, in every language; `null` for the 404, which has no address of its own. */
type Where = ((lang: Lang) => string) | null;

/** The page's JSON-LD graph, from what its head already knows (site/content/schema.ts). */
type Graph = (page: PageMeta) => Node[];

function head(lang: Lang, where: Where, assets: Assets, title: string, description: string, graph: Graph | null): string {
  const image = `${SITE_ORIGIN}${assets.og[lang]}`;
  const alternates = !where
    ? '<meta name="robots" content="noindex">'
    : [
        '<meta name="robots" content="max-image-preview:large, max-snippet:-1">',
        ...LANGS.map((code) => `<link rel="alternate" hreflang="${code}" href="${SITE_ORIGIN}${where(code)}">`),
        `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${where("en")}">`,
        `<link rel="canonical" href="${SITE_ORIGIN}${where(lang)}">`,
        `<link rel="alternate" type="text/markdown" href="${markdownPath(where(lang))}">`,
        `<meta property="og:url" content="${SITE_ORIGIN}${where(lang)}">`,
      ].join("\n");
  const structured =
    where && graph ? `\n${jsonLd(graph({ lang, url: `${SITE_ORIGIN}${where(lang)}`, title, description, updated: assets.updated, image }))}` : "";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${alternates}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Serain">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${image}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(`Serain. ${T.headline[lang]} ${T.headline2[lang]} ${T.sub[lang]}`)}">
<meta property="og:locale" content="${OG_LOCALE[lang]}">
<meta property="og:locale:alternate" content="${OG_LOCALE[other(lang)]}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#ffffff">
<meta name="color-scheme" content="light">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="${assets.font}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${assets.css}">
<script type="module" src="${assets.js}"></script>${structured}
</head>`;
}

function header(lang: Lang, page: Page, where: Where): string {
  const home = pathOf("home", lang);
  const anchor = (id: string) => (page === "home" ? `#${id}` : `${home}#${id}`);
  const switchHref = (where ?? ((code: Lang) => pathOf("home", code)))(other(lang));
  return `<a class="skip" href="#main">${T.skip[lang]}</a>
<header class="nav" data-nav>
  <div class="nav-bar">
    <a class="logo" href="${home}">Serain</a>
    <nav class="nav-links" aria-label="${lang === "en" ? "Main" : "Hauptmenü"}">
      <a class="nav-link nav-optional" href="${anchor("features")}">${T.navFeatures[lang]}</a>
      <a class="nav-link nav-optional" href="${anchor("security")}">${T.navSecurity[lang]}</a>
      <a class="nav-link" href="${pathOf("connectors", lang)}"${page === "connectors" || page === "connector" || page === "submit" ? ' aria-current="page"' : ""}>${T.navConnectors[lang]}</a>
    </nav>
    <div class="nav-end">
      <a class="nav-link lang" href="${switchHref}" hreflang="${other(lang)}" lang="${other(lang)}">${T.switchTo[lang]}</a>
      <a class="btn primary nav-cta" href="${REPO}" aria-label="GitHub">${GITHUB}<span>GitHub</span></a>
    </div>
  </div>
</header>`;
}

function footer(lang: Lang): string {
  return `<footer class="footer">
  <div class="wrap footer-inner">
    <div class="footer-brand">
      <a class="logo footer-logo" href="${pathOf("home", lang)}">Serain</a>
      <p>${T.footerLine[lang]}</p>
      <p>${T.footerLicense[lang]}</p>
    </div>
    <nav class="footer-links" aria-label="${lang === "en" ? "Footer" : "Fußzeile"}">
      <a href="${REPO}">GitHub</a>
      <a href="${pathOf("connectors", lang)}">${T.navConnectors[lang]}</a>
      <a href="${repoFile("docs/SETUP.md")}">${T.footerSetup[lang]}</a>
      <a href="${repoFile("docs/ARCHITECTURE.md")}">${T.footerArchitecture[lang]}</a>
      <a href="${repoFile("SECURITY.md")}">${T.footerSecurity[lang]}</a>
      <a href="${readme(lang)}#${lang === "en" ? "legal" : "rechtliches"}">${T.footerLegal[lang]}</a>
      <a href="${imprintPath(lang)}">${T.footerImprint[lang]}</a>
      <a href="${privacyPath(lang)}">${T.footerPrivacy[lang]}</a>
    </nav>
  </div>
  <p class="wrap trademark">${T.trademark[lang]}</p>
</footer>`;
}

function shell(lang: Lang, page: Page, where: Where, assets: Assets, title: string, description: string, main: string, graph: Graph | null = null): string {
  return `${head(lang, where, assets, title, description, graph)}
<body class="page-${page}">
${header(lang, page, where)}
<main id="main">
${main}
</main>
${footer(lang)}
</body>
</html>
`;
}

/** A full-bleed photograph with its shader on top; without WebGL the photograph alone. */
function backdrop(kind: "sky" | "glass", assets: Assets, priority: boolean): string {
  const [large, small] = kind === "sky" ? [assets.dusk, assets.dusk960] : [assets.night, assets.night960];
  return `<div class="backdrop backdrop-${kind}" aria-hidden="true">
    <img data-shader-image src="${large}" srcset="${small} 960w, ${large} 1672w" sizes="100vw" alt=""${priority ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">
    <canvas data-shader="${kind}"></canvas>
    <div class="shade"></div>
  </div>`;
}

/** The service's own logo, several side by side for a combined listing; the initial where it has none (community entries). */
function mark(listing: Listing, assets: Assets): string {
  if (!listing.logos?.length) return `<span class="mono-tile" aria-hidden="true">${esc(listing.name.charAt(0))}</span>`;
  const images = listing.logos.map((file) => `<img src="${assets.logo(file)}" alt="" width="40" height="40" loading="lazy" decoding="async">`).join("");
  return `<span class="logo-tile${listing.logos.length > 1 ? " several" : ""}" aria-hidden="true">${images}</span>`;
}

const words = (text: string) =>
  text
    .split(" ")
    .map((word) => `<span class="w">${esc(word)}</span>`)
    .join(" ");

function home(lang: Lang, assets: Assets, listings: readonly Listing[]): string {
  const tiles = listings
    .filter((listing) => listing.group !== "community")
    .map((listing) => `<li>${mark(listing, assets)}${esc(listing.name)}</li>`)
    .join("");
  const chapterThreads = CHAPTER_CHATS.map((chat) => thread(chat, lang));
  const main = `<section class="hero">
  <div class="wrap hero-head">
    <h1 class="reveal"><span class="logo hero-logo">Serain</span><span class="hero-line">${T.headline[lang]} <span>${T.headline2[lang]}</span></span></h1>
    <p class="sub reveal">${T.sub[lang]}</p>
    <div class="actions center reveal">
      <a class="btn primary" href="${REPO}">${GITHUB}${T.ctaGithub[lang]}</a>
      <a class="btn ghost" href="${repoFile("docs/SETUP.md")}">${T.ctaSetup[lang]}${ARROW}</a>
    </div>
  </div>
  <div class="wrap">
    <div class="panel hero-panel reveal" data-shader-section>
      ${backdrop("sky", assets, true)}
      ${phone([thread(HERO, lang, "data-hero-thread")], "hero", "phone-hero")}
    </div>
  </div>
</section>

<section class="define" aria-label="serein">
  <div class="wrap narrow">
    <p class="word reveal"><span class="serif">se·rein</span><span class="ipa">${T.ipa[lang]}</span></p>
    <p class="definition" data-words>${words(T.definition[lang])}</p>
    <p class="define-after reveal">${T.defineAfter[lang]}</p>
  </div>
</section>

<section class="section chapters-section" id="features" aria-labelledby="features-title">
  <div class="wrap">
    <header class="section-head reveal">
      <h2 class="title" id="features-title">${T.featuresTitle[lang]}</h2>
    </header>
    <div class="chapters-grid">
      <div class="phone-col"><div class="phone-sticky">${phone(chapterThreads, "stack", "phone-stack")}</div></div>
      <ol class="chapters">
        ${T.chapters
          .map(
            (chapter, index) => `<li class="chapter${index === 0 ? " active" : ""}" data-chapter>
          <span class="chip">0${index + 1}</span>
          <h3>${chapter.title[lang]}</h3>
          <p>${chapter.body[lang]}</p>
          <div class="chat-card">${thread(CHAPTER_CHATS[index]!, lang)}</div>
        </li>`,
          )
          .join("\n        ")}
      </ol>
    </div>
  </div>
</section>

<section class="night" id="security" aria-labelledby="security-title">
  <div class="panel night-panel" data-shader-section>
    ${backdrop("glass", assets, false)}
    <div class="wrap">
      <header class="section-head reveal">
        <h2 class="title" id="security-title">${T.securityTitle[lang]}</h2>
        <p class="lead">${rich(T.securityLead, lang)}</p>
      </header>
      <ol class="tiers">
        ${T.levels
          .map((level, index) => {
            const meter = [0, 1, 2, 3].map((i) => `<i${i <= index ? ' class="on"' : ""}></i>`).join("");
            const chat = LEVEL_CHATS[index];
            const demo = chat
              ? `<div class="tier-demo">${thread(chat, lang)}</div>`
              : `<div class="tier-demo tier-money" aria-hidden="true"><span class="tier-yes">${T.moneyEvery[lang]}</span><s class="tier-no">${T.moneyNever[lang]}</s></div>`;
            return `<li class="tier reveal${level.name === "irreversible" ? " key" : ""}">
          <div class="tier-top"><span class="tier-n">0${index + 1}</span><span class="meter" role="img" aria-label="${T.strictness[lang].replace("{n}", String(index + 1))}">${meter}</span></div>
          <code>${level.name}</code>
          <p class="tier-how">${level.how[lang]}</p>
          ${demo}
        </li>`;
          })
          .join("\n        ")}
      </ol>
      <div class="kill reveal">
        <div class="kill-text">
          <h3>${T.killTitle[lang]}</h3>
          <p>${rich(T.killBody, lang)}</p>
          <p class="more"><a href="${readme(lang)}#${lang === "en" ? "security-model" : "sicherheitsmodell"}">${T.securityMore[lang]}${ARROW}</a></p>
        </div>
        <div class="chat-card">${thread(KILL, lang)}</div>
      </div>
    </div>
  </div>
</section>

<section class="section" aria-labelledby="own-title">
  <div class="wrap">
    <header class="section-head reveal">
      <h2 class="title" id="own-title">${T.ownTitle[lang]}</h2>
      <p class="lead">${T.ownLead[lang]}</p>
    </header>
    <ol class="flow reveal" data-flow>
      ${T.flow
        .map((node, index) => {
          const wire =
            index < T.wires.length
              ? `<li class="wire" aria-hidden="true"><span class="wire-label">${T.wires[index]![lang]}</span><i class="pkt" data-wire="${index}" data-dir="1"></i><i class="pkt" data-wire="${index}" data-dir="-1"></i></li>`
              : "";
          const work = index === 2 ? `<span class="work" aria-hidden="true"><i></i><i></i><i></i></span>` : "";
          return `<li class="node${index === 2 ? " home" : ""}" data-node="${index}"><i class="ping" aria-hidden="true"></i><strong>${node.name[lang]}</strong><span>${node.sub[lang]}</span>${work}</li>${wire}`;
        })
        .join("\n      ")}
    </ol>
  </div>
</section>

<section class="section wash connectors-teaser" aria-labelledby="connectors-title">
  <div class="wrap">
    <header class="section-head reveal">
      <h2 class="title" id="connectors-title">${T.connTeaserTitle[lang]}</h2>
      <p class="lead">${T.connTeaser[lang]}</p>
    </header>
  </div>
  <div class="marquee">
    <ul class="marquee-track" aria-label="${T.navConnectors[lang]}">${tiles}</ul>
    <ul class="marquee-track" aria-hidden="true">${tiles}</ul>
  </div>
  <div class="wrap actions reveal">
    <a class="btn primary" href="${pathOf("connectors", lang)}">${T.allConnectors[lang]}${ARROW}</a>
    <a class="btn ghost" href="${submitPath(lang)}">${T.submitOne[lang]}</a>
  </div>
</section>

<section class="section" id="start" aria-labelledby="start-title">
  <div class="wrap start-grid">
    <header class="reveal">
      <h2 class="title" id="start-title">${T.startTitle[lang]}</h2>
      <p class="lead">${T.startLead[lang]}</p>
      <div class="actions">
        <a class="btn primary" href="${REPO}">${GITHUB}${T.ctaGithub[lang]}</a>
        <a class="btn ghost" href="${repoFile("docs/SETUP.md")}">${T.ctaSetup[lang]}${ARROW}</a>
      </div>
    </header>
    <div class="terminal reveal">
      <div class="terminal-bar" aria-hidden="true"><i></i><i></i><i></i></div>
      <pre><code><span class="prompt">$</span> git clone ${REPO}
<span class="prompt">$</span> cd serain &amp;&amp; pnpm install
<span class="comment">${esc(T.startComment[lang])}</span></code></pre>
      <button class="copy" type="button" data-copy="git clone ${REPO} &amp;&amp; cd serain &amp;&amp; pnpm install" hidden><span class="copy-idle">${T.copy[lang]}</span><span class="copy-done">${T.copied[lang]}</span></button>
    </div>
  </div>
</section>

<section class="section wash" id="faq" aria-labelledby="faq-title">
  <div class="wrap faq-grid">
    <header class="section-head faq-head reveal">
      <h2 class="title" id="faq-title">${T.faqTitle[lang]}</h2>
      <p class="more"><a href="${readme(lang)}">${T.faqMore[lang]}${ARROW}</a></p>
    </header>
    <div class="faq">
      ${T.faq.map((item) => `<div class="faq-item reveal"><h3>${esc(item.q[lang])}</h3><p>${esc(item.a[lang])}</p></div>`).join("\n      ")}
    </div>
  </div>
</section>`;
  return shell(lang, "home", (code) => pathOf("home", code), assets, T.homeTitle[lang], T.homeDescription[lang], main, homeGraph);
}

function toolTable(tools: readonly Tool[], lang: Lang): string {
  const rows = tools
    .map(
      (tool) =>
        `<tr><td><code>${esc(tool.name)}</code></td><td>${say(tool.label, lang)}</td><td><span class="level ${tool.level === "read" ? "read" : "write"}">${(tool.level === "read" ? T.levelRead : T.levelWrite)[lang]}</span></td></tr>`,
    )
    .join("");
  return `<table class="tools"><tbody>${rows}</tbody></table>`;
}

/** The text the directory's search compares against: name, summary, category and tool names. */
function haystack(listing: Listing, lang: Lang): string {
  const summary = (listing.summary as Partial<L>)[lang] ?? listing.summary.en;
  return [listing.name, summary, CATEGORY[listing.category][lang], ...(listing.tools ?? []).map((tool) => tool.name)].join(" ").toLowerCase();
}

/** One tile of the directory: the whole tile links to the connector's own page. */
function card(listing: Listing, lang: Lang, assets: Assets): string {
  return `<li class="conn" data-category="${listing.category}" data-search="${esc(haystack(listing, lang))}">
  <a class="conn-link" href="${connectorPath(listing.id, lang)}">
    ${mark(listing, assets)}
    <span class="conn-body">
      <span class="conn-name">${esc(listing.name)}</span>
      <span class="conn-summary">${say(listing.summary, lang)}</span>
      <span class="conn-meta">${CATEGORY[listing.category][lang]} · ${access(listing, lang)}</span>
    </span>
    ${ARROW}
  </a>
</li>`;
}

/** The connector form sends a GET to GitHub's new issue page; the field names are the ids in the issue form. GitHub prefills only text fields. */
export const SUBMIT_FIELDS = ["title", "website", "source", "summary", "tools", "risks"] as const;

/** The band below the directory that leads to the submit page. */
function submitBand(lang: Lang): string {
  return `<section class="section wash submit-band" aria-labelledby="missing-title">
  <div class="wrap submit-band-inner">
    <div>
      <h2 class="title" id="missing-title">${T.missingTitle[lang]}</h2>
      <p class="lead">${T.missingLead[lang]}</p>
    </div>
    <a class="btn primary" href="${submitPath(lang)}">${T.submitTitle[lang]}${ARROW}</a>
  </div>
</section>`;
}

/**
 * Submitting a connector, in steps like the directories of the big assistants:
 * rules first, then the service, its tools, its risks and a last look. With the
 * script one step shows at a time and the tools are rows with a level picker;
 * without it the same fields stand in one form. Either way it ends in a GET to
 * GitHub's new issue page, which prefills the text fields of the issue form.
 */
function submitPage(lang: Lang, assets: Assets): string {
  const step = (index: number, key: keyof typeof T.steps, body: string) => `<fieldset class="step" data-step="${index}" aria-labelledby="step-${key}">
      <legend class="step-title" id="step-${key}"><span class="step-n">${index + 1}</span>${T.steps[key][lang]}</legend>
      ${body}
    </fieldset>`;
  const toolsHint = "todoist_tasks, Open tasks, read\ntodoist_add, Add a task, write_reversible";
  const levels = `<option value="read">${T.levelRead[lang]}</option><option value="write_reversible">${T.levelWrite[lang]}</option>`;
  const keys = Object.keys(T.steps) as Array<keyof typeof T.steps>;
  const review = (["title", "website", "source", "summary", "tools", "risks"] as const)
    .map((field) => {
      const label = { title: T.fieldService, website: T.fieldWebsite, source: T.fieldSource, summary: T.fieldSummary, tools: T.steps.tools, risks: T.fieldRisks }[field];
      return `<div><dt>${label[lang]}</dt><dd data-review-of="${field}" data-empty="${T.reviewEmpty[lang]}"></dd></div>`;
    })
    .join("\n        ");
  const main = `<section class="page-head submit-head">
  <div class="wrap">
    <a class="back reveal" href="${pathOf("connectors", lang)}">${BACK}${T.allConnectors[lang]}</a>
    <h1 class="reveal">${T.submitTitle[lang]}</h1>
    <p class="lead reveal">${T.submitLead[lang]}</p>
  </div>
</section>
<div class="wrap wizard-layout">
  <nav class="wizard-steps" data-wizard-only hidden aria-label="${T.submitTitle[lang]}">
    <ol>
      ${keys.map((key, index) => `<li><button type="button" data-goto="${index}"${index === 0 ? ' aria-current="step"' : " disabled"}><span class="step-n">${index + 1}</span>${T.steps[key][lang]}</button></li>`).join("\n      ")}
    </ol>
  </nav>
  <form class="wizard" data-wizard method="get" action="${ISSUE_NEW}">
    <input type="hidden" name="template" value="${CONNECTOR_TEMPLATE}">
    ${step(
      0,
      "start",
      `<div class="kinds" data-wizard-only hidden>
        <button type="button" class="kind" data-kind="built" aria-pressed="true"><span class="kind-title">${T.kindBuilt[lang]}</span><span class="kind-sub">${T.kindBuiltSub[lang]}</span></button>
        <button type="button" class="kind" data-kind="idea" aria-pressed="false"><span class="kind-title">${T.kindIdea[lang]}</span><span class="kind-sub">${T.kindIdeaSub[lang]}</span></button>
      </div>
      <p class="step-lead">${T.rulesLead[lang]}</p>
      <ul class="rules">
        ${T.rules.map((rule) => `<li>${rich(rule, lang)}</li>`).join("\n        ")}
      </ul>
      <p class="more"><a href="${repoFile("docs/INSTANCE.md")}">${T.howBuild[lang]}${ARROW}</a></p>`,
    )}
    ${step(
      1,
      "service",
      `<label>${T.fieldService[lang]}<input name="title" required maxlength="80" autocomplete="off" placeholder="${esc(T.fieldServiceHint[lang])}"></label>
      <label>${T.fieldWebsite[lang]}<input name="website" type="url" required maxlength="200" pattern="https://.+" placeholder="https://"></label>
      <label data-built-only>${T.fieldSource[lang]}<input name="source" type="url" maxlength="200" pattern="https://.+" placeholder="https://github.com/…"><span class="hint">${T.fieldSourceHint[lang]}</span></label>
      <label>${T.fieldSummary[lang]}<textarea name="summary" required rows="3" maxlength="600"></textarea><span class="hint">${T.fieldSummaryHint[lang]}</span></label>`,
    )}
    ${step(
      2,
      "tools",
      `<p class="step-lead">${T.toolsLead[lang]}</p>
      <div class="tool-rows" data-tool-rows data-wizard-only hidden>
        <div class="tool-head" aria-hidden="true"><span>${T.toolName[lang]}</span><span>${T.toolLabel[lang]}</span><span>${T.toolLevel[lang]}</span></div>
      </div>
      <button type="button" class="btn ghost small" data-tool-add data-wizard-only hidden>${PLUS}${T.toolAdd[lang]}</button>
      <template data-tool-template><div class="tool-row"><input class="tool-name" aria-label="${T.toolName[lang]}" placeholder="todoist_tasks" maxlength="64" pattern="[a-z][a-z0-9_]{1,63}" autocomplete="off" spellcheck="false"><input class="tool-label" aria-label="${T.toolLabel[lang]}" placeholder="${lang === "en" ? "Open tasks" : "Offene Aufgaben"}" maxlength="120" autocomplete="off"><select class="tool-level" aria-label="${T.toolLevel[lang]}">${levels}</select><button type="button" class="tool-remove" aria-label="${T.toolRemove[lang]}">${CROSS}</button></div></template>
      <label class="tools-raw" data-no-wizard>${T.fieldTools[lang]}<textarea name="tools" rows="4" maxlength="1500" placeholder="${esc(toolsHint)}"></textarea></label>`,
    )}
    ${step(3, "risks", `<label>${T.fieldRisks[lang]}<textarea name="risks" rows="5" maxlength="1500"></textarea><span class="hint">${T.fieldRisksHint[lang]}</span></label>`)}
    ${step(
      4,
      "review",
      `<p class="step-lead">${T.reviewLead[lang]}</p>
      <dl class="review" data-wizard-only hidden>
        ${review}
      </dl>
      <button class="btn primary" type="submit">${GITHUB}${T.submitButton[lang]}</button>
      <p class="fine">${T.submitNote[lang]}</p>`,
    )}
    <div class="wizard-nav" data-wizard-only hidden>
      <button type="button" class="btn ghost" data-prev>${BACK}${T.back[lang]}</button>
      <span class="wizard-progress" data-progress data-template="${T.stepOf[lang]}" aria-live="polite"></span>
      <button type="button" class="btn primary" data-next>${T.next[lang]}${ARROW}</button>
    </div>
  </form>
</div>
<section class="section wash after" aria-labelledby="after-title">
  <div class="wrap">
    <h2 class="title" id="after-title">${T.afterTitle[lang]}</h2>
    <ol class="after-steps">
      ${T.after.map((item, index) => `<li class="reveal"><span class="step-n">${index + 1}</span><h3>${item.title[lang]}</h3><p>${item.text[lang]}</p></li>`).join("\n      ")}
    </ol>
  </div>
</section>`;
  return shell(lang, "submit", submitPath, assets, T.submitPageTitle[lang], T.submitDescription[lang], main, (page) => subpageGraph(page, T.submitTitle[lang]));
}

function connectors(lang: Lang, assets: Assets, listings: readonly Listing[]): string {
  const groups = (["integration", "connection", "community"] as const)
    .map((group) => {
      const items = listings.filter((listing) => listing.group === group);
      const body = items.length
        ? `<ul class="cards">${items.map((listing) => card(listing, lang, assets)).join("\n")}</ul>`
        : `<p class="empty">${T.communityEmpty[lang]} <a href="${submitPath(lang)}">${T.submitOne[lang]}${ARROW}</a></p>`;
      return `<section class="group" data-group aria-labelledby="group-${group}">
  <header class="group-head"><h2 id="group-${group}">${T.groups[group].title[lang]}</h2><p>${T.groups[group].sub[lang]}</p></header>
  ${body}
</section>`;
    })
    .join("\n");
  const categories = (Object.keys(CATEGORY) as Array<keyof typeof CATEGORY>)
    .map((category) => [category, listings.filter((listing) => listing.category === category).length] as const)
    .filter(([, count]) => count > 0);
  const filter = (value: string, label: string, count: number, pressed: boolean) =>
    `<li><button type="button" class="filter" data-filter="${value}" aria-pressed="${pressed}"><span>${label}</span><span class="count">${count}</span></button></li>`;
  // Search and filter need the script; without it every connector is simply listed.
  const main = `<section class="page-head dir-head">
  <div class="wrap">
    <h1 class="reveal">${T.navConnectors[lang]}</h1>
    <p class="lead reveal">${T.connLead[lang]}</p>
    <div class="actions reveal"><a class="btn primary" href="${submitPath(lang)}">${T.submitTitle[lang]}</a><a class="btn ghost" href="${REPO}">${GITHUB}GitHub</a></div>
  </div>
</section>
<div class="wrap dir" data-directory>
  <aside class="dir-side" data-filters hidden>
    <p class="dir-side-title" id="filter-title">${T.filter[lang]}</p>
    <ul class="filters" aria-labelledby="filter-title">
      ${[filter("all", T.filterAll[lang], listings.length, true), ...categories.map(([category, count]) => filter(category, CATEGORY[category][lang], count, false))].join("\n      ")}
    </ul>
  </aside>
  <div class="dir-main">
    <div class="dir-search" data-filters hidden>
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <input type="search" data-search-input placeholder="${T.search[lang]}" aria-label="${T.search[lang]}" autocomplete="off" spellcheck="false">
    </div>
    ${groups}
    <p class="empty" data-no-match hidden>${T.noMatch[lang]}</p>
  </div>
</div>
${submitBand(lang)}`;
  const graph: Graph = (page) => directoryGraph(page, listings, (listing) => `${SITE_ORIGIN}${connectorPath(listing.id, lang)}`);
  return shell(lang, "connectors", (code) => pathOf("connectors", code), assets, T.connTitle[lang], T.connDescription[lang], main, graph);
}

/** Up to three other listings: same category first, then the same group. */
function relatedTo(listing: Listing, listings: readonly Listing[]): Listing[] {
  const others = listings.filter((other) => other.id !== listing.id);
  const rank = (other: Listing) => (other.category === listing.category ? 0 : other.group === listing.group ? 1 : 2);
  return [...others].sort((a, b) => rank(a) - rank(b)).slice(0, 3);
}

/** How it is connected: the command to copy, the web interface, or a community connector's code. */
function connectBox(listing: Listing, lang: Lang): string {
  if (listing.group === "community") {
    return `<p>${T.communityConnect[lang]} <a href="${repoFile("docs/INSTANCE.md")}">${T.instanceGuide[lang]}</a></p>`;
  }
  const text = listing.connect ? `<p>${esc(listing.connect[lang])}</p>` : "";
  const command = listing.command
    ? `<div class="cmd"><code>${esc(listing.command)}</code><button class="copy" type="button" data-copy="${esc(listing.command)}" hidden><span class="copy-idle">${T.copy[lang]}</span><span class="copy-done">${T.copied[lang]}</span></button></div>`
    : "";
  return text + command;
}

const connectorTitle = (listing: Listing, lang: Lang) => `${listing.name} · ${T.connTitle[lang]}`;

/** What Serain is, then the connector's own summary: the summary alone says nothing to someone who does not know Serain. */
function connectorDescription(listing: Listing, lang: Lang): string {
  const summary = (listing.summary as Partial<L>)[lang] ?? listing.summary.en;
  return T.connectorDescription[lang].replace("{name}", () => listing.name).replace("{summary}", () => summary);
}

function connectorPage(listing: Listing, lang: Lang, assets: Assets, listings: readonly Listing[]): string {
  const by =
    listing.group === "community"
      ? `<a href="https://github.com/${esc(listing.author!)}">@${esc(listing.author!)}</a>`
      : "Serain";
  const links =
    listing.group === "community"
      ? `<a href="${esc(listing.source!)}">${T.source[lang]}</a><a href="${REPO}/issues/${listing.issue}">${T.review[lang]} #${listing.issue}</a>`
      : `<a href="${repoFile("docs/SETUP.md")}">${T.setupGuide[lang]}</a>`;
  const tools = listing.tools?.length
    ? `<section class="detail-section" aria-labelledby="tools-title">
      <h2 id="tools-title">${T.toolsTitle[lang]} <span class="count">${listing.tools.length}</span></h2>
      ${toolTable(listing.tools, lang)}
    </section>`
    : "";
  const related = relatedTo(listing, listings);
  const main = `<section class="page-head detail-head">
  <div class="wrap">
    <a class="back reveal" href="${pathOf("connectors", lang)}">${BACK}${T.allConnectors[lang]}</a>
    <div class="detail-top">
      <div class="detail-title reveal">
        ${mark(listing, assets)}
        <h1>${esc(listing.name)}</h1>
        <p class="lead">${say(listing.summary, lang)}</p>
      </div>
      <dl class="meta reveal">
        <div><dt>${T.metaCategory[lang]}</dt><dd>${CATEGORY[listing.category][lang]}</dd></div>
        <div><dt>${T.metaGroup[lang]}</dt><dd>${T.groups[listing.group].title[lang]}</dd></div>
        <div><dt>${T.metaAccess[lang]}</dt><dd>${access(listing, lang)}</dd></div>
        <div><dt>${T.metaBy[lang]}</dt><dd>${by}</dd></div>
        <div><dt>${T.metaLinks[lang]}</dt><dd class="meta-links">${links}</dd></div>
      </dl>
    </div>
  </div>
</section>
<div class="wrap detail-body">
  <div class="detail-main">
    <section class="detail-section" aria-labelledby="acts-title">
      <h2 id="acts-title">${T.actsTitle[lang]}</h2>
      <p>${esc(actsOf(listing, lang))}</p>
    </section>
    <section class="detail-section" aria-labelledby="connect-title">
      <h2 id="connect-title">${T.connectTitle[lang]}</h2>
      ${connectBox(listing, lang)}
    </section>
    ${tools}
    <p class="note">${T.trust[lang]}${listing.group === "community" ? ` ${T.trustCommunity[lang]}` : ""}</p>
  </div>
</div>
<section class="section wash related" aria-labelledby="related-title">
  <div class="wrap">
    <h2 class="related-title" id="related-title">${T.related[lang]}</h2>
    <ul class="cards">${related.map((other) => card(other, lang, assets)).join("\n")}</ul>
  </div>
</section>`;
  const graph: Graph = (page) => subpageGraph(page, listing.name);
  return shell(lang, "connector", (code) => connectorPath(listing.id, code), assets, connectorTitle(listing, lang), connectorDescription(listing, lang), main, graph);
}

/** A paragraph of the legal pages (site/content/legal.ts): links, **strong** and `code`, after escaping. */
const legalText = (text: string) =>
  esc(text)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

function legal(lang: Lang, where: Address, assets: Assets, page: LegalPage): string {
  const sections = page.sections
    .map((section, index) => {
      const address = section.address ? `<address>${section.address.map(esc).join("<br>")}</address>` : "";
      const paragraphs = section.paragraphs.map((text) => `<p>${legalText(text)}</p>`).join("");
      return `<section class="detail-section" aria-labelledby="legal-${index}">
      <h2 id="legal-${index}">${esc(section.heading)}</h2>
      ${address}${paragraphs}
    </section>`;
    })
    .join("\n    ");
  const main = `<section class="page-head legal-head">
  <div class="wrap">
    <h1 class="reveal">${esc(page.heading)}</h1>${page.intro ? `\n    <p class="lead reveal">${legalText(page.intro)}</p>` : ""}
  </div>
</section>
<div class="wrap legal">
  <div class="detail-main">
    ${sections}
  </div>
</div>`;
  return shell(lang, "legal", where, assets, page.title, page.description, main, (meta) => subpageGraph(meta, page.heading));
}

function notFound(assets: Assets): string {
  const main = `<section class="page-head center">
  <div class="wrap">
    <h1 class="reveal"><span class="logo hero-logo">404</span></h1>
    <p class="lead reveal">This page does not exist. <span lang="de">Diese Seite gibt es nicht.</span></p>
    <div class="actions center reveal"><a class="btn primary" href="/">Serain</a><a class="btn ghost" href="/de/" lang="de">Deutsch</a></div>
  </div>
</section>`;
  return shell("en", "notFound", null, assets, T.notFoundTitle.en, T.homeDescription.en, main);
}

/** Every file of the site except the assets: path below `dist/` → content. */
export function renderSite(assets: Assets, community: readonly CommunityConnector[] = COMMUNITY): Record<string, string> {
  const listings = directory(community);
  const files: Record<string, string> = { "404.html": notFound(assets) };
  const markdownMeta = (where: Address, lang: Lang, title: string, description: string): MarkdownMeta => ({
    lang,
    url: `${SITE_ORIGIN}${where(lang)}`,
    otherUrl: `${SITE_ORIGIN}${where(other(lang))}`,
    title,
    description,
    updated: assets.updated,
  });
  /** A page and its Markdown twin, side by side. */
  const write = (where: Address, lang: Lang, html: string, markdown: (meta: MarkdownMeta) => string, title: string, description: string) => {
    const path = where(lang).slice(1);
    files[`${path}index.html`] = html;
    files[markdownPath(path)] = markdown(markdownMeta(where, lang, title, description));
  };
  const homeAt: Address = (lang) => pathOf("home", lang);
  const directoryAt: Address = (lang) => pathOf("connectors", lang);
  const connectorAt = (listing: Listing): Address => (lang) => connectorPath(listing.id, lang);
  for (const lang of LANGS) {
    write(homeAt, lang, home(lang, assets, listings), (meta) => homeMarkdown(meta, listings), T.homeTitle[lang], T.homeDescription[lang]);
    write(directoryAt, lang, connectors(lang, assets, listings), (meta) => connectorsMarkdown(meta, listings), T.connTitle[lang], T.connDescription[lang]);
    write(submitPath, lang, submitPage(lang, assets), submitMarkdown, T.submitPageTitle[lang], T.submitDescription[lang]);
    for (const listing of listings) {
      const html = connectorPage(listing, lang, assets, listings);
      write(connectorAt(listing), lang, html, (meta) => connectorMarkdown(meta, listing), connectorTitle(listing, lang), connectorDescription(listing, lang));
    }
    for (const [where, page] of [[imprintPath, imprintPage(lang, assets.imprint)], [privacyPath, privacyPage(lang, assets.imprint)]] as const) {
      write(where, lang, legal(lang, where, assets, page), (meta) => legalMarkdown(meta, page), page.title, page.description);
    }
  }
  files["sitemap.xml"] = sitemapXml([homeAt, directoryAt, submitPath, ...listings.map(connectorAt), imprintPath, privacyPath], assets.updated);
  files["robots.txt"] = robotsTxt();
  files["llms.txt"] = llmsTxt(listings);
  files[".well-known/security.txt"] = securityTxt(assets.updated);
  files[`${INDEXNOW_KEY}.txt`] = INDEXNOW_KEY;
  return files;
}
