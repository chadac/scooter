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
 *
 * A CONTRIB adds a tab through the generated manifest rather than by editing
 * this file, which is why `Tab` is a string: the set is open at build time. Its
 * tabs sit after the app's own, in the manifest's order. See
 * contrib/ui-manifest.nix.
 */

import { useEffect, useRef, useState } from "react";

import { mobileNav, useDrawer } from "./mobileNav.js";
import { InterruptList } from "./InterruptPanel.js";
import { QueuedMessages } from "./QueuedMessages.js";
import { SandboxPanelView, useSandboxStatus } from "./SandboxPanel.js";
import { SubagentsPanel, subagentsOf } from "./SubagentsPanel.js";
import { useSessions } from "./sessions.js";
import { useConversationInterrupts } from "./RuntimeProvider.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { contribPanels } from "./contribPanels.generated.js";

/** A built-in tab id, or a contrib panel's. */
type Tab = string;

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
  return (
    <Button
      variant="ghost"
      size="sm"
      role="tab"
      aria-selected={active}
      data-testid={`right-panel-tab-${label.toLowerCase()}`}
      onClick={onClick}
      className={cn(
        "flex-1 rounded-none border-b-2",
        active
          ? "border-foreground font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:bg-transparent hover:text-foreground"
      )}
    >
      {label}
      {count > 0 && (
        <span
          data-testid={`right-panel-badge-${label.toLowerCase()}`}
          data-alert={alert ? "true" : undefined}
          className={
            "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs " +
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

export function RightPanel() {
  const { interrupts, queuedMessages } = useConversationInterrupts();
  const sandbox = useSandboxStatus();
  const { sessions, currentId } = useSessions();
  const nInterrupts = interrupts.length;
  const nQueued = queuedMessages.length;
  const subagents = subagentsOf(sessions, currentId);
  const nSubagents = subagents.length;
  // Published static shares for this conversation. `configured` is false when the
  // broker path isn't wired (local/fake) — hide the tab entirely then, rather than
  // show a permanently-empty one.

  // Sandbox is the leftmost, ALWAYS-present tab — so it's the default. It now hosts
  // BOTH the pod status AND the web services (start/stop), so there's no separate
  // Services tab or bottom panel.
  const [active, setActive] = useState<Tab>("sandbox");

  // One hook per contrib panel. Calling hooks from a map is normally a bug; it is
  // sound here because `contribPanels` is COMPILED IN, so its length cannot change
  // between renders — the rule exists to stop the hook ORDER varying, which it
  // cannot. A contrib panel that should not appear returns show:false; it still
  // runs its hook, so a contrib cannot change the order by hiding itself.
  const panels = contribPanels.map((p) => ({ ...p, ...p.usePanel() }));

  // On mobile the panel is an overlay right-drawer toggled from the header; drawer
  // state drives its slide-in. Desktop (desk+ (≥1200px)) pins it in-flow regardless.
  const drawer = useDrawer();

  // Auto-focus Approvals whenever the pending-interrupt count RISES (a new gate the
  // user must answer). Tracked by count so re-renders that don't change it don't
  // re-steal focus, and the queue never triggers it.
  const prevInterrupts = useRef(nInterrupts);
  useEffect(() => {
    if (nInterrupts > prevInterrupts.current) setActive("approvals");
    prevInterrupts.current = nInterrupts;
  }, [nInterrupts]);

  // A contrib tab can go away under the user — shares hides itself on a
  // conversation whose broker path isn't wired. Without this the tab strip loses
  // its selection and the body silently falls through to the Queue.
  const activeHidden = panels.some((p) => p.id === active && !p.show);
  useEffect(() => {
    if (activeHidden) setActive("sandbox");
  }, [activeHidden]);

  // The panel is ALWAYS shown now (the Sandbox status tab is persistent) — as long as
  // there IS a conversation. Only a truly empty app (no conversation) hides it.
  if (!sandbox.hasConversation) return null;

  return (
    <aside
      className={cn(
        "flex flex-col border-l bg-background",
        // Mobile: off-canvas right drawer over the thread, below the h-11 header.
        "fixed bottom-0 right-0 top-11 z-40 w-[86vw] max-w-80 translate-x-full shadow-xl transition-transform duration-200 ease-out",
        // Desktop (desk+ (≥1200px)): the original static, in-flow column — unchanged.
        "desk:static desk:h-full desk:w-80 desk:max-w-none desk:translate-x-0 desk:shadow-lg desk:transition-none",
        drawer === "panel" && "translate-x-0",
      )}
      data-testid="right-panel"
      aria-label="Sandbox status + services, approvals, and queued messages"
    >
      <div className="flex border-b" role="tablist">
        {/* Mobile-only: dismiss the drawer (backdrop tap also closes it). */}
        <button
          type="button"
          data-testid="mobile-panel-close"
          aria-label="Close panel"
          onClick={() => mobileNav.close()}
          className="flex w-9 shrink-0 items-center justify-center border-r text-muted-foreground hover:text-foreground desk:hidden"
        >
          ✕
        </button>
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
        {panels.map(
          (p) =>
            p.show && (
              <TabButton
                key={p.id}
                active={active === p.id}
                onClick={() => setActive(p.id)}
                label={p.title}
                count={p.count}
              />
            ),
        )}
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
            onRescanServices={sandbox.rescanServices}
            rescanning={sandbox.rescanning}
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
        ) : panels.some((p) => p.id === active && p.show) ? (
          panels.find((p) => p.id === active)!.body
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
