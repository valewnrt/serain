# serain.si

The project's public website (D65 in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#d65)): the landing page, the connector directory with one page per connector (`/connectors/<id>/`) and the submit flow (`/connectors/submit/`), in English (`/`) and German (`/de/`). A Cloudflare Worker that serves static files with security headers; no database, no secret, nothing of any owner. An instance's web interface runs on its own host behind Access (D49), never here.

```bash
pnpm site:dev      # build, then wrangler dev on http://localhost:8788
pnpm site:check    # is the domain free of Access and not the web interface's?
pnpm site:deploy   # checks, builds, deploys, then checks the site and the web interface from outside
pnpm site:stats    # what the Worker counted in the last 7 days (pnpm site:stats 30 for 30)
```

`site:deploy` needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in `.dev.vars` and a committed tree.

## Layout

| Path | What |
|---|---|
| `content/site.ts` | Origin, repository, languages, paths |
| `content/text.ts` | Every fixed text, English and German, including the questions on the home page |
| `content/render.ts` | The pages |
| `content/schema.ts` | One JSON-LD graph per page |
| `content/markdown.ts` | The Markdown twin of every page (`index.md`) for agents |
| `content/crawlers.ts` | `robots.txt`, `sitemap.xml`, `llms.txt`, `security.txt` |
| `content/chats.ts` | The conversations in the drawn iPhone (invented owner Alex, real catalog wording) |
| `content/directory.ts` | The directory: built-in integrations, the catalog's services (`src/connectors/catalog.ts`), community entries |
| `content/community.ts` | Reviewed community connectors |
| `client/` | The one script: WebGL shaders over the photographs, conversation playback, reveals, directory search and filter, the submit steps |
| `images/` | The photographs (generated) and the social preview |
| `images/logos/` | The services' own logos, unchanged from their source (`images/logos/README.md`) |
| `og.ts` | The social preview per language, drawn at build time |
| `worker/worker.ts` | Headers, CSP with Trusted Types, caching, Markdown for `Accept: text/markdown` (`worker/accept.ts`) |
| `worker/analytics.ts` | Counting per request in Workers Analytics Engine, categories only |

## Search engines and AI assistants

What the site says is in its text; JSON-LD, the Markdown twins and `llms.txt` repeat it and never add to it. A new fact for assistants (a question people ask, a limit worth knowing) goes into `content/text.ts`, where the page, its JSON-LD, its twin and `llms.txt` all read it. The sitemap's `lastmod` is the date of the last commit to `content/`, `images/` or the connector catalog. After a deploy, `pnpm site:deploy` announces the changed pages to IndexNow (Bing and others); Google finds them through the sitemap. Once per domain, by hand: add the site to Google Search Console and Bing Webmaster Tools and submit `https://serain.si/sitemap.xml`.

## Counting

The Worker counts, the browser never does (`worker/analytics.ts`, D65): no script, no cookie, nothing on the visitor's device, so no consent banner and no change to the CSP. One data point per page, Markdown twin, `llms.txt`, `robots.txt`, sitemap, `security.txt`, social preview and missing page, with the page, the kind, the language, the class of client (and the name of a known crawler), the host of a foreign referrer and the country; never the IP, the raw user agent, a query string or a path the build did not write. Scripts, styles, images and redirects are not counted. Views, not visitors; Analytics Engine keeps them three months. `pnpm site:stats [days]` needs Account Analytics Read on `CLOUDFLARE_API_TOKEN`. A new crawler worth naming goes into `KNOWN` in `worker/analytics.ts`.

## Listing a community connector

Submissions arrive as issues from the form on `/connectors/submit/` (`.github/ISSUE_TEMPLATE/connector.yml`). After the code is reviewed (levels only `read` and `write_reversible`, tools and descriptions in the catalog, results untrusted, fuzz tests green with the connector in an instance), add an entry to `content/community.ts` in a pull request that links the issue. `pnpm test` (`test/site.test.ts`) and the build refuse an entry with a taken or reserved id (`submit`) or tool name, a level above `write_reversible`, a source that is not https or an author that is not a GitHub handle.
