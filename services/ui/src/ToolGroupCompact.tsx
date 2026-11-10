/**
 * Compact-density ToolGroup (density.ts): tool calls fold to one line naming the tools
 * ("5 tool calls · grep, read_file, bash"), expanded on click. Consecutive tool-only
 * messages share one line, drawn by the first (toolRuns.ts); the rest render only while
 * it is expanded, and are hidden otherwise.
 */

import { useMemo, useState, type PropsWithChildren, type ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ChevronRightIcon, LoaderIcon, WrenchIcon } from "lucide-react";

import type { ThreadGroupPart } from "@/components/assistant-ui/thread";
import { toolNames, toolRunAt, toolRunOpen, useToolRunOpen, type RunMessage, type ToolRun } from "./toolRuns.js";

export function ToolGroupCompact({ group, children }: PropsWithChildren<{ group: ThreadGroupPart }>) {
  const run = useToolRun();
  const open = useToolRunOpen(run?.leaderId);
  if (!run) return <StandaloneGroup group={group}>{children}</StandaloneGroup>;

  if (!run.isLeader) {
    // Marks the whole message for hiding while its run is collapsed (globals.css).
    return open ? <CompactToolCalls>{children}</CompactToolCalls> : <span data-slot="tool-run-collapsed" hidden />;
  }
  return (
    <div data-slot="tool-group-compact">
      <CompactToolLine
        count={run.count}
        names={run.names.join(", ")}
        running={run.running || group.status.type === "running"}
        open={open}
        onToggle={() => toolRunOpen.toggle(run.leaderId)}
      />
      {open && <CompactToolCalls>{children}</CompactToolCalls>}
    </div>
  );
}

/** This message's tool run, or undefined when the message holds more than tool calls. */
function useToolRun(): ToolRun | undefined {
  // A string, so the selector's result compares equal until the run changes.
  const key = useAuiState((s) =>
    JSON.stringify(toolRunAt(s.thread.messages as unknown as readonly RunMessage[], s.message.index) ?? null),
  );
  return useMemo(() => (JSON.parse(key) as ToolRun | null) ?? undefined, [key]);
}

/** A tool group in a message that also holds text: its own line, with its own open state. */
function StandaloneGroup({ group, children }: PropsWithChildren<{ group: ThreadGroupPart }>) {
  const [open, setOpen] = useState(false);
  const names = useAuiState((s) =>
    toolNames(group.indices.map((i) => s.message.parts[i] as { toolName?: string })).join(", "),
  );
  return (
    <div data-slot="tool-group-compact">
      <CompactToolLine
        count={group.indices.length}
        names={names}
        running={group.status.type === "running"}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open && <CompactToolCalls>{children}</CompactToolCalls>}
    </div>
  );
}

function CompactToolLine({
  count,
  names,
  running,
  open,
  onToggle,
}: {
  count: number;
  names: string;
  running: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-slot="tool-group-compact-trigger"
      aria-expanded={open}
      onClick={onToggle}
      className="group/compact flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-start text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <ChevronRightIcon className="size-3 shrink-0 transition-transform group-aria-expanded/compact:rotate-90" aria-hidden />
      {running ? (
        <LoaderIcon className="size-3 shrink-0 animate-spin [animation-duration:0.6s]" aria-hidden />
      ) : (
        <WrenchIcon className="size-3 shrink-0" aria-hidden />
      )}
      <span className="shrink-0 font-medium">
        {count} tool {count === 1 ? "call" : "calls"}
      </span>
      {names && <span className="min-w-0 truncate font-mono opacity-80">· {names}</span>}
    </button>
  );
}

function CompactToolCalls({ children }: { children: ReactNode }) {
  return (
    <div data-slot="tool-group-compact-content" className="ms-2.5 mt-1 flex flex-col gap-1 border-s ps-2 text-xs">
      {children}
    </div>
  );
}
