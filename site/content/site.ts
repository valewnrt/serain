/**
 * The project's public website (D65): the landing page and the connector
 * directory. It belongs to the project, not to an instance, so its address and
 * the repository are fixed here. It has no database, no script and no access to
 * anything of an owner; the web interface of an instance runs on its own
 * origin behind Access (D49).
 */
export const SITE_ORIGIN = "https://serain.si";
export const REPO = "https://github.com/valewnrt/serain";
/** The copyright holder in README.md: who builds Serain, and the entity behind the site in its JSON-LD (site/content/schema.ts). */
export const MAINTAINER = { name: "Valentin Weinert", url: "https://github.com/valewnrt" };
export const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";
/**
 * IndexNow (Bing, Yandex, Seznam, Naver): after a deploy, `pnpm site:deploy`
 * names the pages whose content changed. Public by design: the site serves
 * it as `/<key>.txt` to prove the domain is ours.
 */
export const INDEXNOW_KEY = "a7de5ae5daf1c1b189f10c4b083c4c9a"; // gitleaks:allow (public by protocol)

export const LANGS = ["en", "de"] as const;
export type Lang = (typeof LANGS)[number];
export type L = Record<Lang, string>;

export type Page = "home" | "connectors" | "connector" | "submit" | "notFound";

/** Path of a page in a language: English at the root, German under /de/. */
export function pathOf(page: "home" | "connectors", lang: Lang): string {
  const prefix = lang === "en" ? "/" : `/${lang}/`;
  return page === "home" ? prefix : `${prefix}connectors/`;
}

/** Path of one connector's own page. */
export const connectorPath = (id: string, lang: Lang) => `${pathOf("connectors", lang)}${id}/`;

/** Path of the page to submit a connector; `submit` is therefore no connector id (site/content/directory.ts). */
export const submitPath = (lang: Lang) => `${pathOf("connectors", lang)}submit/`;

/** The Markdown twin of a page for agents (site/content/markdown.ts), next to its `index.html`. */
export const markdownPath = (path: string) => `${path}index.md`;

/** A file in the repository on GitHub. */
export const repoFile = (path: string) => `${REPO}/blob/main/${path}`;

/** New issue from the connector form (`.github/ISSUE_TEMPLATE/connector.yml`). */
export const ISSUE_NEW = `${REPO}/issues/new`;
export const CONNECTOR_TEMPLATE = "connector.yml";
