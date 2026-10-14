/**
 * serain.si (D65): only the static files from `site/dist`, with security
 * headers. No API, no database, no secret; one script from the own origin,
 * which builds no HTML (Trusted Types). Unlike the web interface (D49) there
 * is no Access in front: everything here is public.
 *
 * Every page has a Markdown twin for agents next to it (`index.md`,
 * site/content/markdown.ts). A request that prefers `text/markdown` gets the
 * twin instead of the HTML; the HTML names it in a `Link` header.
 *
 * Every request is counted here, never in the browser (worker/analytics.ts).
 */

import { record } from "./analytics.js";
import { prefersMarkdown } from "./accept.js";

interface Env {
  ASSETS: Fetcher;
  ANALYTICS: AnalyticsEngineDataset;
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  // The connector form opens a new issue on GitHub (site/content/render.ts).
  "form-action https://github.com",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join("; ");

/** A page's own address: the paths `html_handling` serves an `index.html` for. */
const isPage = (path: string) => path.endsWith("/");

function harden(response: Response, path: string): Response {
  const out = new Response(response.body, response);
  const h = out.headers;
  h.set("content-security-policy", CSP);
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("cross-origin-opener-policy", "same-origin");
  h.set("cross-origin-resource-policy", "same-origin");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  h.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  // Built files carry their hash in the name (site/build.ts); pages revalidate every time.
  if (response.ok) h.set("cache-control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate");
  if (path.endsWith(".md")) h.set("content-type", "text/markdown; charset=utf-8");
  if (path === "/llms.txt" || path === "/robots.txt" || path === "/.well-known/security.txt") h.set("content-type", "text/plain; charset=utf-8");
  return out;
}

async function serve(request: Request, env: Env, url: URL): Promise<{ response: Response; markdown: boolean }> {
  if (isPage(url.pathname) && prefersMarkdown(request.headers.get("accept"))) {
    const twin = await env.ASSETS.fetch(new Request(new URL(`${url.pathname}index.md`, url), request));
    if (twin.ok || twin.status === 304) {
      const out = harden(twin, `${url.pathname}index.md`);
      out.headers.set("vary", "accept");
      // The twin is a copy: search engines should index and cite the page itself.
      out.headers.set("link", `<${url.origin}${url.pathname}>; rel="canonical"`);
      return { response: out, markdown: true };
    }
  }
  const response = harden(await env.ASSETS.fetch(request), url.pathname);
  if (isPage(url.pathname)) {
    response.headers.set("vary", "accept");
    if (response.ok) response.headers.set("link", `<${url.pathname}index.md>; rel="alternate"; type="text/markdown"`);
  } else if (url.pathname.endsWith("/index.md")) {
    response.headers.set("link", `<${url.origin}${url.pathname.slice(0, -"index.md".length)}>; rel="canonical"`);
  }
  return { response, markdown: false };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return harden(new Response("Method not allowed.", { status: 405, headers: { allow: "GET, HEAD" } }), url.pathname);
    }
    const { response, markdown } = await serve(request, env, url);
    record(env.ANALYTICS, request, url.pathname, response.status, markdown);
    return response;
  },
} satisfies ExportedHandler<Env>;
