import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.js";
import {
  decideDeadmanAction,
  logMissingPingUrlOnce,
  sendDeadmanPing,
} from "../src/health/deadman.js";
import { DeliveryLog, type DeliveryHealth } from "../src/health/delivery.js";
import type { Channel } from "../src/channel/types.js";
import type { OutboundGate } from "../src/outbound.js";

const PING_URL = "https://hc-ping.com/test-uuid-not-real";

// For the heartbeat run below: no database, a set ping URL.
const statusWrites: Array<{ component: string; status: string; detail: Record<string, unknown> }> = [];
const transitions: Array<{ component: string; healthy: boolean; message: string }> = [];
const openIncidents = new Set<string>();
vi.mock("../src/config/env.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/config/env.js")>();
  return { ...original, env: { ...original.env, healthchecksPingUrl: "https://hc-ping.com/test-uuid-not-real" } };
});
vi.mock("../src/db/client.js", () => ({
  db: { from: () => ({ select: () => ({ limit: async () => ({ error: null }) }) }) },
}));
vi.mock("../src/db/pg.js", () => ({ pgRows: async () => [{ ok: 1 }] }));
vi.mock("../src/health/status.js", () => ({
  recordComponentStatus: async (component: string, status: string, detail: Record<string, unknown>) =>
    void statusWrites.push({ component, status, detail }),
}));
vi.mock("../src/health/incidents.js", () => ({
  findOpenIncident: async (component: string) => (openIncidents.has(component) ? { id: "i1", component } : null),
  applyHealthTransition: async (component: string, healthy: boolean, message: string) => {
    transitions.push({ component, healthy, message });
    return { action: "none", incident: null };
  },
}));
const { startHeartbeat } = await import("../src/health/heartbeat.js");

describe("deadman switch decision", () => {
  it("does nothing without a configured URL, whatever the state", () => {
    expect(decideDeadmanAction(true, undefined)).toBe("none");
    expect(decideDeadmanAction(false, undefined)).toBe("none");
  });

  it("pings when all components are ok", () => {
    expect(decideDeadmanAction(true, PING_URL)).toBe("ping");
  });

  it("reports /fail when a component is disturbed", () => {
    expect(decideDeadmanAction(false, PING_URL)).toBe("fail");
  });
});

describe("deadman switch ping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the plain URL when ok", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    await sendDeadmanPing(PING_URL, "ping", fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(PING_URL);
    expect(init.method).toBe("GET");
  });

  it("appends /fail when a component is disturbed", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    await sendDeadmanPing(PING_URL, "fail", fetchMock as unknown as typeof fetch);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${PING_URL}/fail`);
  });

  it("never throws when the ping fails, but logs without the URL", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      sendDeadmanPing(PING_URL, "ping", fetchMock as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain(PING_URL);
  });

  it("never throws when the server returns an error status", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(
      sendDeadmanPing(PING_URL, "fail", fetchMock as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain(PING_URL);
  });
});

describe("notice on a missing URL", () => {
  it("logs only once, even on several calls", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => undefined);
    logMissingPingUrlOnce(undefined);
    logMissingPingUrlOnce(undefined);
    logMissingPingUrlOnce(undefined);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    infoSpy.mockRestore();
  });

  it("logs nothing when a URL is set", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => undefined);
    logMissingPingUrlOnce(PING_URL);
    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });
});

describe("[D44] heartbeat: sick delivery sends the deadman to /fail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    statusWrites.length = 0;
    transitions.length = 0;
    openIncidents.clear();
  });

  /** One heartbeat run with a connected channel; returns the ping URL that was called. */
  async function tick(delivery: DeliveryHealth): Promise<string> {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const channel = { isConnected: () => true } as unknown as Channel;
    const outbound = { deliveryHealth: () => delivery, sendToOwner: async () => true } as unknown as OutboundGate;
    const heartbeat = startHeartbeat(channel, outbound);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    heartbeat.stop();
    return (fetchMock.mock.calls[0] as unknown as [string])[0];
  }

  const failing = (): DeliveryHealth => {
    const log = new DeliveryLog();
    for (let i = 0; i < 3; i += 1) log.record(Date.now(), false, "Target not allowed for this project");
    return log.health(Date.now());
  };

  it("reports /fail although process, channel stream and database are healthy", async () => {
    expect(await tick(failing())).toBe(`${PING_URL}/fail`);
    expect(statusWrites.find((entry) => entry.component === "delivery")).toMatchObject({
      status: "down",
      detail: { attempts: 3, failures: 3, consecutive_failures: 3, last_error: "Target not allowed for this project", idle: false },
    });
    expect(transitions.find((entry) => entry.component === "delivery")).toEqual({
      component: "delivery",
      healthy: false,
      message: "detected automatically: deliveries fail (3 in a row, 3 of 3 in the window): Target not allowed for this project",
    });
    expect(transitions.find((entry) => entry.component === "channel")?.healthy).toBe(true);
  });

  it("pings normally while messages go out", async () => {
    const log = new DeliveryLog();
    log.record(Date.now(), true);
    expect(await tick(log.health(Date.now()))).toBe(PING_URL);
  });

  it("pings normally without a single send attempt", async () => {
    expect(await tick(new DeliveryLog().health(Date.now()))).toBe(PING_URL);
  });

  it("stays on /fail after a restart while the old incident is open and nothing went out", async () => {
    openIncidents.add("delivery");
    expect(await tick(new DeliveryLog().health(Date.now()))).toBe(`${PING_URL}/fail`);
  });
});
