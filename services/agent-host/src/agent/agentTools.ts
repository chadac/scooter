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
 */

import { z } from "zod";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConversationLink } from "../session/manager.js";

/** An MCP tool result (matches mcpServer.ts's ToolResult). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** The external resource a conversation maps to, as recorded by the webhooks
 *  service in Postgres (conversation_map). The FALLBACK source of the target when
 *  a conversation's link has no structured `ref` (e.g. it was created before ref
 *  existed). `resourceId` is source-specific:
 *    slack:  "<channel>:<thread_ts>"
 *    github: "<owner>/<repo>#<number>"
 *    gitlab: "<repo>!<iid>" (MR) or "<repo>#<iid>" (issue) */
export interface ResourceMapping {
  source: string;
  resourceType: string;
  resourceId: string;
  /** Slack keeps the channel/ts as their own columns too — prefer these if set. */
  slackChannel?: string;
  slackTs?: string;
}

/** The conversation context the tools resolve inferred defaults from. */
export interface ToolContext {
  conversationId: string;
  /** The conversation's links (store.listLinks) — carry the `ref` targets. */
  links(): Promise<ConversationLink[]>;
  /** FALLBACK: the webhooks Postgres conversation_map row for this conversation,
   *  used to discover the target when the link has no `ref`. undefined when no DB
   *  is wired (then the tools rely on `ref` alone). Returns undefined if the
   *  conversation isn't mapped (a genuinely non-webhook conversation). */
  resourceLookup?(source: "slack" | "gitlab" | "github" | "jira"): Promise<ResourceMapping | undefined>;
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

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

/**
 * Turn a broker/upstream response into a ToolResult. A non-2xx status → isError
 * with the verbatim status + raw body. `slackOkCheck` additionally treats a
 * 200-with-`{ok:false}` (Slack's logical-failure shape) as an error, surfacing
 * Slack's `error` string. Success → the provided success text.
 *
 * This is the single place the "never hide an error" rule is enforced: the REAL
 * status + upstream body are surfaced verbatim, so the agent sees the same error
 * it would from the raw broker endpoint.
 */
export function toToolResult(
  res: BrokerResponse,
  opts: { successText: string; slackOkCheck?: boolean; idempotentErrors?: string[] },
): ToolResult {
  if (res.status < 200 || res.status >= 300) {
    return err(`Request FAILED (HTTP ${res.status}). The service returned:\n${res.raw}`);
  }
  if (opts.slackOkCheck) {
    // Slack returns HTTP 200 even on logical failure: {ok:false, error:"..."}.
    const data = res.data as { ok?: boolean; error?: string } | undefined;
    if (data && data.ok === false) {
      // Some Slack errors mean "the desired state already exists" — treat them as
      // SUCCESS, not failure. e.g. reacting with an emoji the message already has
      // (`already_reacted`) is a no-op that achieved the goal. Without this, the
      // webhooks handler's pre-dispatch 👀 reaction makes the agent's own ack-react
      // always fail (see the slack-react-already-reacted bug report).
      if (data.error && opts.idempotentErrors?.includes(data.error)) {
        return ok(`${opts.successText} (already done — ${data.error}.)`);
      }
      return err(`Slack rejected the request: ${data.error ?? "unknown error"}\nFull response:\n${res.raw}`);
    }
  }
  return ok(opts.successText);
}

// --- Context inference from the conversation's links ---------------------------

/** Find the link for `source`; return its `ref`, or undefined if absent (the tool
 *  then returns a clear isError asking for an explicit target — never a guess). */
export function inferRef(
  links: ConversationLink[],
  source: "slack" | "gitlab" | "github" | "jira",
): ConversationLink["ref"] | undefined {
  return links.find((l) => l.source === source)?.ref;
}

// --- The five tool handlers (pure, testable — no MCP/HTTP plumbing) -------------

// Parse the webhooks conversation_map `resource_id` (the fallback target source)
// per provider. Formats mirror the webhooks handlers' _resource_id().

/** slack: "<channel>:<thread_ts>". */
function parseSlackResourceId(resourceId: string): { channel?: string; threadTs?: string } {
  const i = resourceId.lastIndexOf(":");
  if (i <= 0) return {};
  return { channel: resourceId.slice(0, i), threadTs: resourceId.slice(i + 1) };
}

/** github: "<owner>/<repo>#<number>". */
function parseGithubResourceId(resourceId: string): { owner?: string; repo?: string; number?: number } {
  const m = resourceId.match(/^([^/]+)\/(.+)#(\d+)$/);
  if (!m) return {};
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** gitlab: "<repo>!<iid>" (MR) or "<repo>#<iid>" (issue). `repo` is the project
 *  PATH — GitLab's API accepts a URL-encoded path in place of the numeric id, so
 *  we return it as `projectId`. `isMr` distinguishes the endpoint. */
function parseGitlabResourceId(resourceId: string): { projectId?: string; iid?: string; isMr?: boolean } {
  const mr = resourceId.match(/^(.+)!(\d+)$/);
  if (mr) return { projectId: mr[1], iid: mr[2], isMr: true };
  const issue = resourceId.match(/^(.+)#(\d+)$/);
  if (issue) return { projectId: issue[1], iid: issue[2], isMr: false };
  return {};
}

/** Post to the current Slack thread (channel + thread_ts inferred). */
export async function handleSlackRespond(
  deps: AgentToolsDeps,
  ctx: ToolContext,
  args: { text: string; thread_ts?: string },
): Promise<ToolResult> {
  // Prefer the link's structured `ref`; if it's missing (e.g. a conversation
  // created before `ref` existed), FALL BACK to the webhooks conversation_map in
  // Postgres before failing — the channel/thread_ts are recorded there for every
  // Slack conversation (as slack_channel/slack_ts columns and in resource_id
  // "<channel>:<thread_ts>"). This is additive: ref wins when present.
  const ref = inferRef(await ctx.links(), "slack");
  let channel = ref?.channel;
  let threadTs = args.thread_ts ?? ref?.threadTs;
  if (!channel) {
    const m = await ctx.resourceLookup?.("slack");
    if (m) {
      const parsed = parseSlackResourceId(m.resourceId);
      channel = m.slackChannel ?? parsed.channel;
      threadTs = args.thread_ts ?? m.slackTs ?? parsed.threadTs;
    }
  }
  if (!channel) {
    return err(
      "Could not determine the Slack channel for this conversation — it has no slack " +
        "link with a channel, and no Slack mapping was found in the webhooks store. " +
        "If you know the channel, pass it to the broker directly.",
    );
  }
  const res = await deps.broker.call(ctx.conversationId, "POST", "/slack/chat.postMessage", {
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: args.text,
  });
  return toToolResult(res, { successText: "Posted to the Slack thread.", slackOkCheck: true });
}

/** React to a Slack message with an emoji (channel inferred; defaults to the
 *  triggering message = the thread anchor ts). Same channel/thread resolution as
 *  slack_respond. `emoji` is the reaction name WITHOUT colons (e.g. "eyes"). */
export async function handleSlackReact(
  deps: AgentToolsDeps,
  ctx: ToolContext,
  args: { emoji: string; timestamp?: string },
): Promise<ToolResult> {
  const ref = inferRef(await ctx.links(), "slack");
  let channel = ref?.channel;
  let ts = args.timestamp ?? ref?.threadTs;
  if (!channel) {
    const m = await ctx.resourceLookup?.("slack");
    if (m) {
      const parsed = parseSlackResourceId(m.resourceId);
      channel = m.slackChannel ?? parsed.channel;
      ts = args.timestamp ?? m.slackTs ?? parsed.threadTs;
    }
  }
  if (!channel || !ts) {
    return err(
      "Could not determine the Slack channel + message to react to — this " +
        "conversation has no slack link with a channel/timestamp, and no Slack " +
        "mapping was found in the webhooks store. Pass the message `timestamp` " +
        "explicitly if you know it.",
    );
  }
  // Slack's reactions.add wants the emoji name WITHOUT the surrounding colons.
  const name = args.emoji.replace(/:/g, "").trim();
  const res = await deps.broker.call(ctx.conversationId, "POST", "/slack/reactions.add", {
    channel,
    timestamp: ts,
    name,
  });
  // `already_reacted` = the emoji is already on the message → the goal is met. The
  // webhooks handler adds 👀 pre-dispatch, so the agent's own ack-react hits this
  // constantly; treat it as success, not a (noisy, wasted-turn) error.
  return toToolResult(res, {
    successText: `Reacted with :${name}:.`,
    slackOkCheck: true,
    idempotentErrors: ["already_reacted"],
  });
}

/** Comment on the conversation's GitLab MR/issue (project + iid inferred). */
export async function handleGitlabComment(
  deps: AgentToolsDeps,
  ctx: ToolContext,
  args: { body: string; discussion_id?: string },
): Promise<ToolResult> {
  // Prefer the link `ref`; fall back to the webhooks conversation_map (resource_id
  // "<repo>!<iid>" MR / "<repo>#<iid>" issue — repo is the project path, which the
  // GitLab API accepts URL-encoded as the project id). ref wins when present.
  const ref = inferRef(await ctx.links(), "gitlab");
  let projectId = ref?.projectId;
  let iid: string | undefined = ref?.mrIid;
  let isMr = true;
  if (!projectId || !iid) {
    const m = await ctx.resourceLookup?.("gitlab");
    if (m) {
      const p = parseGitlabResourceId(m.resourceId);
      projectId = projectId ?? p.projectId;
      iid = iid ?? p.iid;
      isMr = p.isMr ?? true;
    }
  }
  if (!projectId || !iid) {
    return err(
      "Could not determine the GitLab MR/issue for this conversation — it has no " +
        "gitlab link with a project + iid, and no GitLab mapping was found in the " +
        "webhooks store. Pass the project + iid explicitly, or use the broker directly.",
    );
  }
  const kind = isMr ? "merge_requests" : "issues";
  const base = `/gitlab/projects/${encodeURIComponent(projectId)}/${kind}/${iid}`;
  const path = args.discussion_id
    ? `${base}/discussions/${encodeURIComponent(args.discussion_id)}/notes`
    : `${base}/notes`;
  const res = await deps.broker.call(ctx.conversationId, "POST", path, { body: args.body });
  return toToolResult(res, { successText: `Commented on the GitLab ${isMr ? "MR" : "issue"}.` });
}

/** Comment on the conversation's GitHub PR/issue (owner/repo/number inferred). */
export async function handleGithubComment(
  deps: AgentToolsDeps,
  ctx: ToolContext,
  args: { body: string; in_reply_to?: number },
): Promise<ToolResult> {
  // Prefer the link `ref`; fall back to the webhooks conversation_map (resource_id
  // "<owner>/<repo>#<number>"). ref wins when present.
  const ref = inferRef(await ctx.links(), "github");
  let owner = ref?.owner;
  let repo = ref?.repo;
  let number: number | undefined = ref?.number;
  if (!owner || !repo || number == null) {
    const m = await ctx.resourceLookup?.("github");
    if (m) {
      const p = parseGithubResourceId(m.resourceId);
      owner = owner ?? p.owner;
      repo = repo ?? p.repo;
      number = number ?? p.number;
    }
  }
  if (!owner || !repo || number == null) {
    return err(
      "Could not determine the GitHub PR/issue for this conversation — it has no " +
        "github link with owner/repo/number, and no GitHub mapping was found in the " +
        "webhooks store. Pass owner/repo/number explicitly, or use the broker directly.",
    );
  }
  // A review-comment reply uses a different endpoint; a plain comment posts to the
  // issue/PR comments. Default = a new issue comment.
  const path = args.in_reply_to
    ? `/github/repos/${owner}/${repo}/pulls/${number}/comments/${args.in_reply_to}/replies`
    : `/github/repos/${owner}/${repo}/issues/${number}/comments`;
  const res = await deps.broker.call(ctx.conversationId, "POST", path, { body: args.body });
  return toToolResult(res, { successText: "Commented on the GitHub PR/issue." });
}

/** Comment on the conversation's Jira issue (issue key inferred). */
export async function handleJiraComment(
  deps: AgentToolsDeps,
  ctx: ToolContext,
  args: { body: string },
): Promise<ToolResult> {
  // Prefer the link `ref`; fall back to the webhooks conversation_map (resource_id
  // IS the issue key for jira). ref wins when present.
  const ref = inferRef(await ctx.links(), "jira");
  let issueKey = ref?.issueKey;
  if (!issueKey) {
    const m = await ctx.resourceLookup?.("jira");
    if (m?.resourceId) issueKey = m.resourceId;
  }
  if (!issueKey) {
    return err(
      "Could not determine the Jira issue for this conversation — it has no jira " +
        "link with an issue key, and no Jira mapping was found in the webhooks store. " +
        "Pass the issue key explicitly, or use the broker directly.",
    );
  }
  // Jira Cloud REST v2 accepts a plain-text `body` (v3 requires ADF); the broker
  // proxies to /ex/jira/{cloud_id}, so the path is /jira/rest/api/2/....
  const path = `/jira/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`;
  const res = await deps.broker.call(ctx.conversationId, "POST", path, { body: args.body });
  return toToolResult(res, { successText: "Commented on the Jira issue." });
}

/**
 * DuckDuckGo Instant Answer search (free, no key). Runs straight from the
 * agent-host (no per-conversation identity needed). Returns the abstract +
 * related topics; errors echoed.
 */
export async function handleWebSearch(
  deps: AgentToolsDeps,
  args: { query: string },
): Promise<ToolResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1&no_redirect=1`;
  let res: Response;
  try {
    res = await doFetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return err(`web_search failed to reach DuckDuckGo: ${(e as Error).message}`);
  }
  if (!res.ok) return err(`web_search FAILED (HTTP ${res.status}) from DuckDuckGo.`);
  const data = (await res.json().catch(() => ({}))) as {
    Heading?: string;
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
  };
  const lines: string[] = [];
  if (data.AbstractText) lines.push(`${data.Heading ?? ""}: ${data.AbstractText} (${data.AbstractURL ?? ""})`.trim());
  for (const t of (data.RelatedTopics ?? []).slice(0, 8)) {
    if (t.Text && t.FirstURL) lines.push(`- ${t.Text} (${t.FirstURL})`);
  }
  if (lines.length === 0) {
    return ok(`No instant answer for "${args.query}". (DuckDuckGo's IA API returns definitions/abstracts, not full web results.)`);
  }
  return ok(lines.join("\n"));
}

/** Fetch a URL's main text content. SSRF-guarded (refuses internal/metadata IPs). */
export async function handleWebFetch(
  deps: AgentToolsDeps,
  args: { url: string },
): Promise<ToolResult> {
  const guard = await ssrfCheck(args.url);
  if (!guard.ok) return err(`web_fetch refused: ${guard.reason}`);

  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(args.url, {
      redirect: "error", // a redirect could bounce to an internal host — refuse it
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "scooter-agent/1.0" },
    });
  } catch (e) {
    return err(`web_fetch failed: ${(e as Error).message}`);
  }
  if (!res.ok) return err(`web_fetch FAILED (HTTP ${res.status}) for ${args.url}.`);
  const MAX = 200_000; // cap the returned content
  const text = (await res.text()).slice(0, MAX);
  // Crude de-HTML: strip tags/scripts so the agent gets readable text.
  const stripped = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ok(stripped || "(empty response)");
}

// --- SSRF guard (strict: static block-list + DNS-resolve check) ----------------

/** Reject internal / loopback / link-local / cloud-metadata / cluster addresses,
 *  AND resolve the hostname to catch DNS-rebinding to an internal IP. */
async function ssrfCheck(rawUrl: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${u.protocol}` };
  }
  const host = u.hostname.toLowerCase();
  // Obvious internal names.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".cluster.local") ||
    host.endsWith(".svc") ||
    host.endsWith(".internal")
  ) {
    return { ok: false, reason: `internal host ${host}` };
  }
  // Resolve to IP(s) and reject any private/loopback/link-local/metadata address.
  const ips: string[] = [];
  if (isIP(host)) ips.push(host);
  else {
    try {
      const addrs = await lookup(host, { all: true });
      ips.push(...addrs.map((a) => a.address));
    } catch {
      return { ok: false, reason: `could not resolve ${host}` };
    }
  }
  for (const ip of ips) {
    if (isBlockedIp(ip)) return { ok: false, reason: `resolves to a blocked address (${ip})` };
  }
  return { ok: true };
}

/** True for loopback / RFC1918 / link-local (incl. 169.254.169.254 metadata) / ULA / ::1. */
function isBlockedIp(ip: string): boolean {
  if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 0) return true; // this-host
  return false;
}

// --- Registration --------------------------------------------------------------

/** Register the five agent-tools on an McpServer bound to one conversation. */
// NOTE: the `title` strings below are load-bearing for the UI. goose surfaces the
// ACP tool `title` as the tool name in the AG-UI stream, and ui/src/toolCallView.ts
// matches these EXACT strings to render slack/github/gitlab/jira tool calls as
// provider message cards. If you rename a title, update that matcher (a guard test
// in agentTools.spec.ts asserts these titles so a rename fails CI, not silently).
export function registerAgentTools(
  server: McpServer,
  deps: AgentToolsDeps,
  ctx: ToolContext,
): void {
  server.registerTool(
    "slack_respond",
    {
      title: "Respond in the Slack thread",
      description:
        "Post a message to THIS conversation's Slack thread (the channel + thread are already known — " +
        "you only provide the text). Use this to acknowledge and to reply; it reports the real result " +
        "(a Slack error is returned to you — do NOT retry blindly). Prefer this over a raw curl.",
      inputSchema: { text: z.string().describe("The message to post."), thread_ts: z.string().optional().describe("Override the thread (rarely needed).") },
    },
    async (args) => (await handleSlackRespond(deps, ctx, args)) as never,
  );
  server.registerTool(
    "slack_react",
    {
      title: "React to the Slack message",
      description:
        "Add an emoji reaction to THIS conversation's Slack message (the channel + message are already " +
        "known; by default it reacts to the message that triggered you). Give the emoji `name` WITHOUT " +
        "colons (e.g. \"eyes\", \"white_check_mark\", \"tada\"). Reports the real Slack result. Nice for a " +
        "quick 👀 acknowledgment or a ✅ when done — but don't spam reactions.",
      inputSchema: {
        emoji: z.string().describe('The emoji name, without colons (e.g. "eyes").'),
        timestamp: z.string().optional().describe("Override which message to react to (rarely needed)."),
      },
    },
    async (args) => (await handleSlackReact(deps, ctx, args)) as never,
  );
  server.registerTool(
    "gitlab_comment",
    {
      title: "Comment on the GitLab MR",
      description:
        "Post a comment on THIS conversation's GitLab merge request (project + MR inferred). Pass " +
        "`discussion_id` to reply within a review discussion. Returns the real GitLab result.",
      inputSchema: { body: z.string().describe("The comment (Markdown)."), discussion_id: z.string().optional() },
    },
    async (args) => (await handleGitlabComment(deps, ctx, args)) as never,
  );
  server.registerTool(
    "github_comment",
    {
      title: "Comment on the GitHub PR/issue",
      description:
        "Post a comment on THIS conversation's GitHub PR/issue (owner/repo/number inferred). Pass " +
        "`in_reply_to` (a review-comment id) to reply within a PR review thread. Returns the real result.",
      inputSchema: { body: z.string().describe("The comment (Markdown)."), in_reply_to: z.number().optional() },
    },
    async (args) => (await handleGithubComment(deps, ctx, args)) as never,
  );
  server.registerTool(
    "jira_comment",
    {
      title: "Comment on the Jira issue",
      description:
        "Post a comment on THIS conversation's Jira issue (the issue key is inferred). Returns the " +
        "real Jira result. Prefer this over a raw broker call.",
      inputSchema: { body: z.string().describe("The comment text.") },
    },
    async (args) => (await handleJiraComment(deps, ctx, args)) as never,
  );
  server.registerTool(
    "web_search",
    {
      title: "Search the web (DuckDuckGo)",
      description:
        "Search the web via DuckDuckGo's Instant Answer API (definitions, abstracts, related topics — " +
        "not a full result index). Good for quick facts + finding a canonical URL to web_fetch.",
      inputSchema: { query: z.string().describe("The search query.") },
    },
    async (args) => (await handleWebSearch(deps, args)) as never,
  );
  server.registerTool(
    "web_fetch",
    {
      title: "Fetch a URL",
      description:
        "Fetch a public web page and return its readable text. Refuses internal/cluster/metadata " +
        "addresses. Use after web_search, or on a URL from a PR/issue.",
      inputSchema: { url: z.string().describe("The http(s) URL to fetch.") },
    },
    async (args) => (await handleWebFetch(deps, args)) as never,
  );
}
