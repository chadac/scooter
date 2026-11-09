/**
 * Shared types for the agent-host, which runs outside the sandbox and per
 * conversation bridges ACP to the agent (./acp/), AG-UI to the browser (./agui/),
 * and the agent's terminal/* and fs/* actions to the session's pod via the K8s exec
 * API (./exec/). The sandbox image contains neither the agent nor this host.
 */

import type { BlockingTool } from "./acp/client.js";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type SessionId = string;
export type RunId = string;
export type ThreadId = string;

export interface SessionConfig {
  /** Working directory inside the sandbox pod (agent's cwd). */
  cwd: string;
  /** Directory of injected skill files (markdown), loaded as agent context. */
  skillsDir: string;
  /** Model/provider config passed through to the agent (env/flags). */
  agent: AgentLaunchConfig;
  /** How to reach the session's sandbox pod for exec. */
  sandbox: SandboxRef;
  /** MCP servers offered to the agent on newSession, passed through ACP. */
  mcpServers?: unknown[];
  /** Display name the agent goes by, needed to build the prompt a BYO container is sent. */
  agentName?: string;
  /** Agent tools that block on the user's answer, offered to the provider on newSession. */
  blockingTools?: Record<string, BlockingTool>;
}

export interface AgentLaunchConfig {
  /** Executable + args to start the ACP agent server over stdio. */
  command: string; // e.g. "goose"
  args: string[]; // e.g. ["acp", "--with-builtin", "developer"]
  /** Extra env for the agent process (model keys, etc.). */
  env: Record<string, string>;
}

/** Identifies the agent-sandbox sandbox a session executes in. */
export interface SandboxRef {
  /** SandboxClaim / Sandbox name. */
  name: string;
  namespace: string;
  /** The ready pod's IP when known, which changes across suspend/resume, so re-fetch it on revive rather than cache it. */
  podIP?: string;
}

// ---------------------------------------------------------------------------
// Exec backend: ACP terminal/* and fs/* are serviced by running commands in the session's pod.
// ---------------------------------------------------------------------------

export interface ExecRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Fed on stdin, so large input avoids the argv limit. */
  stdin?: string;
  /** Per-command deadline for `spawn`, overriding the backend default. */
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Executes the agent's tool actions in the remote sandbox pod; one ExecBackend is bound to one SandboxRef. */
export interface ExecBackend {
  /** Run a command and collect its output. */
  run(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;

  /** Streaming variant for ACP terminal/*. */
  spawn(req: ExecRequest): TerminalHandle;

  /** Read a text file from the sandbox. */
  readTextFile(path: string): Promise<string>;
  /** Write a text file into the sandbox. */
  writeTextFile(path: string, content: string): Promise<void>;
  /** Write raw bytes (base64) to a file in the sandbox, creating parent dirs, streamed over stdin so the single-argv limit does not apply. */
  writeBinaryFile(path: string, base64: string): Promise<void>;
  /** Queue a binary write that every later call waits for; resolves when it lands. */
  writeBinaryFileLater?(path: string, base64: string): Promise<void>;
}

export interface TerminalHandle {
  readonly id: string;
  onOutput(cb: (chunk: string) => void): void;
  waitForExit(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
  release(): Promise<void>;
}

/** Constructs an ExecBackend bound to a sandbox. */
export declare function createSandboxExecBackend(ref: SandboxRef): ExecBackend;
