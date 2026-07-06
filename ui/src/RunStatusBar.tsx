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
  const { isRunning, cancel } = useConversationInterrupts();
  if (!isRunning) return null;
  return (
    <div
      data-testid="run-status-bar"
      className="flex items-center justify-between gap-3 border-t bg-muted/40 px-4 py-2 text-sm"
    >
      <span data-testid="thinking-indicator" className="flex items-center gap-2 text-muted-foreground">
        {/* Pulsing dot — a lightweight "working" cue without a spinner dependency. */}
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-current" aria-hidden />
        Scooter is working…
      </span>
      <button
        type="button"
        data-testid="stop-run"
        onClick={() => void cancel()}
        className="rounded-md border px-3 py-1 font-medium hover:bg-background"
      >
        Stop
      </button>
    </div>
  );
}
