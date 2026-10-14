import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";

/**
 * `pnpm web:dev`: build the client, start the database tunnel, `wrangler dev`.
 *
 * Why a tunnel: Supabase signs the pooler with its own CA
 * (Supabase Root 2021 CA, `web/supabase-ca-2021.crt`, official download).
 * The Workers runtime cannot be given a custom CA, so TLS fails there.
 * Connecting without verification is out of the question. So locally this
 * tunnel listens on loopback only; the Worker talks to it without TLS, the tunnel
 * talks to Supabase with TLS, verified against exactly this CA and the hostname.
 * On Cloudflare, Hyperdrive does this with the same CA (`web/README.md`).
 */

const ROOT = resolve(import.meta.dirname, "..");
const LOCAL_PORT = 54320;

function readVar(name: string): string {
  const line = readFileSync(join(ROOT, "web", ".dev.vars"), "utf8").split("\n").find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is missing in web/.dev.vars (pnpm web db-password).`);
  return line.slice(name.length + 1).trim();
}

/** SSLRequest per the Postgres protocol: length 8, code 80877103. */
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

export function startTunnel(upstream: { host: string; port: number }, ca: Buffer, localPort = LOCAL_PORT): Promise<() => Promise<void>> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.pause();
    const raw = connect(upstream.port, upstream.host, () => raw.write(SSL_REQUEST));
    const fail = (error: Error) => {
      console.error(`Tunnel: ${error.message}`);
      client.destroy();
      raw.destroy();
    };
    raw.on("error", fail);
    raw.once("data", (answer) => {
      if (answer[0] !== 0x53) return fail(new Error("Supabase does not offer TLS. Aborting, nothing goes out unencrypted."));
      const secure = tlsConnect({ socket: raw, servername: upstream.host, ca, rejectUnauthorized: true, minVersion: "TLSv1.2" }, () => {
        client.pipe(secure).pipe(client);
        client.resume();
      });
      secure.on("error", fail);
      client.on("close", () => secure.destroy());
      secure.on("close", () => client.destroy());
    });
    client.on("close", () => sockets.delete(client));
    client.on("error", () => raw.destroy());
  });
  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(localPort, "127.0.0.1", () =>
      resolveStart(
        () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      ),
    );
  });
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, "web", "wrangler.toml"))) {
    throw new Error("web/wrangler.toml is missing. Run pnpm web vault-key first (creates it from web/wrangler.toml.example and fills in the vault key).");
  }
  const url = new URL(readVar("DATABASE_URL"));
  if (url.hostname !== "127.0.0.1" || Number(url.port) !== LOCAL_PORT) {
    throw new Error(`DATABASE_URL in web/.dev.vars must point to 127.0.0.1:${LOCAL_PORT} (pnpm web db-password writes it that way).`);
  }
  const [host, port] = readVar("DATABASE_UPSTREAM").split(":");
  if (!host || !port) throw new Error("DATABASE_UPSTREAM in web/.dev.vars is not host:port.");
  const stop = await startTunnel({ host, port: Number(port) }, readFileSync(join(ROOT, "web", "supabase-ca-2021.crt")));
  console.log(`Tunnel: 127.0.0.1:${LOCAL_PORT} → ${host}:${port} (TLS, verified against the Supabase CA)`);
  await import("./build.js");
  const wrangler = spawn("npx", ["wrangler", "dev", "--config", "web/wrangler.toml"], { cwd: ROOT, stdio: "inherit" });
  const shutdown = () => {
    wrangler.kill("SIGTERM");
    void stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  wrangler.on("exit", (code) => void stop().finally(() => process.exit(code ?? 0)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
