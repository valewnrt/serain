import { z } from "zod";
import { CompanionFailure, CompanionOffline, type Companion } from "../../companion/client.js";
import type { CalendarEvent, OpenReminder } from "../../companion/protocol.js";
import { formatWallTime } from "../../time.js";
import { defineTool, type ToolDefinition, type ToolResult } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * Apple data from the owner's Mac (D7, D28): calendar, reminders, contacts.
 * Read only, and only while the Mac is awake.
 *
 * **Why with the chat and not the executor:** the executor reads foreign pages
 * and can fetch addresses. If it had the owner's contacts, a prepared page
 * would be a way to write them into a URL. The chat has no way out except
 * `run_task`, and exactly that is blocked by the taint (see below).
 *
 * **Why `returnsUntrusted`:** a calendar invitation from a stranger lands in
 * the owner's calendar with any title, a contact can carry a note. That is
 * foreign text, even though it lives on the owner's Mac. The registry frames
 * the result and sets the taint: in the same turn there is then no
 * `run_task`, no owner-only tools and no standing approvals (D8.4, D14, D16).
 *
 * Level `read`. Narrow scope per call (W3): one period, one list, one name.
 */

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe(`Day as YYYY-MM-DD, calendar day in ${owner.timezone}.`);

function offline(error: unknown): ToolResult | null {
  if (error instanceof CompanionOffline) {
    return {
      ok: false,
      text: `${owner.name}'s Mac is not reachable right now (lid closed or offline). Tell them, instead of guessing.`,
    };
  }
  if (error instanceof CompanionFailure) {
    return {
      ok: false,
      text:
        error.code === "not_authorized"
          ? `The Mac lacks the permission for this (System Settings, Privacy). Tell ${owner.name}.`
          : `The Mac refused: ${error.message}`,
    };
  }
  return null;
}

/** "Mon 21 Sept, 09:00" split into day and time. */
function wallParts(instant: Date): { day: string; time: string } {
  const text = formatWallTime(instant);
  const cut = text.lastIndexOf(", ");
  return cut < 0 ? { day: text, time: "" } : { day: text.slice(0, cut), time: text.slice(cut + 2) };
}

function eventLine(event: CalendarEvent): string {
  const start = wallParts(new Date(event.start));
  const end = wallParts(new Date(event.end));
  const when = event.allDay
    ? `${start.day}, all day`
    : `${start.day}, ${start.time} to ${end.day === start.day ? end.time : `${end.day}, ${end.time}`}`;
  return [
    `- ${when}: ${event.title || "(no title)"}`,
    event.location ? `(${event.location.replace(/\s+/g, " ")})` : "",
    `[${event.calendar}]`,
  ]
    .filter(Boolean)
    .join(" ");
}

function reminderLine(reminder: OpenReminder): string {
  return `- ${reminder.title}${reminder.due ? `, due ${formatWallTime(new Date(reminder.due))}` : ""} [${reminder.list}]`;
}

export function macTools(companion: Companion): ToolDefinition[] {
  return [
    defineTool({
      name: "mac_calendar",
      description:
        `Reads events from ${owner.name}'s calendar on their Mac, for a period of at most 31 days. ` +
        "Read only. Works only while the Mac is awake.",
      level: "read",
      repeatable: true,
      returnsUntrusted: true,
      schema: { from: day, to: day },
      async run(args) {
        try {
          const result = await companion.call("calendar_events", args);
          const lines = result.events.map(eventLine);
          return {
            ok: true,
            source: `calendar on ${owner.name}'s Mac`,
            text: lines.length > 0 ? [...lines, result.truncated ? "(truncated, there are more)" : ""].filter(Boolean).join("\n") : "No events in this period.",
          };
        } catch (error) {
          const handled = offline(error);
          if (handled) return handled;
          throw error;
        }
      },
    }),

    defineTool({
      name: "mac_reminders",
      description:
        `Reads ${owner.name}'s open reminders from the Reminders app on their Mac, optionally just one list. ` +
        "Read only. These are not the reminders you create yourself with set_reminder.",
      level: "read",
      repeatable: true,
      returnsUntrusted: true,
      schema: { list: z.string().trim().min(1).max(100).optional().describe("Name of the list, otherwise all.") },
      async run(args) {
        try {
          const result = await companion.call("reminders_open", args.list ? { list: args.list } : {});
          const lines = result.reminders.map(reminderLine);
          return {
            ok: true,
            source: `reminders on ${owner.name}'s Mac`,
            text: lines.length > 0 ? [...lines, result.truncated ? "(truncated, there are more)" : ""].filter(Boolean).join("\n") : "No open reminders.",
          };
        } catch (error) {
          const handled = offline(error);
          if (handled) return handled;
          throw error;
        }
      },
    }),

    defineTool({
      name: "mac_contacts",
      description:
        `Looks up a name in ${owner.name}'s contacts on their Mac and returns numbers and mail addresses. ` +
        "Always a specific name, never the whole address book. Read only.",
      level: "read",
      repeatable: true,
      returnsUntrusted: true,
      schema: { query: z.string().trim().min(2).max(80).describe("Name or part of a name.") },
      async run(args) {
        try {
          const result = await companion.call("contacts_search", args);
          const lines = result.contacts.map((contact) =>
            [`- ${contact.name || contact.organization || "(no name)"}`, contact.organization && contact.name ? `(${contact.organization})` : "", [...contact.phones, ...contact.emails].join(", ")]
              .filter(Boolean)
              .join(" "),
          );
          return {
            ok: true,
            source: `contacts on ${owner.name}'s Mac`,
            text: lines.length > 0 ? [...lines, result.truncated ? "(truncated, there are more matches)" : ""].filter(Boolean).join("\n") : "No contact with this name.",
          };
        } catch (error) {
          const handled = offline(error);
          if (handled) return handled;
          throw error;
        }
      },
    }),
  ];
}
