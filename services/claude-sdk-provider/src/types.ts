/**
 * The interface boundary between this isolated package and the agent-host.
 *
 * This package bundles the Claude Agent SDK (which peer-requires zod v4) and
 * exposes ONLY `createSdkAcpClient` returning an `AcpClient`. To keep the SDK's
 * zod v4 from colliding with the agent-host's zod v3, nothing here imports from
 * agent-host's src. Instead we redeclare the small, stable contract types the two
 * sides share — `AcpClient`, `ExecBackend`, `SessionUpdate`, `ContentBlock`, etc.
 * They are STRUCTURALLY identical to agent-host's (services/agent-host/src/acp/
 * client.ts + types.ts), so agent-host consumes the return value as its own
 * AcpClient with no adapter. If agent-host's interface changes, mirror it here.
 */

// --- content + session-update contract (mirror of acp/client.ts) --------------

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string }
  | { type: "image"; data: string; mimeType: string };

export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | { sessionUpdate: "tool_call"; toolCallId: string; title: string; rawInput?: unknown }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; status: string; content?: unknown; rawInput?: unknown; rawOutput?: unknown }
  | { sessionUpdate: "plan"; entries: unknown[] }
  // Context-window fill after a turn — usedTokens / contextWindow (both absolute), so
  // the UI can show a fill bar. Rides the SDK `result` message's modelUsage.
  | { sessionUpdate: "context_usage"; usedTokens: number; contextWindow: number };

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean };
}
export interface NewSessionParams {
  cwd: string;
  mcpServers?: unknown[];
}
export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}
export interface PermissionRequest {
  sessionId: string;
  toolCallId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}
export type PermissionAnswer = { optionId: string } | { cancelled: true };

export interface AcpClient {
  initialize(params: InitializeParams): Promise<{ protocolVersion: number }>;
  newSession(params: NewSessionParams): Promise<{ sessionId: string }>;
  prompt(params: PromptParams): Promise<{ stopReason: string }>;
  cancel(sessionId: string): Promise<void>;
  killActiveTerminals(): Promise<void>;
  onSessionUpdate(cb: (sessionId: string, update: SessionUpdate) => void): () => void;
  onTerminalCreated(cb: (terminalId: string, command: string, args: string[]) => void): () => void;
  onPermissionRequest(handler: (req: PermissionRequest) => Promise<PermissionAnswer>): void;
  close(): Promise<void>;
}

// --- exec contract (mirror of types.ts ExecBackend) ---------------------------

export interface ExecRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface TerminalHandle {
  readonly id: string;
  onOutput(cb: (chunk: string) => void): void;
  waitForExit(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
  release(): Promise<void>;
}
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface ExecBackend {
  run(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;
  spawn(req: ExecRequest): TerminalHandle;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
}
