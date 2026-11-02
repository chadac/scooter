/**
 * The interface boundary between this isolated package and the agent-host. Nothing
 * here imports from agent-host's src (the SDK's zod v4 must not collide with
 * agent-host's zod v3); the contract types are redeclared structurally identical to
 * services/agent-host/src/acp/client.ts and types.ts, and must be mirrored when
 * those change.
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
  // Context-window fill after a turn, both values absolute, for the UI's fill bar.
  | { sessionUpdate: "context_usage"; usedTokens: number; contextWindow: number };

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean };
}
export interface NewSessionParams {
  cwd: string;
  mcpServers?: unknown[];
  /** Agent tools that block on the user's answer, by tool name. */
  blockingTools?: Record<string, BlockingTool>;
}
/** One tool that waits on the user: its input is sent as a request of `kind`. */
export interface BlockingTool {
  kind: string;
  /** The request's heading. */
  title: string;
  /** What the model is told when the user dismisses it. */
  dismissed: string;
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
  /** Set when the agent asks for input a contrib renders rather than a plain choice. */
  request?: { kind: string; data: unknown };
}
/** `result` is the user's answer to a contrib-rendered request. */
export type PermissionAnswer = { optionId: string; result?: Record<string, unknown> } | { cancelled: true };

export interface AcpClient {
  initialize(params: InitializeParams): Promise<{ protocolVersion: number }>;
  newSession(params: NewSessionParams): Promise<{ sessionId: string }>;
  prompt(params: PromptParams): Promise<{ stopReason: string }>;
  cancel(sessionId: string): Promise<void>;
  killActiveTerminals(): Promise<void>;
  /** Liveness of the underlying agent, probed by the bridge's stall watchdog. */
  isAlive(): boolean;
  /** Recent diagnostic lines (oldest first), which the dead-on-arrival watchdog quotes. */
  recentDiagnostics(): string[];
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
  /** Per-command deadline for `spawn`, overriding the backend default. */
  timeoutMs?: number;
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

// --- tool hooks (the agent-host's, fired from the SDK's own) ---

/** A PreToolUse answer: `deny` refuses the call, `updatedInput` rewrites it. */
export interface PreToolHookResult {
  deny?: string;
  updatedInput?: Record<string, unknown>;
  context?: string;
}
/** Both fields reach the model with the tool result. */
export interface PostToolHookResult {
  block?: string;
  context?: string;
}
export interface ToolHooks {
  pre(toolName: string, toolInput: unknown, toolUseId: string | undefined): Promise<PreToolHookResult>;
  post(toolName: string, toolInput: unknown, toolResponse: unknown, toolUseId: string | undefined): Promise<PostToolHookResult>;
}
