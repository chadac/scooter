/**
 * RightPanel — the single right-side panel that hosts the Approvals and Queue tabs.
 *
 * WHY: approvals were already a right-side slider; the queue was an INLINE strip in
 * the main column that stacked every queued message's full text and ate the screen on
 * a backlog. This unifies both into ONE right panel with two tabs, so neither steals
 * vertical space from the conversation. The panel collapses entirely (renders null)
 * when both are empty — idle conversations stay clean, matching the old behavior.
 *
 * Tab behavior:
 *   • Approvals is a GATE the user can't miss — when a new interrupt arrives we
 *     auto-focus that tab. The queue never steals focus.
 *   • Each tab carries a count badge. A tab with an empty backing list is still
 *     selectable (so the user can see "0"), but the panel as a whole hides when BOTH
 *     are empty.
 *
 * The two tabs' bodies are the existing components: InterruptList (data-testid
 * `interrupt-panel`, so the e2e specs still find it) and QueuedMessages
 * (data-testid `queued-messages`).
 */

import { useEffect, useRef, useState } from "react";

import { InterruptList } from "./InterruptPanel.js";
import { QueuedMessages } from "./QueuedMessages.js";
import { SandboxPanelView, useSandboxStatus } from "./SandboxPanel.js";
import { SubagentsPanel, subagentsOf } from "./SubagentsPanel.js";
import { useSessions } from "./sessions.js";
import { useConversationInterrupts } from "./RuntimeProvider.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Tab = "sandbox" | "approvals" | "queue" | "subagents";

function TabButton({
  active,
  onClick,
  label,
  count,
  alert,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  /** Render the count badge as a RED alert (an approval is a gate the user must act
   *  on). Otherwise it's a neutral grey count. */
  alert?: boolean;
}) {
  // Short labels for mobile: S=Sandbox, A=Approvals, Q=Queue, Sub=Subagents
  const shortLabel = label === "Sandbox" ? "S" : label === "Approvals" ? "A" : label === "Queue" ? "Q" : "Sub";
  
  return (
    <Button
      variant="ghost"
      size="sm"
      role="tab"
      aria-selected={active}
      data-testid={`right-panel-tab-${label.toLowerCase()}`}
      onClick={onClick}
      className={cn(
        "flex-1 rounded-none border-b-2 px-2 sm:px-4",
        active
          ? "border-foreground font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:bg-transparent hover:text-foreground"
      )}
    >
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{shortLabel}</span>
      {count > 0 && (
        <span
          data-testid={`right-panel-badge-${label.toLowerCase()}`}
          data-alert={alert ? "true" : undefined}
          className={
            "ml-1 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs " +
            (alert
              ? "bg-destructive font-semibold text-white dark:bg-destructive/60"
              : "bg-muted text-muted-foreground")
          }
        >
          {count}
        </span>
      )}
    </Button>
  );
}

export function RightPanel({ onClose }: { onClose?: () => void }) {
  const { interrupts, queuedMessages } = useConversationInterrupts();
  const sandbox = useSandboxStatus();
  const { sessions, currentId } = useSessions();
  const nInterrupts = interrupts.length;
  const nQueued = queuedMessages.length;
  const subagents = subagentsOf(sessions, currentId);
  const nSubagents = subagents.length;

  // Sandbox is the leftmost, ALWAYS-present tab — so it's the default. It now hosts
  // BOTH the pod status AND the web services (start/stop), so there's no separate
  // Services tab or bottom panel.
  const [active, setActive] = useState<Tab>("sandbox");

  // Auto-focus Approvals whenever the pending-interrupt count RISES (a new gate the
  // user must answer). Tracked by count so re-renders that don't change it don't
  // re-steal focus, and the queue never triggers it.
  const prevInterrupts = useRef(nInterrupts);
  useEffect(() => {
    if (nInterrupts > prevInterrupts.current) setActive("approvals");
    prevInterrupts.current = nInterrupts;
  }, [nInterrupts]);

  // The panel is ALWAYS shown now (the Sandbox status tab is persistent) — as long as
  // there IS a conversation. Only a truly empty app (no conversation) hides it.
  if (!sandbox.hasConversation) return null;

  return (
    <aside
      className="flex h-full w-80 shrink-0 flex-col border-l bg-background shadow-lg"
      data-testid="right-panel"
      aria-label="Sandbox status + services, approvals, and queued messages"
    >
      <div className="flex items-center border-b" role="tablist">
        {/* Close button for mobile */}
        {onClose && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="right-panel-close"
            aria-label="Close panel"
            onClick={onClose}
            className="mx-2 lg:hidden"
          >
            ✕
          </Button>
        )}
        <div className="flex flex-1">
          <TabButton
            active={active === "sandbox"}
            onClick={() => setActive("sandbox")}
            label="Sandbox"
            count={0}
          />
          <TabButton
            active={active === "approvals"}
            onClick={() => setActive("approvals")}
            label="Approvals"
            count={nInterrupts}
            alert // a pending approval is a gate — red badge so the user knows to click here
          />
          <TabButton
            active={active === "queue"}
            onClick={() => setActive("queue")}
            label="Queue"
            count={nQueued}
          />
          {nSubagents > 0 && (
            <TabButton
              active={active === "subagents"}
              onClick={() => setActive("subagents")}
              label="Subagents"
              count={nSubagents}
            />
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {active === "sandbox" ? (
          <SandboxPanelView
            state={sandbox.state}
            services={sandbox.services}
            busy={sandbox.busy}
            conversationId={sandbox.conversationId}
            onStartSandbox={() => void sandbox.startSandbox()}
            onStartService={sandbox.startService}
            onStopService={sandbox.stopService}
          />
        ) : active === "approvals" ? (
          nInterrupts > 0 ? (
            <InterruptList />
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="approvals-empty">
              No pending approvals.
            </p>
          )
        ) : active === "subagents" ? (
          <SubagentsPanel />
        ) : nQueued > 0 ? (
          <QueuedMessages />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="queue-empty">
            No queued messages.
          </p>
        )}
      </div>
    </aside>
  );
}
