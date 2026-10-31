/**
 * Inline run status: a thinking indicator (what the agent is doing and for how long)
 * and a Stop button, rendered in the conversation flow just above the composer while
 * a run is in flight, plus a failed run's error. It reads `isRunning` / `activeTool` /
 * `runStartedAt` / `cancel` from the conversation context (RuntimeProvider), so it
 * reflects every run (local, Slack, another tab) rather than only a locally-driven one.
 */

import { useEffect, useState } from "react";
import { RotateCw, TriangleAlert, X } from "@/icons";
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

/** A thin context-window fill bar above the composer: grey, amber past 75%, red past
 *  90%, hidden until a usage reading exists. */
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

  // Offer Compact once the context is at least half full and no run is in flight.
  const canCompact = pct >= 50 && !isRunning && !compacting;
  const compact = async () => {
    setCompacting(true);
    setNote(null);
    try {
      // Nothing to compact before the conversation exists server-side.
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

/** The send-error banner plus the run indicator above the composer; null when idle with no error. */
export function InlineRunStatus() {
  return (
    <>
      <SendErrorBanner />
      <RunStatus />
    </>
  );
}

/** A send or resume the server never accepted (e.g. a 413 for an oversized image) starts no run, so say so here or the message just vanishes. */
function SendErrorBanner() {
  const { sendError, clearSendError } = useConversationInterrupts();
  if (!sendError) return null;
  return (
    <div
      data-testid="send-error-bar"
      role="alert"
      className="mx-auto flex w-full max-w-(--thread-max-width) items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span data-testid="send-error-message" className="flex-1">{sendError}</span>
      <button
        type="button"
        data-testid="send-error-dismiss"
        aria-label="Dismiss"
        onClick={() => clearSendError?.()}
        className="shrink-0 leading-none opacity-70 hover:opacity-100"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

/** The inline indicator, Stop button and error banner; null when
 *  idle with no error. */
function RunStatus() {
  const { isRunning, activeTool, runStartedAt, cancel, cancelState, runError, runRetrying, streamAuthError, conversationId } = useConversationInterrupts();

  // Tick once a second while running so the elapsed time advances.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  // An expired ingress/auth session outranks every other state: show a durable banner
  // that clears once the stream reconnects.
  if (streamAuthError) {
    return (
      <div
        data-testid="stream-auth-error-bar"
        role="alert"
        className="mx-auto flex w-full max-w-(--thread-max-width) items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span data-testid="stream-auth-error-message">
          Your session expired — reconnecting. If this persists, reload the page to sign in again.
        </span>
      </div>
    );
  }

  // A server-side auto-retry supersedes the run error until a fresh RUN_STARTED clears
  // it or the retries are exhausted.
  if (runRetrying) {
    return (
      <div
        data-testid="run-retrying-bar"
        role="status"
        className="mx-auto flex w-full max-w-(--thread-max-width) items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
      >
        <RotateCw aria-hidden className="size-4 shrink-0 animate-spin" />
        <span data-testid="run-retrying-message">
          The agent stopped unexpectedly — retrying ({runRetrying.attempt}/{runRetrying.max})…
        </span>
      </div>
    );
  }

  // A failed run clears `isRunning` but renders no message, so surface the error inline.
  if (!isRunning) {
    if (!runError) return null;
    return (
      <div
        data-testid="run-error-bar"
        role="alert"
        className="mx-auto flex w-full max-w-(--thread-max-width) items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span data-testid="run-error-message">{runError}</span>
      </div>
    );
  }

  const stopping = cancelState === "stopping";
  const failed = cancelState === "failed";
  const elapsed = runStartedAt != null ? fmtElapsed(Math.max(0, now - runStartedAt)) : null;

  // The label says what the agent is doing and for how long ("Running bash… 2m 10s" /
  // "Working… 8s"); stop states take precedence.
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
        // Disabled while a stop is in flight or there is no server-side run to stop; a
        // failed stop re-enables the button so the user can retry.
        disabled={stopping || !hasId(conversationId)}
        aria-busy={stopping}
        onClick={() => void cancel()}
        className="shrink-0 rounded-full px-3 py-0.5 font-medium"
      >
        {stopping ? "Stopping…" : failed ? "Retry stop" : "Stop"}
      </Button>
    </div>
  );
}
