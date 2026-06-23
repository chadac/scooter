/**
 * ACP client — speaks JSON-RPC 2.0 over stdio to a `goose acp` subprocess.
 *
 * Design stage: interfaces only. The agent-host is the ACP *client*; Goose is
 * the ACP *agent*. We call agent methods; Goose calls our client methods
 * (which we service via the ExecBackend / permission UI).
 *
 * Spec: https://agentclientprotocol.com  (camelCase props, snake_case discriminators)
 */

import type { ExecBackend } from "../types.js";

// --- Agent methods we invoke (host -> agent) --------------------------------

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: ClientCapabilities;
}

export interface ClientCapabilities {
  /** We service fs/read_text_file + fs/write_text_file. */
  fs: { readTextFile: boolean; writeTextFile: boolean };
  /** We service terminal/* methods. */
  terminal: boolean;
}

export interface NewSessionParams {
  cwd: string;
  /** MCP servers / builtins to advertise, if any. */
  mcpServers?: unknown[];
}

export interface PromptParams {
  sessionId: string;
  /** Content blocks (text, resource links, etc.). */
  prompt: ContentBlock[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string };

// --- Agent notifications we receive (agent -> host) -------------------------

export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "tool_call"; toolCallId: string; title: string; rawInput?: unknown }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; status: string; content?: unknown }
  | { sessionUpdate: "plan"; entries: unknown[] }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock };

// --- Client methods Goose invokes on us (agent -> host) ---------------------

export interface PermissionRequest {
  sessionId: string;
  toolCallId: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

/**
 * The ACP transport + session. One AcpClient drives one Goose process.
 *
 * Client methods (fs/*, terminal/*) are routed to `exec`; permission requests
 * are surfaced via onPermissionRequest for the UI to answer.
 */
export interface AcpClient {
  initialize(params: InitializeParams): Promise<{ protocolVersion: number }>;
  newSession(params: NewSessionParams): Promise<{ sessionId: string }>;
  prompt(params: PromptParams): Promise<{ stopReason: string }>;
  cancel(sessionId: string): Promise<void>;

  /** Subscribe to streamed session/update notifications. */
  onSessionUpdate(cb: (sessionId: string, update: SessionUpdate) => void): () => void;

  /** Called when Goose requests permission for a tool call. */
  onPermissionRequest(
    handler: (req: PermissionRequest) => Promise<{ optionId: string }>,
  ): void;

  /** Terminate the underlying process. */
  close(): Promise<void>;
}

export interface AcpClientDeps {
  /** Spawned `goose acp` process I/O is wired here. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Services Goose's fs/* and terminal/* client-method calls. */
  exec: ExecBackend;
}

/** Spawns `goose acp` and returns a connected ACP client. */
export declare function createAcpClient(deps: AcpClientDeps): Promise<AcpClient>;
