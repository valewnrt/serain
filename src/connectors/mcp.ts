import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CONNECTOR_RESULT_MAX_CHARS, CONNECTOR_TOOL_TIMEOUT_MS } from "../config/limits.js";

/**
 * A remote MCP server, addressed with the owner's token (D51). The token is only
 * set by `fetch` here, at the network edge, and only for requests to exactly
 * that MCP server, nowhere else. When it expires, `token({ renew: true })`
 * fetches a new one, once per request.
 *
 * The connection stays open and is rebuilt once on an error.
 */

export interface RemoteTool {
  name: string;
  title: string;
}

export interface McpConnection {
  listTools(): Promise<RemoteTool[]>;
  /**
   * `retry` only for read tools: otherwise a second attempt after an abort
   * could enter something twice.
   */
  call(name: string, args: Record<string, unknown>, options: { retry: boolean }): Promise<{ ok: boolean; text: string }>;
  close(): Promise<void>;
}

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

type TokenSource = (options: { renew: boolean }) => Promise<string>;

function authorizedFetch(origin: string, token: TokenSource, base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) throw new McpError(`Request to ${url.origin} instead of the MCP server refused.`);
    const send = async (renew: boolean) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${await token({ renew })}`);
      return base(input, { ...init, headers, redirect: "error" });
    };
    const first = await send(false);
    if (first.status !== 401) return first;
    await first.body?.cancel().catch(() => undefined);
    return send(true);
  };
}

/** Text from a tool result. Images and embedded interfaces stay out. */
export function resultText(result: { content?: unknown; structuredContent?: unknown }): string {
  const parts = Array.isArray(result.content)
    ? result.content.flatMap((item) => (item && typeof item === "object" && (item as { type?: unknown }).type === "text" ? [String((item as { text?: unknown }).text ?? "")] : []))
    : [];
  let text = parts.join("\n").trim();
  if (!text && result.structuredContent !== undefined) text = JSON.stringify(result.structuredContent);
  if (text.length > CONNECTOR_RESULT_MAX_CHARS) text = `${text.slice(0, CONNECTOR_RESULT_MAX_CHARS)}\n… (truncated)`;
  return text || "(empty response)";
}

export function mcpConnection(input: { url: string; token: TokenSource; fetch?: typeof fetch }): McpConnection {
  const url = new URL(input.url);
  const fetcher = authorizedFetch(url.origin, input.token, input.fetch ?? fetch);
  let client: Promise<Client> | null = null;

  const connect = () =>
    (client ??= (async () => {
      const next = new Client({ name: "serain", version: "1.0.0" });
      // exactOptionalPropertyTypes: the SDK's transport declares `sessionId` as optional without `| undefined`.
      await next.connect(new StreamableHTTPClientTransport(url, { fetch: fetcher }) as unknown as Transport);
      return next;
    })().catch((error: unknown) => {
      client = null;
      throw error;
    }));

  const reset = async () => {
    const old = client;
    client = null;
    await old?.then((c) => c.close()).catch(() => undefined);
  };

  /** Reconnect once when the open connection gives up (server restarted, session gone). */
  async function withClient<T>(work: (c: Client) => Promise<T>, retry = true): Promise<T> {
    try {
      return await work(await connect());
    } catch (error) {
      await reset();
      if (!retry) throw error;
      return work(await connect());
    }
  }

  return {
    async listTools() {
      const tools: RemoteTool[] = [];
      await withClient(async (c) => {
        tools.length = 0;
        let cursor: string | undefined;
        do {
          const page = await c.listTools(cursor ? { cursor } : {}, { timeout: CONNECTOR_TOOL_TIMEOUT_MS });
          for (const tool of page.tools) tools.push({ name: tool.name, title: tool.title ?? tool.annotations?.title ?? tool.name });
          cursor = page.nextCursor;
        } while (cursor && tools.length < 500);
      });
      return tools;
    },
    async call(name, args, options) {
      const result = await withClient((c) => c.callTool({ name, arguments: args }, undefined, { timeout: CONNECTOR_TOOL_TIMEOUT_MS }), options.retry);
      return { ok: result.isError !== true, text: resultText(result as { content?: unknown; structuredContent?: unknown }) };
    },
    close: reset,
  };
}
