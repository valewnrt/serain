import type { ZodRawShape, z } from "zod";
import { CONNECTOR_RESULT_MAX_CHARS } from "../config/limits.js";
import { clip } from "../text/clip.js";
import { defineTool, type ToolDefinition, type ToolResult } from "../agent/tools/types.js";
import { connectorInfo } from "./catalog.js";
import { ConnectorError, type Json, type Snapshot } from "./types.js";

/**
 * Tools of a connected service (D51). Description and schema live in our code,
 * not at the provider: no provider can fill what the model reads about a tool
 * with its own text, and a tool we do not know does not exist.
 *
 * What holds for mail holds for all of them (D30, D31): the result is untrusted
 * content (`returnsUntrusted`), it never appears in the audit log
 * (`privateResult`), and reading happens only in the chat, never in the
 * executor. Writing tools run only on the owner's own instruction in a turn
 * without untrusted content: their confirmation is the instruction itself, as
 * with `forget_fact` (D12).
 */

export interface RemoteToolSpec<Schema extends ZodRawShape = ZodRawShape> {
  /** Name at Serain, as it appears in the catalog. */
  name: string;
  description: string;
  schema: Schema;
  /** For MCP: the name at the provider. */
  remote?: string;
  /** Bring arguments into the provider's form (date format, required fields). */
  map?(args: z.infer<z.ZodObject<Schema>>): Json;
}

/** Define type-safe, store schemaless; the cast happens here, once. */
export function remoteTool<Schema extends ZodRawShape>(spec: RemoteToolSpec<Schema>): RemoteToolSpec {
  return spec as unknown as RemoteToolSpec;
}

export type RemoteCall = (spec: RemoteToolSpec, args: Json, options: { retry: boolean }) => Promise<ToolResult>;

/** Checks that catalog and code know the same tools. An error here is an error in the repo. */
export function catalogTools(id: string, specs: readonly RemoteToolSpec[]) {
  const info = connectorInfo(id);
  if (!info) throw new ConnectorError(`${id} is not in the catalog.`);
  const names = new Set(specs.map((spec) => spec.name));
  for (const tool of info.tools) if (!names.has(tool.name)) throw new ConnectorError(`${tool.name} is missing in driver ${id}.`);
  for (const spec of specs) if (!info.tools.some((tool) => tool.name === spec.name)) throw new ConnectorError(`${spec.name} is missing in the catalog.`);
  return info;
}

export function buildTools(id: string, specs: readonly RemoteToolSpec[], call: RemoteCall): ToolDefinition[] {
  const info = catalogTools(id, specs);
  return specs.map((spec) => {
    const level = info.tools.find((tool) => tool.name === spec.name)!.level;
    const write = level !== "read";
    return defineTool({
      name: spec.name,
      description: spec.description,
      level,
      schema: spec.schema,
      returnsUntrusted: true,
      privateResult: true,
      ...(write ? { ownerOriginOnly: true, cleanTurnOnly: true } : { repeatable: true }),
      async run(args) {
        const result = await call(spec, spec.map ? spec.map(args) : (args as Json), { retry: !write });
        // Bounded for every driver in one place, not in each one: the next service
        // brings its own response shape (fuzzing 2026-10-04, the bank had no limit).
        return { ...result, text: clip(result.text, CONNECTOR_RESULT_MAX_CHARS), source: info.name };
      },
    });
  });
}

/** Our tools against the provider's list (MCP only). */
export function compareTools(id: string, specs: readonly RemoteToolSpec[], remote: readonly string[]): Snapshot {
  const info = catalogTools(id, specs);
  const offered = new Set(remote);
  const used = new Set(specs.map((spec) => spec.remote ?? spec.name));
  return {
    tools: info.tools.map((tool) => {
      const spec = specs.find((candidate) => candidate.name === tool.name)!;
      return { ...tool, available: offered.has(spec.remote ?? spec.name) };
    }),
    unlisted: remote.filter((name) => !used.has(name)).slice(0, 100),
  };
}

/** Without a provider list (bank): everything the driver can do is there. */
export function fixedSnapshot(id: string, specs: readonly RemoteToolSpec[]): Snapshot {
  const info = catalogTools(id, specs);
  return { tools: info.tools.map((tool) => ({ ...tool, available: true })), unlisted: [] };
}
