/**
 * UI client — the reusable "general library" wrapping assistant-ui's native
 * AG-UI runtime, pointed at the agent-host (NOT at an LLM provider).
 *
 * The agent-host exposes the standard AG-UI HttpAgent protocol at POST /agui:
 * a RunAgentInput in, an SSE stream of AG-UI events out. So we just construct
 * an @ag-ui/client HttpAgent against it; assistant-ui's useAgUiRuntime renders
 * the events (messages, tool calls, reasoning) with no custom transport code.
 */

import { HttpAgent } from "@ag-ui/client";

export interface AgentHostConfig {
  /** Base URL of the agent-host (e.g. http://localhost:8080). */
  baseUrl: string;
  /** Auth token for the agent-host, if any. */
  token?: string;
}

/** Build an AG-UI agent bound to the agent-host's /agui endpoint. */
export function createAgentHostAgent(config: AgentHostConfig): HttpAgent {
  return new HttpAgent({
    url: `${config.baseUrl.replace(/\/$/, "")}/agui`,
    headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
  });
}

/** List existing conversations (for the sessions/history view). */
export async function listSessions(
  config: AgentHostConfig,
): Promise<Array<{ threadId: string; status: string; title?: string }>> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/sessions`, {
    headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
  });
  if (!res.ok) return [];
  return res.json();
}
