import type { Listing } from "./directory.js";
import { LICENSE_URL, LANGS, MAINTAINER, pathOf, REPO, SITE_ORIGIN, type Lang } from "./site.js";
import { T } from "./text.js";

/**
 * Structured data for serain.si (D65), one JSON-LD graph per page. The
 * entities (the website, Serain itself, its source code and its maintainer)
 * are declared once with an `@id` and only referenced elsewhere. Everything
 * in here is also visible on the page: search engines and AI assistants
 * that never read JSON-LD find the same facts in the text.
 */

export type Node = Record<string, unknown>;

const ID = {
  website: `${SITE_ORIGIN}/#website`,
  serain: `${SITE_ORIGIN}/#serain`,
  source: `${SITE_ORIGIN}/#source`,
  maintainer: `${SITE_ORIGIN}/#maintainer`,
};
const ref = (id: string) => ({ "@id": id });

const LOCALE: Record<Lang, string> = { en: "en", de: "de" };

/** The entities every page refers to, described in the page's language. */
function entities(lang: Lang, image: string): Node[] {
  return [
    {
      "@type": "WebSite",
      "@id": ID.website,
      name: "Serain",
      url: `${SITE_ORIGIN}/`,
      description: T.homeDescription[lang],
      inLanguage: LANGS.map((code) => LOCALE[code]),
      publisher: ref(ID.maintainer),
    },
    {
      "@type": "SoftwareApplication",
      "@id": ID.serain,
      name: "Serain",
      url: `${SITE_ORIGIN}${pathOf("home", lang)}`,
      description: T.homeDescription[lang],
      applicationCategory: "CommunicationApplication",
      applicationSubCategory: T.appCategory[lang],
      operatingSystem: "Linux",
      featureList: T.chapters.map((chapter) => chapter.title[lang]),
      image,
      license: LICENSE_URL,
      isAccessibleForFree: true,
      // The code costs nothing; what an owner pays for (API, server) is theirs and named in the FAQ.
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
      author: ref(ID.maintainer),
      sameAs: [REPO],
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": ID.source,
      name: "Serain",
      codeRepository: REPO,
      programmingLanguage: "TypeScript",
      runtimePlatform: "Node.js",
      license: LICENSE_URL,
      author: ref(ID.maintainer),
      targetProduct: ref(ID.serain),
    },
    { "@type": "Person", "@id": ID.maintainer, name: MAINTAINER.name, url: MAINTAINER.url },
  ];
}

export interface PageMeta {
  lang: Lang;
  /** Absolute URL of the page. */
  url: string;
  title: string;
  description: string;
  /** ISO date the site's content last changed (site/build.ts). */
  updated: string;
  /** Absolute URL of the social preview. */
  image: string;
}

function webPage(type: string, page: PageMeta, extra: Node = {}): Node {
  return {
    "@type": type,
    "@id": `${page.url}#webpage`,
    url: page.url,
    name: page.title,
    description: page.description,
    inLanguage: LOCALE[page.lang],
    isPartOf: ref(ID.website),
    about: ref(ID.serain),
    dateModified: page.updated,
    ...extra,
  };
}

/** Serain › Connectors › …, the way back the page itself shows. */
function breadcrumb(page: PageMeta, trail: ReadonlyArray<readonly [string, string]>): Node {
  return {
    "@type": "BreadcrumbList",
    "@id": `${page.url}#breadcrumb`,
    itemListElement: trail.map(([name, url], index) => ({ "@type": "ListItem", position: index + 1, name, item: url })),
  };
}

const connectorsUrl = (lang: Lang) => `${SITE_ORIGIN}${pathOf("connectors", lang)}`;
const trailTo = (lang: Lang): Array<readonly [string, string]> => [
  ["Serain", `${SITE_ORIGIN}${pathOf("home", lang)}`],
  [T.navConnectors[lang], connectorsUrl(lang)],
];

export function homeGraph(page: PageMeta): Node[] {
  return [
    ...entities(page.lang, page.image),
    webPage("WebPage", page, { mainEntity: ref(ID.serain) }),
    {
      "@type": "FAQPage",
      "@id": `${page.url}#faq`,
      url: page.url,
      inLanguage: LOCALE[page.lang],
      isPartOf: ref(`${page.url}#webpage`),
      mainEntity: T.faq.map((item) => ({
        "@type": "Question",
        name: item.q[page.lang],
        acceptedAnswer: { "@type": "Answer", text: item.a[page.lang] },
      })),
    },
  ];
}

/** The directory: a collection page whose list is every connector's own page. */
export function directoryGraph(page: PageMeta, listings: readonly Listing[], urlOf: (listing: Listing) => string): Node[] {
  return [
    ...entities(page.lang, page.image),
    webPage("CollectionPage", page, {
      breadcrumb: ref(`${page.url}#breadcrumb`),
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: listings.length,
        itemListElement: listings.map((listing, index) => ({ "@type": "ListItem", position: index + 1, name: listing.name, url: urlOf(listing) })),
      },
    }),
    breadcrumb(page, trailTo(page.lang)),
  ];
}

/** A page below the directory: one connector, or the submit page. */
export function subpageGraph(page: PageMeta, name: string): Node[] {
  return [
    ...entities(page.lang, page.image),
    webPage("WebPage", page, { breadcrumb: ref(`${page.url}#breadcrumb`) }),
    breadcrumb(page, [...trailTo(page.lang), [name, page.url]]),
  ];
}

/**
 * The graph as a `<script type="application/ld+json">` data block. It is not
 * executed, so the CSP's `script-src 'self'` does not apply; `<` is escaped
 * so no text in it can close the element.
 */
export function jsonLd(graph: Node[]): string {
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}
