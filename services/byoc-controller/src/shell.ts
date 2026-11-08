/** The controller's network shell: HTTP/SSE and container sockets, with heartbeats. */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import { createSessionRegistry, type SessionStore } from "./sessionRegistry.js";
import { createRunRelay, type LinkRequest } from "./runRelay.js";
import { LINK_ID_PARAM, LINK_SEQ_PARAM } from "./link.js";
import { createServer } from "./server.js";
import { createDeviceAuth, type DeviceStore } from "./deviceAuth.js";

/** SSE comment cadence on every stream. */
export const SSE_HEARTBEAT_MS = 15_000;
/** Container ping cadence. */
export const WS_PING_MS = 20_000;
/** Consecutive unanswered pings before the socket is declared dead. */
export const WS_MAX_MISSED_PONGS = 3;

export interface ControllerOptions {
  /** The internal listener, for in-cluster callers only; 0 picks a free port. */
  port: number;
  /** The public listener the ingress targets; omitted means none, 0 picks a free port. */
  publicPort?: number;
  secret: string;
  /** Caller-owned, so a restarted controller reuses them. */
  store: SessionStore;
  deviceStore: DeviceStore;
  sseHeartbeatMs?: number;
  wsPingMs?: number;
  wsMaxMissedPongs?: number;
}

export interface RunningController {
  port: number;
  publicPort?: number;
  /** Stop listening and drop every container socket and stream. */
  close(): Promise<void>;
}

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
};

/** The identity the agent-host names; server.ts drops it on the public surface. */
const userFrom = (req: IncomingMessage): { id: string } | undefined => {
  const id = (req.headers["x-auth-request-user"] ?? req.headers["x-forwarded-user"]) as string | undefined;
  return id ? { id } : undefined;
};

