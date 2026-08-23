/**
 * The container's local MCP proxies — one tiny HTTP server per offered MCP server.
 *
 * The SDK reaches MCP by URL and knows nothing about the tunnel: each proxy listens on an
 * ephemeral 127.0.0.1 port and forwards what it receives as `ch:"tunnel"` frames, so the SDK
 * makes ordinary HTTP calls to ordinary local URLs.
 *
 * ONE PER SERVER, N PER SESSION: the cloud offers a list on `new_session` (scooter-env today;
 * sandbox-declared servers later), and each gets its own proxy + its own `target` name. The
 * proxies are owned by the SESSION's client, so they are torn down with it — a stale proxy
 * pointing at a dead session would hang the SDK instead of failing it.
 *
 * 127.0.0.1 ONLY, never 0.0.0.0: this listens on a user's personal machine, and a
 * tunnel-into-the-cluster endpoint must not be reachable from their network.
 *
 * STREAMING, NOT BUFFERING: MCP StreamableHTTP streams responses, so chunks are written to the
 * HTTP response as they arrive rather than accumulated.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import type { WireFrame } from "./protocol.js";

export interface McpProxyDeps {
  /** Send a tunnel frame to the cloud. */
  send(frame: WireFrame): void;
  /** Subscribe to inbound frames (the cloud's chunks/closes); returns unsubscribe. */
  onFrame(cb: (frame: WireFrame) => void): () => void;
  /** Stamp streams with this session, so the cloud attributes them (see #305). */
  sessionId?: string;
}

export interface McpProxy {
  /** The name the cloud resolves ("scooter-env"). */
  readonly target: string;
  /** The local URL to hand the SDK (http://127.0.0.1:<port>/). */
  readonly url: string;
  /** Stop listening + fail any in-flight streams. */
  close(): Promise<void>;
}

/** One in-flight request: the HTTP response it must be written back to. */
interface Stream {
  res: ServerResponse;
  headersSent: boolean;
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });

export async function startMcpProxy(target: string, deps: McpProxyDeps): Promise<McpProxy> {
  const streams = new Map<string, Stream>();

  /** Write the cloud's status/headers once, on whichever frame carries them first. */
  const ensureHead = (s: Stream, payload: { status?: number; headers?: Record<string, string> }) => {
    if (s.headersSent) return;
    s.headersSent = true;
    s.res.writeHead(payload.status ?? 200, payload.headers ?? { "content-type": "application/json" });
  };

  const unsubscribe = deps.onFrame((frame) => {
    if (frame.ch !== "tunnel" || !frame.id) return;
    const s = streams.get(frame.id);
    if (!s) return;
    const payload = (frame.payload ?? {}) as {
      data?: string;
      error?: string;
      status?: number;
      headers?: Record<string, string>;
    };
    if (frame.type === "chunk") {
      ensureHead(s, payload);
      if (payload.data) s.res.write(Buffer.from(payload.data, "base64"));
      return;
    }
    if (frame.type === "close") {
      streams.delete(frame.id);
      if (payload.error) {
        // FAIL LOUD. A dropped tunnel must surface as a tool ERROR the agent can react to,
        // never an unanswered call it waits on forever.
        if (!s.headersSent) {
          s.headersSent = true;
          s.res.writeHead(502, { "content-type": "text/plain" });
        }
        s.res.end(payload.error);
        return;
      }
      ensureHead(s, payload);
      s.res.end();
    }
  });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const id = randomUUID();
      streams.set(id, { res, headersSent: false });
      // If the SDK gives up first, stop tracking (its socket is gone).
      res.on("close", () => streams.delete(id));
      const body = await readBody(req).catch(() => Buffer.alloc(0));
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
      const sid = deps.sessionId;
      deps.send({
        ch: "tunnel",
        type: "open",
        id,
        ...(sid ? { sid } : {}),
        payload: { target, method: req.method ?? "GET", path: req.url ?? "/", headers },
      });
      if (body.length) {
        deps.send({ ch: "tunnel", type: "chunk", id, payload: { data: body.toString("base64") } });
      }
      // Signal the REQUEST is complete. Not `close` — that would end the whole stream before
      // the response could come back; the cloud replies with chunks and its own close.
      deps.send({ ch: "tunnel", type: "end", id, payload: {} });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    target,
    url: `http://127.0.0.1:${port}/`,
    async close() {
      unsubscribe();
      // Fail anything in flight rather than leaving the SDK pending on a dead proxy.
      for (const [id, s] of streams) {
        streams.delete(id);
        if (!s.headersSent) s.res.writeHead(502, { "content-type": "text/plain" });
        s.res.end("mcp tunnel closed");
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function startMcpProxies(
  offered: Array<{ name: string; url?: string }>,
  deps: McpProxyDeps,
): Promise<{ servers: Array<{ type: "http"; name: string; url: string; headers: string[] }>; close: () => Promise<void> }> {
  const proxies = await Promise.all(offered.map((o) => startMcpProxy(o.name, deps)));
  return {
    // The SDK gets ordinary local URLs; the NAME is what travels over the wire.
    servers: proxies.map((p) => ({ type: "http" as const, name: p.target, url: p.url, headers: [] })),
    close: async () => {
      await Promise.all(proxies.map((p) => p.close().catch(() => undefined)));
    },
  };
}
