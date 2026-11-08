/**
 * ACP-over-WS wire protocol, container side, vendored so the container is standalone;
 * it must match services/agent-host/src/acp/remoteProtocol.ts.
 *
 * Channel A (ACP): cloud → container  initialize | new_session | prompt | cancel | kill_terminals
 *                  container → cloud  ack (reply) | session_update | terminal_created | permission_request
 * Channel B (exec tunnel): container → cloud  exec_run | fs_read | fs_write
 *                          cloud → container  exec_result
 */

export const REMOTE_PROTOCOL_VERSION = 1;

/** `link` carries the resumable link's acks (see link.ts). */
export type Channel = "acp" | "exec" | "tunnel" | "link";

export interface WireFrame<P = unknown> {
  ch: Channel;
  type: string;
  id?: string;
  /** The ACP session this frame belongs to, stamped by the container, by which the relay routes container-to-cloud frames to the matching in-flight run. */
  sid?: string;
  /** Link sequence number; absent on link frames and old peers. */
  seq?: number;
  payload: P;
}

/** The connect hello the container sends first. */
export interface RemoteConnectHello {
  protocolVersion: number;
  joinToken: string;
}

// Minimal ACP shapes the container needs, mirroring the cloud AcpClient types.
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

// Channel B request payloads the container sends: its tool calls, run on the cloud sandbox.
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
// A named-target stream mux: `target` is a name the agent-host resolves server-side, the
// container runs one local HTTP proxy per offered server, and streams are bidirectional
// (`open` starts one, `chunk` flows both ways, `close` ends it, always with a reason on
// failure).
export type TunnelType = "open" | "chunk" | "end" | "close";

/** container -> cloud: start a stream to a named target. */
export interface TunnelOpenPayload {
  /** The server name, resolved server-side; never a host:port. */
  target: string;
  method: string;
  /** Path + query as the local proxy received it (e.g. "/" or "/messages?x=1"). */
  path: string;
  headers: Record<string, string>;
}

/** container -> cloud: the request body is complete, while the response may still stream back. */
export type TunnelEndPayload = Record<string, never>;

/** Either direction: a body chunk, base64 for binary safety. */
export interface TunnelChunkPayload {
  data: string;
}

/** Either direction: the stream is over, and `error` set means it failed. */
export interface TunnelClosePayload {
  error?: string;
  /** cloud -> container, on the first frame of a response. */
  status?: number;
  headers?: Record<string, string>;
}
