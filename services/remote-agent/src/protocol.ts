/**
 * ACP-over-WS wire protocol (container side) — MUST match the cloud's
 * services/agent-host/src/acp/remoteProtocol.ts. Vendored here so the container is standalone.
 *
 * Channel A (ACP): cloud → container  initialize | new_session | prompt | cancel | kill_terminals
 *                  container → cloud  ack (reply) | session_update | terminal_created | permission_request
 * Channel B (exec tunnel): container → cloud  exec_run | fs_read | fs_write
 *                          cloud → container  exec_result
 */

export const REMOTE_PROTOCOL_VERSION = 1;

export type Channel = "acp" | "exec" | "tunnel";

export interface WireFrame<P = unknown> {
  ch: Channel;
  type: string;
  id?: string;
  /** The ACP session this frame belongs to, stamped by the CONTAINER on frames it originates
   *  (exec requests especially — their payloads carry no session, unlike session_update's).
   *  The relay routes container->cloud frames to the matching in-flight run by this, which is
   *  what makes CONCURRENT conversations on one container safe: without it, exec requests were
   *  broadcast to every run and two conversations would each execute the other's tool calls. */
  sid?: string;
  payload: P;
}

/** The connect hello the container sends first (protocol version + owner-bound join token). */
export interface RemoteConnectHello {
  protocolVersion: number;
  joinToken: string;
}

// Minimal ACP shapes the container needs (mirrors the cloud AcpClient types).
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string }
  | { type: "image"; data: string; mimeType: string };

export interface AcpInitializePayload {
  params: { protocolVersion: number; clientCapabilities: unknown };
}
export interface AcpNewSessionPayload {
  params: { cwd: string; mcpServers?: unknown[] };
}
export interface AcpPromptPayload {
  sessionId: string;
  prompt: ContentBlock[];
}
export interface AcpCancelPayload {
  sessionId: string;
}

// Channel B request payloads the container SENDS (its tool calls, run on the cloud sandbox).
export interface ExecRunPayload {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export interface FsReadPayload {
  path: string;
}
export interface FsWritePayload {
  path: string;
  content: string;
}

// --- Channel C: TUNNEL (MCP over the wire, BYOC only) ---------------------------------------
//
// WHY. The container's SDK reaches MCP servers by URL, but `scooter-env` lives at
// http://127.0.0.1:8080/mcp on the AGENT-HOST POD's loopback — goose and the in-cluster SDK
// reach it because they run in that pod; a laptop cannot, by any route. So a BYO agent had no
// scooter-env at all: no background jobs, model switch, scheduler, or resize.
//
// SHAPE. A named-target stream mux, NOT a raw TCP tunnel. `target` is a NAME the agent-host
// resolves server-side ("scooter-env" today; "sandbox:<name>" reserved for sandbox-declared
// servers). Raw host:port forwarding was rejected deliberately: it would open cluster network
// reachability from a user's machine, give up per-stream attribution, and still need port
// allocation + URL rewriting on the laptop.
//
// N SERVERS PER CONVERSATION. The container runs one local HTTP proxy per offered server and
// hands its SDK ordinary http://127.0.0.1:<port>/ URLs. Adding a server later is a resolution
// entry, not a protocol change.
//
// BIDIRECTIONAL STREAMS from day one: MCP StreamableHTTP streams responses, and a stateful or
// server-push server would otherwise force a redesign. `open` starts a stream, `chunk` flows
// BOTH ways, `close` ends it — always with a reason on failure, because a tunnel that goes
// quiet leaves the agent with tools that HANG.
export type TunnelType = "open" | "chunk" | "end" | "close";

/** container -> cloud: start a stream to a named target. */
export interface TunnelOpenPayload {
  /** The server NAME, resolved server-side. Never a host:port. */
  target: string;
  method: string;
  /** Path + query as the local proxy received it (e.g. "/" or "/messages?x=1"). */
  path: string;
  headers: Record<string, string>;
}

/** container -> cloud: the REQUEST body is complete (the response may still stream back).
 *  A distinct type rather than a flag on close: `close` ends the whole stream, and conflating
 *  "I finished sending" with "we are done" would cut off every response. */
export type TunnelEndPayload = Record<string, never>;

/** Either direction: a body chunk, base64 for binary safety. */
export interface TunnelChunkPayload {
  data: string;
}

/** Either direction: the stream is over. `error` set => it failed (never a silent stop). */
export interface TunnelClosePayload {
  error?: string;
  /** cloud -> container, on the FIRST frame of a response. */
  status?: number;
  headers?: Record<string, string>;
}
