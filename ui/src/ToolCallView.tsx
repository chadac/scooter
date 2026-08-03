/**
 * ToolCallView — the Thread's ToolFallback override that gives the provider
 * "post" tools (slack_respond / github_comment / gitlab_comment / jira_comment) a
 * message-like card with the provider's icon, instead of the generic collapsed
 * tool box. Everything else delegates to the stock ToolFallback unchanged.
 *
 * Wired in App.tsx: <Thread components={{ ToolFallback: ToolCallView }} />.
 */

import { Loader2Icon } from "lucide-react";
import type { ToolCallMessagePartComponent, ToolCallMessagePartProps } from "@assistant-ui/react";

import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { SourceBadge, sourceLabel } from "./sourceIcon.js";
import { matchToolCall, resultStatusText } from "./toolCallView.js";
import { useConversationInterrupts } from "./RuntimeProvider.js";
import { MarimoEmbed } from "./MarimoEmbed.js";

/** The marimo_embed tool returns a ```marimo-embed\n<base64>\n``` fence in its result
 *  text. Pull the base64 payload out so we can render the island directly here (a
 *  tool RESULT never reaches the message markdown renderer). Returns null if absent. */
function marimoEmbedBase64(result: unknown): string | null {
  const text = resultStatusText(result);
  const m = text.match(/```marimo-embed\s*\n([A-Za-z0-9+/=]+)\s*\n```/);
  return m ? m[1] : null;
}

/** normalizeToolName strips the mcp__scooter-env__ prefix; the embed tool is
 *  `marimo_embed` (possibly namespaced). */
function isMarimoEmbed(toolName: string): boolean {
  return /(?:^|__)marimo_embed$/.test(toolName);
}

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
  // marimo_embed: render the live island inline (the fence is in the tool RESULT,
  // which otherwise only shows a one-line status). While the result is pending, fall
  // through to the normal running box.
  if (isMarimoEmbed(props.toolName)) {
    const base64 = marimoEmbedBase64(props.result);
    if (base64) return <MarimoEmbed base64Body={base64} />;
    // no result yet → show the generic running box until the island arrives.
  }

  const visual = matchToolCall(props.toolName, readArgs(props));
  // Whether the turn is live. In the single-source render model assistant-ui
  // FORCES every folded tool-call part's status to "complete" (ExternalThread's
  // usePartResource clobbers it), so props.status is useless as a liveness signal.
  // Derive "still running" from OUR run state instead: the turn is in flight AND
  // this part has no result yet (the bridge emits the result on the tool_call
  // update, so "no result" ⇔ "not finished").
  const { isRunning } = useConversationInterrupts();
  const stillRunning = isRunning && props.result === undefined;

  // Not a provider "post" tool → the stock generic tool box (told the real
  // running state, since its own status prop is likewise forced to complete).
  if (!visual) return <ToolFallback {...props} forceRunning={stillRunning} />;

  const status = props.status?.type;
  const failed = status === "incomplete" && !stillRunning;
  const isShell = visual.provider === "shell";
  // A CLEAN one-line status from the tool result — NOT the raw ACP content blob
  // (e.g. [{"content":{"text":"Posted to the Slack thread."}}]); the posted text
  // is shown as the body above, the result is just a confirmation/error line. For
  // a shell tool this is usually "" (the terminal-handle result carries no stdout —
  // the real output streams into the assistant reply), so no noisy result line.
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
        {stillRunning && (
          <span
            className="ml-auto flex items-center gap-1.5 text-foreground"
            data-testid="provider-tool-running"
          >
            <Loader2Icon className="size-3.5 animate-spin [animation-duration:0.7s]" />
            <span className="animate-pulse">{isShell ? "running…" : "sending…"}</span>
          </span>
        )}
      </div>
      {visual.body && (
        <div
          className={
            isShell
              ? "whitespace-pre-wrap px-3 py-2 font-mono text-xs"
              : "whitespace-pre-wrap px-3 py-2 text-sm"
          }
          data-testid="provider-tool-body"
        >
          {isShell ? `$ ${visual.body}` : visual.body}
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
