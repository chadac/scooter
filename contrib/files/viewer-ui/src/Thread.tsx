import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, CircleAlert, Loader2, MessageSquare, RotateCcw, Trash2, Undo2 } from "lucide-react";
import clsx from "clsx";
import { outbox, useOutbox, type Annotation, type Thread } from "./api";
import { previewOf } from "./markdown";

function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Where a comment is on its way to the agent; nothing once delivered. */
export function SyncBadge({ a, onChange }: { a: Annotation; onChange?: () => void }) {
  const { stalled } = useOutbox();
  if (a.state === "queued")
    return stalled ? (
      <button
        className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-warning hover:underline"
        title="Saved in this browser; it sends once the sandbox is up"
        onClick={() => outbox.poke()}
      >
        <RotateCcw className="size-3" /> still waking, retry
      </button>
    ) : (
      <span
        className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground"
        title="Waking the sandbox to send this; it's saved in this browser meanwhile"
      >
        <Loader2 className="size-3 animate-spin" /> submitting…
      </span>
    );
  if (a.state === "pending")
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        title="Not yet delivered to the agent"
      >
        <Loader2 className="size-3 animate-spin" /> sending
      </span>
    );
  if (a.state === "failed")
    return (
      <button
        className="inline-flex items-center gap-1 text-xs text-destructive hover:underline"
        title={a.error}
        onClick={() => outbox.retry(a.id).then(onChange)}
      >
        <CircleAlert className="size-3" /> not delivered, retry
      </button>
    );
  return null;
}

export function Composer({
  placeholder,
  submitLabel,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  onSubmit: (text: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(text);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          if (e.key === "Escape") onCancel?.();
        }}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-sans text-base text-foreground md:text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground pointer-coarse:invisible">⌘/Ctrl + Enter</span>
        {onCancel && (
          <button className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn-primary" disabled={!text.trim() || busy} onClick={submit}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

export function Quote({ text, className }: { text: string; className?: string }) {
  return (
    <blockquote
      title={text}
      className={clsx(
        "line-clamp-2 border-l-2 border-warning/60 pl-2 text-xs leading-relaxed text-muted-foreground",
        className,
      )}
    >
      {text}
    </blockquote>
  );
}

function Avatar({ agent }: { agent: boolean }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
        agent ? "bg-brand/15 text-brand" : "bg-secondary text-secondary-foreground",
      )}
    >
      {agent ? "S" : "Y"}
    </span>
  );
}

