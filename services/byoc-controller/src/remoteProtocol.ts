/**
 * ACP-over-WebSocket wire protocol for bring-your-own-Claude. The user's container runs the
 * Claude Agent SDK and dials an outbound WS to the cloud, which drives it over that WS while
 * the agent's tools still exec into the cloud sandbox. All frames are JSON
 * `{ch, type, id?, payload}`, with `id` correlating a request to its reply:
 *
 *   Channel A (ACP): cloud → agent  initialize | new_session | prompt | cancel | kill_terminals
 *                    agent → cloud  session_update | terminal_created | permission_request
 *                                   + replies: ack (to initialize/new_session/prompt/cancel)
 *   Channel B (exec, the reverse tunnel): agent → cloud  exec_run | exec_spawn | fs_read | fs_write
 *                                         cloud → agent  exec_result | exec_chunk | exec_exit
 */

// The wire types are declared here rather than imported: the controller only forwards these payloads as opaque cargo, so keep them minimal and share the type if a field ever needs interpreting.
export type ContentBlock = { type: string; [k: string]: unknown };

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean };
}

export interface NewSessionParams {
  cwd: string;
  mcpServers?: unknown[];
}

/** Opaque to the relay, forwarded verbatim to the agent-host. */
export type SessionUpdate = { sessionUpdate: string; [k: string]: unknown };

export interface PermissionRequest {
  sessionId: string;
  toolCallId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

/** The negotiated protocol version, bumped on any wire change so a mismatched container fails clean. */
export const REMOTE_PROTOCOL_VERSION = 1;

/** `link` carries the resumable link's acks (see link.ts). */
export type Channel = "acp" | "exec" | "tunnel" | "link";

/** Every wire frame; `id` is present on request/reply pairs and absent on one-way notifications. */
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

// --- Channel A: ACP (cloud → agent requests, each answered by an `ack` reply) ----------------
export type AcpDownType = "initialize" | "new_session" | "prompt" | "cancel" | "kill_terminals";

export interface AcpInitializePayload {
  params: InitializeParams;
}
export interface AcpNewSessionPayload {
  params: NewSessionParams;
}
export interface AcpPromptPayload {
  sessionId: string;
  prompt: ContentBlock[];
}
export interface AcpCancelPayload {
  sessionId: string;
}

/** The reply to an ACP request (`type: "ack"`, same `id`), carrying a request-specific `result` or an `error`. */
export interface AcpAckPayload {
  result?: unknown;
  error?: string;
}

// --- Channel A: ACP (agent → cloud notifications) --------------------------------------------
export interface AcpSessionUpdatePayload {
  sessionId: string;
  update: SessionUpdate;
}
export interface AcpTerminalCreatedPayload {
  terminalId: string;
  command: string;
  args: string[];
}
/** A request from the agent, which blocks until the cloud replies with an `ack` carrying {optionId} or {cancelled:true}. */
export interface AcpPermissionRequestPayload {
  request: PermissionRequest;
}
export interface AcpPermissionAnswerPayload {
  optionId?: string;
  cancelled?: boolean;
}

// --- Channel B: exec tunnel (agent → cloud requests, cloud runs them on the CLOUD ExecBackend) --
export type ExecUpType = "exec_run" | "exec_spawn" | "fs_read" | "fs_write";

export interface ExecRunPayload {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}
export interface FsReadPayload {
  path: string;
}
export interface FsWritePayload {
  path: string;
  content: string;
}

/** The reply to an exec/fs request (`type: "exec_result"`, same `id`), carrying a request-specific `result` or an `error`. */
export interface ExecResultPayload {
  result?: unknown;
  error?: string;
}
export interface ExecChunkPayload {
  streamId: string;
  chunk: string;
}
export interface ExecExitPayload {
  streamId: string;
  exitCode: number;
}

// --- Transport abstraction (so RemoteAcpClient is testable with a fake WS pair) ---------------
/** A minimal duplex frame transport: the WS in prod, an in-memory pair in tests. */
export interface RemoteTransport {
  /** Send one frame to the peer; throws or no-ops if closed. */
  send(frame: WireFrame): void;
  /** Subscribe to inbound frames from the peer; returns an unsubscribe fn. */
  onFrame(cb: (frame: WireFrame) => void): () => void;
  /** Whether the underlying connection is currently open. */
  isOpen(): boolean;
  /** Notified when the connection closes. */
  onClose(cb: () => void): () => void;
  /** Close the transport. */
  close(): void;
}

/** The connect handshake the container sends before any ACP frame. */
export interface RemoteConnectHello {
  protocolVersion: number;
  joinToken: string;
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
