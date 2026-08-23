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
 *
 * Design stage: SIGNATURES ONLY.
 */

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

/**
 * Start a local proxy for one named target. Resolves once it is listening (so the URL is
 * usable immediately).
 *
 * Design stage: SIGNATURE ONLY.
 */
export async function startMcpProxy(target: string, deps: McpProxyDeps): Promise<McpProxy> {
  void target;
  void deps;
  throw new Error("not implemented (design stage)");
}

/**
 * Start one proxy per offered server and return the SDK-ready mcpServers list (names kept,
 * urls replaced with the local ones).
 *
 * Design stage: SIGNATURE ONLY.
 */
export async function startMcpProxies(
  offered: Array<{ name: string; url?: string }>,
  deps: McpProxyDeps,
): Promise<{ servers: Array<{ type: "http"; name: string; url: string; headers: string[] }>; close: () => Promise<void> }> {
  void offered;
  void deps;
  throw new Error("not implemented (design stage)");
}
