import type { ConnectorTier } from "../../src/connectors/catalog.js";
import type { L } from "./site.js";

/**
 * Connectors from the community, listed on serain.si/connectors after review.
 * A submission arrives as an issue (`.github/ISSUE_TEMPLATE/connector.yml`);
 * once its code is reviewed, it gets an entry here, in a pull request that
 * links the issue. The code stays in the author's repository and is added to
 * an instance (docs/INSTANCE.md); a connector that many owners need moves into
 * the core instead and is listed from the catalog.
 *
 * Levels are only `read` and `write_reversible`, like in the catalog: a
 * connector never brings a tool that sends, deletes or pays. `site/build.ts`
 * refuses an entry whose id or tool names already exist, whose source is not
 * https, or whose author is not a GitHub handle.
 */
export interface CommunityConnector {
  id: string;
  name: string;
  category: "mail" | "calendar" | "apple" | "health" | "finance" | "web" | "media" | "productivity" | "home";
  /** One or two sentences: what Serain can do with it. German may follow later; until then the English text is shown. */
  summary: L | { en: string };
  /** GitHub handle of the author, without @. */
  author: string;
  /** Repository with the catalog entry and the driver. */
  source: string;
  /** The issue the submission was reviewed in. */
  issue: number;
  tools: ReadonlyArray<{ name: string; label: string; level: ConnectorTier }>;
}

export const COMMUNITY: readonly CommunityConnector[] = [];
