/**
 * AG-UI server — streams AG-UI events from the agent-host to the browser.
 *
 * Design stage: interfaces only. Transport (SSE vs WS) is an open item; the
 * interface is transport-neutral. assistant-ui's native AG-UI runtime consumes
 * these events on the browser side.
 */

import type { AguiEvent } from "../bridge.js";
import type { SessionId, ThreadId } from "../types.js";

/** A user prompt arriving from the UI (AG-UI RunAgentInput, subset). */
export interface RunAgentInput {
  threadId: ThreadId;
  /** New user message text for this run. */
  text: string;
}

/** One connected UI client subscribed to a session's event stream. */
export interface AguiConnection {
  readonly sessionId: SessionId;
  send(event: AguiEvent): void;
  close(): void;
}

/**
 * HTTP/WS surface for the UI. Routes:
 *   POST /sessions                      -> create/attach a conversation
 *   POST /sessions/:id/prompt           -> submit a RunAgentInput
 *   GET  /sessions/:id/events           -> subscribe (SSE) OR upgrade (WS)
 *   POST /sessions/:id/permission/:tcid -> answer a permission request
 *   POST /sessions/:id/suspend|resume   -> lifecycle
 */
export interface AguiServer {
  listen(port: number): Promise<void>;
  close(): Promise<void>;

  /** Wired by the session manager to handle inbound prompts. */
  onPrompt(handler: (sessionId: SessionId, input: RunAgentInput) => Promise<void>): void;

  /** Push an event to all connections subscribed to a session. */
  broadcast(sessionId: SessionId, event: AguiEvent): void;

  /** Replay the persisted event log to a newly-attached connection. */
  onAttach(handler: (sessionId: SessionId, conn: AguiConnection) => Promise<void>): void;
}

export declare function createAguiServer(): AguiServer;
