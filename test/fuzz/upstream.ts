import { generateKeyPairSync, randomBytes } from "node:crypto";
import fc from "fast-check";
import { CANARY, hostileString, jsonFrom, sourceWords } from "./helpers.js";

/**
 * A provider that answers all sorts of things, the same for every driver
 * (`fetch` at the network edge, as every driver accepts it). It only tells
 * protocols apart, not services: it answers a JSON-RPC request as an MCP
 * server, any other as an HTTP interface with JSON. What it delivers on a tool
 * call is set by the scenario of the current case.
 */

const WORDS = sourceWords(["src/connectors"]);
const json = jsonFrom(WORDS);

/** What the provider does on a request that is supposed to deliver something. */
export type Reply =
  | { kind: "json"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "raw"; status: number; body: string; contentType: string }
  | { kind: "rpc_result"; result: unknown }
  | { kind: "rpc_error"; code: number; message: string; data?: unknown };

/** Headers carry only printable ASCII; `Response` already rejects anything else. */
const headerValue = fc.oneof(fc.constantFrom("0", "1", "86400", "-5", "Wed, 21 Oct 2099 07:28:00 GMT", "text/html", "https://evil.example/"), hostileString.map((s) => s.replace(/[^\x20-\x7e]/g, "").slice(0, 120)));

const statuses = fc.constantFrom(200, 200, 200, 201, 204, 400, 401, 403, 404, 429, 500, 503);

/** A CallToolResult as an MCP server might send it, and everything around it. */
const contentItem = fc.oneof(
  { weight: 4, arbitrary: fc.record({ type: fc.constant("text"), text: hostileString }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("image"), data: fc.base64String({ maxLength: 40 }), mimeType: fc.constantFrom("image/png", "text/html") }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("resource"), resource: fc.record({ uri: fc.webUrl(), text: hostileString }) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("resource_link"), uri: fc.webUrl(), name: hostileString }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constantFrom("audio", "ui", "html", ""), text: hostileString }) },
  { weight: 1, arbitrary: json },
);
export const callToolResult: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ content: fc.array(contentItem, { maxLength: 5 }), isError: fc.option(fc.boolean(), { nil: undefined }), structuredContent: fc.option(json, { nil: undefined }) }, { requiredKeys: ["content"] }) },
  { weight: 1, arbitrary: fc.record({ content: fc.constant([]), structuredContent: json }) },
  { weight: 1, arbitrary: json },
  { weight: 1, arbitrary: fc.record({ content: fc.array(fc.record({ type: fc.constant("text"), text: fc.constant(CANARY.repeat(5_000)) }), { minLength: 1, maxLength: 3 }) }) },
);

export const reply: fc.Arbitrary<Reply> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("rpc_result" as const), result: callToolResult }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("rpc_error" as const), code: fc.integer({ min: -33_000, max: 1_000 }), message: hostileString, data: json }) },
  {
    weight: 5,
    arbitrary: fc.record(
      { kind: fc.constant("json" as const), status: statuses, body: json, headers: fc.dictionary(fc.constantFrom("retry-after", "content-type", "location"), headerValue, { maxKeys: 2 }) },
      { requiredKeys: ["kind", "status", "body"] },
    ),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("raw" as const), status: statuses, body: hostileString, contentType: fc.constantFrom("application/json", "text/html", "text/event-stream", "") }) },
);

/** Credentials as a driver stores them after connecting: a superset of all shapes, nothing is expired. */
export function storedCredentials(): Record<string, unknown> {
  const far = Date.now() + 365 * 86_400_000;
  return {
    // OAuth (mcp-oauth)
    clientId: "fuzz-client",
    tokenEndpoint: "https://aussteller.invalid/token",
    revocationEndpoint: null,
    accessToken: "fuzz-access",
    refreshToken: "fuzz-refresh",
    expiresAt: far,
    // Account information (enable-banking)
    sessionId: "fuzz-session",
    accounts: [{ uid: "konto-1", name: "Girokonto", last4: "1234", currency: "EUR" }],
    validUntil: new Date(far).toISOString(),
  };
}

/** An app configuration for drivers that sign themselves (bank), with a fresh test key. */
export function testBankConfig() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { aspsp: { name: "Fuzzbank", country: "DE" }, appId: `fuzz-${randomBytes(4).toString("hex")}`, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

function respond(status: number, body: string, headers: Record<string, string>): Response {
  // 204/304 must not have a body; a provider that tries anyway just loses it.
  const empty = status === 204 || status === 304;
  return new Response(empty ? null : body, { status, headers });
}

interface Rpc {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { protocolVersion?: unknown };
}

function parseRpc(text: string): Rpc | null {
  try {
    const parsed = JSON.parse(text) as Rpc | null;
    return parsed && typeof parsed === "object" && parsed.jsonrpc === "2.0" ? parsed : null;
  } catch {
    return null;
  }
}

export interface FakeUpstream {
  fetch: typeof fetch;
  /** Requests since the last `reset`, except the MCP handshake. */
  requests: number;
  /** What the next requests get; if the list is empty, the last reply again. */
  script(replies: Reply[]): void;
  reset(): void;
}

export function fakeUpstream(): FakeUpstream {
  let queue: Reply[] = [];
  let last: Reply = { kind: "json", status: 500, body: {} };
  const next = () => (last = queue.shift() ?? last);
  const state = {
    requests: 0,
    script(replies: Reply[]) {
      queue = [...replies];
      if (replies[0]) last = replies[0];
    },
    reset() {
      state.requests = 0;
      queue = [];
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
      const rpc = parseRpc(text);
      if (rpc) {
        // Protocol, not content: every MCP server answers handshake and notifications the same way.
        if (rpc.id === undefined) return new Response(null, { status: 202 });
        const ok = (result: unknown) => respond(200, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }), { "content-type": "application/json" });
        if (rpc.method === "initialize") {
          return ok({ protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fuzz", version: "1.0.0" } });
        }
        if (rpc.method === "tools/list") return ok({ tools: [] });
        state.requests += 1;
        const answer = next();
        if (answer.kind === "rpc_result") return ok(answer.result);
        if (answer.kind === "rpc_error") {
          return respond(200, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: answer.code, message: answer.message, data: answer.data } }), { "content-type": "application/json" });
        }
        if (answer.kind === "raw") return respond(answer.status, answer.body, answer.contentType ? { "content-type": answer.contentType } : {});
        return respond(answer.status, JSON.stringify(answer.body), { "content-type": "application/json", ...(answer.headers ?? {}) });
      }
      if (request.method === "GET" && request.headers.get("accept")?.includes("text/event-stream")) return new Response(null, { status: 405 });
      state.requests += 1;
      const answer = next();
      if (answer.kind === "raw") return respond(answer.status, answer.body, answer.contentType ? { "content-type": answer.contentType } : {});
      if (answer.kind === "json") return respond(answer.status, JSON.stringify(answer.body), { "content-type": "application/json", ...(answer.headers ?? {}) });
      // An MCP reply to an ordinary HTTP request: the result as a JSON body.
      return respond(200, JSON.stringify(answer.kind === "rpc_result" ? answer.result : { error: answer.message }), { "content-type": "application/json" });
    }) as typeof fetch,
  };
  return state;
}
