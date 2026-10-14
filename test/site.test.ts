import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_CONNECTORS } from "../src/connectors/catalog.js";
import type { CommunityConnector } from "../site/content/community.js";
import { directory } from "../site/content/directory.js";
import { renderSite, SUBMIT_FIELDS } from "../site/content/render.js";
import { CONNECTOR_TEMPLATE, INDEXNOW_KEY } from "../site/content/site.js";
import { T } from "../site/content/text.js";
import { prefersMarkdown } from "../site/worker/accept.js";
import { agentOf, counted, record, referrerHost } from "../site/worker/analytics.js";

const ROOT = join(import.meta.dirname, "..");
const ASSETS = {
  css: "/assets/site.test.css",
  js: "/assets/site.test.js",
  font: "/assets/font.test.woff2",
  dusk: "/assets/dusk.webp",
  dusk960: "/assets/dusk-960.webp",
  night: "/assets/night.webp",
  night960: "/assets/night-960.webp",
  og: { en: "/assets/og-en.jpg", de: "/assets/og-de.jpg" },
  logo: (file: string) => `/assets/${file}`,
  updated: "2026-10-14",
};
const pages = renderSite(ASSETS);

const entry = (patch: Partial<CommunityConnector> = {}): CommunityConnector => ({
  id: "todo",
  name: "Todo",
  category: "productivity",
  summary: { en: "Open tasks." },
  author: "someone",
  source: "https://github.com/someone/serain-todo",
  issue: 7,
  tools: [{ name: "todo_tasks", label: "Open tasks", level: "read" }],
  ...patch,
});

describe("connector directory (D65)", () => {
  it("lists every service of the catalog with exactly its tools and levels", () => {
    const listings = directory([]);
    for (const info of BUILT_IN_CONNECTORS) {
      const listing = listings.find((item) => item.id === info.id);
      expect(listing?.group).toBe("connection");
      expect(listing?.tools?.map((tool) => [tool.name, tool.level])).toEqual(info.tools.map((tool) => [tool.name, tool.level]));
    }
  });

  it("accepts a valid community entry", () => {
    expect(directory([entry()]).find((item) => item.id === "todo")?.group).toBe("community");
  });

  it("refuses community entries that break the rules", () => {
    const tool = (level: string, name = "todo_x") => [{ name, label: "x", level } as never];
    expect(() => directory([entry({ id: "coros" })])).toThrow(/exists twice/);
    expect(() => directory([entry({ id: "submit" })])).toThrow(/reserved/);
    expect(() => directory([entry({ tools: tool("irreversible") })])).toThrow(/only read or write reversibly/);
    expect(() => directory([entry({ tools: tool("money") })])).toThrow(/only read or write reversibly/);
    expect(() => directory([entry({ tools: tool("read", "coros_sleep") })])).toThrow(/exists twice/);
    expect(() => directory([entry({ tools: [] })])).toThrow(/no tools/);
    expect(() => directory([entry({ source: "http://example.com" })])).toThrow(/https source/);
    expect(() => directory([entry({ source: 'https://x" onclick="y' })])).toThrow(/https source/);
    expect(() => directory([entry({ author: "<b>" })])).toThrow(/GitHub handle/);
    expect(() => directory([entry({ issue: 0 })])).toThrow(/issue/);
  });
});

