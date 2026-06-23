/**
 * Shared types for the agent-host.
 *
 * The agent-host runs OUTSIDE the sandbox. Per conversation it spawns a
 * `goose acp` process and bridges three boundaries:
 *   - ACP (JSON-RPC/stdio) to Goose                            -> ./acp/
 *   - AG-UI (streaming events) to the browser                  -> ./agui/
 *   - exec: the agent's terminal/* + fs/* actions are serviced -> ./exec/
 *     by running commands in the session's pod via the K8s exec API
 *
 * The sandbox image itself is a plain generic Nix image (no in-pod server); it
 * does NOT contain Goose or this host.
 */

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
}

// ---------------------------------------------------------------------------
// Exec backend — ACP terminal/* and fs/* are serviced by calling the
// agent-sandbox API (/execute, /upload, /download) against the session's pod.
// (Decision: SDK-backed remote exec, NOT local OS. The agent runs outside.)
// ---------------------------------------------------------------------------

export interface ExecRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Executes the agent's tool actions in the remote sandbox pod via the
 * agent-sandbox client SDK. One ExecBackend is bound to one SandboxRef.
 */
export interface ExecBackend {
  /** agent-sandbox: POST /execute */
  run(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;

  /** Streaming variant for ACP terminal/* (incremental output). */
  spawn(req: ExecRequest): TerminalHandle;

  /** agent-sandbox: GET /download/{path} */
  readTextFile(path: string): Promise<string>;
  /** agent-sandbox: POST /upload */
  writeTextFile(path: string, content: string): Promise<void>;
}

export interface TerminalHandle {
  readonly id: string;
  onOutput(cb: (chunk: string) => void): void;
  waitForExit(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
  release(): Promise<void>;
}

/** Constructs an ExecBackend bound to a sandbox (agent-sandbox SDK impl). */
export declare function createSandboxExecBackend(ref: SandboxRef): ExecBackend;
