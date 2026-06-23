/**
 * ACP <-> AG-UI bridge — the core of the agent-host.
 *
 * Design stage: interfaces only. Implementation maps ACP session/update
 * notifications to AG-UI events (see docs/DESIGN.md §4c) and routes ACP
 * client methods (terminal/*, fs/*, session/request_permission) to the
 * ExecBackend (agent-sandbox SDK) / permission UI.
 *
 * Note: this interface is UNCHANGED by the agent-outside inversion — only the
 * ExecBackend implementation flipped (local-OS -> agent-sandbox SDK), a sign
 * the seam is in the right place.
 */

import type {
  SessionId,
  RunId,
  SessionConfig,
  ExecBackend,
} from "./types.js";

// AG-UI event union (subset used here; full set per AG-UI spec).
export type AguiEvent =
  | { type: "RUN_STARTED"; threadId: ThreadId; runId: RunId }
  | { type: "RUN_FINISHED"; runId: RunId; result?: unknown }
  | { type: "RUN_ERROR"; message: string; code?: string }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string }
  | { type: "TOOL_CALL_RESULT"; toolCallId: string; messageId: string; content: string }
  | { type: "REASONING_START"; messageId: string }
  | { type: "REASONING_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "REASONING_END"; messageId: string };

import type { ThreadId } from "./types.js";

/** A user prompt entering the run (maps to ACP session/prompt). */
export interface PromptInput {
  threadId: ThreadId;
  text: string;
}

/**
 * Drives one ACP session and emits AG-UI events.
 *
 * Lifecycle:
 *   start()    -> spawn agent, ACP initialize + session/new
 *   prompt()   -> ACP session/prompt, stream AG-UI events via onEvent
 *   cancel()   -> ACP session/cancel
 *   stop()     -> tear down agent process
 */
export interface SessionBridge {
  readonly sessionId: SessionId;

  start(): Promise<void>;
  prompt(input: PromptInput): Promise<RunId>;
  cancel(runId: RunId): Promise<void>;
  stop(): Promise<void>;

  /** Subscribe to the AG-UI event stream for this session. */
  onEvent(cb: (event: AguiEvent) => void): () => void;
}

export interface BridgeDeps {
  config: SessionConfig;
  exec: ExecBackend;
}

/** Factory — constructs a SessionBridge from its dependencies. */
export declare function createSessionBridge(deps: BridgeDeps): SessionBridge;
