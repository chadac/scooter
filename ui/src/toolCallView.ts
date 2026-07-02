/**
 * Match an agent tool call to a provider-flavored visualization.
 *
 * WHAT ARRIVES AS `toolName`: goose surfaces the MCP tool through the ACP stream
 * as "<Server>: <Title-Cased Tool Name>" — e.g. the `slack_respond` tool on the
 * `scooter-env` MCP server arrives as "Scooter-env: Slack Respond" (NOT the raw
 * tool name, and NOT the registerTool `title`). So we normalize the incoming
 * string to the underlying tool-name identity (strip the "<server>:" prefix,
 * lowercase, spaces/punct -> "_") and match that against the known tool names.
 * We also accept the raw registerTool titles as a fallback, so either shape works.
 *
 * Returns null for anything we don't specialize (web_search, web_fetch,
 * modify_environment, unknown) — the caller renders the generic ToolFallback.
 */

export type Provider = "slack" | "github" | "gitlab" | "jira";

export interface ToolCallVisual {
  provider: Provider;
  /** What the agent posted, e.g. the Slack text / the comment body. "" if absent. */
  body: string;
  /** A short human verb for the header, e.g. "replied in Slack". */
  action: string;
}

interface Meta { provider: Provider; argKey: string; action: string }

/** Keyed by the underlying tool NAME (the stable identity). */
const BY_TOOL: Record<string, Meta> = {
  slack_respond: { provider: "slack", argKey: "text", action: "replied in Slack" },
  github_comment: { provider: "github", argKey: "body", action: "commented on GitHub" },
  gitlab_comment: { provider: "gitlab", argKey: "body", action: "commented on GitLab" },
  jira_comment: { provider: "jira", argKey: "body", action: "commented on Jira" },
};

/** The registerTool `title` strings, accepted as a fallback (some ACP paths may
 *  surface the raw title instead of the "<server>: <Name>" form). */
const BY_TITLE: Record<string, string> = {
  "respond in the slack thread": "slack_respond",
  "comment on the github pr/issue": "github_comment",
  "comment on the gitlab mr": "gitlab_comment",
  "comment on the jira issue": "jira_comment",
};

/** Normalize goose's "Scooter-env: Slack Respond" (or a raw tool name) to the
 *  tool-name identity "slack_respond". Drops any "<server>:" prefix, lowercases,
 *  and turns runs of non-alphanumerics into single underscores. */
export function normalizeToolName(toolName: string): string {
  const afterColon = toolName.includes(":") ? toolName.slice(toolName.lastIndexOf(":") + 1) : toolName;
  return afterColon
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Decide the provider visualization for a tool call, or null to fall back.
 * `toolName` is whatever the stream carried (server-prefixed title, or a title,
 * or a raw name); `args` is the parsed arguments object.
 */
export function matchToolCall(toolName: string, args: unknown): ToolCallVisual | null {
  const norm = normalizeToolName(toolName);
  const tool = BY_TOOL[norm] ? norm : BY_TITLE[toolName.trim().toLowerCase()];
  const meta = tool ? BY_TOOL[tool] : undefined;
  if (!meta) return null;
  const a = asRecord(args);
  const raw = a[meta.argKey];
  const body = typeof raw === "string" ? raw : "";
  return { provider: meta.provider, body, action: meta.action };
}
