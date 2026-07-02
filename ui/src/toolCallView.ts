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
/** The visual "kind": a provider message card, or a shell/command card. */
export type ToolKind = Provider | "shell";

export interface ToolCallVisual {
  /** The provider (slack/…) or "shell". `provider` name kept for back-compat with
   *  the icon lookup — "shell" renders a terminal glyph instead. */
  provider: ToolKind;
  /** What the agent posted / the command it ran. "" if absent. */
  body: string;
  /** A short human verb for the header, e.g. "replied in Slack" / "ran a command". */
  action: string;
}

interface Meta { provider: Provider; argKey: string; action: string }

/** Keyed by the underlying tool NAME (the stable identity). */
const BY_TOOL: Record<string, Meta> = {
  slack_respond: { provider: "slack", argKey: "text", action: "replied in Slack" },
  slack_react: { provider: "slack", argKey: "emoji", action: "reacted in Slack" },
  github_comment: { provider: "github", argKey: "body", action: "commented on GitHub" },
  gitlab_comment: { provider: "gitlab", argKey: "body", action: "commented on GitLab" },
  jira_comment: { provider: "jira", argKey: "body", action: "commented on Jira" },
};

/** The registerTool `title` strings, accepted as a fallback (some ACP paths may
 *  surface the raw title instead of the "<server>: <Name>" form). */
const BY_TITLE: Record<string, string> = {
  "respond in the slack thread": "slack_respond",
  "react to the slack message": "slack_react",
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
  if (meta) {
    const raw = asRecord(args)[meta.argKey];
    const body = typeof raw === "string" ? raw : "";
    return { provider: meta.provider, body, action: meta.action };
  }
  // Shell/command tools: goose surfaces them as "Shell" (or "run: <cmd>"). Show the
  // COMMAND (from args.command) on a compact card, so the shell's noisy result — a
  // terminal-handle blob like [{terminalId,type:terminal}] with no stdout (the real
  // output streams into the assistant reply) — doesn't render as a raw JSON dump.
  const cmd = shellCommand(toolName, norm, args);
  if (cmd !== null) return { provider: "shell", body: cmd, action: "ran a command" };
  return null;
}

/** The command a shell/terminal tool ran, or null if this isn't one. Recognized by
 *  EITHER a shell-ish name OR a `command`/`cmd` string arg (the strongest signal —
 *  a command arg means it runs a command). We check the RAW name too because goose
 *  titles its shell tool "run: <cmd>", and normalizeToolName strips at the colon
 *  (which would drop the "run" marker). Returns the command string (or "" when the
 *  tool is shell-ish but the arg is absent). */
function shellCommand(rawName: string, norm: string, args: unknown): string | null {
  const a = asRecord(args);
  const cmd = a.command ?? a.cmd;
  const hasCmdArg = typeof cmd === "string";
  const raw = rawName.trim().toLowerCase();
  const shellish =
    norm === "shell" ||
    norm.startsWith("run_") ||
    norm.startsWith("execute") ||
    raw === "shell" ||
    raw.startsWith("run:") ||
    raw.startsWith("run ");
  if (!shellish && !hasCmdArg) return null;
  return hasCmdArg ? (cmd as string) : "";
}

/**
 * Extract a CLEAN one-line status from a tool result, unwrapping the ACP shapes so
 * we don't dump a JSON blob into the card. Handles: a plain string; MCP
 * `{content:[{type:"text",text}]}`; the ACP content-array
 * `[{content:{type:"text",text}}]` (what slack_respond returns); `{text}`. Falls
 * back to "" (show nothing) rather than a raw JSON.stringify.
 */
export function resultStatusText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result.trim();

  const pickText = (v: unknown): string => {
    const r = asRecord(v);
    if (typeof r.text === "string") return r.text;
    // { content: "..." } | { content: { text } } | { content: [{ text }] }
    if (r.content !== undefined) {
      if (typeof r.content === "string") return r.content;
      if (Array.isArray(r.content)) return r.content.map(pickText).filter(Boolean).join("\n");
      const c = asRecord(r.content);
      if (typeof c.text === "string") return c.text;
    }
    return "";
  };

  if (Array.isArray(result)) {
    const parts = result.map(pickText).filter(Boolean);
    if (parts.length) return parts.join("\n").trim();
    return "";
  }
  const single = pickText(result);
  return single.trim();
}
