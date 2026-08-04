/**
 * Conversation UI — session sidebar + the styled assistant-ui Thread, driven by
 * the agent-host's AG-UI stream. Messages, tool calls, and reasoning stream in
 * live as the agent works in the sandbox.
 */

import { RuntimeProvider, useConversationInterrupts } from "./RuntimeProvider.js";
import { Sidebar } from "./Sidebar.js";
import { RightPanel } from "./RightPanel.js";
import { ThreadErrorBoundary } from "./ThreadErrorBoundary.js";
import { UserBadge } from "./UserBadge.js";
import { ToolCallView } from "./ToolCallView.js";
import { ToolGroupOpen } from "./ToolGroupOpen.js";
import { SettingsPage } from "./SettingsPage.js";
import { viewStore, useView } from "./view.js";
import { StartingPodLanding } from "./DeadPodLanding.js";
import { useSandboxStatus } from "./SandboxPanel.js";
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

/** The conversation area: ALWAYS the thread (its history + composer), even when the
 *  pod is asleep. A suspended/ended pod no longer takes the screen over with a landing
 *  that hides the conversation — the history renders straight off the persisted
 *  integrity stream (no live pod needed), and SENDING a message resumes the pod
 *  automatically (promptByThread revives before it runs). Start is also available in
 *  the Sandbox tab for an explicit wake. The only non-thread state is the brief
 *  spinner while a Sandbox-tab Start is in flight, so that click gives feedback. */
function ConversationArea() {
  const { starting } = useSandboxStatus();
  if (starting) return <StartingPodLanding />;
  return <GuardedThread />;
}

export function App() {
  const view = useView();
  return (
    <RuntimeProvider>
      <div className="flex h-dvh flex-col">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3 text-sm">
          <div>
            <strong>Scooter</strong>
            <span className="text-muted-foreground"> — your agent, running in a Nix sandbox</span>
          </div>
          <div className="flex items-center gap-3">
            {/* Settings (scheduled tasks, …). Toggles the main pane. */}
            <button
              data-testid="settings-toggle"
              aria-label="Settings"
              title="Settings"
              aria-pressed={view === "settings"}
              onClick={() => viewStore.set(view === "settings" ? "chat" : "settings")}
              className={
                "rounded-md border px-2 py-1 hover:bg-accent " +
                (view === "settings" ? "bg-accent" : "")
              }
            >
              ⚙
            </button>
            {/* Signed-in user (from the ingress identity); hidden when anonymous. */}
            <UserBadge />
          </div>
        </header>
        {view === "settings" ? (
          <div className="min-h-0 flex-1">
            <SettingsPage />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <Sidebar />
            <main className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1">
                {/* Provider "post" tool calls (slack/github/gitlab/jira) render as
                    message cards with the provider icon; other tools use the stock
                    generic box. ToolGroupOpen keeps grouped tool calls EXPANDED so
                    the cards + shell commands are visible top-level, not hidden
                    behind a "N tool calls" collapse. The run status (thinking
                    indicator + Stop) now lives INLINE in the thread (above the
                    composer), not a detached bottom bar — see InlineRunStatus.
                    A suspended/ended pod shows a Start landing instead of the thread. */}
                <ConversationArea />
              </div>
            </main>
            {/* Right-side tabbed panel: Approvals (AG-UI interrupts — a gate the user
                can't miss; auto-focused on a new one) + Queue (messages waiting behind
                the active run, moved off the main column so a backlog no longer eats
                the screen). Collapses entirely when both are empty. */}
            <RightPanel />
          </div>
        )}
      </div>
    </RuntimeProvider>
  );
}
