/**
 * Conversation UI — session sidebar + the styled assistant-ui Thread, driven by
 * the agent-host's AG-UI stream. Messages, tool calls, and reasoning stream in
 * live as the agent works in the sandbox.
 */

import { RuntimeProvider, useConversationInterrupts } from "./RuntimeProvider.js";
import { Sidebar } from "./Sidebar.js";
import { RightPanel } from "./RightPanel.js";
import { RunStatusBar } from "./RunStatusBar.js";
import { ThreadErrorBoundary } from "./ThreadErrorBoundary.js";
import { UserBadge } from "./UserBadge.js";
import { ToolCallView } from "./ToolCallView.js";
import { ToolGroupOpen } from "./ToolGroupOpen.js";
import { Thread } from "@/components/assistant-ui/thread";

/** The Thread wrapped in an error boundary keyed to the render tick, so a
 *  transient assistant-ui runtime crash (e.g. during a model-switch rebuild)
 *  recovers on the next frame instead of blanking the page. */
function GuardedThread() {
  const { renderTick } = useConversationInterrupts();
  return (
    <ThreadErrorBoundary resetKey={renderTick}>
      <Thread components={{ ToolFallback: ToolCallView, ToolGroup: ToolGroupOpen }} />
    </ThreadErrorBoundary>
  );
}

export function App() {
  return (
    <RuntimeProvider>
      <div className="flex h-dvh flex-col">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3 text-sm">
          <div>
            <strong>Scooter</strong>
            <span className="text-muted-foreground"> — your agent, running in a Nix sandbox</span>
          </div>
          {/* Signed-in user (from the ingress identity); hidden when anonymous. */}
          <UserBadge />
        </header>
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              {/* Provider "post" tool calls (slack/github/gitlab/jira) render as
                  message cards with the provider icon; other tools use the stock
                  generic box. ToolGroupOpen keeps grouped tool calls EXPANDED so
                  the cards + shell commands are visible top-level, not hidden
                  behind a "N tool calls" collapse. */}
              <GuardedThread />
            </div>
            {/* Thinking indicator + Stop button while a run is in flight (any
                source — local, Slack, another tab). Renders nothing when idle. */}
            <RunStatusBar />
          </main>
          {/* Right-side tabbed panel: Approvals (AG-UI interrupts — a gate the user
              can't miss; auto-focused on a new one) + Queue (messages waiting behind
              the active run, moved off the main column so a backlog no longer eats
              the screen). Collapses entirely when both are empty. */}
          <RightPanel />
        </div>
      </div>
    </RuntimeProvider>
  );
}
