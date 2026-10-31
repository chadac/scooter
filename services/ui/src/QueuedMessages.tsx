/**
 * Queued messages, rendered inline at the tail of the thread: the messages the user sent
 * while a run was in flight, waiting their turn behind it. Each one looks like the user
 * bubble it will become, but faded and with a small status line (spinner + "Queued", or
 * "Sending…" before the server has acknowledged it), so a sent message never "disappears"
 * — it stays where the user expects it and solidifies into a real message once the agent
 * picks it up.
 *
 * How a message waits decides how it looks: one that kills the running tool call gets the
 * warning "Priority" treatment and sorts to the top; one that interrupts the turn once its
 * tools finish is an ordinary queued bubble; one that waits for the whole run to end stays
 * hidden until it is sent (optimistic sends always show as "Sending…"). The list is read from the QUEUE_UPDATED snapshots on
 * the integrity stream (via RuntimeProvider context) plus optimistic pending sends, so it
 * survives a refresh and clears itself as the queue drains. A platform-injected message
 * (one with a `source`) renders as the same collapsed system-event line it becomes once
 * persisted, rather than as a user bubble.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { Zap } from "@/icons";
import { Loader2Icon } from "@/icons";

import { useConversationInterrupts } from "./RuntimeProvider.js";
import type { QueuedItem } from "./integrityAgent.js";
import { Button } from "@/components/ui/button";
import { SystemEventMessage } from "@/components/assistant-ui/system-event-message";

type QueuedMessage = QueuedItem;

/** Lines to show before clamping; spelled out literally so Tailwind's JIT scanner emits the utility. */
const CLAMP_CLASS = "line-clamp-6";

/** RuntimeProvider tags not-yet-acknowledged sends with this id prefix. */
const OPTIMISTIC_PREFIX = "optimistic-";

const isOptimistic = (m: QueuedMessage) => m.id.startsWith(OPTIMISTIC_PREFIX);

/** Only a message that kills the running tool call gets the priority treatment. */
const interruptsTool = (m: QueuedMessage) => m.priority > 0 && m.interrupt === "tool-call";

/** A message waiting for the whole run to end is not shown until it is sent. */
const isVisible = (m: QueuedMessage) => isOptimistic(m) || m.priority > 0;

function statusLabel(m: QueuedMessage): string {
  if (isOptimistic(m)) return "Sending…";
  return interruptsTool(m) ? "Interrupting current tool call…" : "Queued — sends once running tools finish";
}

function QueuedMessageRow({ m }: { m: QueuedMessage }) {
  const priority = interruptsTool(m);
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // The toggle is offered only when the clamped text actually overflows.
  const [overflows, setOverflows] = useState(false);

  // Measured after layout: a scrollHeight taller than clientHeight means the text exceeds the clamp.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    setOverflows(el.scrollHeight - el.clientHeight > 1);
  }, [m.text, expanded]);

  const label = statusLabel(m);

  return (
    // Same grid as the real UserMessage so the bubble lines up exactly where it will land.
    <div
      data-testid="queued-message"
      data-priority={priority ? "true" : undefined}
      data-role="user-queued"
      className="fade-in slide-in-from-bottom-1 animate-in grid grid-cols-[minmax(72px,1fr)_auto] gap-y-1 px-2 duration-150"
      title={label}
    >
      <div className="col-start-2 min-w-0 opacity-60">
        <div
          className={
            "rounded-xl border border-dashed px-4 py-2 text-[15px] text-foreground desk:text-base " +
            (priority ? "border-warning/60 bg-warning/10" : "border-muted-foreground/30 bg-muted")
          }
        >
          {/* When clamped, line-clamp sets `display:-webkit-box`, so do not also set `block`, which would override it. */}
          <div
            ref={textRef}
            data-testid="queued-message-text"
            className={"whitespace-pre-wrap break-words " + (expanded ? "block" : CLAMP_CLASS)}
          >
            {priority && (
              <span
                data-testid="queued-priority-pill"
                className="mr-1.5 rounded bg-warning/20 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning"
              >
                Priority
              </span>
            )}
            {m.text}
          </div>
          {(overflows || expanded) && (
            <Button
              variant="link"
              size="xs"
              data-testid="queued-message-toggle"
              onClick={() => setExpanded((e) => !e)}
              className="mt-0.5 h-auto p-0 text-muted-foreground"
            >
              {expanded ? "Show less" : "Show more"}
            </Button>
          )}
        </div>
      </div>
      <div
        data-testid="queued-message-status"
        className={
          "col-start-2 flex items-center justify-end gap-1 text-xs " +
          (priority ? "text-warning" : "text-muted-foreground")
        }
      >
        {priority ? <Zap className="size-3" aria-hidden /> : null}
        <Loader2Icon aria-hidden className="size-3 animate-spin" />
        <span>{label}</span>
      </div>
    </div>
  );
}

export function QueuedMessages() {
  const { queuedMessages } = useConversationInterrupts();
  const visible = queuedMessages.filter(isVisible);
  if (visible.length === 0) return null;

  // Tool-call interrupts float to the top; everything else keeps arrival order.
  const ordered = visible
    .map((m, i) => ({ m, i }))
    .sort((a, b) => Number(interruptsTool(b.m)) - Number(interruptsTool(a.m)) || a.i - b.i)
    .map(({ m }) => m);

  return (
    <div data-testid="queued-messages" aria-label="Queued messages" className="flex flex-col gap-y-3">
      {ordered.map((m) => (
        // A platform-injected message (webhook, scheduler, subagent…) uses the same collapsed
        // line as its persisted form, so a burst of queued events doesn't flood the thread.
        m.source ? (
          <div key={m.id} data-testid="queued-message" data-role="system-queued" title={statusLabel(m)}>
            <SystemEventMessage source={m.source} text={m.text} status={interruptsTool(m) ? "Interrupting…" : "Queued"} />
          </div>
        ) : (
          <QueuedMessageRow key={m.id} m={m} />
        )
      ))}
    </div>
  );
}
