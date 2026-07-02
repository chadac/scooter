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

import { useEffect, useState } from "react";

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

/** An AWS approval interrupt is tagged `metadata.aws` by the host (management.ts).
 *  Its `requestId` is carried explicitly (== the interrupt id, but don't assume).
 *  Returns undefined for a non-AWS interrupt (tool permission etc.) → no can-approve
 *  check, button never greyed. Exported for unit testing this classification. */
export function awsRequestId(intr: PendingInterrupt): string | undefined {
  const m = intr.metadata;
  if (!m || m.aws !== true) return undefined;
  return typeof m.requestId === "string" ? m.requestId : intr.id;
}

/**
 * Per-VIEWER can-approve check for an AWS interrupt. The interrupt is raised once
 * server-side but seen by many users, so whether *this* viewer may approve is
 * asked live from the host (which forwards the viewer's identity to the broker's
 * OpenFGA check). Undefined while loading / for non-AWS interrupts → treated as
 * "allowed" (don't grey a button we can't yet judge). Fails toward greying only on
 * an explicit `false`.
 */
function useCanApprove(
  requestId: string | undefined,
  conversationId: string,
  baseUrl: string,
): boolean | undefined {
  const [can, setCan] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!requestId || !conversationId) return;
    let cancelled = false;
    fetch(
      `${baseUrl}/conversations/${encodeURIComponent(conversationId)}/aws-request/${encodeURIComponent(requestId)}/can-approve`,
      { credentials: "include" },
    )
      .then((r) => (r.ok ? r.json() : { canApprove: false }))
      .then((j: { canApprove?: boolean }) => {
        if (!cancelled) setCan(j.canApprove !== false);
      })
      .catch(() => {
        if (!cancelled) setCan(false); // fail closed → greyed
      });
    return () => {
      cancelled = true;
    };
  }, [requestId, conversationId, baseUrl]);
  return can;
}

/** One pending interrupt: its message + option buttons. For an AWS interrupt, the
 *  Approve button is greyed (with a tooltip) when this viewer can't approve. */
function InterruptCard({
  intr,
  busy,
  answer,
  conversationId,
  baseUrl,
}: {
  intr: PendingInterrupt;
  busy: boolean;
  answer: (intr: PendingInterrupt, status: "resolved" | "cancelled", optionId?: string) => void;
  conversationId: string;
  baseUrl: string;
}) {
  const options = optionsOf(intr);
  const requestId = awsRequestId(intr);
  const canApprove = useCanApprove(requestId, conversationId, baseUrl);
  // Only gate the "approve" option of an AWS interrupt, and only on an explicit
  // no. Loading/unknown leaves it enabled (optimistic; the broker still enforces).
  const approveBlocked = requestId !== undefined && canApprove === false;

  return (
    <div
      className="mb-3 rounded-lg border bg-muted/40 p-3 last:mb-0"
      data-testid="interrupt-request"
    >
      {intr.message && (
        <p className="mb-3 whitespace-pre-wrap text-sm" data-testid="interrupt-message">
          {intr.message}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {options.map((o) => {
          const blocked = approveBlocked && o.optionId === "approve";
          return (
            <button
              key={o.optionId}
              type="button"
              disabled={busy || blocked}
              data-testid="interrupt-option"
              data-option-id={o.optionId}
              data-blocked={blocked ? "true" : undefined}
              title={blocked ? "You need an admin to approve this request." : undefined}
              className={
                "rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 " +
                (blocked ? "cursor-not-allowed" : "hover:bg-accent")
              }
              onClick={() => !blocked && answer(intr, "resolved", o.optionId)}
            >
              {o.name}
            </button>
          );
        })}
        {approveBlocked && (
          <p className="text-xs text-muted-foreground" data-testid="interrupt-approve-hint">
            You don't have permission to approve this — an admin must.
          </p>
        )}
        {/* Always offer an explicit dismiss when there are no options or
            the user wants to decline. */}
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
}

export function InterruptPanel() {
  const { interrupts: pending, submitResume, conversationId, baseUrl } = useConversationInterrupts();
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

  // A right-side slider: a pending approval is a gate, so it gets its own
  // prominent panel that slides in from the right rather than a strip that's easy
  // to miss below the thread. Hidden entirely when nothing is pending.
  return (
    <aside
      className="flex h-full w-80 shrink-0 flex-col border-l bg-background shadow-lg"
      data-testid="interrupt-panel"
      aria-label="Pending approval requests"
    >
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">
          Approval needed
          {pending.length > 1 ? ` (${pending.length})` : ""}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          The agent is waiting on your decision to continue.
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {pending.map((intr) => (
          <InterruptCard
            key={intr.id}
            intr={intr}
            busy={submitting === intr.id}
            answer={answer}
            conversationId={conversationId}
            baseUrl={baseUrl}
          />
        ))}
      </div>
    </aside>
  );
}
