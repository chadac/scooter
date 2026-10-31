/**
 * Conversation UI — session sidebar + the styled assistant-ui Thread, driven by
 * the agent-host's AG-UI stream. Messages, tool calls, and reasoning stream in
 * live as the agent works in the sandbox.
 */

import { RuntimeProvider, useConversationInterrupts } from "./RuntimeProvider.js";
import { Menu, PanelRight, PictureInPicture2, ScooterMark, Settings } from "@/icons";
import { Sidebar } from "./Sidebar.js";
import { RightPanel } from "./RightPanel.js";
import { ApprovalDetail } from "./InterruptPanel.js";
import { ThreadErrorBoundary } from "./ThreadErrorBoundary.js";
import { UserBadge } from "./UserBadge.js";
import { ThemePicker } from "./ThemePicker.js";
import { ToolCallView } from "./ToolCallView.js";
import { ToolGroupOpen } from "./ToolGroupOpen.js";
import { SettingsPage } from "./SettingsPage.js";
import { viewStore, useView } from "./view.js";
import { currentConversation, useSessions } from "./sessions.js";
import { chatPath } from "./chatRoute.js";
import { HeaderConversationTitle } from "./HeaderConversationTitle.js";
import { mobileNav, useDrawer } from "./mobileNav.js";
import { StartingPodLanding } from "./DeadPodLanding.js";
import { useSandboxStatus, LABEL as SANDBOX_LABEL, DOT as SANDBOX_DOT } from "./SandboxPanel.js";
import { Thread } from "@/components/assistant-ui/thread";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The Thread in an error boundary keyed to the render tick, so a transient runtime crash recovers on the next frame. */
export function GuardedThread() {
  const { renderTick } = useConversationInterrupts();
  return (
    <ThreadErrorBoundary resetKey={renderTick}>
      <Thread components={{ ToolFallback: ToolCallView, ToolGroup: ToolGroupOpen }} />
    </ThreadErrorBoundary>
  );
}

/** The conversation area is always the thread, even when the pod is asleep; the only other state is the spinner while a Sandbox-tab Start is in flight. */
export function ConversationArea() {
  const { starting } = useSandboxStatus();
  if (starting) return <StartingPodLanding />;
  return (
    <>
      <GuardedThread />
      <ApprovalDetail />
    </>
  );
}

/** Header sandbox pill mirroring the Sandbox tab's status. */
export function SandboxStatusPill() {
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

/** Opens this conversation's `/chat/<id>` subpage in its own window, to sit beside any other tab. */
function PopOutChatButton() {
  useSessions(); // re-render when the selection or its server id changes
  const id = currentConversation()?.serverId();
  if (id === undefined) return null;
  return (
    <Button
      data-testid="pop-out-chat"
      variant="ghost"
      size="icon-sm"
      aria-label="Pop out chat"
      title="Pop out chat"
      onClick={() => window.open(chatPath(id), `scooter-chat-${id}`, "popup,width=480,height=820")}
      className="text-muted-foreground"
    >
      <PictureInPicture2 />
    </Button>
  );
}

/** The dim/dismiss layer behind an open mobile drawer; it sits below the header (top-11) and the drawers (z-30), and desktop hides it via `desk:hidden`. */
function MobileDrawerBackdrop() {
  const drawer = useDrawer();
  if (drawer === "none") return null;
  return (
    <div
      data-testid="mobile-drawer-backdrop"
      aria-hidden
      onClick={() => mobileNav.close()}
      className="fixed inset-x-0 bottom-0 top-11 z-30 bg-black/40 desk:hidden"
    />
  );
}

export function App() {
  const view = useView();
  const drawer = useDrawer(); // for the header toggles' pressed state
  return (
    <RuntimeProvider>
      <div className="flex h-dvh flex-col">
        <header className="flex h-11 items-center justify-between gap-3 border-b bg-header px-3 pl-4 text-sm">
          {/* Compact wordmark: mark + name. */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {/* Mobile-only sessions-drawer toggle, hidden at desk+ and in settings. */}
            {view !== "settings" && (
              <Button
                data-testid="mobile-nav-open"
                variant="ghost"
                size="icon-sm"
                aria-label="Toggle conversations"
                title="Conversations"
                aria-pressed={drawer === "sessions"}
                onClick={() => mobileNav.toggle("sessions")}
                className="-ml-1 text-muted-foreground desk:hidden"
              >
                <Menu />
              </Button>
            )}
            <ScooterMark className="size-4 text-primary" aria-hidden />
            {/* The wordmark gives way below sm, so the title and its actions fit a phone header. */}
            <span className="hidden text-[13.5px] font-semibold tracking-tight sm:inline">scooter</span>
            {view !== "settings" && <HeaderConversationTitle actions />}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Live pod status, desktop-only. */}
            <span className="hidden desk:flex">
              <SandboxStatusPill />
            </span>
            {/* Mobile-only right-panel toggle, hidden at desk+. */}
            {view !== "settings" && (
              <Button
                data-testid="mobile-panel-open"
                variant="ghost"
                size="icon-sm"
                aria-label="Toggle sandbox & approvals panel"
                title="Sandbox & approvals"
                aria-pressed={drawer === "panel"}
                onClick={() => mobileNav.toggle("panel")}
                className="text-muted-foreground desk:hidden"
              >
                <PanelRight />
              </Button>
            )}
            {view !== "settings" && <PopOutChatButton />}
            {/* Light / dark / system theme toggle. */}
            <ThemePicker />
            {/* Settings toggles the main pane. */}
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
              <Settings />
            </Button>
            {/* Signed-in user, hidden when anonymous and desktop-only. */}
            <span className="hidden desk:flex">
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
            {/* Dim + dismiss layer behind an open mobile drawer. */}
            <MobileDrawerBackdrop />
            <main className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1">
                {/* Provider "post" tool calls render as cards, and ToolGroupOpen keeps grouped tool calls expanded. */}
                <ConversationArea />
              </div>
            </main>
            {/* Right-side tabbed panel (Sandbox, Approvals, Subagents, Shares). */}
            <RightPanel />
          </div>
        )}
      </div>
    </RuntimeProvider>
  );
}
