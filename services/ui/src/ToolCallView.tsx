/**
 * ToolCallView — the Thread's ToolFallback override that gives the provider
 * "post" tools (slack_respond / github_comment / gitlab_comment / jira_comment) a
 * message-like card with the provider's icon, and a shell tool a collapsed command
 * card, instead of the generic tool box. Everything else delegates to the stock
 * ToolFallback unchanged.
 *
 * A shell card starts folded: the header names the command on one line, and the full
 * command and its output open on click. The folded body stays in the DOM under
 * hidden="until-found" (FoldedContent.tsx), so find-in-page still matches it and
 * opens the card. Provider posts stay open: they are messages, not noise.
 *
 * Wired in App.tsx: <Thread components={{ ToolFallback: ToolCallView }} />.
 */

import { useState } from "react";
import { ChevronDownIcon, Loader2Icon } from "lucide-react";
import type { ToolCallMessagePartComponent, ToolCallMessagePartProps } from "@assistant-ui/react";

import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { cn } from "@/lib/utils";
import { FoldedContent } from "./FoldedContent.js";
import { SourceBadge, sourceLabel } from "./sourceIcon.js";
import { matchToolCall, resultStatusText } from "./toolCallView.js";
import { useConversationInterrupts } from "./RuntimeProvider.js";

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

/** The one line of a command the folded header shows: its first non-empty line, with "…" when more follow. */
export function commandPreview(command: string): string {
  const lines = command.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  return lines.length > 1 ? `${lines[0]} …` : lines[0]!;
}

export const ToolCallView: ToolCallMessagePartComponent = (props) => {
  const visual = matchToolCall(props.toolName, readArgs(props));
  // assistant-ui forces every folded tool-call part's status to "complete", so liveness is derived from our run state: in flight and no result yet.
  const { isRunning } = useConversationInterrupts();
  const stillRunning = isRunning && props.result === undefined;
  // A shell card is folded until the reader opens it (or find-in-page lands inside it).
  const [open, setOpen] = useState(false);

  // Not a provider "post" tool: the stock generic box, told the real running state.
  if (!visual) return <ToolFallback {...props} forceRunning={stillRunning} />;

  const status = props.status?.type;
  const failed = status === "incomplete" && !stillRunning;
  const isShell = visual.provider === "shell";
  // A one-line status from the tool result rather than the raw ACP content blob; for a shell tool this is usually "".
  const resultText = resultStatusText(props.result);
  const action = failed ? "failed to " + visual.action.replace(/ed /, " ") : visual.action;

  const running = stillRunning && (
    <span className="ml-auto flex items-center gap-1.5 text-foreground" data-testid="provider-tool-running">
      <Loader2Icon className="size-3.5 animate-spin [animation-duration:0.7s]" />
      <span className="animate-pulse">{isShell ? "running…" : "sending…"}</span>
    </span>
  );

  const body = visual.body && (
    <div
      className={isShell ? "whitespace-pre-wrap px-3 py-2 font-mono text-xs" : "whitespace-pre-wrap px-3 py-2 text-sm"}
      data-testid="provider-tool-body"
    >
      {isShell ? `$ ${visual.body}` : visual.body}
    </div>
  );

  // A shell's output keeps its lines; a post's status is one line of prose.
  const result = resultText && (
    <div
      className={cn(
        "border-t px-3 py-1.5 text-xs",
        failed ? "text-destructive" : "text-muted-foreground",
        isShell && "max-h-96 overflow-auto font-mono whitespace-pre-wrap",
      )}
      data-testid="provider-tool-result"
    >
      {resultText}
    </div>
  );

  if (!isShell) {
    return (
      <div
        data-testid="provider-tool-card"
        data-provider={visual.provider}
        className="my-2 overflow-hidden rounded-lg border bg-background"
      >
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <SourceBadge source={visual.provider} size={14} />
          <span className="font-medium text-foreground">{sourceLabel(visual.provider)}</span>
          <span>· {action}</span>
          {running}
        </div>
        {body}
        {result}
      </div>
    );
  }

  const preview = commandPreview(visual.body);
  return (
    <div
      data-testid="provider-tool-card"
      data-provider="shell"
      data-state={open ? "open" : "closed"}
      className="my-2 overflow-hidden rounded-lg border bg-background"
    >
      <button
        type="button"
        data-testid="provider-tool-trigger"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 bg-muted/40 px-3 py-1.5 text-start text-xs text-muted-foreground transition-colors hover:bg-muted/70"
      >
        <SourceBadge source="shell" size={14} />
        <span className="shrink-0 font-medium text-foreground">{sourceLabel("shell")}</span>
        <span className={cn("shrink-0", failed && "text-destructive")}>· {action}</span>
        {preview && (
          <span className="min-w-0 flex-1 truncate font-mono text-foreground/80" data-testid="provider-tool-preview" title={preview}>
            $ {preview}
          </span>
        )}
        {running}
        <ChevronDownIcon
          aria-hidden
          className={cn("ml-auto size-3.5 shrink-0 transition-transform duration-200", !open && "-rotate-90")}
        />
      </button>
      <FoldedContent open={open} onReveal={() => setOpen(true)} className="border-t" data-testid="provider-tool-content">
        {body}
        {result}
      </FoldedContent>
    </div>
  );
};
