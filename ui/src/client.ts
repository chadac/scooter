/**
 * UI client — the reusable "general library" wrapping assistant-ui's native
 * AG-UI runtime, pointed at the agent-host (NOT at an LLM provider).
 *
 * Design stage: interfaces only. The AG-UI stream originates in the agent-host
 * and arrives here directly (SSE/WS), so this is a thin transport + runtime
 * adapter; assistant-ui renders the events (messages, tool calls, reasoning).
 */

export interface AgentHostClientConfig {
  /** Base URL of the agent-host AG-UI server. */
  baseUrl: string;
  /** Auth token for the agent-host, if any. */
  token?: string;
}

export interface ConversationHandle {
  readonly threadId: string;
  /** Submit a user prompt (POST /sessions/:id/prompt). */
  send(text: string): Promise<void>;
  /** Answer a pending tool-permission request. */
  approve(toolCallId: string, optionId: string): Promise<void>;
  suspend(): Promise<void>;
  /** Subscribe to the AG-UI event stream (drives assistant-ui). */
  subscribe(): EventSource | WebSocket;
}

export interface AgentHostClient {
  /** Start a new conversation. */
  start(): Promise<ConversationHandle>;
  /** Re-attach to an existing conversation (replays the event log). */
  attach(threadId: string): Promise<ConversationHandle>;
  /** List conversations (for history/logs view). */
  list(): Promise<Array<{ threadId: string; status: string; title?: string }>>;
}

export declare function createAgentHostClient(config: AgentHostClientConfig): AgentHostClient;

/**
 * Build an assistant-ui runtime from a ConversationHandle.
 * (Wraps assistant-ui's AG-UI runtime; implementation at impl stage.)
 */
export declare function useAgentSandboxRuntime(handle: ConversationHandle): unknown;