describe("serain.si pages (D65)", () => {
  const html = Object.entries(pages).filter(([path]) => path.endsWith(".html"));

  it("renders every page in both languages, one page per connector and a 404", () => {
    const ids = directory().map((listing) => listing.id);
    const perLang = ["index.html", "connectors/index.html", "connectors/submit/index.html", ...ids.map((id) => `connectors/${id}/index.html`)];
    const withTwins = perLang.flatMap((path) => [path, path.replace(/index\.html$/, "index.md")]);
    const files = ["404.html", "robots.txt", "sitemap.xml", "llms.txt", ".well-known/security.txt", `${INDEXNOW_KEY}.txt`, ...withTwins, ...withTwins.map((path) => `de/${path}`)];
    expect(Object.keys(pages).sort()).toEqual(files.sort());
    expect(pages["index.html"]).toContain('<html lang="en">');
    expect(pages["de/index.html"]).toContain('<html lang="de">');
  });

  it("loads only its own module script and has no inline script or handler", () => {
    for (const [path, content] of html) {
      // JSON-LD is a data block, never executed; it may hold no "<" that could end it early.
      const blocks = [...content.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)];
      expect(blocks.length, path).toBe(path === "404.html" ? 0 : 1);
      const code = content.replace(/<script type="application\/ld\+json">[^<]*<\/script>/g, "");
      const scripts = [...code.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
      expect(scripts).toEqual(['<script type="module" src="/assets/site.test.js">']);
      expect(code).not.toMatch(/<script[^>]*>[^<]+<\/script>|\son[a-z]+=|javascript:|\sstyle=/i);
    }
  });

  it("links internally only to pages and anchors that exist", () => {
    for (const [path, content] of html) {
      for (const [, href] of content.matchAll(/href="(\/[^"]*)"/g)) {
        const [target, anchor] = href!.split("#") as [string, string | undefined];
        if (target.startsWith("/assets/") || target === "/favicon.svg") continue;
        const file = target === "" ? path : `${target.slice(1)}${target.endsWith("/") ? "index.html" : ""}`;
        expect(pages[file], `${path} → ${href}`).toBeDefined();
        if (anchor) expect(pages[file], `${path} → ${href}`).toContain(`id="${anchor}"`);
      }
      for (const [, anchor] of content.matchAll(/href="#([^"]+)"/g)) expect(content, `${path} → #${anchor}`).toContain(`id="${anchor}"`);
    }
  });

  it("shows each connector's tools with their levels on its own page", () => {
    for (const info of BUILT_IN_CONNECTORS) {
      const page = pages[`connectors/${info.id}/index.html`]!;
      for (const tool of info.tools) expect(page).toContain(`<code>${tool.name}</code>`);
      expect(page.match(/<span class="level (?:read|write)">/g)).toHaveLength(info.tools.length);
    }
  });

  it("prefills exactly the text fields the issue form has", () => {
    const template = readFileSync(join(ROOT, ".github", "ISSUE_TEMPLATE", CONNECTOR_TEMPLATE), "utf8");
    const ids = new Map([...template.matchAll(/^\s+- type: ([a-z]+)\n\s+id: ([a-z_]+)$/gm)].map((match) => [match[2], match[1]]));
    for (const lang of ["", "de/"]) {
      const page = pages[`${lang}connectors/submit/index.html`]!;
      const names = [...page.matchAll(/<(?:input|textarea)[^>]*\sname="([a-z_]+)"/g)].map((match) => match[1]);
      expect(names).toEqual(["template", ...SUBMIT_FIELDS]);
      expect(page).toContain(`name="template" value="${CONNECTOR_TEMPLATE}"`);
    }
    // `title` is the issue's own title, every other field is a text field of the form: GitHub prefills nothing else.
    for (const field of SUBMIT_FIELDS.filter((name) => name !== "title")) expect(["input", "textarea"]).toContain(ids.get(field));
  });

  it("escapes what comes from the community", () => {
    const hostile = entry({ name: '<img src=x onerror="alert(1)">', summary: { en: "<script>alert(1)</script>" }, tools: [{ name: "todo_tasks", label: "<b>x</b>", level: "read" }] });
    const site = renderSite(ASSETS, [hostile]);
    for (const page of [site["connectors/index.html"]!, site["connectors/todo/index.html"]!]) {
      expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
      expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      for (const raw of ["<img src=x", "<script>alert", "<b>x"]) expect(page).not.toContain(raw);
    }
    expect(site["connectors/todo/index.html"]).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

/** The JSON-LD graph of a page. */
function graphOf(content: string): Array<Record<string, unknown>> {
  const json = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(content)?.[1];
  expect(json).toBeDefined();
  const data = JSON.parse(json!) as { "@context": string; "@graph": Array<Record<string, unknown>> };
  expect(data["@context"]).toBe("https://schema.org");
  return data["@graph"];
}

const canonicalOf = (content: string) => /<link rel="canonical" href="([^"]+)">/.exec(content)?.[1];

describe("serain.si for search engines and AI assistants (D65)", () => {
  const indexable = Object.entries(pages).filter(([path]) => path.endsWith("index.html"));

  it("declares every entity once and refers only to entities it declares", () => {
    for (const [path, content] of indexable) {
      const graph = graphOf(content);
      const ids = graph.map((node) => node["@id"]).filter(Boolean);
      expect(new Set(ids).size, path).toBe(ids.length);
      const refs = [...JSON.stringify(graph).matchAll(/\{"@id":"([^"]+)"\}/g)].map((match) => match[1]);
      for (const ref of refs) expect(ids, `${path} → ${ref}`).toContain(ref);
      const page = graph.find((node) => node["@id"] === `${canonicalOf(content)}#webpage`);
      expect(page?.dateModified, path).toBe(ASSETS.updated);
    }
  });

  it("answers in its FAQ JSON-LD exactly the questions the home page shows", () => {
    for (const [path, lang] of [["index.html", "en"], ["de/index.html", "de"]] as const) {
      const faq = graphOf(pages[path]!).find((node) => node["@type"] === "FAQPage") as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
      expect(faq.mainEntity.map((item) => item.name)).toEqual(T.faq.map((item) => item.q[lang]));
      const shown = [...pages[path]!.matchAll(/<div class="faq-item[^"]*"><h3>([^<]+)<\/h3><p>([^<]+)<\/p>/g)].map((match) => [match[1], match[2]]);
      expect(shown).toEqual(T.faq.map((item) => [item.q[lang], item.a[lang]]));
    }
  });

  it("gives every page a Markdown twin that it links and that names the page as canonical", () => {
    for (const [path, content] of indexable) {
      const twin = path.replace(/index\.html$/, "index.md");
      expect(content).toContain(`<link rel="alternate" type="text/markdown" href="/${twin}">`);
      expect(pages[twin], twin).toContain(`\ncanonical: ${canonicalOf(content)}\n`);
      expect(pages[twin]).toContain(`\nlast_updated: ${ASSETS.updated}\n`);
    }
    for (const info of BUILT_IN_CONNECTORS) {
      for (const tool of info.tools) expect(pages[`connectors/${info.id}/index.md`]).toContain(`| \`${tool.name}\` |`);
    }
  });

  it("keeps community text in the Markdown twins plain: no links, no HTML", () => {
    const hostile = entry({ name: "[Click](https://evil.example)", summary: { en: "<img src=x> **bold** | row" } });
    const site = renderSite(ASSETS, [hostile]);
    // The front matter holds title and description as quoted YAML strings: data, never rendered.
    const body = (markdown: string) => markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
    for (const page of [body(site["connectors/todo/index.md"]!), body(site["connectors/index.md"]!), site["llms.txt"]!]) {
      expect(page).not.toContain("[Click](https://evil.example)");
      expect(page).not.toMatch(/(^|[^\\])<img/);
    }
    expect(site["connectors/todo/index.md"]).toContain("\\[Click\\](https://evil.example)");
    expect(site["connectors/todo/index.md"]).toContain("\\<img src=x\\> \\*\\*bold\\*\\* \\| row");
  });

  it("lists every page in the sitemap with its other language, x-default and the content's date", () => {
    const sitemap = pages["sitemap.xml"]!;
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(locs.sort()).toEqual(indexable.map(([, content]) => canonicalOf(content)).sort());
    expect(sitemap.match(/<lastmod>2026-10-14<\/lastmod>/g)).toHaveLength(locs.length);
    expect(sitemap.match(/hreflang="x-default"/g)).toHaveLength(locs.length);
    expect(sitemap).toContain('<xhtml:link rel="alternate" hreflang="de" href="https://serain.si/de/connectors/"/>');
  });

  it("points robots.txt to the sitemap and llms.txt only to files that exist", () => {
    expect(pages["robots.txt"]).toContain("Sitemap: https://serain.si/sitemap.xml");
    expect(pages["robots.txt"]).toMatch(/^Content-Signal: search=yes, ai-input=yes, ai-train=yes$/m);
    const llms = pages["llms.txt"]!;
    expect(llms.startsWith("# Serain\n\n> ")).toBe(true);
    for (const [, path] of llms.matchAll(/\]\(https:\/\/serain\.si\/([^)]*)\)/g)) expect(pages[path!], path).toBeDefined();
    for (const info of BUILT_IN_CONNECTORS) expect(llms).toContain(`/connectors/${info.id}/index.md`);
  });

  it("shows a social preview in the page's language and a security.txt that has not expired", () => {
    expect(pages["index.html"]).toContain('<meta property="og:image" content="https://serain.si/assets/og-en.jpg">');
    expect(pages["de/index.html"]).toContain('<meta property="og:image" content="https://serain.si/assets/og-de.jpg">');
    expect(pages[".well-known/security.txt"]).toMatch(/^Expires: 2027-10-14T00:00:00Z$/m);
  });

  it("serves Markdown only to clients that prefer it", () => {
    expect(prefersMarkdown("text/markdown, text/html;q=0.9, */*;q=0.8")).toBe(true);
    expect(prefersMarkdown("text/markdown")).toBe(true);
    expect(prefersMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(false);
    expect(prefersMarkdown("text/html, text/markdown;q=0.5")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0, */*")).toBe(false);
    expect(prefersMarkdown("*/*")).toBe(false);
    expect(prefersMarkdown(null)).toBe(false);
  });
});

describe("site counting", () => {
  /** One request through the counting, as the Worker calls it with the status it served. */
  function count(path: string, status: number, headers: Record<string, string> = {}, options: { markdown?: boolean; method?: string } = {}) {
    const points: Array<{ indexes: string[]; blobs: string[] }> = [];
    const request = new Request(`https://serain.si${path}`, { method: options.method ?? "GET", headers });
    record({ writeDataPoint: (point) => void points.push(point) }, request, new URL(request.url).pathname, status, options.markdown ?? false);
    return points;
  }

  const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

  it("counts a page view with categories only: no IP, no user agent, no query string, only the referrer's host", () => {
    const points = count("/de/connectors/gmail/?email=alex%40example.com", 200, {
      "user-agent": BROWSER,
      referer: "https://news.ycombinator.com/item?id=1",
      "cf-connecting-ip": "203.0.113.7",
    });
    expect(points).toEqual([{ indexes: ["/de/connectors/gmail/"], blobs: ["/de/connectors/gmail/", "page", "de", "browser", "", "news.ycombinator.com", ""] }]);
    const written = JSON.stringify(points);
    for (const leak of ["203.0.113.7", "alex", "Safari", "item?id"]) expect(written).not.toContain(leak);
  });

  it("counts what assistants read: the Markdown twin and llms.txt, by crawler name", () => {
    const claudebot = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";
    expect(count("/", 200, { "user-agent": claudebot }, { markdown: true })[0]!.blobs).toEqual(["/", "markdown", "en", "ai-crawler", "ClaudeBot", "", ""]);
    expect(count("/de/index.md", 200, { "user-agent": claudebot })[0]!.blobs.slice(0, 3)).toEqual(["/de/", "markdown", "de"]);
    const chatgpt = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
    expect(count("/llms.txt", 200, { "user-agent": chatgpt })[0]!.blobs).toEqual(["/llms.txt", "llms", "", "ai-assistant", "ChatGPT-User", "", ""]);
  });

  it("counts the social preview by language without its hash, and a missing page without its path", () => {
    expect(count("/assets/og-de.35ef151fab.jpg", 200, { "user-agent": "facebookexternalhit/1.1" })[0]!.blobs.slice(0, 5)).toEqual(["/assets/og-de", "preview-image", "de", "preview", "facebookexternalhit"]);
    expect(count("/wp-admin/", 404, { "user-agent": BROWSER })[0]!.blobs.slice(0, 2)).toEqual(["", "notfound"]);
  });

  it("counts revalidated pages, but not scripts, missing files, redirects or HEAD", () => {
    expect(count("/", 304, { "user-agent": BROWSER })).toHaveLength(1);
    for (const [path, status, method] of [["/assets/site.test.js", 200, "GET"], ["/.env", 404, "GET"], ["/connectors", 307, "GET"], ["/", 200, "HEAD"]] as const) {
      expect(count(path, status, { "user-agent": BROWSER }, { method }), `${method} ${path}`).toEqual([]);
    }
  });

  it("never fails the request when counting fails", () => {
    const failing = { writeDataPoint: () => { throw new Error("quota"); } };
    expect(() => record(failing, new Request("https://serain.si/"), "/", 200, false)).not.toThrow();
  });

  it("classifies clients by a fixed list and keeps only foreign referrer hosts", () => {
    expect(agentOf(BROWSER)).toEqual({ agent: "browser", name: "" });
    expect(agentOf("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toEqual({ agent: "search", name: "Googlebot" });
    expect(agentOf("curl/8.7.1")).toEqual({ agent: "bot", name: "" });
    expect(agentOf(null)).toEqual({ agent: "bot", name: "" });
    expect(counted("/connectors/", 307, false)).toBeNull();
    expect(referrerHost("https://serain.si/de/", "serain.si")).toBe("");
    expect(referrerHost("android-app://com.slack/", "serain.si")).toBe("");
  });
});
