/**
 * Conversation UI — session sidebar + the styled assistant-ui Thread, driven by
 * the agent-host's AG-UI stream. Messages, tool calls, and reasoning stream in
 * live as the agent works in the sandbox.
 */

import React from "react";
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
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  const [leftSidebarOpen, setLeftSidebarOpen] = React.useState(false);
  const [rightPanelOpen, setRightPanelOpen] = React.useState(false);

  return (
    <RuntimeProvider>
      <div className="flex h-dvh flex-col">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3 text-sm">
          <div className="flex items-center gap-2">
            {/* Mobile menu toggle for left sidebar */}
            <Button
              data-testid="mobile-menu-left"
              variant="ghost"
              size="sm"
              aria-label="Toggle sidebar"
              onClick={() => setLeftSidebarOpen(!leftSidebarOpen)}
              className="lg:hidden -ml-2 touch-manipulation"
            >
              ☰
            </Button>
            <div>
              <strong className="hidden sm:inline">Scooter</strong>
              <strong className="sm:hidden">S</strong>
              <span className="hidden md:inline text-muted-foreground"> — your agent, running in a Nix sandbox</span>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Mobile menu toggle for right panel - visible on mobile when there are items */}
            <Button
              data-testid="mobile-menu-right"
              variant="ghost"
              size="sm"
              aria-label="Toggle right panel"
              onClick={() => setRightPanelOpen(!rightPanelOpen)}
              className="lg:hidden touch-manipulation"
            >
              ☰
            </Button>
            {/* Settings (scheduled tasks, …). Toggles the main pane. */}
            <Button
              data-testid="settings-toggle"
              variant="outline"
              size="sm"
              aria-label="Settings"
              title="Settings"
              aria-pressed={view === "settings"}
              onClick={() => viewStore.set(view === "settings" ? "chat" : "settings")}
              className={cn(view === "settings" && "bg-accent")}
            >
              ⚙
            </Button>
            {/* Signed-in user (from the ingress identity); hidden when anonymous. */}
            <UserBadge />
          </div>
        </header>
        {view === "settings" ? (
          <div className="min-h-0 flex-1">
            <SettingsPage />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 relative">
            {/* Mobile overlay backdrop */}
            {(leftSidebarOpen || rightPanelOpen) && (
              <div
                className="fixed inset-0 z-20 bg-black/50 lg:hidden"
                onClick={() => {
                  setLeftSidebarOpen(false);
                  setRightPanelOpen(false);
                }}
                aria-hidden="true"
              />
            )}
            
            {/* Left Sidebar - slides in on mobile */}
            <div className={cn(
              "fixed inset-y-0 left-0 z-30 lg:relative lg:z-0 transition-transform duration-300 lg:translate-x-0",
              leftSidebarOpen ? "translate-x-0" : "-translate-x-full"
            )}>
              <Sidebar onClose={() => setLeftSidebarOpen(false)} />
            </div>

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
            
            {/* Right Panel - slides in on mobile */}
            <div className={cn(
              "fixed inset-y-0 right-0 z-30 lg:relative lg:z-0 transition-transform duration-300 lg:translate-x-0",
              rightPanelOpen ? "translate-x-0" : "translate-x-full"
            )}>
              <RightPanel onClose={() => setRightPanelOpen(false)} />
            </div>
          </div>
        )}
      </div>
    </RuntimeProvider>
  );
}
