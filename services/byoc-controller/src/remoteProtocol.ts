/**
 * ACP-over-WebSocket wire protocol for bring-your-own-Claude (Increment 2).
 *
 * The user's container runs the real Claude Agent SDK (the BRAIN) and dials an OUTBOUND WS to the
 * cloud. The cloud's RemoteAcpClient (an AcpClient impl) drives it over that WS, while the agent's
 * TOOLS still exec into the CLOUD sandbox (tunneled back). Two logical channels multiplexed on one
 * WS, all frames JSON `{ch, type, id?, payload}`:
 *
 *   Channel A (ACP): cloud → agent  initialize | new_session | prompt | cancel | kill_terminals
 *                    agent → cloud  session_update | terminal_created | permission_request
 *                                   + REPLIES: ack (to initialize/new_session/prompt/cancel)
 *   Channel B (exec, the reverse tunnel): agent → cloud  exec_run | exec_spawn | fs_read | fs_write
 *                                         cloud → agent  exec_result | exec_chunk | exec_exit
 *
 * `id` correlates a request to its reply. The token + the Anthropic inference call live ENTIRELY in
 * the container; the cloud only ever sees these frames (ACP messages + tool exec) — the compliance
 * invariant. See todo/docs/BYO_CLAUDE_REMOTE_AGENT.md.
 */

// WIRE TYPES, declared HERE rather than imported.
//
// I first tried importing these from the ACP SDK; they are not there. The agent-host's
// `acp/client.ts` HAND-WRITES them (the SDK exposes InitializeRequest/NewSessionRequest/
// SessionNotification, a different shape). Importing from the agent-host instead would couple this
// credential-free relay (§L Q2) to the agent-host's client machinery for four type aliases.
//
// Structural typing makes the duplication safe in the direction that matters: the controller only
// FORWARDS these payloads and never reads their fields, so a drift on either side cannot silently
// corrupt a relayed frame — it is opaque cargo here. Keep them minimal for that reason; if the
// controller ever needs to interpret a field, share the type instead of widening this block.
export type ContentBlock = { type: string; [k: string]: unknown };

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean };
}

export interface NewSessionParams {
  cwd: string;
  mcpServers?: unknown[];
}

/** Opaque to the relay — forwarded verbatim to the agent-host, which owns the ACP semantics. */
export type SessionUpdate = { sessionUpdate: string; [k: string]: unknown };

export interface PermissionRequest {
  sessionId: string;
  toolCallId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

/** The negotiated protocol version — bumped on any wire change; the connect handshake rejects a
 *  mismatch so an old container fails clean against a new cloud (and vice-versa). */
export const REMOTE_PROTOCOL_VERSION = 1;

export type Channel = "acp" | "exec" | "tunnel";

/** Every wire frame. `id` present on request/reply pairs; absent on one-way notifications
 *  (session_update, terminal_created, exec_chunk). */
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

/** The reply to an ACP request (`type: "ack"`, same `id`). `result` shape depends on the request:
 *  initialize → {protocolVersion}; new_session → {sessionId}; prompt → {stopReason}; cancel /
 *  kill_terminals → {}. `error` set instead when the agent failed the call. */
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
/** A permission request is a REQUEST from the agent (it blocks until the cloud replies with an
 *  `ack` carrying the user's answer): {optionId} or {cancelled:true}. */
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

/** The reply to an exec/fs request (`type: "exec_result"`, same `id`). For exec_run/spawn: the
 *  ExecResult ({stdout, stderr, exitCode}); for fs_read: {content}; for fs_write: {}. `error` set
 *  on failure. Streaming spawn output arrives as separate one-way `exec_chunk` frames (same id in
 *  a `streamId` field) terminated by `exec_exit`. */
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
/** A minimal duplex frame transport — the WS in prod, an in-memory pair in tests. RemoteAcpClient
 *  (cloud) and RemoteAgentClient (container) each hold one end. */
export interface RemoteTransport {
  /** Send one frame to the peer. Throws / no-ops if closed (the caller's request then times out). */
  send(frame: WireFrame): void;
  /** Subscribe to inbound frames from the peer. Returns an unsubscribe fn. */
  onFrame(cb: (frame: WireFrame) => void): () => void;
  /** Whether the underlying connection is currently open (drives RemoteAcpClient.isAlive()). */
  isOpen(): boolean;
  /** Notified when the connection closes (drives offline handling → RUN_ERROR, not a silent hang). */
  onClose(cb: () => void): () => void;
  /** Close the transport (bridge shutdown / unregister). */
  close(): void;
}

/** The connect handshake the container sends first (before any ACP frame): its protocol version +
 *  the owner-bound join token. The cloud verifies both before accepting into the registry. */
export interface RemoteConnectHello {
  protocolVersion: number;
  joinToken: string;
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
