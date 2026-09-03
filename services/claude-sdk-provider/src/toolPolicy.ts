/**
 * Which CLI built-ins the model may use, and what to say when it may not.
 *
 * THE BUG THIS FIXES: a built-in that is neither disabled nor allow-listed is
 * *callable but unwired*. With no permissionMode the CLI runs on "default"
 * ("prompts for dangerous operations"), and a prompt in a headless subprocess has
 * nobody to answer it — the turn stalls holding that prompt and readMessages throws
 * `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use`.
 * The UI showed a bare exit 1.
 *
 * Omission was the default, and omission was the failure mode. So every built-in is
 * now explicitly aliased, allowed, or denied — and anything NOT named here is denied
 * too, which is what makes a tool added by a future CLI release safe rather than fatal.
 *
 * Enforcement is a PreToolUse hook, not canUseTool. Per the SDK docs, canUseTool is a
 * user-input callback that "never fires for auto-approved tools"; for logic that must
 * apply to every call the documented mechanism is PreToolUse, which runs before the
 * rest of the permission flow.
 * See https://code.claude.com/docs/en/agent-sdk/user-input
 */

/** Built-ins that run IN THE SANDBOX via the aliased MCP tools (see sandboxMcp.ts). */
export const ALIASED_BUILTINS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;

/** Built-ins that are safe as-is: no sandbox access, no side effects we care about.
 *  ToolSearch is load-bearing: the scooter-env MCP tools are DEFERRED, so denying it
 *  leaves the model unable to enumerate the tools it was given. */
export const ALLOWED_BUILTINS = ["TodoWrite", "ToolSearch"] as const;

/**
 * Built-ins we deliberately do not support, and what to use instead. The message is
 * shown to the MODEL, which "may adjust its approach" (SDK docs), so it reads as an
 * instruction rather than an error report — the model retries on the right tool
 * instead of stalling.
 */
export const TOOL_REDIRECTS: Record<string, string> = {
  Task:
    "The Task tool is not available here. Use the scooter-env `spawn_subagent` tool " +
    "instead: it runs the subagent in this conversation's sandbox and reports back " +
    "through the UI.",
  AskUserQuestion:
    "There is no interactive question channel here — the user reads this conversation " +
    "asynchronously. State the question and the options in your REPLY, say which option " +
    "you are proceeding with and why, and continue. Do not block waiting for an answer.",
  WebSearch: "The WebSearch tool is not available here. Use the scooter-env `web_search` tool instead.",
  WebFetch:
    "The WebFetch tool is not available here. Use the scooter-env `web_fetch` tool " +
    "instead — it fetches through the platform and refuses internal addresses.",
  NotebookEdit:
    "Jupyter notebooks are not supported here. Edit the file directly with the " +
    "sandbox edit tool.",
};

export type ToolDecision =
  | { allow: true }
  | { allow: false; reason: string };

/**
 * Decide whether `toolName` may run.
 *
 * DENY-BY-DEFAULT. An unrecognised name is refused with a generic reason rather than
 * being allowed to prompt — that is the whole point: a built-in shipped by a newer CLI
 * lands here and is denied cleanly instead of hanging the turn.
 *
 * `extraAllowed` carries the dynamically-named MCP tools (the sandbox aliases and any
 * `mcp__*` servers), which are not knowable at module scope.
 */
export function decideTool(toolName: string, extraAllowed: readonly string[] = []): ToolDecision {
  // MCP tools are ours by construction: the sandbox server and the scooter-env /
  // BYOC-tunnelled servers. They are gated by the bridge's own permission flow.
  if (toolName.startsWith("mcp__")) return { allow: true };
  if ((ALLOWED_BUILTINS as readonly string[]).includes(toolName)) return { allow: true };
  if (extraAllowed.includes(toolName)) return { allow: true };

  const redirect = TOOL_REDIRECTS[toolName];
  if (redirect) return { allow: false, reason: redirect };

  // An ALIASED built-in reaching here means the alias did not take effect — the model
  // asked for the local tool rather than the sandbox one. Denying is right (it would
  // run in the agent-host pod, not the sandbox), and saying so beats a generic refusal.
  if ((ALIASED_BUILTINS as readonly string[]).includes(toolName)) {
    return {
      allow: false,
      reason:
        `${toolName} must run in the sandbox. Use the mcp__sandbox__ tool of the same ` +
        `name — the local built-in would run outside this conversation's workspace.`,
    };
  }

  return {
    allow: false,
    reason:
      `${toolName} is not available in this environment. Do not retry it; use one of ` +
      `the tools you were given instead.`,
  };
}
