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
import { useConversationInterrupts } from "./RuntimeProvider.js";

type Tab = "approvals" | "queue";

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
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={`right-panel-tab-${label.toLowerCase()}`}
      onClick={onClick}
      className={
        "flex flex-1 items-center justify-center gap-1.5 border-b-2 px-3 py-2 text-sm " +
        (active
          ? "border-foreground font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground")
      }
    >
      {label}
      {count > 0 && (
        <span
          data-testid={`right-panel-badge-${label.toLowerCase()}`}
          data-alert={alert ? "true" : undefined}
          className={
            "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs " +
            (alert
              ? "bg-red-600 font-semibold text-white"
              : "bg-muted text-muted-foreground")
          }
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function RightPanel() {
  const { interrupts, queuedMessages } = useConversationInterrupts();
  const nInterrupts = interrupts.length;
  const nQueued = queuedMessages.length;

  const [active, setActive] = useState<Tab>("approvals");

  // Auto-focus Approvals whenever the pending-interrupt count RISES (a new gate the
  // user must answer). Tracked by count so re-renders that don't change it don't
  // re-steal focus, and the queue never triggers it.
  const prevInterrupts = useRef(nInterrupts);
  useEffect(() => {
    if (nInterrupts > prevInterrupts.current) setActive("approvals");
    prevInterrupts.current = nInterrupts;
  }, [nInterrupts]);

  // Collapse entirely when there's nothing in either tab — costs no space when idle.
  if (nInterrupts === 0 && nQueued === 0) return null;

  return (
    <aside
      className="flex h-full w-80 shrink-0 flex-col border-l bg-background shadow-lg"
      data-testid="right-panel"
      aria-label="Approvals and queued messages"
    >
      <div className="flex border-b" role="tablist">
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
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {active === "approvals" ? (
          nInterrupts > 0 ? (
            <InterruptList />
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="approvals-empty">
              No pending approvals.
            </p>
          )
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
