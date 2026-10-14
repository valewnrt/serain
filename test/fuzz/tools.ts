import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolDefinition } from "../../src/agent/tools/types.js";

/**
 * Every tool in the code, without a list in the test: every exported
 * `…Tools` factory under `src/agent/tools` and `src/executor` is called with
 * stubs that say yes to everything (so every factory also builds its optional
 * tools). None of them is run: the fuzz tests replace `run` and check what the
 * registry makes of the result.
 */

export const TOOL_DIRS = ["src/agent/tools", "src/executor"];

/**
 * A stub that has every property, is callable, passes as a list with one
 * entry (one mailbox, one account) and never wants to be a promise.
 */
export function yesStub(): unknown {
  const target = function stub() {
    return undefined;
  };
  return new Proxy(target, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toPrimitive) return () => "stub";
      if (prop === Symbol.iterator) return () => [yesStub()][Symbol.iterator]();
      if (prop === "length") return 1;
      const method = typeof prop === "string" ? (Array.prototype as unknown as Record<string, unknown>)[prop] : undefined;
      if (typeof method === "function") return (...args: unknown[]) => (method as (...a: unknown[]) => unknown).apply([yesStub()], args);
      return yesStub();
    },
    apply: () => yesStub(),
  });
}

export async function discoverTools(): Promise<{ defs: ToolDefinition[]; factories: string[]; failed: string[] }> {
  const defs: ToolDefinition[] = [];
  const factories: string[] = [];
  const failed: string[] = [];
  for (const dir of TOOL_DIRS) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts")).sort()) {
      const mod = (await import(resolve(dir, file))) as Record<string, unknown>;
      for (const [name, factory] of Object.entries(mod)) {
        if (typeof factory !== "function" || !/Tools$/.test(name)) continue;
        try {
          const built = (factory as (...args: unknown[]) => unknown)(yesStub(), yesStub());
          if (!Array.isArray(built)) continue;
          factories.push(`${file}:${name}`);
          defs.push(...(built as ToolDefinition[]));
        } catch (error) {
          failed.push(`${file}:${name}: ${(error as Error).message}`);
        }
      }
    }
  }
  return { defs, factories, failed };
}

/** Every name that stands at a `defineTool({ name: "…" })` in the source. */
export function declaredToolNames(): string[] {
  const names = new Set<string>();
  for (const dir of TOOL_DIRS) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(resolve(dir, file), "utf8");
      for (const match of text.matchAll(/defineTool\(\{\s*name:\s*"([a-z][a-z0-9_]*)"/g)) names.add(match[1]!);
    }
  }
  return [...names].sort();
}
