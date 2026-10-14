import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEntry } from "../src/calendar/types.js";

const auditMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...args) }));

const { CalendarRefs, coarsePlace } = await import("../src/calendar/refs.js");
const { turnContext, systemPrompt } = await import("../src/agent/prompt.js");
const { taskTools } = await import("../src/agent/tools/task.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { ConfidentialGuard } = await import("../src/security/confidential.js");
const { executorIncoming } = await import("../src/executor/run.js");
type TaskPlace = import("../src/calendar/refs.js").TaskPlace;

/**
 * Location from the calendar in searches (addendum D54 of 2026-10-10): the
 * chat only sees handle and time, `run_task` resolves the handle, and only the
 * executor gets the location. All names and places are invented.
 */

// Friday, 2026-10-09, 10:00 in Berlin.
const NOW = new Date("2026-10-09T08:00:00Z");
const TITLE = "Brunch bei Tante Erika";
const PLACE = "Beispielgasse 4, 55116 Musterstadt";

function entry(overrides: Partial<CalendarEntry>): CalendarEntry {
  return {
    id: "e",
    title: TITLE,
    start: "2026-10-11T14:00:00+02:00",
    end: "2026-10-11T18:00:00+02:00",
    allDay: false,
    location: PLACE,
    guests: [],
    status: "confirmed",
    organizerSelf: true,
    declined: false,
    ...overrides,
  };
}

const ENTRIES: CalendarEntry[] = [
  entry({ id: "sonntag" }),
  entry({ id: "ohne-ort", title: "Zahnarzt", location: "  ", start: "2026-10-10T09:00:00+02:00", end: "2026-10-10T10:00:00+02:00" }),
  entry({ id: "abgelehnt", title: "Party", location: "Musterbar", declined: true, start: "2026-10-10T20:00:00+02:00", end: "2026-10-10T23:00:00+02:00" }),
  entry({ id: "abgesagt", title: "Lauf", location: "Stadion", status: "cancelled", start: "2026-10-10T08:00:00+02:00", end: "2026-10-10T09:00:00+02:00" }),
  entry({ id: "vorbei", title: "Frühstück", location: "Café Beispiel", start: "2026-10-09T07:00:00+02:00", end: "2026-10-09T08:00:00+02:00" }),
  entry({ id: "zu-weit", title: "Konferenz", location: "Musterhausen", start: "2026-10-20T09:00:00+02:00", end: "2026-10-20T17:00:00+02:00" }),
  entry({ id: "laeuft", title: "Workshop", location: "Musterhalle\nRaum 2", start: "2026-10-09T09:00:00+02:00", end: "2026-10-09T12:00:00+02:00" }),
  entry({ id: "ganztags", title: "Ausflug", location: "Beispielsee", allDay: true, start: "2026-10-12", end: "2026-10-14" }),
];

const refs = () => CalendarRefs.from(ENTRIES, NOW);

beforeEach(() => auditMock.mockClear());

describe("events as handles in the <context>", () => {
  it("takes only upcoming events with a location, without declined and cancelled ones, numbered by time", () => {
    expect(refs().contextLines()).toEqual([
      "t1: Fri 9 Oct, 09:00 to 12:00",
      "t2: Sun 11 Oct, 14:00 to 18:00",
      "t3: Mon 12 Oct to Tue 13 Oct, all day",
    ]);
  });

  it("shows the chat neither title nor location, only handle and time", () => {
    const context = turnContext(NOW, "", [], [], refs().contextLines());
    expect(context).toContain("<events>\nt1: Fri 9 Oct, 09:00 to 12:00");
    for (const secret of [TITLE, "Beispielgasse", "Musterstadt", "Musterhalle", "Beispielsee", "Ausflug", "Workshop"]) {
      expect(context).not.toContain(secret);
    }
    // Without events no empty block.
    expect(turnContext(NOW)).not.toContain("<events>");
    // The system prompt explains the block, only when there is run_task.
    expect(systemPrompt("", { web: true })).toContain("Under <events> in the <context>");
    expect(systemPrompt("", { web: false })).not.toContain("<events>");
  });

  it("resolves only handles of this turn, case does not matter", () => {
    expect(refs().resolve(" T2 ")).toEqual({ id: "t2", when: "Sun 11 Oct, 14:00 to 18:00", location: PLACE });
    // Line breaks in the location become one line.
    expect(refs().resolve("t1")?.location).toBe("Musterhalle Raum 2");
    expect(refs().resolve("t9")).toBeNull();
    expect(CalendarRefs.empty.resolve("t1")).toBeNull();
  });

  it("turns an address into postal code and town", () => {
    expect(coarsePlace(PLACE)).toBe("55116 Musterstadt");
    expect(coarsePlace("Beispielweg 7, 12345 Musterstadt am See, Deutschland")).toBe("12345 Musterstadt am See");
    expect(coarsePlace("Musterbar")).toBeNull();
  });
});

describe("run_task with event_id", () => {
  // Stands for the user model: Alex's own address (invented).
  const SECRETS = ConfidentialGuard.from(["- Adresse: **Beispielgasse 4, 55116 Musterstadt**"]);

  function rig(guard = ConfidentialGuard.from([])) {
    const started: Array<{ task: string; place?: TaskPlace }> = [];
    const registry = new ToolRegistry().registerAll(
      taskTools({
        port: { canReact: true, canReplyInThread: true, send: async () => true, react: async () => true },
        tasks: { precondition: async () => null, start: (request) => void started.push(request) },
        confidential: async () => guard,
      }),
    );
    return { started, registry };
  }
  const turn = (calendarRefs = refs()) =>
    new TurnState({ origin: "owner_message", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: ["m-1"], calendarRefs });
  const TASK = { task: "Wie wird das Wetter am Sonntag nachmittag am Ort des Termins?", screenshot: true, event_id: "t2" };

  it("gives the location only to the executor, never into the task text, the result or the audit log", async () => {
    const { started, registry } = rig();
    const result = await registry.execute("run_task", TASK, turn());
    expect(result.ok).toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0]?.place).toEqual({ when: "Sun 11 Oct, 14:00 to 18:00", location: PLACE });
    expect(started[0]?.task).not.toContain("Musterstadt");
    expect(result.text).not.toContain("Musterstadt");
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain("Musterstadt");
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain(TITLE);

    // The executor reads it framed after the task.
    const incoming = executorIncoming(NOW, started[0]!.task, false, started[0]!.place);
    expect(incoming).toContain("The location of the event the task means (Sun 11 Oct, 14:00 to 18:00), from Alex's calendar:");
    expect(incoming).toContain(`<untrusted source="Location from Alex's calendar">\nBeispielgasse 4, 55116 Musterstadt\n</untrusted>`);
    expect(executorIncoming(NOW, started[0]!.task)).not.toContain("location of the event the task means");
  });

  it("rejects a handle that was not in the <context> of this turn", async () => {
    const { started, registry } = rig();
    const unknown = await registry.execute("run_task", { ...TASK, event_id: "t7" }, turn());
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("There are only t1, t2, t3");
    const none = await registry.execute("run_task", TASK, turn(CalendarRefs.empty));
    expect(none.ok).toBe(false);
    expect(none.text).toContain("The <context> lists no events with a place");
    // A turn without handles: a handle from an earlier turn finds nothing.
    const bare = new TurnState({ origin: "owner_message", triggerExternalId: "m-2", triggerMessageId: "db-2", reactableIds: [] });
    expect((await registry.execute("run_task", TASK, bare)).ok).toBe(false);
    expect(started).toHaveLength(0);
    expect(auditMock).toHaveBeenCalledWith("tool_denied", { tool: "run_task", reason: "unknown_event" }, "db-1");
  });

  it("sends a confidential address only as postal code and town (D29)", async () => {
    const { started, registry } = rig(SECRETS);
    expect((await registry.execute("run_task", TASK, turn())).ok).toBe(true);
    expect(started[0]?.place?.location).toBe("55116 Musterstadt");
  });

  it("starts nothing when the location is confidential and cannot be coarsened", async () => {
    const guard = ConfidentialGuard.from(["- Adresse: **Musterallee 12**"]);
    const { started, registry } = rig(guard);
    const own = CalendarRefs.from([entry({ location: "Musterallee 12" })], NOW);
    const result = await registry.execute("run_task", { ...TASK, event_id: "t1" }, turn(own));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("an address");
    expect(started).toHaveLength(0);
    expect(auditMock).toHaveBeenCalledWith("tool_denied", { tool: "run_task", reason: "confidential_place", kinds: ["address"] }, "db-1");
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain("Musterallee");
  });

  it("runs without event_id as before", async () => {
    const { started, registry } = rig();
    const { event_id: _unused, ...plain } = TASK;
    expect((await registry.execute("run_task", plain, turn())).ok).toBe(true);
    expect(started[0]?.place).toBeUndefined();
  });
});
