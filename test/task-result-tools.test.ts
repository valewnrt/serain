import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import { messagingTools, type MessagePort } from "../src/agent/tools/messaging.js";
import { calendarTools } from "../src/agent/tools/calendar.js";
import type { Calendar } from "../src/calendar/types.js";

/**
 * The result turn of a task (origin `task`) gets two protocol lines: values
 * to copy via `copy` and, with a calendar, a look at exactly the time window.
 * Both only work when the tools are really offered in this turn.
 */
describe("tools in the result turn of a task", () => {
  const port = { canReact: true, canReplyInThread: true, send: async () => true, react: async () => true } as unknown as MessagePort;
  const calendar = { label: "Testkalender", invites: false, deleteUndo: "" } as unknown as Calendar;
  const registry = new ToolRegistry().registerAll([...messagingTools(port), ...calendarTools(calendar).filter((def) => def.name === "calendar_events")]);
  const offered = registry.listFor({ origin: "task" });

  it("offers send_message and reply_in_thread with copy", () => {
    for (const name of ["send_message", "reply_in_thread"]) {
      const tool = offered.find((def) => def.name === name);
      expect(tool, name).toBeDefined();
      expect(Object.keys(tool!.schema), name).toContain("copy");
    }
  });

  it("offers calendar_events when a calendar is connected", () => {
    expect(offered.map((def) => def.name)).toContain("calendar_events");
  });
});
