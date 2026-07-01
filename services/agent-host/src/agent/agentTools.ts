/**
 * Agent-tools MCP server — typed, reliable tools for the things the agent does
 * constantly: respond in a Slack thread, comment on a GitLab MR / GitHub PR,
 * search the web, fetch a URL. Registered alongside `modify_environment` on the
 * per-conversation MCP endpoint (see mcpServer.ts).
 *
 * WHY: the agent used to hand-run `curl -sf $BROKER_URL/slack/chat.postMessage`
 * from the sandbox — which fails silently on errors (agent retries → duplicate
 * Slack messages) and can't see Slack's `{ok:false}` (returned with HTTP 200).
 * These tools are THIN typed wrappers over the SAME broker calls, with two
 * guarantees:
 *   1. INFERRED DEFAULTS — channel/thread_ts, MR iid, PR number come from the
 *      conversation's links (store.listLinks). The agent passes only the message.
 *   2. ERRORS ARE NEVER HIDDEN — a non-2xx broker/upstream response, OR Slack's
 *      200-with-{ok:false}, maps to an MCP isError result carrying the REAL
 *      status + upstream error VERBATIM. Same error whether the agent uses the
 *      tool or the raw broker endpoint. (User requirement: the abstraction must
 *      not swallow, rewrite, or generic-ify errors.)
 *
 * Design stage: SIGNATURES + stub bodies. No real implementations.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConversationLink } from "../session/manager.js";

/** An MCP tool result (matches mcpServer.ts's ToolResult). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** The conversation context the tools resolve inferred defaults from. */
export interface ToolContext {
  conversationId: string;
  /** The conversation's links (store.listLinks) — carry the `ref` targets. */
  links(): Promise<ConversationLink[]>;
}

/** A broker HTTP call bound to a conversation's identity. Returns the raw upstream
 *  outcome so the caller can echo errors faithfully (never hide them). */
export interface BrokerClient {
  call(
    conversationId: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<BrokerResponse>;
}

export interface BrokerResponse {
  /** HTTP status from the broker/upstream. */
  status: number;
  /** Parsed JSON body when the response was JSON; else undefined. */
  data?: unknown;
  /** Raw text body (always present) — the verbatim upstream error on failure. */
  raw: string;
}

export interface AgentToolsDeps {
  broker: BrokerClient;
  /** How to fetch a URL for web_fetch / web_search (injectable for tests). */
  fetchImpl?: typeof fetch;
}

// --- The shared error-echo mapper — the load-bearing "never hide" rule ---------

/** Not-yet-implemented marker (design stage). Real bodies land in implementation. */
const NOT_IMPL = (): never => {
  throw new Error("agentTools: not implemented (design stage)");
};

/**
 * Turn a broker/upstream response into a ToolResult. A non-2xx status → isError
 * with the verbatim status + raw body. `slackOkCheck` additionally treats a
 * 200-with-`{ok:false}` (Slack's logical-failure shape) as an error, surfacing
 * Slack's `error` string. Success → the provided success text.
 */
export function toToolResult(
  _res: BrokerResponse,
  _opts: { successText: string; slackOkCheck?: boolean },
): ToolResult {
  return NOT_IMPL();
}

// --- Context inference from the conversation's links ---------------------------

/** Find the link for `source`; return its `ref`, or undefined if absent (the tool
 *  then returns a clear isError asking for an explicit target — never a guess). */
export function inferRef(
  _links: ConversationLink[],
  _source: "slack" | "gitlab" | "github",
): ConversationLink["ref"] | undefined {
  return NOT_IMPL();
}

// --- The five tool handlers (pure, testable — no MCP/HTTP plumbing) -------------

/** Post to the current Slack thread (channel + thread_ts inferred). */
export async function handleSlackRespond(
  _deps: AgentToolsDeps,
  _ctx: ToolContext,
  _args: { text: string; thread_ts?: string },
): Promise<ToolResult> {
  return NOT_IMPL();
}

/** Comment on the conversation's GitLab MR (project + iid inferred). */
export async function handleGitlabComment(
  _deps: AgentToolsDeps,
  _ctx: ToolContext,
  _args: { body: string; discussion_id?: string },
): Promise<ToolResult> {
  return NOT_IMPL();
}

/** Comment on the conversation's GitHub PR/issue (owner/repo/number inferred). */
export async function handleGithubComment(
  _deps: AgentToolsDeps,
  _ctx: ToolContext,
  _args: { body: string; in_reply_to?: number },
): Promise<ToolResult> {
  return NOT_IMPL();
}

/** DuckDuckGo Instant Answer search (free, no key). */
export async function handleWebSearch(
  _deps: AgentToolsDeps,
  _args: { query: string },
): Promise<ToolResult> {
  return NOT_IMPL();
}

/** Fetch a URL's main text content. SSRF-guarded (refuses internal/metadata IPs). */
export async function handleWebFetch(
  _deps: AgentToolsDeps,
  _args: { url: string },
): Promise<ToolResult> {
  return NOT_IMPL();
}

// --- Registration --------------------------------------------------------------

/** Register the five agent-tools on an McpServer bound to one conversation. */
export function registerAgentTools(
  _server: McpServer,
  _deps: AgentToolsDeps,
  _ctx: ToolContext,
): void {
  NOT_IMPL();
}
