/**
 * `web_fetch` — the ONE agent tool still served by the agent-host, and the SSRF guard
 * that is the reason it is a tool at all. Registered alongside `modify_environment` on
 * the per-conversation MCP endpoint (see mcpServer.ts).
 *
 * WHY IT STAYED HERE while every other tool moved to the contrib that owns its
 * credential (issue #700): `web_fetch` has no credential and no provider, so a contrib
 * would buy it nothing but an on/off switch — while the guard below, which is the
 * security-relevant half, would have to be rewritten in Python (its own DNS
 * resolution and blocked-range arithmetic) to get there. Rewriting tested SSRF
 * checks for no gain is not a move, it is a risk.
 *
 * ERRORS ARE NEVER HIDDEN, the rule it keeps along with the rest of the tool surface:
 * a non-2xx maps to an MCP isError result carrying the real status. The agent used to
 * hand-run `curl -sf`, which fails SILENTLY — and a silent failure is how it retried.
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

/** Deps for `web_fetch`. It hits an arbitrary URL directly and never touches the
 *  broker, so it must not be gated on the broker being wired — a deployment with no
 *  broker still gets a URL fetcher. */
export interface WebFetchDeps {
  /** How to fetch a URL (injectable for tests). */
  fetchImpl?: typeof fetch;
}

// --- The shared error-echo mapper — the load-bearing "never hide" rule ---------

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** Fetch a URL's main text content. SSRF-guarded (refuses internal/metadata IPs). */
export async function handleWebFetch(
  deps: WebFetchDeps,
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

/** Register `web_fetch`. It needs no broker and no credential, so buildServer
 *  registers it unconditionally — enabling AWS or broker-routed sandboxes is NOT a
 *  prerequisite for a URL fetcher. Named for the one tool it registers: `web_search`
 *  used to ride along here, which is what let a keyless search backend look like
 *  platform furniture rather than an integration (issue #700). */
export function registerWebFetch(server: McpServer, deps: WebFetchDeps): void {
  server.registerTool(
    "web_fetch",
    {
      title: "Fetch a URL",
      description:
        "Fetch a public web page and return its readable text. Refuses internal/cluster/metadata " +
        "addresses. Use on a URL from a search result, or from a PR/issue.",
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
 * `web_search` followed them in phase 3: it needs a SEARCH KEY, which makes it an
 * integration's tool and not the platform's — contrib/{brave,kagi,duckduckgo} own it
 * now, and a deployment with neither has no search tool rather than one that answers
 * every query with an empty result set (PR #698).
 *
 * What remains is registerWebFetch, which needs no credential at all. Why: issue #700.
 */
