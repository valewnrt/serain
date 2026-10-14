import { SEARCH_MAX_RESULTS, SEARCH_TIMEOUT_MS } from "../config/limits.js";

/**
 * Web search behind an interface (D7, D16). A provider is one file; the
 * executor only knows `SearchProvider`.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  /** Only hits from these hosts. The caller still checks for itself: the provider is no boundary. */
  domains?: readonly string[];
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
}

/**
 * Tavily (https://docs.tavily.com). `POST /search` with a bearer key, answer
 * `{ results: [{ title, url, content }] }`. `search_depth: "basic"` costs one
 * credit per search; `include_answer` stays off, because Serain words things
 * itself and a ready-made answer would only be a second, unmarked source.
 */
export function tavilyProvider(apiKey: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    name: "tavily",
    async search(query, options = {}) {
      const response = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: SEARCH_MAX_RESULTS,
          include_answer: false,
          include_raw_content: false,
          ...(options.domains?.length ? { include_domains: [...options.domains] } : {}),
        }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        // Do not pass the body on: it can mirror the key or the query.
        throw new Error(`Search failed (HTTP ${response.status})`);
      }
      const data = (await response.json()) as { results?: unknown };
      if (!Array.isArray(data.results)) throw new Error("Search returned no results field");
      const hits: SearchHit[] = [];
      for (const entry of data.results) {
        const { title, url, content } = (entry ?? {}) as Record<string, unknown>;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
        hits.push({
          title: typeof title === "string" ? title.trim().slice(0, 200) : "",
          url,
          snippet: typeof content === "string" ? content.trim().slice(0, 600) : "",
        });
      }
      return hits;
    },
  };
}
