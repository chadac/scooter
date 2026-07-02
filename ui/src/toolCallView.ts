/**
 * Match an agent tool call to a provider-flavored visualization.
 *
 * The UI receives goose's human-readable ACP `title` as `toolName` (NOT the raw
 * MCP tool name — the bridge maps `toolCallName = u.title`, bridge.ts). So we key
 * off the stable title strings the agent-host sets in registerTool
 * (agentTools.ts), disambiguating the three "comment" tools (which share a `body`
 * arg) by provider. The `args` object is the reliable payload; we pull the
 * message text from the provider's arg key.
 *
 * Returns null for anything we don't specialize (web_search, web_fetch,
 * modify_environment, unknown) — the caller then renders the generic ToolFallback.
 */

export type Provider = "slack" | "github" | "gitlab" | "jira";

export interface ToolCallVisual {
  provider: Provider;
  /** What the agent posted, e.g. the Slack text / the comment body. "" if absent. */
  body: string;
  /** A short human verb for the header, e.g. "replied in Slack". */
  action: string;
}

/** title (from registerTool) -> provider + how to read the posted text + a verb. */
const BY_TITLE: Record<string, { provider: Provider; argKey: string; action: string }> = {
  "Respond in the Slack thread": { provider: "slack", argKey: "text", action: "replied in Slack" },
  "Comment on the GitHub PR/issue": { provider: "github", argKey: "body", action: "commented on GitHub" },
  "Comment on the GitLab MR": { provider: "gitlab", argKey: "body", action: "commented on GitLab" },
  "Comment on the Jira issue": { provider: "jira", argKey: "body", action: "commented on Jira" },
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Decide the provider visualization for a tool call, or null to fall back.
 * `toolName` is goose's title; `args` is the parsed arguments object.
 */
export function matchToolCall(toolName: string, args: unknown): ToolCallVisual | null {
  const meta = BY_TITLE[toolName];
  if (!meta) return null;
  const a = asRecord(args);
  const raw = a[meta.argKey];
  const body = typeof raw === "string" ? raw : "";
  return { provider: meta.provider, body, action: meta.action };
}