export async function startController(opts: ControllerOptions): Promise<RunningController> {
  const { secret, store, deviceStore } = opts;
  const sseHeartbeatMs = opts.sseHeartbeatMs ?? SSE_HEARTBEAT_MS;
  const wsPingMs = opts.wsPingMs ?? WS_PING_MS;
  const wsMaxMissedPongs = Math.max(1, opts.wsMaxMissedPongs ?? WS_MAX_MISSED_PONGS);

  const registry = createSessionRegistry({ store, secret });
  const relay = createRunRelay({ registry });
  // Device identities let a laptop reconnect without a fresh join token.
  const devices = createDeviceAuth({ store: deviceStore, secret });
  const api = createServer({ registry, relay, secret, devices });

  const serve = (surface: "public" | "internal") => (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.url === "/healthz") {
        res.writeHead(200).end("ok");
        return;
      }
      try {
        const result = await api.handle({
          method: req.method ?? "GET",
          path: req.url ?? "/",
          body: await readBody(req),
          user: userFrom(req),
          surface,
        });

        if (result.stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          // Flush the head with an SSE comment, since Node buffers it until the first write and a quiet stream would trip the client's headers timeout.
          res.write(": open\n\n");
          const heartbeat = setInterval(() => res.write(": ping\n\n"), sseHeartbeatMs);
          // Stop pumping if the agent-host goes away mid-run.
          let clientGone = false;
          res.on("close", () => {
            clientGone = true;
            clearInterval(heartbeat);
          });
          try {
            for await (const frame of result.stream) {
              if (clientGone) break;
              res.write(`data: ${JSON.stringify(frame)}\n\n`);
            }
          } finally {
            clearInterval(heartbeat);
          }
          res.end();
          return;
        }

        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(result.json === undefined ? "" : JSON.stringify(result.json));
      } catch (err) {
        console.error("[byoc] request failed:", err);
        // A thrown handler must not take down the one process holding every container socket.
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    })();
  };
  const http = createHttpServer(serve("internal"));
  const publicHttp = opts.publicPort === undefined ? undefined : createHttpServer(serve("public"));

  // --- Container sockets -----------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  // Unanswered pings per socket; one miss is jitter, not death.
  const missedPongs = new WeakMap<WebSocket, number>();
  const pinger = setInterval(() => {
    for (const ws of sockets) {
      const missed = missedPongs.get(ws);
      if (missed !== undefined) {
        if (missed + 1 >= wsMaxMissedPongs) {
          console.warn(`[byoc] container missed ${missed + 1} pongs in a row; terminating its socket`);
          ws.terminate();
          continue;
        }
        console.warn(`[byoc] container missed a pong (${missed + 1}/${wsMaxMissedPongs}); still waiting`);
      }
      missedPongs.set(ws, missed === undefined ? 0 : missed + 1);
      ws.ping();
    }
  }, wsPingMs);

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = /^\/byoc\/ws\/([^/]+)$/.exec(url.pathname);
    if (!m) {
      socket.destroy();
      return;
    }
    const sessionId = decodeURIComponent(m[1]);
    // The token rides as a query param because the check below, not the ingress, is the gate.
    const token = url.searchParams.get("token") ?? "";
    // A registered container signs a server-issued nonce and needs no token; a first-time container presents the join token.
    const deviceId = url.searchParams.get("deviceId");
    const nonce = url.searchParams.get("nonce");
    const signature = url.searchParams.get("signature");
    // Absent from containers that predate links.
    const linkId = url.searchParams.get(LINK_ID_PARAM);
    const linkSeq = Number(url.searchParams.get(LINK_SEQ_PARAM) ?? "0");
    const link: LinkRequest | undefined = linkId ? { id: linkId, seq: linkSeq } : undefined;
    void (async () => {
      const authorized =
        deviceId && nonce && signature
          ? await api.authorizeDevice(deviceId, nonce, signature)
          : api.authorizeUpgrade(sessionId, token);
      if (!authorized.ok) {
        console.warn(
          `[byoc] upgrade rejected for session ${sessionId} ` +
            `(${deviceId ? `device ${deviceId}` : "join token"}): ${authorized.reason}`,
        );
        // Record the failure so the Settings UI can show it via /byoc/status.
        void api.noteAuthFailure({ deviceId, token, reason: authorized.reason });
        // Reject by completing the upgrade and closing with a code and reason, so the container logs the cause and backs off to the slow auth-retry cadence.
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          ws.close(4001, `auth rejected: ${authorized.reason}`);
        });
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        // Build the adapter once and keep the reference, because detachIfCurrent compares by identity.
        const containerSocket = {
          send: (data: string) => ws.send(data),
          close: (code?: number, reason?: string) => (code ? ws.close(code, reason) : ws.close()),
        };
        // A device-authenticated container attaches by the owner the signature proved; a first-time container uses the token path.
        const attached = deviceId
          ? registry.attachAuthenticated(sessionId, authorized.owner, containerSocket)
          : registry.attach(sessionId, token, containerSocket);
        if (!attached.ok) {
          // Close with a code and reason so the container can log why.
          console.warn(`[byoc] attach rejected: session=${sessionId} owner=${authorized.owner}: ${attached.reason}`);
          ws.close(4001, `attach rejected: ${attached.reason}`);
          return;
        }
        // The session actually attached can differ from the URL's id on a device re-attach, and every relay wire-up below must use it.
        const liveSessionId = attached.sessionId;
        console.log(`[byoc] container attached: session=${liveSessionId} owner=${authorized.owner}`);
        sockets.add(ws);
        ws.on("pong", () => missedPongs.delete(ws));
        const attachedLink = relay.onContainerAttached(liveSessionId, containerSocket, link);
        // Confirm the attach, then replay what the container missed.
        ws.send(
          JSON.stringify({
            type: "connected",
            payload: { owner: authorized.owner, sessionId: liveSessionId, link: attachedLink.resume },
          }),
        );
        attachedLink.start();

        ws.on("message", (data) => relay.onContainerFrame(liveSessionId, data.toString()));
        ws.on("close", () => {
          sockets.delete(ws);
          console.log(`[byoc] container gone: session=${liveSessionId}`);
          // Hold or end the runs, then release the socket.
          relay.onContainerClosed(liveSessionId, containerSocket);
          registry.detachIfCurrent(liveSessionId, containerSocket);
        });
        ws.on("error", (e) => console.warn(`[byoc] socket error session=${liveSessionId}: ${e.message}`));
      });
    })();
  };
  // Both listeners take the connect, which authenticates itself.
  http.on("upgrade", onUpgrade);
  publicHttp?.on("upgrade", onUpgrade);

  const listen = async (server: Server, at: number): Promise<number> => {
    await new Promise<void>((resolve) => server.listen(at, resolve));
    return (server.address() as AddressInfo).port;
  };
  const port = await listen(http, opts.port);
  const publicPort = publicHttp ? await listen(publicHttp, opts.publicPort!) : undefined;
  console.log(`[byoc] listening on :${port} (internal)${publicPort === undefined ? "" : `, :${publicPort} (public)`}`);

  return {
    port,
    publicPort,
    async close() {
      clearInterval(pinger);
      for (const ws of sockets) ws.terminate();
      api.close();
      await Promise.all(
        [http, publicHttp].map(
          (s) =>
            s &&
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections();
            }),
        ),
      );
    },
  };
}