/** Deleting the comment that opened a thread takes its replies with it (the server's rule). */
function DeleteButton({ a, thread, onChange }: { a: Annotation; thread: Thread; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const opener = a.id === thread.id;
  const replies = thread.comments.length - 1;
  const label = opener && replies ? "Delete thread" : opener ? "Delete comment" : "Delete reply";
  return (
    <button
      aria-label={label}
      title={label}
      disabled={busy}
      className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50 pointer-coarse:opacity-100"
      onClick={async () => {
        if (opener && replies && !confirm(`Delete this comment and its ${replies} repl${replies === 1 ? "y" : "ies"}?`))
          return;
        setBusy(true);
        try {
          await outbox.remove(a.id);
        } finally {
          setBusy(false);
          onChange();
        }
      }}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
    </button>
  );
}

export function ThreadCard({
  thread,
  path,
  onChange,
  showQuote,
  active,
  reveal = 0,
}: {
  thread: Thread;
  path: string;
  onChange: () => void;
  showQuote?: boolean;
  active?: boolean;
  /** Bumped when the thread is picked from the document; unfolds it. */
  reveal?: number;
}) {
  const [replying, setReplying] = useState(false);
  const [open, setOpen] = useState(!thread.resolved);
  // Optimistic until the refetch agrees, or the card flips back after the POST.
  const [pending, setPending] = useState<{ want: boolean; acked: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const resolved = pending ? pending.want : thread.resolved;
  const saving = !!pending && !pending.acked;
  useEffect(() => {
    if (pending?.acked && thread.resolved === pending.want) setPending(null);
  }, [thread.resolved, pending]);
  const setResolved = async (want: boolean) => {
    setPending({ want, acked: false });
    setFailed(false);
    setOpen(!want);
    try {
      await outbox.resolve(thread.id, want);
    } catch {
      setPending(null);
      setOpen(true);
      setFailed(true);
      return;
    }
    setPending({ want, acked: true });
    onChange();
  };
  // Resolve folds, reopen unfolds, from either side. Our own change is already applied.
  useEffect(() => {
    if (pending?.want !== thread.resolved) setOpen(!thread.resolved);
  }, [thread.resolved]);
  useEffect(() => {
    if (reveal) setOpen(true);
  }, [reveal]);

  if (!open) {
    const n = thread.comments.length;
    return (
      <button
        onClick={() => setOpen(true)}
        title="Expand thread"
        aria-expanded={false}
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-1.5 text-left font-sans text-xs text-muted-foreground hover:bg-accent"
      >
        {saving ? (
          <Loader2 aria-label="Saving" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : resolved ? (
          <Check className="size-3.5 shrink-0 text-success" />
        ) : (
          <MessageSquare className="size-3.5 shrink-0 text-warning" />
        )}
        <span className="shrink-0">
          {resolved ? "Resolved" : "Open"} · {n} comment{n === 1 ? "" : "s"}
        </span>
        <span className="min-w-0 truncate">{thread.comments[0].text}</span>
        <ChevronDown className="ml-auto size-3.5 shrink-0" />
      </button>
    );
  }

  return (
    <div
      data-thread={thread.id}
      className={clsx(
        "rounded-lg border bg-card font-sans text-sm text-card-foreground shadow-sm transition-shadow",
        active ? "border-brand ring-2 ring-brand/30" : "border-border",
      )}
    >
      {showQuote && thread.quote && <Quote text={previewOf(thread.quote)} className="mx-3 mt-3" />}
      {thread.stale && (
        <p className="mx-3 mt-2 flex items-center gap-1.5 rounded-md bg-warning/10 px-2 py-1 text-xs text-warning">
          <CircleAlert className="size-3.5" /> The quoted text has changed since this was written.
        </p>
      )}
      <ul>
        {thread.comments.map((c) => (
          <li key={c.id} className="group px-3 pt-3">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Avatar agent={c.by === "agent"} />
              <span className="font-medium text-foreground">{c.by === "agent" ? "Scooter" : "You"}</span>
              <span>· {ago(c.created_at)}</span>
              <span className="ml-auto flex items-center gap-2">
                <SyncBadge a={c} onChange={onChange} />
                <DeleteButton a={c} thread={thread} onChange={onChange} />
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words pl-7 leading-relaxed">{c.text}</p>
          </li>
        ))}
      </ul>
      {failed && (
        <p role="alert" className="mx-3 mt-2 flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
          <CircleAlert className="size-3.5" /> Couldn't {resolved ? "reopen" : "resolve"} this thread. Try again.
        </p>
      )}
      <div className="px-3 pb-2 pt-2">
        {replying ? (
          <Composer
            autoFocus
            placeholder="Reply…"
            submitLabel="Reply"
            onCancel={() => setReplying(false)}
            onSubmit={async (text) => {
              await outbox.add({ path, line: thread.line, quote: thread.quote, text, thread: thread.id });
              setReplying(false);
              onChange();
            }}
          />
        ) : (
          <div className="-ml-2 flex items-center gap-1 pl-7">
            <button className="btn-ghost" onClick={() => setReplying(true)}>
              <MessageSquare className="size-3.5" /> Reply
            </button>
            <button
              className="btn-ghost ml-auto"
              title="Collapse thread"
              aria-label="Collapse thread"
              aria-expanded
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
            >
              <ChevronUp className="size-3.5" />
            </button>
            <button className="btn-ghost" disabled={saving} onClick={() => setResolved(!resolved)}>
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : resolved ? (
                <Undo2 className="size-3.5" />
              ) : (
                <Check className="size-3.5" />
              )}
              {resolved ? "Reopen" : "Resolve"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function RetryAll({ failed, onChange }: { failed: Annotation[]; onChange: () => void }) {
  if (!failed.length) return null;
  return (
    <button
      className="btn-ghost text-destructive"
      onClick={() => Promise.all(failed.map((a) => outbox.retry(a.id))).then(onChange)}
    >
      <RotateCcw className="size-3.5" /> Retry {failed.length} undelivered
    </button>
  );
}
