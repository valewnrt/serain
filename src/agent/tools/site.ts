import { z } from "zod";
import { t } from "../../i18n/catalog.js";
import { tools } from "../../i18n/messages/tools.js";
import type { ConfidentialGuard } from "../../security/confidential.js";
import { ownerNamedSite } from "../../sites/named.js";
import type { MessagePort } from "./messaging.js";
import { defineTool, type ToolDefinition } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * `run_site_task` (D36, D49): a task in a logged-in browser session on the
 * server, with a login from the vault that the owner maintains in the web
 * interface.
 *
 * Level `irreversible`, although the session only fetches information: logging
 * into an account is nothing Serain does on its own, and "only reading" cannot
 * be proven technically for a browser. So every session gets its preview,
 * without a standing approval. Plus `ownerOriginOnly` and `cleanTurnOnly`: a
 * mail or web page cannot cause a login.
 */

export interface SiteTaskPort {
  precondition(): Promise<string | null>;
  start(request: { task: string; site: string; triggerExternalId: string; triggerMessageId: string; guard: ConfidentialGuard }): void;
}

export function siteTaskTools(deps: { sites: { list(): Promise<string[]> }; tasks: SiteTaskPort; port: MessagePort; confidential(): Promise<ConfidentialGuard> }): ToolDefinition[] {
  return [
    defineTool({
      name: "run_site_task",
      comesBack: true,
      description:
        `Looks something up in one of ${owner.name}'s online accounts: your executor logs in with a login from the vault ` +
        "and fetches information (order status, booking details, invoice, balance of a customer account). It buys, " +
        `books, changes and sends nothing. Only works for sites in the vault; ${owner.name} adds new ones in the web interface. ` +
        `If ${owner.name} named the site in their message, it runs right away, otherwise ${owner.name} gets a preview. ` +
        `The result comes back later as an event. If ${owner.name} wants a ` +
        "screenshot of the page, say so in the task; if login data or codes are on it, there is none.",
      level: "irreversible",
      ownerOriginOnly: true,
      cleanTurnOnly: true,
      schema: {
        site: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{1,30}$/).describe("Name of the login in the vault, e.g. bahn."),
        task: z.string().trim().min(10).max(800).describe("What to look up and what the result should contain."),
      },
      confirm: {
        preview: (args) => `${t(tools.siteAsk, { site: args.site })}\n${args.task}`,
        undo: () => t(tools.siteUndo),
        // "check my booking at bahn" does not ask again (addendum D8 of 2026-10-13).
        namedByOwner: (args, ownerWords) => ownerNamedSite(args.site, ownerWords),
      },
      async run(args, turn) {
        const blocker = await deps.tasks.precondition();
        if (blocker) return { ok: false, text: blocker };
        let sites: string[];
        try {
          sites = await deps.sites.list();
        } catch {
          return { ok: false, text: `The vault can't be read right now. Tell ${owner.name} instead of trying again.` };
        }
        if (!sites.includes(args.site)) {
          return {
            ok: false,
            text: `"${args.site}" is not in the vault.${sites.length > 0 ? ` In there: ${sites.join(", ")}.` : " The vault is empty."} Only ${owner.name} can add logins, in the web interface.`,
          };
        }
        deps.tasks.start({
          task: args.task,
          site: args.site,
          triggerExternalId: turn.triggerExternalId,
          triggerMessageId: turn.triggerMessageId,
          guard: await deps.confidential(),
        });
        return {
          ok: true,
          text:
            `The session at ${args.site} is running. The result comes back to you as an event. ` +
            `Only tell ${owner.name} that you're looking: nothing is done yet.`,
        };
      },
    }),
  ];
}
