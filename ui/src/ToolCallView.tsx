/**
 * ToolCallView — the Thread's ToolFallback override that gives the provider
 * "post" tools (slack_respond / github_comment / gitlab_comment / jira_comment) a
 * message-like card with the provider's icon, instead of the generic collapsed
 * tool box. Everything else delegates to the stock ToolFallback unchanged.
 *
 * Wired in App.tsx: <Thread components={{ ToolFallback: ToolCallView }} />.
 */

import type { ToolCallMessagePartComponent, ToolCallMessagePartProps } from "@assistant-ui/react";

import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { SourceBadge, sourceLabel } from "./sourceIcon.js";
import { matchToolCall, resultStatusText } from "./toolCallView.js";

/** Parse the args object from the part (prefer the parsed `args`, else argsText). */
function readArgs(props: ToolCallMessagePartProps): unknown {
  const withArgs = props as unknown as { args?: unknown; argsText?: string };
  if (withArgs.args && typeof withArgs.args === "object") return withArgs.args;
  try {
    return withArgs.argsText ? JSON.parse(withArgs.argsText) : {};
  } catch {
    return {};
  }
}

export const ToolCallView: ToolCallMessagePartComponent = (props) => {
  const visual = matchToolCall(props.toolName, readArgs(props));
  // Not a provider "post" tool → the stock generic tool box.
  if (!visual) return <ToolFallback {...props} />;

  const status = props.status?.type;
  const failed = status === "incomplete";
  // A CLEAN one-line status from the tool result — NOT the raw ACP content blob
  // (e.g. [{"content":{"text":"Posted to the Slack thread."}}]); the posted text
  // is shown as the body above, the result is just a confirmation/error line.
  const resultText = resultStatusText(props.result);

  return (
    <div
      data-testid="provider-tool-card"
      data-provider={visual.provider}
      className="my-2 overflow-hidden rounded-lg border bg-background"
    >
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <SourceBadge source={visual.provider} size={14} />
        <span className="font-medium text-foreground">{sourceLabel(visual.provider)}</span>
        <span>· {failed ? "failed to " + visual.action.replace(/ed /, " ") : visual.action}</span>
        {status === "running" && <span className="ml-auto animate-pulse">sending…</span>}
      </div>
      {visual.body && (
        <div className="whitespace-pre-wrap px-3 py-2 text-sm" data-testid="provider-tool-body">
          {visual.body}
        </div>
      )}
      {resultText && (
        <div
          className={
            "border-t px-3 py-1.5 text-xs " + (failed ? "text-destructive" : "text-muted-foreground")
          }
          data-testid="provider-tool-result"
        >
          {resultText}
        </div>
      )}
    </div>
  );
};
