/**
 * Interrupt panel — renders the agent's pending option/permission requests as
 * inline buttons and resumes the run with the user's pick.
 *
 * The agent-host pauses a run with an AG-UI interrupt (RUN_FINISHED outcome
 * "interrupt"), which rides the per-conversation integrity log. In the
 * single-source render model the log — not the react-ag-ui runtime's per-run
 * aggregator — is the source of truth, so we read the pending interrupts and
 * answer them through the IntegrityAgent via context (useConversationInterrupts),
 * NOT the runtime's unstable interrupt API. The answer is a POST /agui with
 * resume[], and the continuation streams back through the same integrity log.
 *
 * Each interrupt's metadata.options carries { optionId, name, kind } choices.
 */

import { useState } from "react";

import { useConversationInterrupts } from "./RuntimeProvider.js";
import type { PendingInterrupt } from "./integrityAgent.js";

interface Option {
  optionId: string;
  name: string;
  kind: string;
}

function optionsOf(intr: PendingInterrupt): Option[] {
  const raw = intr.metadata?.options;
  return Array.isArray(raw) ? (raw as Option[]) : [];
}

export function InterruptPanel() {
  const { interrupts: pending, submitResume } = useConversationInterrupts();
  const [submitting, setSubmitting] = useState<string | null>(null);

  if (pending.length === 0) return null;

  const answer = async (intr: PendingInterrupt, status: "resolved" | "cancelled", optionId?: string) => {
    setSubmitting(intr.id);
    try {
      await submitResume([
        { interruptId: intr.id, status, payload: optionId ? { optionId } : undefined },
      ]);
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
