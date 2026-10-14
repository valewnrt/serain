import { createServer, type Socket } from "node:net";
import type { PGlite } from "@electric-sql/pglite";

/**
 * Postgres protocol in front of the E2E throwaway database.
 *
 * PGlite is a single session. postgres.js sends a query in two rounds over the
 * unnamed statement: Parse, Describe, Flush, and only after the response Bind,
 * Execute, Sync. If anything else runs on the session in between, a second
 * connection of the Worker or a direct query from the test, the statement is
 * gone ("unnamed prepared statement does not exist", seen on 2026-10-08).
 * `@electric-sql/pglite-socket` only queues individual messages and allows
 * exactly that; by default it also resets when there is more than one connection.
 *
 * That is why the session here belongs to one connection from start to close.
 * For that long it holds PGlite's lock (`runExclusive`), which the test's
 * `db.query` and `db.exec` also wait for; further connections wait in line.
 * The Worker opens one connection per request and closes it afterwards, so the
 * lock is only taken for the duration of a request.
 */

/** No Worker request holds the database without traffic for longer than this; postgres.js closes after 5 s (`idle_timeout`). */
const IDLE_LIMIT_MS = 10_000;

export interface SerialPgServer {
  /** What went wrong; empty means clean. The run checks this at the end. */
  readonly problems: string[];
  stop(): Promise<void>;
}

const simpleQuery = (text: string): Uint8Array => {
  const body = Buffer.from(`${text}\0`, "utf8");
  const message = Buffer.alloc(5 + body.length);
  message.write("Q", 0, "latin1");
  message.writeInt32BE(4 + body.length, 1);
  body.copy(message, 5);
  return message;
};

export async function serveSerially(db: PGlite, options: { host: string; port: number }): Promise<SerialPgServer> {
  const problems: string[] = [];
  const sockets = new Set<Socket>();

  const handle = (socket: Socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let closed = false;
    let wake: (() => void) | null = null;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      wake?.();
    });
    socket.on("close", () => {
      closed = true;
      sockets.delete(socket);
      wake?.();
    });
    // A client abort ends in "close", nothing more to do here.
    socket.on("error", () => undefined);

    /** The next complete message: first the startup message without a type byte, after that type byte plus length. */
    let started = false;
    const next = (): Buffer | null => {
      const length = started ? (buffer.length >= 5 ? 1 + buffer.readInt32BE(1) : Infinity) : buffer.length >= 4 ? buffer.readInt32BE(0) : Infinity;
      if (buffer.length < length) return null;
      const message = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      return message;
    };

    const idle = () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          problems.push(`A connection held the database for ${IDLE_LIMIT_MS / 1000} s without traffic and was disconnected.`);
          socket.destroy();
        }, IDLE_LIMIT_MS);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });

    const session = async () => {
      while (!closed) {
        const message = next();
        if (!message) {
          await idle();
          continue;
        }
        // Terminate: the connection is done, PGlite's session remains.
        if (started && message[0] === 0x58) break;
        started = true;
        await db.execProtocolRawStream(new Uint8Array(message), { onRawData: (data) => void (!socket.destroyed && socket.write(Buffer.from(data))) });
      }
      // An aborted transaction belongs to this connection and ends with it, as in Postgres.
      if (db.isInTransaction()) await db.execProtocolRawStream(simpleQuery("ROLLBACK"), { onRawData: () => undefined });
      socket.end();
    };

    void db.runExclusive(session).catch((error: unknown) => {
      problems.push(`Database connection: ${(error as Error).message}`);
      socket.destroy();
    });
  };

  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  return {
    problems,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
