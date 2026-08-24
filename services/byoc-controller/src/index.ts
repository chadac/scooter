/**
 * BYOC controller entrypoint — binds the pure HTTP surface (server.ts) to node:http, and the
 * container sockets to `ws`.
 *
 * Deliberately thin: routing, auth, and relay semantics all live in tested modules, and everything
 * here is the part that genuinely needs a socket.
 *
 * SINGLE REPLICA (§L decision 3). One process owns every container socket, so there is no
 * cross-replica socket problem at all. A restart drops the sockets and the containers reconnect on
 * their own (`--restart always` + backoff). Do not scale this without revisiting §L — multi-replica
 * reintroduces exactly the "which pod holds the socket" bug this design exists to delete.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { createSessionRegistry } from "./sessionRegistry.js";
import { createRunRelay } from "./runRelay.js";
import { createServer } from "./server.js";
import { createDeviceAuth } from "./deviceAuth.js";
import {
  createPgSessionStore,
  createMemorySessionStore,
  createPgDeviceStore,
  createMemoryDeviceStore,
} from "./sessionStore.js";

const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.BYOC_JOIN_SECRET ?? "";
// Assemble the DSN from parts, the way webhooks/broker/scheduler do: the platform's postgres-init
// provisions a db + role and writes only a `password` secret, never a full DSN. DATABASE_URL is
// still honoured so a local run can point at anything.
const DSN =
  process.env.DATABASE_URL ??
  (process.env.DB_HOST
    ? `postgresql://${process.env.DB_USER ?? "byoc"}:${encodeURIComponent(process.env.DB_PASSWORD ?? "")}` +
      `@${process.env.DB_HOST}:${process.env.DB_PORT ?? "5432"}/${process.env.DB_NAME ?? "byoc"}` +
      (process.env.DB_SSLMODE ? `?sslmode=${process.env.DB_SSLMODE}` : "")
    : "");

if (!SECRET) {
  console.error("[byoc] BYOC_JOIN_SECRET is required — refusing to start without a signing key");
  process.exit(1);
}

// Durable owner->session mapping when a DSN is configured; in-memory otherwise (local dev). The
// SOCKET is always in-memory either way — see sessionRegistry's header for why that split is
// deliberate rather than a limitation.
const store = DSN ? createPgSessionStore({ dsn: DSN }) : createMemorySessionStore();
if (!DSN) console.warn("[byoc] no DATABASE_URL — owner->session mapping will NOT survive a restart");

const registry = createSessionRegistry({ store, secret: SECRET });
const relay = createRunRelay({ registry });
// Device identities (§P) — what lets a laptop reconnect after sleeping without a fresh
// 10-minute join token. Without this the controller answers /byoc/devices with
// "device auth not enabled", which is exactly what a live registration attempt hit.
const deviceStore = DSN ? createPgDeviceStore({ dsn: DSN }) : createMemoryDeviceStore();
const devices = createDeviceAuth({ store: deviceStore, secret: SECRET });

const api = createServer({ registry, relay, secret: SECRET, devices });

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

/** The identity the authed surface passes down. In-cluster callers (agent-hosts) have none, and the
 *  mint route is the only one that requires it. */
const userFrom = (req: IncomingMessage): { id: string } | undefined => {
  // Set by the ingress auth proxy (same headers the agent-host trusts). Absent on the
  // unauthenticated /byoc/ ingress, which is exactly why mint is not served there.
  const id = (req.headers["x-auth-request-user"] ?? req.headers["x-forwarded-user"]) as string | undefined;
  return id ? { id } : undefined;
};

const http = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
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
      });

      if (result.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // FLUSH THE HEAD IMMEDIATELY. Node buffers the response head until the first write, so
        // a stream that stays quiet (the INBOUND tunnel stream is quiet until the container
        // makes an MCP call — possibly minutes) never sends headers at all. Node's fetch
        // (undici) aborts on its headers timeout, which surfaced as
        // `[tunnel] inbound stream dropped (reconnecting): TypeError: fetch failed` in a loop:
        // the agent-host could never hold the stream open, so container-initiated MCP calls
        // were never served and every BYO tool call timed out. An SSE comment is the standard
        // way to open the stream without emitting a frame.
        res.write(": open\n\n");
        // Stop pumping if the agent-host goes away mid-run (pod evicted, rollout), or the relay
        // would write into a dead response for the rest of the run.
        let clientGone = false;
        res.on("close", () => { clientGone = true; });
        for await (const frame of result.stream) {
          if (clientGone) break;
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
        res.end();
        return;
      }

      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.json === undefined ? "" : JSON.stringify(result.json));
    } catch (err) {
      console.error("[byoc] request failed:", err);
      // A thrown handler must not take the process down: this is the one service holding every
      // user's container socket, so an unhandled error would disconnect the whole fleet.
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  })();
});

