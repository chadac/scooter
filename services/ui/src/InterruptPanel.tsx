/**
 * Interrupt panel: renders the agent's pending option/permission requests and resumes
 * the run with the user's pick, in two views of the same request.
 *
 * - brief: the Approvals-tab card (InterruptList), narrow, enough for the common case.
 * - detail: the central column (ApprovalDetail), opened from a card's "Details", with
 *   room for the whole request, e.g. an AWS grant's full permission set.
 *
 * The agent-host pauses a run with an AG-UI interrupt (RUN_FINISHED outcome
 * "interrupt") that rides the per-conversation integrity log, so pending interrupts
 * are read and answered through the IntegrityAgent (useConversationInterrupts), not
 * the runtime's interrupt API. The answer is a POST /agui with resume[], and the
 * continuation streams back through the same log. Each interrupt's metadata.options
 * carries { optionId, name, kind } choices.
 */

import { useEffect, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "@/icons";
import { createPortal } from "react-dom";
import { hasId, type MaybeConversationId } from "./conversation.js";

import { useConversationInterrupts } from "./RuntimeProvider.js";
import type { PendingInterrupt } from "./integrityAgent.js";
import { contribApprovals, contribInterruptRenderers } from "./contribManifest.js";
import { ContribInterruptCard } from "./contribInterrupts.js";
import { approvalFocus, pruneApprovals, RequestIdContext, useFocusedApproval } from "./approvalFocus.js";
import type { ApprovalView, BlockedOption, InterruptOption } from "./contrib/sdk.js";
import { SourceBadge, sourceLabel } from "./sourceIcon.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function optionsOf(intr: PendingInterrupt): InterruptOption[] {
  const raw = intr.metadata?.options;
  return Array.isArray(raw) ? (raw as InterruptOption[]) : [];
}

/** The request kind and data an interrupt carries for a contrib renderer, or undefined for a plain choice. */
export function requestOf(intr: PendingInterrupt): { kind: string; data: unknown } | undefined {
  const kind = intr.metadata?.kind;
  return typeof kind === "string" && kind ? { kind, data: intr.metadata?.data } : undefined;
}

/** The contrib name and requestId an approval interrupt carries in its metadata, or
 *  undefined for a non-approval interrupt (exported for unit testing). */
export function approvalOf(intr: PendingInterrupt): { contrib: string; requestId: string } | undefined {
  const m = intr.metadata;
  if (!m || typeof m.contrib !== "string" || !m.contrib) return undefined;
  return {
    contrib: m.contrib,
    requestId: typeof m.requestId === "string" ? m.requestId : intr.id,
  };
}

/** The contrib that owns an interrupt, for its brand row: the approval tag, else the kind's prefix. */
export function ownerOf(intr: PendingInterrupt): string | undefined {
  return approvalOf(intr)?.contrib ?? requestOf(intr)?.kind.split(".")[0];
}

/**
 * Whether this viewer may approve an approval interrupt, asked live from the host;
 * undefined while loading or for a non-approval interrupt, which the caller treats
 * as allowed.
 */
