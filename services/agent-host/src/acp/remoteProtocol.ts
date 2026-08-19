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

import type {
  ContentBlock,
  InitializeParams,
  NewSessionParams,
  PermissionRequest,
  SessionUpdate,
} from "./client.js";

/** The negotiated protocol version — bumped on any wire change; the connect handshake rejects a
 *  mismatch so an old container fails clean against a new cloud (and vice-versa). */
export const REMOTE_PROTOCOL_VERSION = 1;

export type Channel = "acp" | "exec";

/** Every wire frame. `id` present on request/reply pairs; absent on one-way notifications
 *  (session_update, terminal_created, exec_chunk). */
export interface WireFrame<P = unknown> {
  ch: Channel;
  type: string;
  id?: string;
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
