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
import { ThemePicker } from "./ThemePicker.js";
import { ToolCallView } from "./ToolCallView.js";
import { ToolGroupOpen } from "./ToolGroupOpen.js";
import { SettingsPage } from "./SettingsPage.js";
import { viewStore, useView } from "./view.js";
import { mobileNav, useDrawer } from "./mobileNav.js";
import { StartingPodLanding } from "./DeadPodLanding.js";
import { useSandboxStatus, LABEL as SANDBOX_LABEL, DOT as SANDBOX_DOT } from "./SandboxPanel.js";
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

/** Header sandbox pill — a colored dot + "sandbox <state>", mirroring the Sandbox
 *  tab's own status so the pod's liveness is visible from anywhere in the shell. */
function SandboxStatusPill() {
  const { state, hasConversation } = useSandboxStatus();
  if (!hasConversation) return null;
  return (
    <div
      data-testid="header-sandbox-status"
      className="flex h-6 items-center gap-1.5 rounded-md border bg-card px-2 text-xs text-muted-foreground"
      title={`Sandbox: ${SANDBOX_LABEL[state]}`}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", SANDBOX_DOT[state])} />
      <span>sandbox {SANDBOX_LABEL[state].toLowerCase().replace("…", "")}</span>
    </div>
  );
}

/** The dim/dismiss layer shown behind an open mobile drawer. Sits below the header
 *  (top-11) so the toggle buttons stay reachable, and below the drawers (z-30 < z-40).
 *  Desktop hides it via `md:hidden` — the panels are in-flow there, never overlays. */
function MobileDrawerBackdrop() {
  const drawer = useDrawer();
  if (drawer === "none") return null;
  return (
    <div
      data-testid="mobile-drawer-backdrop"
      aria-hidden
      onClick={() => mobileNav.close()}
      className="fixed inset-x-0 bottom-0 top-11 z-30 bg-black/40 md:hidden"
    />
  );
}

export function App() {
  const view = useView();
  return (
    <RuntimeProvider>
      <div className="flex h-dvh flex-col">
        <header className="flex h-11 items-center justify-between gap-3 border-b bg-header px-3 pl-4 text-sm">
          {/* Compact wordmark — mark + name; the tagline was dropped in the paper reskin. */}
          <div className="flex items-center gap-2">
            {/* Mobile-only: open the sessions drawer. Hidden at md+ where the sidebar
                is always in-flow. Only in chat (settings has no sidebar). */}
            {view !== "settings" && (
              <Button
                data-testid="mobile-nav-open"
                variant="ghost"
                size="icon-sm"
                aria-label="Open conversations"
                title="Conversations"
                onClick={() => mobileNav.open("sessions")}
                className="-ml-1 text-muted-foreground md:hidden"
              >
                ☰
              </Button>
            )}
            <span className="text-[15px] leading-none" aria-hidden>🛴</span>
            <span className="text-[13.5px] font-semibold tracking-tight">scooter</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Live pod status, mirrored from the Sandbox tab. Desktop-only — on mobile
                the header has no room, and the same status lives in the ⚑ panel drawer. */}
            <span className="hidden md:flex">
              <SandboxStatusPill />
            </span>
            {/* Mobile-only: open the right panel (sandbox/approvals/queue) drawer.
                Hidden at md+ where the panel is always in-flow. */}
            {view !== "settings" && (
              <Button
                data-testid="mobile-panel-open"
                variant="ghost"
                size="icon-sm"
                aria-label="Open sandbox & approvals panel"
                title="Sandbox & approvals"
                onClick={() => mobileNav.open("panel")}
                className="text-muted-foreground md:hidden"
              >
                ⚑
              </Button>
            )}
            {/* Light / dark / system theme toggle. */}
            <ThemePicker />
            {/* Settings (scheduled tasks, …). Toggles the main pane. */}
            <Button
              data-testid="settings-toggle"
              variant="ghost"
              size="icon-sm"
              aria-label="Settings"
              title="Settings"
              aria-pressed={view === "settings"}
              onClick={() => {
                mobileNav.close(); // settings has no drawers; don't leave one open behind it
                viewStore.set(view === "settings" ? "chat" : "settings");
              }}
              className={cn("text-muted-foreground", view === "settings" && "bg-accent text-foreground")}
            >
              ⚙
            </Button>
            {/* Signed-in user (from the ingress identity); hidden when anonymous, and
                desktop-only — the header can't fit it on a phone. */}
            <span className="hidden md:flex">
              <UserBadge />
            </span>
          </div>
        </header>
        {view === "settings" ? (
          <div className="min-h-0 flex-1">
            <SettingsPage />
          </div>
        ) : (
          <div className="relative flex min-h-0 flex-1">
            <Sidebar />
            {/* Dim + dismiss layer behind an open mobile drawer (md-hidden). */}
            <MobileDrawerBackdrop />
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