function useCanApprove(
  approval: { contrib: string; requestId: string } | undefined,
  conversationId: MaybeConversationId,
  baseUrl: string,
): boolean | undefined {
  const [can, setCan] = useState<boolean | undefined>(undefined);
  // Depend on the fields, not the object, which `approvalOf` rebuilds every render.
  const contrib = approval?.contrib;
  const requestId = approval?.requestId;
  useEffect(() => {
    if (!contrib || !requestId || !hasId(conversationId)) return;
    let cancelled = false;
    fetch(
      `${baseUrl}/conversations/${encodeURIComponent(conversationId)}/approvals/${encodeURIComponent(contrib)}/${encodeURIComponent(requestId)}/can-approve`,
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
  }, [contrib, requestId, conversationId, baseUrl]);
  return can;
}

type Answer = (
  intr: PendingInterrupt,
  status: "resolved" | "cancelled",
  optionId?: string,
  result?: Record<string, unknown>,
) => void;

/** Resume wiring shared by both views: which request is sending, and how to answer one. */
function useAnswer(): { submitting: string | null; answer: Answer } {
  const { submitResume } = useConversationInterrupts();
  const [submitting, setSubmitting] = useState<string | null>(null);
  const answer: Answer = async (intr, status, optionId, result) => {
    setSubmitting(intr.id);
    try {
      await submitResume([
        { interruptId: intr.id, status, payload: optionId ? { optionId, ...(result ? { result } : {}) } : undefined },
      ]);
    } catch {
      // The banner shows failure; the card stays pending for retry.
    } finally {
      setSubmitting(null);
    }
  };
  return { submitting, answer };
}

/** The core card for a request no contrib draws: its message plus option buttons. */
function PlainCard({
  intr,
  view,
  options,
  blocked,
  busy,
  choose,
  dismiss,
}: {
  intr: PendingInterrupt;
  view: ApprovalView;
  options: InterruptOption[];
  blocked?: BlockedOption;
  busy: boolean;
  choose: (optionId: string) => void;
  dismiss: () => void;
}) {
  const detail = view === "detail";
  const buttons = (
    <div className={cn("flex gap-2", detail ? "flex-row-reverse flex-wrap justify-start" : "flex-col")}>
      {options.map((o) => {
        const isBlocked = blocked?.optionId === o.optionId;
        return (
          <Button
            key={o.optionId}
            variant={detail && o.kind.startsWith("allow") ? "default" : "outline"}
            size="sm"
            disabled={busy || isBlocked}
            data-testid="interrupt-option"
            data-option-id={o.optionId}
            data-blocked={isBlocked ? "true" : undefined}
            title={isBlocked ? blocked?.title : undefined}
            className={cn(isBlocked && "cursor-not-allowed")}
            onClick={() => !isBlocked && choose(o.optionId)}
          >
            {o.name}
          </Button>
        );
      })}
      {/* An explicit dismiss is always offered. */}
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        data-testid="interrupt-cancel"
        className={cn("text-muted-foreground", detail && "mr-auto")}
        onClick={dismiss}
      >
        Dismiss
      </Button>
    </div>
  );
  const hint = blocked && (
    <p className="text-xs text-muted-foreground" data-testid="interrupt-approve-hint">
      {blocked.hint}
    </p>
  );

  if (!detail) {
    return (
      <div className="rounded-lg border bg-muted/40 p-3" data-testid="interrupt-request">
        {intr.message && (
          <p className="mb-3 line-clamp-6 whitespace-pre-wrap text-sm" data-testid="interrupt-message">
            {intr.message}
          </p>
        )}
        {buttons}
        {hint && <div className="mt-2">{hint}</div>}
      </div>
    );
  }

  // Everything but the options, which the buttons already show.
  const { options: _options, ...rest } = intr.metadata ?? {};
  return (
    <div className="flex flex-col gap-5" data-testid="interrupt-request">
      {intr.message && (
        <p className="whitespace-pre-wrap text-base leading-relaxed" data-testid="interrupt-message">
          {intr.message}
        </p>
      )}
      {intr.toolCallId && (
        <p className="text-xs text-muted-foreground">
          Tool call <code className="font-mono">{intr.toolCallId}</code>
        </p>
      )}
      {Object.keys(rest).length > 0 && (
        <details className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <summary className="cursor-pointer select-none">Raw request</summary>
          <pre className="mt-2 max-h-96 overflow-auto font-mono text-xs">{JSON.stringify(rest, null, 2)}</pre>
        </details>
      )}
      <div className="sticky bottom-0 -mx-1 flex flex-col gap-2 border-t bg-background px-1 pb-1 pt-3">
        {hint}
        {buttons}
      </div>
    </div>
  );
}

/**
 * One pending request in either view: its contrib's renderer when it has one, else the
 * core card. Owns the per-viewer gating, so both views grey the same option.
 */
function InterruptView({
  intr,
  view,
  busy,
  answer,
  conversationId,
  baseUrl,
}: {
  intr: PendingInterrupt;
  view: ApprovalView;
  busy: boolean;
  answer: Answer;
  /** Undefined before the server creates the conversation. */
  conversationId: MaybeConversationId;
  baseUrl: string;
}) {
  const options = optionsOf(intr);
  const approval = approvalOf(intr);
  const canApprove = useCanApprove(approval, conversationId, baseUrl);
  // A contrib absent from the manifest has no gating; greying is a courtesy, and the
  // broker remains the enforcement point.
  const gating = approval ? contribApprovals()[approval.contrib] : undefined;
  // Gate only on an explicit no; loading/unknown leaves it enabled.
  const blocked: BlockedOption | undefined =
    approval && gating && canApprove === false
      ? { optionId: gating.gatedOption, title: gating.blockedTitle, hint: gating.blockedHint }
      : undefined;

  const choose = (optionId: string, result?: Record<string, unknown>) => {
    if (blocked?.optionId === optionId) return;
    answer(intr, "resolved", optionId, result);
  };
  const dismiss = () => answer(intr, "cancelled");

  const plain = (
    <PlainCard
      intr={intr}
      view={view}
      options={options}
      blocked={blocked}
      busy={busy}
      choose={choose}
      dismiss={dismiss}
    />
  );
  const request = requestOf(intr);
  const renderer = request && contribInterruptRenderers()[request.kind];
  // `resolve` answers with the first option, which carries a question-style result.
  const first = options[0]?.optionId;
  const body =
    !request || !renderer || !first ? (
      plain
    ) : (
      <ContribInterruptCard
        renderer={renderer}
        fallback={plain}
        props={{
          message: intr.message ?? "",
          data: request.data,
          view,
          busy,
          options,
          blocked,
          resolve: (result) => choose(first, result),
          choose,
          dismiss,
        }}
      />
    );
  return <RequestIdContext.Provider value={intr.id}>{body}</RequestIdContext.Provider>;
}

/**
 * The pending requests in their brief view plus the resume wiring, the content of the
 * Approvals tab (RightPanel owns the chrome). Keeps the `interrupt-panel` testid the
 * e2e specs select by, and renders nothing when no interrupt is pending.
 */
export function InterruptList() {
  const { interrupts: pending, conversationId, baseUrl } = useConversationInterrupts();
  const { submitting, answer } = useAnswer();
  const focused = useFocusedApproval();

  if (pending.length === 0) return null;

  return (
    <div data-testid="interrupt-panel" aria-label="Pending approval requests">
      <p className="mb-3 text-xs text-muted-foreground">
        The agent is waiting on your decision to continue.
      </p>
      {pending.map((intr) => {
        const open = focused === intr.id;
        return (
          <div
            key={intr.id}
            className={cn("mb-3 last:mb-0", open && "rounded-lg ring-2 ring-primary/50 ring-offset-2 ring-offset-background")}
            data-testid="interrupt-brief"
            data-focused={open ? "true" : undefined}
          >
            <InterruptView
              intr={intr}
              view="brief"
              busy={submitting === intr.id}
              answer={answer}
              conversationId={conversationId}
              baseUrl={baseUrl}
            />
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                data-testid="interrupt-open-detail"
                className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => (open ? approvalFocus.close() : approvalFocus.open(intr.id))}
              >
                {open ? "Close details" : <>Details <ChevronRight className="inline size-3" aria-hidden /></>}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The detail view of the request the user opened, drawn over the whole page so a large
 * request has room. Keeps the app mounted underneath, so closing it loses no scroll or
 * draft. Mounted wherever the conversation area is, so it also prunes stale focus and drafts.
 */
export function ApprovalDetail() {
  const { interrupts: pending, conversationId, baseUrl } = useConversationInterrupts();
  const { submitting, answer } = useAnswer();
  const focused = useFocusedApproval();
  const ids = pending.map((p) => p.id).join("\n");

  useEffect(() => {
    pruneApprovals(ids ? ids.split("\n") : []);
  }, [ids]);

  const index = pending.findIndex((p) => p.id === focused);
  const intr = index >= 0 ? pending[index] : undefined;

  useEffect(() => {
    if (!intr) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") approvalFocus.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [intr]);

  if (!intr) return null;
  const owner = ownerOf(intr);
  const step = (d: number) => approvalFocus.open(pending[(index + d + pending.length) % pending.length].id);

  // Portalled so no panel clips it; dialogs (z-50) stay above.
  return createPortal(
    <section
      className="fixed inset-0 z-40 flex flex-col bg-background"
      data-testid="approval-detail"
      data-interrupt-id={intr.id}
      aria-label="Approval request details"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-4">
        <Button variant="outline" size="sm" data-testid="approval-detail-back" onClick={() => approvalFocus.close()}>
          <ArrowLeft className="size-4" aria-hidden /> Back to conversation
        </Button>
        {pending.length > 1 && (
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <span className="mr-2" data-testid="approval-detail-position">
              Approval {index + 1} of {pending.length}
            </span>
            <Button variant="outline" size="icon-sm" aria-label="Previous request" onClick={() => step(-1)}>
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" aria-label="Next request" onClick={() => step(1)}>
              <ChevronRight />
            </Button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-8 py-6">
          {owner && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <SourceBadge source={owner} fallback={null} />
              <span>{sourceLabel(owner)}</span>
              <span aria-hidden>·</span>
              <code className="font-mono text-xs">{approvalOf(intr)?.requestId ?? intr.id}</code>
            </div>
          )}
          <InterruptView
            key={intr.id}
            intr={intr}
            view="detail"
            busy={submitting === intr.id}
            answer={answer}
            conversationId={conversationId}
            baseUrl={baseUrl}
          />
        </div>
      </div>
    </section>,
    document.body,
  );
}
