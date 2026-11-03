/**
 * PanelSection: one collapsible section of the Session tab, with a left chevron, a
 * label and a count badge. The body stays mounted while collapsed, so a contrib
 * panel inside keeps its badge count current. The open state persists per browser.
 */

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

const STORAGE_PREFIX = "scooter-panel-section-";

export function PanelSection({
  id,
  label,
  count = 0,
  children,
}: {
  /** Stable key for the test ids and the persisted open state. */
  id: string;
  label: string;
  count?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readOpen(id));
  const toggle = () => {
    setOpen(!open);
    writeOpen(id, !open);
  };
  const bodyId = `right-panel-section-body-${id}`;
  return (
    <section data-testid={`right-panel-section-${id}`} data-open={open ? "true" : "false"}>
      <button
        type="button"
        data-testid={`right-panel-section-toggle-${id}`}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
        className="-ml-1 flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
        <span className="truncate">{label}</span>
        {count > 0 && (
          <span
            data-testid={`right-panel-section-badge-${id}`}
            className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-normal normal-case tracking-normal"
          >
            {count}
          </span>
        )}
      </button>
      <div id={bodyId} hidden={!open} className="pt-1.5">
        {children}
      </div>
    </section>
  );
}

function readOpen(id: string): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_PREFIX + id) !== "0";
  } catch {
    return true;
  }
}

function writeOpen(id: string, open: boolean) {
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + id, open ? "1" : "0");
  } catch {
    // Storage can be unavailable (private mode); the toggle still works.
  }
}
