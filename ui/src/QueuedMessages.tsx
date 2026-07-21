/**
 * Queued-messages list — the messages the user sent WHILE a run was in flight,
 * waiting their turn behind it. Rendered inside the right-side panel's Queue tab
 * (it used to be an inline strip below the thread, which stacked full message text
 * and ate the screen on a backlog — see RightPanel).
 *
 * Priority: a message with priority > 0 will INTERRUPT the current turn (jump ahead)
 * rather than wait for it to finish. Those are visually distinct — a "Priority" pill
 * + lightning icon — and sorted to the top (highest priority first), so it's obvious
 * which messages run next. Normal (priority 0) messages show a clock cue and keep
 * their arrival order.
 *
 * Long messages are CLAMPED to a few lines with a Show more/less toggle, so one long
 * message can't dominate the narrow panel; the toggle only appears when the text
 * actually overflows the clamp.
 *
 * Why sourced from context: the queue lives in the agent-host's bridge run-queue
 * (server-side), which emits QUEUE_UPDATED snapshots on the integrity stream. The UI
 * used to track "queued" in client memory only, so it VANISHED on refresh (and never
 * showed across tabs). Reading the queue off the single-source stream (via
 * RuntimeProvider context) makes it durable + live: a refresh re-derives it from the
 * log, and it clears itself when the queue drains (the messages become normal user
 * turns as they run).
 */

import { useLayoutEffect, useRef, useState } from "react";
import { FiClock, FiZap } from "react-icons/fi";

import { useConversationInterrupts } from "./RuntimeProvider.js";

type QueuedMessage = { id: string; text: string; priority: number };

/** Lines to show before clamping a long queued message. The class is spelled out
 *  literally (not interpolated) so Tailwind's JIT scanner emits the utility. */
const CLAMP_CLASS = "line-clamp-4";

function QueuedMessageRow({ m }: { m: QueuedMessage }) {
  const priority = m.priority > 0;
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Whether the (clamped) text actually overflows — only then do we offer a toggle.
  const [overflows, setOverflows] = useState(false);

  // Measure after layout: when clamped, a taller scrollHeight than clientHeight means
  // the text is longer than the clamp, so the toggle is warranted. Re-measured when
  // the text changes (a QUEUE_UPDATED snapshot can replace the list).
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    setOverflows(el.scrollHeight - el.clientHeight > 1);
  }, [m.text, expanded]);

  return (
    <div
      data-testid="queued-message"
      data-priority={priority ? "true" : undefined}
      className={
        "flex items-start gap-2 rounded-md border px-2 py-1.5 " +
        (priority
          ? "border-amber-500/40 bg-amber-500/10 text-foreground"
          : "border-transparent text-muted-foreground")
      }
      title={priority ? "Will interrupt the current turn" : "Waiting for the current turn to finish"}
    >
      {/* State cue: a lightning bolt for a priority (interrupting) message, a clock
          for a normal waiting one. */}
      <span aria-hidden className={"mt-0.5 shrink-0 " + (priority ? "text-amber-600" : "text-muted-foreground/70")}>
        {priority ? <FiZap size={13} /> : <FiClock size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        {/* Wrap long messages (incl. unbroken strings) instead of stretching the panel
            width; clamp to CLAMP_LINES until expanded. When clamped, line-clamp-4 sets
            `display:-webkit-box` (so do NOT also set `block`, which would override it and
            defeat the clamp); expanded is a normal block. min-w-0 lets break-words apply. */}
        <div
          ref={textRef}
          data-testid="queued-message-text"
          className={"whitespace-pre-wrap break-words " + (expanded ? "block" : CLAMP_CLASS)}
        >
          {priority && (
            <span
              data-testid="queued-priority-pill"
              className="mr-1.5 rounded bg-amber-500/20 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700"
            >
              Priority
            </span>
          )}
          {m.text}
        </div>
        {(overflows || expanded) && (
          <button
            type="button"
            data-testid="queued-message-toggle"
            onClick={() => setExpanded((e) => !e)}
            className="mt-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}

export function QueuedMessages() {
  const { queuedMessages } = useConversationInterrupts();
  if (queuedMessages.length === 0) return null;

  // Priority messages (will interrupt the current turn) float to the top, highest
  // first; ties + normal messages keep their arrival order (stable sort).
  const ordered = queuedMessages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.priority - a.m.priority || a.i - b.i)
    .map(({ m }) => m);

  return (
    <div data-testid="queued-messages" className="flex flex-col gap-1.5 text-sm">
      {ordered.map((m) => (
        <QueuedMessageRow key={m.id} m={m} />
      ))}
    </div>
  );
}
