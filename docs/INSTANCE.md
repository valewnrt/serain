# Your instance: additions that stay yours

Serain is one codebase for everyone. What only you need, a service nobody else uses or a rule about which of your mails matter, lives in **your instance**: a directory `instance/` next to `src/`, which this repository ignores. Keep it in your own private repository and link it in:

```bash
ln -s ~/path/to/your-private-repo/instance instance
```

Without `instance/` the core runs with the empty defaults in `src/instance/defaults/`. Nothing else in the code changes; you never need to edit tracked files to run your own Serain (D64 in [ARCHITECTURE.md](ARCHITECTURE.md#d64)).

## What an instance can contain

| File | Exports | What it does |
|---|---|---|
| `instance/catalog.ts` | `connectors: readonly ConnectorInfo[]` | Your own services on the Connections page, with every tool, its level and its label (D51). Data only: the browser and the worker bundle this file too. |
| `instance/server.ts` | `server: InstanceServer` | `drivers(api)`: one driver per service in your catalog, same ids. `mailRules`: your own rules for which mails matter, one English sentence each; they come before the general rules (`src/mail/rules.ts`). |
| `instance/logos/<id>.png` | | The logo of each of your services on the Connections page. |

Each file is optional; a missing one falls back to its default. The contract is `src/instance/types.ts`.

## Rules

- **Only type imports from the core**, through the alias `@serain/…`: `import type { InstanceServer } from "@serain/instance/types.js"`. Everything needed at runtime (`z`, `remoteTool`, `mcpOAuthDriver`, the client registry) comes in through `api`. That way the files resolve the same wherever the directory really lives.
- **Your services are not special.** They run through the same catalog, registry, guards and fuzz harness as the built-in ones: results are `returnsUntrusted` and `privateResult`, writing tools are `ownerOriginOnly` and `cleanTurnOnly`, levels come from your catalog, never from the provider. A service or tool name that already exists stops every process at load. `pnpm test` with your instance linked fuzzes your drivers too; run it before every deploy (`deploy.sh` does).
- **Mail rules change how often Serain gets in touch.** Measure before and after with `pnpm eval:mail`.
- **Committed only.** `deploy/deploy.sh` and `pnpm web:deploy` refuse an instance with uncommitted changes and ship an export of its commit, not the working tree. The server gets a plain copy in `/opt/serain/instance`, with its commit in `instance/REVISION`.

## Example

```ts
// instance/catalog.ts
import type { ConnectorInfo } from "@serain/connectors/catalog.js";

export const connectors: readonly ConnectorInfo[] = [
  {
    id: "diary",
    name: "Diary",
    summary: "Meals from your food diary. Logging only when you tell Serain to.",
    tools: [
      { name: "diary_day", label: "One day", level: "read" },
      { name: "diary_log_meal", label: "Log a meal", level: "write_reversible" },
    ],
  },
];
```

```ts
// instance/server.ts
import type { InstanceServer } from "@serain/instance/types.js";

export const server: InstanceServer = {
  drivers: ({ z, remoteTool, mcpOAuthDriver, clients, fetch }) => [
    mcpOAuthDriver(
      {
        id: "diary",
        url: "https://mcp.diary.example/mcp",
        issuer: "https://auth.diary.example",
        scope: "",
        tools: [
          remoteTool({ name: "diary_day", remote: "get_day", description: "One day in the diary.", schema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) } }),
          remoteTool({ name: "diary_log_meal", remote: "log_meal", description: "Logs a meal, only if the owner says so in this message.", schema: { description: z.string().min(3).max(1000) } }),
        ],
        promptLine: "diary_* read the owner's food diary. Logging only on the owner's instruction in this message.",
      },
      { clients, ...(fetch ? { fetch } : {}) },
    ),
  ],
  mailRules: ["Mails from my tax firm are always important, even if they only report the state of a matter."],
};
```
