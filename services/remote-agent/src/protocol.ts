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

export type Channel = "acp" | "exec";

export interface WireFrame<P = unknown> {
  ch: Channel;
  type: string;
  id?: string;
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
