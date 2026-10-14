import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";
import { BlockedAddressError, checkUrl, guardedLookup } from "../executor/netguard.js";

/**
 * Filtering proxy for the headless browser (D28). Chrome resolves names itself
 * and loads whatever a page embeds: without this proxy a crafted page could
 * reach the owner's router, NAS or `localhost` from the owner's Mac
 * (`<img src="http://192.168.1.1/…">`). So every connection of the browser
 * passes through here, and resolving uses the same protection as `web_fetch`
 * on the server: public addresses only, ports 80 and 443 only, checked at the
 * address that is really connected to.
 */
export interface FilterProxy {
  /** 0 when the proxy listens on a Unix socket. */
  port: number;
  blocked: string[];
  close(): Promise<void>;
}

function refuse(target: Socket | ServerResponse, blocked: string[], what: string, error?: Error): void {
  // Only what the network guard rejected counts as blocked. A name that does not
  // exist, or a server that does not answer, is an ordinary error.
  // Capped: the proxy for the sandbox runs as long as the service (D61).
  if ((!error || error instanceof BlockedAddressError) && blocked.length < 100) blocked.push(what);
  if ("writeHead" in target) {
    target.writeHead(403).end();
  } else {
    target.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }
}

export interface FilterProxyOptions {
  /**
   * Listen on a Unix socket instead of a loopback port (D61): that way a
   * sandbox container without network, which only gets this directory
   * passed in, can reach it. The socket is writable for everyone because the
   * container runs as nobody; nobody else gets more than public addresses
   * through it either.
   */
  socketPath?: string;
}

export async function startFilterProxy(options: FilterProxyOptions = {}): Promise<FilterProxy> {
  const blocked: string[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Plain HTTP: Chrome sends the full address.
    const verdict = checkUrl(req.url ?? "");
    if (!verdict.ok || verdict.url.protocol !== "http:") return refuse(res, blocked, req.url ?? "");
    const { "proxy-connection": _drop, ...headers } = req.headers;
    const upstream = httpRequest(
      {
        host: verdict.url.hostname,
        port: 80,
        path: `${verdict.url.pathname}${verdict.url.search}`,
        method: req.method,
        headers,
        lookup: guardedLookup,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", (error) => refuse(res, blocked, verdict.url.hostname, error));
    req.pipe(upstream);
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const [host = "", port = ""] = (req.url ?? "").split(/:(?=\d+$)/);
    // The same check as for a URL: scheme, port, internal names and IPs.
    const verdict = checkUrl(`https://${host}${port === "443" ? "" : `:${port}`}/`);
    if (!verdict.ok) return refuse(client, blocked, req.url ?? "");
    const upstream = connect({ host: verdict.url.hostname.replace(/^\[|\]$/g, ""), port: 443, lookup: guardedLookup });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (error) => refuse(client, blocked, host, error));
  });

  let port = 0;
  if (options.socketPath) {
    const path = options.socketPath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    // A socket from an earlier run would otherwise stay behind and block listening.
    rmSync(path, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    chmodSync(path, 0o666);
  } else {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Proxy did not get a port");
    port = address.port;
  }
  return {
    port,
    blocked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
