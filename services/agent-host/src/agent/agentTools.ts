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

/** An MCP tool result (matches mcpServer.ts's ToolResult). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** The external resource a conversation maps to, as recorded by the webhooks
 *  service in Postgres (conversation_map). The FALLBACK source of the target when
 *  a conversation's link has no structured `ref` (e.g. it was created before ref
 *  existed). `resourceId` is source-specific — and the resource's URL is accepted for
 *  every one of them, since that is the shape the agent-host API stores (#563):
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

/** Deps for the broker-INDEPENDENT web tools (web_search / web_fetch). These hit
 *  DuckDuckGo / an arbitrary URL directly and never touch the broker, so they must
 *  not be gated on the broker being wired. See PR (decouple web tools from broker). */
export interface WebToolsDeps {
  /** How to fetch a URL for web_fetch / web_search (injectable for tests). */
  fetchImpl?: typeof fetch;
}

// --- The shared error-echo mapper — the load-bearing "never hide" rule ---------

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

/**
 * DuckDuckGo Instant Answer search (free, no key). Runs straight from the
 * agent-host (no per-conversation identity needed). Returns the abstract +
 * related topics; errors echoed.
 */
export async function handleWebSearch(
  deps: WebToolsDeps,
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
  deps: WebToolsDeps,
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

/** Register the broker-INDEPENDENT web tools (web_search / web_fetch). They need no
 *  broker, so buildServer registers them unconditionally — decoupled from the broker
 *  gate that governs the provider reply tools. Keep this separate from
 *  registerAgentTools so enabling AWS / broker-routed sandboxes is NOT a prerequisite
 *  for a web fetcher. See PR (decouple web tools from broker). */
export function registerWebTools(server: McpServer, deps: WebToolsDeps): void {
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

/* THE PROVIDER REPLY TOOLS USED TO BE REGISTERED HERE.
 *
 * slack_respond / slack_react / get_slack_context / github_comment / gitlab_comment /
 * jira_comment now live in the contribs that own them and are served by the broker's
 * /mcp — see contrib/slack/scooter_contrib_slack/mcp_tools.py and friends. A tool now
 * ships iff its integration is enabled: previously enabling or disabling
 * contrib/github did nothing to the agent's tool surface, and contrib/gitlab even
 * declared `ui.tools.gitlab_comment` for a tool it neither owned nor gated.
 *
 * Two things went with them and are deliberately NOT reimplemented here: target
 * inference from the conversation's links (now scooter_broker_lib/links.py + refs.py)
 * and the attachment gate (now each contrib's `@gate`). Both are ports with the
 * incident-driven rules intact — oldest link first, completeness per link.
 *
 * What remains is registerWebTools (web_search / web_fetch), which needs no provider
 * credential; it moves to per-provider search contribs in phase 3. Why: issue #700.
 */
