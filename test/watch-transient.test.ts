import { createServer, type Server } from "node:http";
import { lookup } from "node:dns";
import type { AddressInfo, LookupFunction } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Short instead of 15 s: this is only about what the real fetch throws on a timeout.
vi.mock("../src/config/limits.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  FETCH_TIMEOUT_MS: 300,
}));

const { fetchPage } = await import("../src/executor/fetch.js");
const { readUrlWatch } = await import("../src/watch/read.js");
const { ConfidentialGuard } = await import("../src/security/confidential.js");

/**
 * Transient or not (2026-10-10), against the executor's real fetch and a real
 * local server: this way it shows when `fetchPage` reports its timeout
 * differently one day and a watcher would give up after five slow answers
 * again, or when its content-type message changes and the content type of the
 * other side would reach the model.
 */

const open = {
  lookup: lookup as unknown as LookupFunction,
  checkUrl: (raw: string) => ({ ok: true as const, url: new URL(raw) }),
};
const guard = ConfidentialGuard.from([]);
const fetcher = (url: string) => fetchPage(url, open);
const watch = (url: string) => ({ kind: "url_value" as const, spec: { url, anchor: "Preis", compare: "changes" as const } });

let server: Server;
let base: string;
let closedPort: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/hang") return; // never answers
    if (req.url === "/down") {
      res.writeHead(503, { "content-type": "text/html" }).end("Wartung");
      return;
    }
    if (req.url === "/gone") {
      res.writeHead(404, { "content-type": "text/html" }).end("Nicht gefunden");
      return;
    }
    res.writeHead(200, { "content-type": "image/png" }).end("x");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A port nobody listens on for sure: taken briefly and released again.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("watcher: what counts as transient, at the real fetch", () => {
  it("timeout, refused connection and 503 are transient", async () => {
    expect(await readUrlWatch(watch(`${base}/hang`), guard, fetcher)).toMatchObject({ ok: false, final: false, transient: true });
    expect(await readUrlWatch(watch(`http://127.0.0.1:${closedPort}/`), guard, fetcher)).toMatchObject({
      ok: false,
      transient: true,
      reason: "unreachable (ECONNREFUSED)",
    });
    expect(await readUrlWatch(watch(`${base}/down`), guard, fetcher)).toMatchObject({ ok: false, transient: true });
  });

  it("404 and a content type that is not text are not", async () => {
    const gone = await readUrlWatch(watch(`${base}/gone`), guard, fetcher);
    expect(gone).toMatchObject({ ok: false, wrongPage: true });
    expect(gone).not.toHaveProperty("transient");
    const image = await readUrlWatch(watch(`${base}/bild`), guard, fetcher);
    expect(image).toMatchObject({ ok: false, reason: "the page is not readable text" });
    expect(JSON.stringify(image)).not.toContain("image/png");
    expect(image).not.toHaveProperty("transient");
  });
});
