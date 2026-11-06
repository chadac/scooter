/**
 * RightPanel: the single right-side panel with two tabs. Session holds the sandbox
 * status and collapsible sections (Services, Subagents, then one per enabled contrib
 * that declares a `ui.panel`), so adding a section never widens the tab bar.
 * Approvals is a gate the user cannot miss, so a new interrupt auto-focuses that tab.
 * (Queued messages render inline in the thread.) The tab bodies are existing
 * components, e.g. InterruptList (data-testid `interrupt-panel`).
 */

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { mobileNav, useDrawer } from "./mobileNav.js";
import { InterruptList } from "./InterruptPanel.js";
import { SandboxPanelView, useSandboxStatus } from "./SandboxPanel.js";
import { SubagentsPanel, subagentsOf } from "./SubagentsPanel.js";
import { PanelSection } from "./PanelSection.js";
import { contribPanels } from "./contribManifest.js";
import { ContribPanelBody } from "./contribPanels.js";
import { useSessions } from "./sessions.js";
import { useConversationInterrupts } from "./RuntimeProvider.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Tab = "session" | "approvals";

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
  /** Render the count badge as a red alert rather than a neutral grey count. */
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
  const { interrupts } = useConversationInterrupts();
  const sandbox = useSandboxStatus();
  const { sessions, currentId } = useSessions();
  const nInterrupts = interrupts.length;
  const subagents = subagentsOf(sessions, currentId);
  const nSubagents = subagents.length;
  const panels = Object.values(contribPanels()).sort(
    (a, b) => a.order - b.order || a.contrib.localeCompare(b.contrib),
  );
  const [panelCounts, setPanelCounts] = useState<Record<string, number | null>>({});
  // One setter per contrib, stable across renders, so a panel's effects do not re-run.
  const counters = useRef(new Map<string, (n: number | null) => void>());
  const counterFor = (contrib: string) => {
    let set = counters.current.get(contrib);
    if (!set) {
      set = (n) => setPanelCounts((c) => (c[contrib] === n ? c : { ...c, [contrib]: n }));
      counters.current.set(contrib, set);
    }
    return set;
  };

  // Session is the leftmost, always-present tab, so it is the default.
  const [active, setActive] = useState<Tab>("session");

  // On mobile the panel is an overlay right-drawer toggled from the header; desktop
  // (≥1200px) pins it in-flow regardless.
  const drawer = useDrawer();

  // Auto-focus Approvals whenever the pending-interrupt count rises; tracking the count
  // keeps re-renders from re-stealing focus.
  const prevInterrupts = useRef(nInterrupts);
  useEffect(() => {
    if (nInterrupts > prevInterrupts.current) setActive("approvals");
    prevInterrupts.current = nInterrupts;
  }, [nInterrupts]);

  // Only an app with no conversation hides the panel.
  if (!sandbox.hasConversation) return null;

  return (
    <aside
      className={cn(
        "flex flex-col border-l bg-background",
        // Mobile: off-canvas right drawer over the thread, below the h-11 header.
        "fixed bottom-0 right-0 top-11 z-40 w-[86vw] max-w-80 translate-x-full shadow-xl transition-transform duration-200 ease-out",
        // Desktop (≥1200px): a static, in-flow column.
        "desk:static desk:h-full desk:w-80 desk:max-w-none desk:translate-x-0 desk:shadow-lg desk:transition-none",
        drawer === "panel" && "translate-x-0",
      )}
      data-testid="right-panel"
      aria-label="Session and approvals"
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
          <X className="size-4" aria-hidden />
        </button>
        <TabButton
          active={active === "session"}
          onClick={() => setActive("session")}
          label="Session"
          count={0}
        />
        <TabButton
          active={active === "approvals"}
          onClick={() => setActive("approvals")}
          label="Approvals"
          count={nInterrupts}
          alert // a pending approval is a gate, so its badge is red
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {/* Session stays mounted while hidden, so contrib sections keep their counts. */}
        <div hidden={active !== "session"}>
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
          >
            {nSubagents > 0 && (
              <PanelSection id="subagents" label="Subagents" count={nSubagents}>
                <SubagentsPanel />
              </PanelSection>
            )}
            {panels.map((p) => (
              <PanelSection
                key={p.contrib}
                id={`contrib-${p.contrib}`}
                label={p.label}
                count={panelCounts[p.contrib] ?? 0}
              >
                <div data-testid={`contrib-panel-${p.contrib}`}>
                  <ContribPanelBody panel={p} setCount={counterFor(p.contrib)} />
                </div>
              </PanelSection>
            ))}
          </SandboxPanelView>
        </div>
        {active === "approvals" ? (
          nInterrupts > 0 ? (
            <InterruptList />
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="approvals-empty">
              No pending approvals.
            </p>
          )
        ) : null}
      </div>
    </aside>
  );
}
