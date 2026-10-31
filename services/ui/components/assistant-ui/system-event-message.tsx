/**
 * SystemEventMessage: a platform-injected message (webhook, scheduler, background job,
 * broker, subagent…) rendered as one collapsed, de-emphasized line until clicked, so a
 * burst of automated events doesn't flood the thread. Used both for persisted system
 * messages in the thread and for system messages still waiting in the run queue (the
 * latter pass `status`, which fades the line and appends a spinner + label).
 */

import { useState, type FC, type ReactNode } from "react";
import { ChevronDown, ChevronUp, CogIcon, Loader2Icon } from "@/icons";
import { SourceBadge, sourceLabel } from "@/src/sourceIcon";

export const SystemEventMessage: FC<{
  source: string;
  text: string;
  /** Set while the message is still queued: fades the line and shows a spinner + this label. */
  status?: ReactNode;
}> = ({ source, text, status }) => {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").trim();
  const short = preview.length > 80 ? preview.slice(0, 80) + "…" : preview;
  const pending = status !== undefined;

  return (
    <div
      data-slot="aui_system-message"
      data-source={source}
      data-pending={pending ? "true" : undefined}
      className={"mx-auto w-full max-w-(--thread-max-width) px-2" + (pending ? " opacity-60" : "")}
    >
      <button
        type="button"
        data-testid="system-event-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      >
        <span aria-hidden className="shrink-0">
          <SourceBadge source={source} size={13} fallback={<CogIcon className="size-3.5" />} />
        </span>
        <span className="shrink-0 font-medium">{sourceLabel(source)}</span>
        {!open && short && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{short}</span>
        )}
        {pending && (
          <span data-testid="system-event-status" className="ml-auto flex shrink-0 items-center gap-1 text-[11px]">
            <Loader2Icon aria-hidden className="size-3 animate-spin" />
            {status}
          </span>
        )}
        <span aria-hidden className={(pending ? "" : "ml-auto ") + "shrink-0 text-[10px] opacity-60"}>
          {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </span>
      </button>
      {open && (
        <div
          data-testid="system-event-body"
          className="mx-2 mb-1 whitespace-pre-wrap break-words border-l-2 border-border/60 pl-3 text-[12px] text-muted-foreground"
        >
          {text}
        </div>
      )}
    </div>
  );
};
