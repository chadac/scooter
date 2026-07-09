/**
 * Run status bar — a thinking indicator + Stop button shown while a goose run is
 * in flight. Reads the log-derived `isRunning` + `cancel` from the conversation
 * context (RuntimeProvider), so it reflects EVERY run (local, Slack, another tab),
 * not just a locally-driven one.
 *
 * Why a dedicated bar instead of assistant-ui's built-in Composer Stop: the
 * single-source render model bypasses the react-ag-ui runtime's per-run
 * aggregator, so `thread.isRunning` is always false and the stock Stop button is
 * dead (see RuntimeProvider header). This bar drives off our real signal.
 */

import { useConversationInterrupts } from "./RuntimeProvider.js";

export function RunStatusBar() {
  const { isRunning, cancel, cancelState, runError } = useConversationInterrupts();

  // A failed run (RUN_ERROR) clears `isRunning` but the base applier renders no
  // message — so when the run isn't in flight but errored, show a visible error
  // banner instead of nothing (the silent-failure half of the hydrate bug). A live
  // run takes precedence (its own indicator below).
  if (!isRunning) {
    if (!runError) return null;
    return (
      <div
        data-testid="run-error-bar"
        role="alert"
        className="flex items-start gap-2 border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
      >
        <span aria-hidden className="mt-0.5 font-semibold">
          ⚠
        </span>
        <span data-testid="run-error-message">{runError}</span>
      </div>
    );
  }

  const stopping = cancelState === "stopping";
  const failed = cancelState === "failed";

  return (
    <div
      data-testid="run-status-bar"
      className="flex items-center justify-between gap-3 border-t bg-muted/40 px-4 py-2 text-sm"
    >
      <span data-testid="thinking-indicator" className="flex items-center gap-2 text-muted-foreground">
        {/* Pulsing dot — a lightweight "working" cue without a spinner dependency. */}
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-current" aria-hidden />
        {stopping ? "Stopping…" : failed ? "Stop didn't land — the run is still going" : "Scooter is working…"}
      </span>
      <button
        type="button"
        data-testid="stop-run"
        // While a stop is in flight the button is disabled + shows the pending
        // state, so the click is visibly acknowledged (the run's terminal event
        // still round-trips through the stream to actually clear the bar). If the
        // stop failed to land, re-enable so the user can retry.
        disabled={stopping}
        aria-busy={stopping}
        onClick={() => void cancel()}
        className="rounded-md border px-3 py-1 font-medium hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
      >
        {stopping ? "Stopping…" : failed ? "Retry stop" : "Stop"}
      </button>
    </div>
  );
}
