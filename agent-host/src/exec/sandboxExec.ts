/**
 * SDK-backed ExecBackend — services ACP terminal/* and fs/* by calling the
 * agent-sandbox API against the session's pod.
 *
 * Design stage: interfaces only. Wraps the agent-sandbox client SDK
 * (k8s-agent-sandbox / Go-or-Python equivalent reached over the router).
 *
 * Maps:
 *   ExecBackend.run         -> agent-sandbox POST /execute
 *   ExecBackend.readTextFile -> GET /download/{path}
 *   ExecBackend.writeTextFile-> POST /upload
 *   ExecBackend.spawn        -> streamed /execute (incremental output)
 */

import type {
  ExecBackend,
  ExecRequest,
  ExecResult,
  SandboxRef,
  TerminalHandle,
} from "../types.js";

/** Thin client over the agent-sandbox router for one sandbox. */
export interface SandboxApiClient {
  execute(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;
  download(path: string): Promise<string>;
  upload(path: string, content: string): Promise<void>;
  /** Connectivity: gateway | port-forward | in-cluster | direct url. */
  readonly mode: "gateway" | "port-forward" | "in-cluster" | "direct";
}

/** Resolves a SandboxRef to a connected SandboxApiClient (via the router). */
export declare function connectSandbox(ref: SandboxRef): Promise<SandboxApiClient>;

/** Constructs an ExecBackend bound to one sandbox. */
export declare function createSandboxExecBackend(api: SandboxApiClient): ExecBackend;

// Re-export the shared types referenced above for convenience.
export type { ExecBackend, ExecRequest, ExecResult, TerminalHandle, SandboxRef };
