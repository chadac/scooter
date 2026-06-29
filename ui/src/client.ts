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

/** A conversation as the management API returns it (GET /conversations). */
export interface ConversationView {
  id: string;
  threadId: string;
  title: string;
  status: string;
  createdAt: number;
  lastActivityAt: number;
  /** The conversation's model (undefined = host default). */
  model?: string;
  /** Distinct providers this conversation links to ("github"|"slack"|…), for a
   *  per-row icon in the sidebar. [] when it has no linked resources. */
  sources?: string[];
}

/** The model catalog (GET /models): the default + the offered models. */
export interface ModelCatalog {
  default: string | null;
  available: string[];
}

/** Fetch the offered models. Returns an empty catalog if the server is
 *  unreachable or has none configured (the picker then hides itself). */
export async function loadModels(config: AgentHostConfig): Promise<ModelCatalog> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
    });
    if (!res.ok) return { default: null, available: [] };
    return (await res.json()) as ModelCatalog;
  } catch {
    return { default: null, available: [] };
  }
}

/** An external resource a conversation is linked to (GET /conversations/:id/links). */
export interface ConversationLink {
  source: string;       // "github" | "gitlab" | "slack" | "jira" | …
  resourceType: string; // "pull_request" | "issue" | "thread" | …
  url?: string;
  title?: string;
}

/** Load a conversation's external resource links (the PR/issue/thread it came
 *  from) for the linked-resources panel. */
export async function loadLinks(
  config: AgentHostConfig,
  conversationId: string,
): Promise<ConversationLink[]> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/links`,
      { headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
    );
    if (!res.ok) return [];
    return ((await res.json()) as { links?: ConversationLink[] }).links ?? [];
  } catch {
    return [];
  }
}

/**
 * Load ALL conversations from the agent-host so the sidebar survives a page
 * refresh and every conversation is listed/searchable (not just the ones this
 * browser tab created in memory).
 */
export async function loadConversations(config: AgentHostConfig): Promise<ConversationView[]> {
  return (await loadConversationsResult(config)).conversations;
}

/**
 * Like loadConversations, but reports whether the server was REACHABLE — so a
 * caller can distinguish "the agent-host is down/restarting" (ok=false) from
 * "the server is up and genuinely has no conversations" (ok=true, []). The
 * initial-load retry uses this to keep retrying only while the server is down.
 */
export async function loadConversationsResult(
  config: AgentHostConfig,
): Promise<{ ok: boolean; conversations: ConversationView[] }> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/conversations`, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
    });
    if (!res.ok) return { ok: false, conversations: [] };
    return { ok: true, conversations: (await res.json()) as ConversationView[] };
  } catch {
    return { ok: false, conversations: [] };
  }
}

/** A minimal AG-UI message (what HttpAgent.initialMessages expects). */
export interface AguiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Load a conversation's history as AG-UI messages, so switching to (or reviving)
 * it shows its prior turns. The agent-host stores the conversation as a stream
 * of AG-UI events; fold the TEXT_MESSAGE_* events back into one message per
 * messageId (tool/reasoning events are rendered live, not replayed as text).
 */
export async function loadHistory(
  config: AgentHostConfig,
  conversationId: string,
): Promise<AguiMessage[]> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(
    conversationId,
  )}/history`;
  let events: Array<Record<string, unknown>>;
  try {
    const res = await fetch(url, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { events?: Array<Record<string, unknown>> };
    events = body.events ?? [];
  } catch {
    return [];
  }

  // Fold TEXT_MESSAGE_START -> CONTENT* -> END into one message per id, in order.
  const order: string[] = [];
  const byId = new Map<string, AguiMessage>();
  for (const e of events) {
    const id = e.messageId as string | undefined;
    switch (e.type) {
      case "TEXT_MESSAGE_START": {
        if (!id) break;
        const role = (e.role as AguiMessage["role"]) ?? "assistant";
        if (!byId.has(id)) {
          byId.set(id, { id, role, content: "" });
          order.push(id);
        }
        break;
      }
      case "TEXT_MESSAGE_CONTENT": {
        if (!id) break;
        const m = byId.get(id);
        if (m) m.content += (e.delta as string) ?? "";
        break;
      }
      // TEXT_MESSAGE_END / tool / reasoning events need no folding here.
      default:
        break;
    }
  }
  return order.map((id) => byId.get(id)!).filter((m) => m.content.trim() !== "");
}
