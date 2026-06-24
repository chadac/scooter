/**
 * Interrupt panel — renders the agent's pending option/permission requests as
 * inline buttons and resumes the run with the user's pick.
 *
 * The agent-host pauses a run with an AG-UI interrupt (RUN_FINISHED outcome
 * "interrupt"); assistant-ui's react-ag-ui runtime collects these as pending
 * interrupts. We read them via the (unstable) interrupt API — wrapped here so a
 * future API change is a one-file fix — and resume via submitInterruptResponses.
 *
 * Each interrupt's metadata.options carries { optionId, name, kind } choices.
 */

import { useEffect, useState } from "react";
import { useAssistantRuntime } from "@assistant-ui/react";

/** The subset of the AgUiAssistantRuntime interrupt API we depend on. Wrapping
 *  it isolates the `unstable_` surface to this one adapter. */
export interface InterruptRuntime {
  unstable_getPendingInterrupts?: () => readonly AgUiInterrupt[];
  unstable_submitInterruptResponses?: (
    responses: ReadonlyArray<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }>,
  ) => Promise<void>;
  subscribe?: (cb: () => void) => () => void;
}

interface AgUiInterrupt {
  id: string;
  reason: string;
  message?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

interface Option {
  optionId: string;
  name: string;
  kind: string;
}

function optionsOf(intr: AgUiInterrupt): Option[] {
  const raw = intr.metadata?.options;
  return Array.isArray(raw) ? (raw as Option[]) : [];
}

export function InterruptPanel() {
  const runtime = useAssistantRuntime() as unknown as InterruptRuntime;

  // The runtime's pending interrupts aren't reactive on their own; re-read on
  // every runtime change (subscribe) and as a fallback poll, so the panel
  // appears/disappears as interrupts arrive and are answered.
  const [pending, setPending] = useState<readonly AgUiInterrupt[]>([]);
  const [submitting, setSubmitting] = useState<string | null>(null);

  useEffect(() => {
    const get = () => runtime.unstable_getPendingInterrupts?.() ?? [];
    const refresh = () => setPending(get());
    refresh();
    const unsub = runtime.subscribe?.(refresh);
    const t = setInterval(refresh, 1000); // fallback if subscribe misses a change
    return () => {
      unsub?.();
      clearInterval(t);
    };
  }, [runtime]);

  if (pending.length === 0) return null;

  const answer = async (intr: AgUiInterrupt, status: "resolved" | "cancelled", optionId?: string) => {
    setSubmitting(intr.id);
    try {
      await runtime.unstable_submitInterruptResponses?.([
        { interruptId: intr.id, status, payload: optionId ? { optionId } : undefined },
      ]);
      setPending(runtime.unstable_getPendingInterrupts?.() ?? []);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="border-t bg-muted/40 px-4 py-3" data-testid="interrupt-panel">
      {pending.map((intr) => {
        const options = optionsOf(intr);
        const busy = submitting === intr.id;
        return (
          <div key={intr.id} className="mb-2 last:mb-0" data-testid="interrupt-request">
            {intr.message && (
              <p className="mb-2 text-sm font-medium" data-testid="interrupt-message">
                {intr.message}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {options.map((o) => (
                <button
                  key={o.optionId}
                  type="button"
                  disabled={busy}
                  data-testid="interrupt-option"
                  data-option-id={o.optionId}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                  onClick={() => answer(intr, "resolved", o.optionId)}
                >
                  {o.name}
                </button>
              ))}
              {/* Always offer an explicit dismiss when there are no options or the
                  user wants to decline. */}
              <button
                type="button"
                disabled={busy}
                data-testid="interrupt-cancel"
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
                onClick={() => answer(intr, "cancelled")}
              >
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
