/**
 * Queued-messages strip — the messages the user sent WHILE a run was in flight,
 * waiting their turn behind it. Shown between the thread and the composer.
 *
 * Why a dedicated strip sourced from context: the queue lives in the agent-host's
 * bridge run-queue (server-side), which emits QUEUE_UPDATED snapshots on the
 * integrity stream. The UI used to track "queued" in client memory only, so it
 * VANISHED on refresh (and never showed across tabs). Reading the queue off the
 * single-source stream (via RuntimeProvider context) makes it durable + live: a
 * refresh re-derives it from the log, and it clears itself when the queue drains
 * (the messages become normal user turns as they run).
 */

import { useConversationInterrupts } from "./RuntimeProvider.js";

export function QueuedMessages() {
  const { queuedMessages } = useConversationInterrupts();
  if (queuedMessages.length === 0) return null;
  return (
    <div
      data-testid="queued-messages"
      className="flex flex-col gap-1 border-t bg-muted/20 px-4 py-2 text-sm"
    >
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Queued ({queuedMessages.length})
      </span>
      {queuedMessages.map((m) => (
        <div
          key={m.id}
          data-testid="queued-message"
          className="flex items-center gap-2 text-muted-foreground"
          title={m.priority > 0 ? "Will interrupt the current turn" : "Waiting for the current turn to finish"}
        >
          {/* A hollow clock-ish cue that these haven't been sent to the agent yet. */}
          <span aria-hidden className="text-muted-foreground/70">
            ⧗
          </span>
          <span className="truncate">{m.text}</span>
        </div>
      ))}
    </div>
  );
}