// --- Container sockets -------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

http.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const m = /^\/byoc\/ws\/([^/]+)$/.exec(url.pathname);
  if (!m) {
    socket.destroy();
    return;
  }
  const sessionId = decodeURIComponent(m[1]);
  // The token rides as a query param: a browser-less container cannot set an Authorization header
  // through every proxy, and this path is unauthenticated at the ingress by design (§L Q3). The
  // token is short-lived and single-purpose, and the check below is the real gate.
  const token = url.searchParams.get("token") ?? "";
  // TWO ways in (§P). A REGISTERED container signs a server-issued nonce and needs no token — that
  // is what survives a laptop sleeping past the join token's 10-minute life. A first-time container
  // still presents the join token. Credentials ride the URL because authorization happens at the
  // UPGRADE, before any application message exists.
  const deviceId = url.searchParams.get("deviceId");
  const nonce = url.searchParams.get("nonce");
  const signature = url.searchParams.get("signature");
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
    // Record the failure so the SETTINGS UI can show it (via /byoc/status). Owner is
    // best-effort: a device id maps through the store; an invalid token's claims are decoded
    // UNVERIFIED — fine for a diagnostic label, never for authorization.
    void api.noteAuthFailure({ deviceId, token, reason: authorized.reason });
    // Reject by COMPLETING the upgrade and closing with a code + reason: a raw 401 socket
    // write reaches the ws client as a generic error with no explanation, and the container
    // fast-loops in silence. Through a real close frame, the reason lands in its log and it
    // backs off to the slow auth-retry cadence.
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      ws.close(4001, `auth rejected: ${authorized.reason}`);
    });
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    // Build the adapter ONCE and keep the reference: detachIfCurrent compares by IDENTITY, so
    // passing a freshly-built object on close would never match the stored socket and the
    // superseded-close guard would silently do nothing.
    const containerSocket = {
      send: (data: string) => ws.send(data),
      close: (code?: number, reason?: string) => (code ? ws.close(code, reason) : ws.close()),
    };
    // A device-authenticated container has NO join token to re-verify — attaching by the OWNER the
    // signature already proved is the whole point of §P 
    // (a stale URL session id re-attaches to the owner's current session; see the registry).
    // First-time containers use the token path.
    const attached = deviceId
      ? registry.attachAuthenticated(sessionId, authorized.owner, containerSocket)
      : registry.attach(sessionId, token, containerSocket);
    if (!attached.ok) {
      // Close with a CODE + REASON. A bare close() surfaces client-side as the opaque
      // `disconnected (code 1005)` — the container retried forever with nothing in either log
      // saying why. 4001 = this application's "attach rejected"; the reason names the cause.
      // eslint-disable-next-line no-console
      console.warn(`[byoc] attach rejected: session=${sessionId} owner=${authorized.owner}: ${attached.reason}`);
      ws.close(4001, `attach rejected: ${attached.reason}`);
      return;
    }
    // The session ACTUALLY attached — for a device re-attach this can differ from the URL's id.
    // Every relay wire-up below must use it, or frames route to a dead session.
    const liveSessionId = attached.sessionId;
    console.log(`[byoc] container attached: session=${liveSessionId} owner=${authorized.owner}`);
    // CONFIRM the attach to the container. The client waits for exactly this frame to log
    // "registered as owner … — ready"; without it a fully-authenticated container looks, from
    // the laptop, like it never finished authenticating (observed live: the only evidence of a
    // healthy attach was on the SERVER, and the user read the silent client as an auth failure).
    ws.send(JSON.stringify({ type: "connected", payload: { owner: authorized.owner, sessionId: liveSessionId } }));

    ws.on("message", (data) => relay.onContainerFrame(liveSessionId, data.toString()));
    ws.on("close", () => {
      console.log(`[byoc] container gone: session=${liveSessionId}`);
      // Order matters: end the in-flight runs FIRST (so their streams terminate with an error ack
      // rather than hanging), then release the socket.
      relay.onContainerGone(liveSessionId);
      registry.detachIfCurrent(liveSessionId, containerSocket);
    });
    ws.on("error", (e) => console.warn(`[byoc] socket error session=${liveSessionId}: ${e.message}`));
  });
  })();
});

http.listen(PORT, () => console.log(`[byoc] listening on :${PORT}`));

const shutdown = () => {
  console.log("[byoc] shutting down");
  http.close();
  void store.close();
  void deviceStore.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
