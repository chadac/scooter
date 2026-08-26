/**
 * Inline run status — a thinking indicator (what the agent is doing + for how long)
 * and a Stop button, shown INLINE in the conversation flow (just above the composer)
 * while a run is in flight. Also surfaces a failed run's error inline.
 *
 * Reads the log-derived `isRunning` / `activeTool` / `runStartedAt` + `cancel` from
 * the conversation context (RuntimeProvider), so it reflects EVERY run (local, Slack,
 * another tab), not just a locally-driven one.
 *
 * Why our own control instead of assistant-ui's built-in Composer Stop: the
 * single-source render model bypasses the react-ag-ui runtime's per-run aggregator,
 * so `thread.isRunning` is always false and the stock Stop button is dead (see
 * RuntimeProvider header). This drives off our real signal.
 *
 * It lives IN the thread (not a detached bottom bar) so the user sees it right where
 * the conversation is happening — following the scroll, next to the latest message.
 */

import { useEffect, useState } from "react";
import { hasId } from "./conversation.js";

import { useConversationInterrupts } from "./RuntimeProvider.js";
import { compactConversation } from "./client.js";
import { agentHostConfig } from "./config.js";
import { Button } from "@/components/ui/button";

/** "3s" / "2m 10s" — compact elapsed time for the working indicator. */
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** A thin context-window fill bar, shown just above the composer. Grey → amber >75%
 *  → red >90%, so the user can see how full the conversation's context is (and knows
 *  it may compact / get too long). Hidden until we have a usage reading. */
export function ContextFillBar() {
  const { contextFill, contextTokens, conversationId, isRunning } = useConversationInterrupts();
  const [compacting, setCompacting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (contextFill == null) return null;
  const pct = Math.round(contextFill * 100);
  const color = pct >= 90 ? "bg-destructive" : pct >= 75 ? "bg-warning" : "bg-muted-foreground/40";
  const tip = contextTokens
    ? `Context ${pct}% full — ${contextTokens.used.toLocaleString()} / ${contextTokens.total.toLocaleString()} tokens`
    : `Context ${pct}% full`;

  // Offer Compact once the context is getting full (≥50%), when NOT mid-run. It
  // summarizes older turns so the conversation can keep going on less context.
  const canCompact = pct >= 50 && !isRunning && !compacting;
  const compact = async () => {
    setCompacting(true);
    setNote(null);
    try {
      // Compaction acts on an EXISTING conversation; nothing to compact before one.
      if (!hasId(conversationId)) return;
      const r = await compactConversation(agentHostConfig, conversationId);
      setNote(r.compacted ? "Compacted earlier messages." : "Nothing to compact yet.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setCompacting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-0.5 px-1">
      <div
        data-testid="context-fill-bar"
        data-fill={pct}
        title={tip}
        aria-label={tip}
        className="flex items-center gap-2"
      >
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <div className={`h-full ${color} transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
        {(canCompact || compacting) && (
          <Button
            variant="outline"
            size="xs"
            data-testid="compact-button"
            disabled={compacting}
            onClick={() => void compact()}
            title="Summarize older messages to free up context"
            className="shrink-0 rounded-full px-2 py-0.5 text-[10px]"
          >
            {compacting ? "Compacting…" : "Compact"}
          </Button>
        )}
      </div>
      {note && <span data-testid="compact-note" className="text-[10px] text-muted-foreground">{note}</span>}
    </div>
  );
}

/** The inline indicator + Stop / error, rendered in the conversation (above the
 *  composer). Returns null when idle with no error. */
export function InlineRunStatus() {
  const { isRunning, activeTool, runStartedAt, cancel, cancelState, runError, runRetrying, streamAuthError } = useConversationInterrupts();

  // Tick once a second WHILE running so the elapsed time advances — this is what
  // makes a long, silent tool call visibly "still working" instead of looking stuck.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  // An expired ingress/auth session (the live stream is 401/403ing) takes
  // precedence over everything: retrying silently would leave the user staring at
  // a "working" dot forever. Surface a durable banner so they know to re-auth; it
  // self-clears once the stream reconnects (the pump keeps polling).
  if (streamAuthError) {
    return (
      <div
        data-testid="stream-auth-error-bar"
        role="alert"
        className="mx-auto flex w-full max-w-(--thread-max-width) items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        <span aria-hidden className="mt-0.5 font-semibold">⚠</span>
        <span data-testid="stream-auth-error-message">
          Your session expired — reconnecting. If this persists, reload the page to sign in again.
        </span>
      </div>
    );
  }

  // AUTO-RETRY in progress: the agent died/stalled transiently and the server is re-driving the run
  // with backoff. Show a "retrying (n/N)…" banner instead of the terminal error — it supersedes the
  // death RUN_ERROR until we know the outcome (a fresh RUN_STARTED clears it; exhaustion falls through
  // to the error banner). Takes precedence over the error banner but sits below auth errors.
  if (runRetrying) {
    return (
      <div
        data-testid="run-retrying-bar"
        role="status"
        className="mx-auto flex w-full max-w-(--thread-max-width) items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
      >
        <span aria-hidden className="animate-spin">↻</span>
        <span data-testid="run-retrying-message">
          The agent stopped unexpectedly — retrying ({runRetrying.attempt}/{runRetrying.max})…
        </span>
      </div>
    );
  }

  // A failed run (RUN_ERROR) clears `isRunning` but the base applier renders no
  // message — so when the run isn't in flight but errored, show a visible error
  // inline instead of nothing (the silent-failure half of the hydrate bug). A live
  // run takes precedence (its own indicator below).
  if (!isRunning) {
    if (!runError) return null;
    return (
      <div
        data-testid="run-error-bar"
        role="alert"
        className="mx-auto flex w-full max-w-(--thread-max-width) items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        <span aria-hidden className="mt-0.5 font-semibold">⚠</span>
        <span data-testid="run-error-message">{runError}</span>
      </div>
    );
  }

  const stopping = cancelState === "stopping";
  const failed = cancelState === "failed";
  const elapsed = runStartedAt != null ? fmtElapsed(Math.max(0, now - runStartedAt)) : null;

  // The label says WHAT it's doing + for HOW LONG — so a long silent tool call (e.g.
  // a build poll) is clearly "still working", not stuck. "Running bash… 2m 10s" /
  // "Working… 8s". Stop states take precedence.
  const workingLabel = activeTool
    ? `Running ${activeTool}…${elapsed ? ` ${elapsed}` : ""}`
    : `Working…${elapsed ? ` ${elapsed}` : ""}`;

  return (
    <div
      data-testid="run-status-bar"
      className="mx-auto flex w-full max-w-(--thread-max-width) items-center justify-between gap-3 rounded-full border bg-muted/40 px-4 py-1.5 text-sm"
    >
      <span data-testid="thinking-indicator" className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-current" aria-label="Scooter is working" />
        <span data-testid="thinking-label" className="truncate">
          {stopping ? "Stopping…" : failed ? "Stop didn't land — the run is still going" : workingLabel}
        </span>
      </span>
      <Button
        variant="outline"
        size="sm"
        data-testid="stop-run"
        // While a stop is in flight the button is disabled + shows the pending state,
        // so the click is visibly acknowledged (the run's terminal event still
        // round-trips through the stream to actually clear it). If the stop failed to
        // land, re-enable so the user can retry.
        disabled={stopping}
        aria-busy={stopping}
        onClick={() => void cancel()}
        className="shrink-0 rounded-full px-3 py-0.5 font-medium"
      >
        {stopping ? "Stopping…" : failed ? "Retry stop" : "Stop"}
      </Button>
    </div>
  );
}
