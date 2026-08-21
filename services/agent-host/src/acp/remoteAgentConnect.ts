/**
 * The cloud endpoint for a BYO remote agent: the /remote-agent/connect WebSocket upgrade handler.
 * The container dials in (wss), sends a hello (protocol version + owner-bound join token); on a
 * valid token we adapt the WS to a RemoteTransport and register it under the owner. See
 * remoteProtocol.ts + remoteAgentRegistry.ts + todo/docs/BYO_CLAUDE_REMOTE_AGENT.md.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import type { RemoteAgentRegistry } from "./remoteAgentRegistry.js";
import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteConnectHello,
  type RemoteTransport,
  type WireFrame,
} from "./remoteProtocol.js";
import { verifyJoinToken } from "../auth/remoteAgentToken.js";

/** Adapt a `ws` WebSocket to the RemoteTransport (WireFrame ⇄ JSON text messages). */
export function wsTransport(ws: WebSocket): RemoteTransport {
  const frameCbs = new Set<(f: WireFrame) => void>();
  const closeCbs = new Set<() => void>();
  ws.on("message", (data) => {
    let frame: WireFrame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return; // ignore a malformed frame (don't kill the connection)
    }
    for (const cb of frameCbs) cb(frame);
  });
  ws.on("close", () => {
    for (const cb of closeCbs) cb();
  });
  ws.on("error", () => {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  });
  return {
    send(frame) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    },
    onFrame(cb) {
      frameCbs.add(cb);
      return () => frameCbs.delete(cb);
    },
    isOpen() {
      return ws.readyState === ws.OPEN;
    },
    onClose(cb) {
      closeCbs.add(cb);
      return () => closeCbs.delete(cb);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    },
  };
}

export interface RemoteAgentConnectDeps {
  registry: RemoteAgentRegistry;
  /** The HS256 secret join tokens are signed with (agent-host secret). */
  joinSecret: string;
}

/**
 * Build the WS upgrade handler for /remote-agent/connect. Registered via
 * aguiServer.onUpgrade("/remote-agent/connect", handler). It completes the WS handshake, waits for
 * the container's hello (protocol version + join token), verifies it, and on success adapts + binds
 * the transport into the registry under the token's owner. A bad hello closes the socket.
 */
export function createRemoteAgentConnectHandler(deps: RemoteAgentConnectDeps) {
  // noServer: we own the upgrade (called from the agui server's `upgrade` event).
  const wss = new WebSocketServer({ noServer: true });

  const closeWithError = (ws: WebSocket, code: number, reason: string) => {
    try {
      ws.close(code, reason);
    } catch {
      /* noop */
    }
  };

  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      // The FIRST message must be the hello (protocol version + join token). A timeout guards a
      // silent client that never authenticates.
      const helloTimeout = setTimeout(() => closeWithError(ws, 4001, "no hello"), 10_000);
      ws.once("message", (data) => {
        clearTimeout(helloTimeout);
        let hello: RemoteConnectHello;
        try {
          hello = JSON.parse(data.toString());
        } catch {
          return closeWithError(ws, 4002, "bad hello");
        }
        if (hello.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
          return closeWithError(ws, 4003, `protocol ${REMOTE_PROTOCOL_VERSION} required`);
        }
        const v = verifyJoinToken(hello.joinToken ?? "", deps.joinSecret);
        if (!v.ok) {
          return closeWithError(ws, 4004, `auth: ${v.reason}`);
        }
        // Authenticated: adapt + register under the owner (latest-wins). Confirm ready so the
        // container can start driving.
        const transport = wsTransport(ws);
        deps.registry.register({ owner: v.claims.owner, transport });
        transport.onClose(() => deps.registry.unregister(v.claims.owner, transport));
        ws.send(JSON.stringify({ ch: "acp", type: "connected", payload: { owner: v.claims.owner } }));
      });
    });
  };
}
