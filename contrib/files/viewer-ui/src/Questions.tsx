import { useState } from "react";
import { CircleHelp, CheckCircle2, Loader2 } from "lucide-react";
import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { outbox, type Question } from "./api";
import { SyncBadge } from "./Thread";

export function QuestionCard({
  path,
  question: q,
  onChange,
}: {
  path: string;
  question: Question;
  onChange: () => void;
}) {
  const last = q.answers.at(-1);
  const [editing, setEditing] = useState(!q.answered);
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const answer = q.kind === "text" ? text.trim() : picked.join(", ");
  const toggle = (label: string) =>
    setPicked((p) =>
      q.kind === "single" ? [label] : p.includes(label) ? p.filter((x) => x !== label) : [...p, label],
    );

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await outbox.add({ path, line: q.line, text: answer, kind: "answer", question_id: q.id });
      setEditing(false);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-question={q.id}
      className={clsx(
        "overflow-hidden rounded-xl border bg-card font-sans shadow-sm",
        q.answered ? "border-border" : "border-brand/60",
      )}
    >
      <div className="flex items-start gap-3 px-4 pt-4">
        {q.answered ? (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
        ) : (
          <CircleHelp className="mt-0.5 size-5 shrink-0 text-brand" />
        )}
        <div className="prose prose-sm prose-stone dark:prose-invert min-w-0 flex-1 font-medium">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{q.prompt}</ReactMarkdown>
        </div>
      </div>

      {editing ? (
        <div className="flex flex-col gap-2 px-4 pb-4 pl-12 pt-3">
          {q.kind === "text" ? (
            <textarea
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Your answer…"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-ring/60"
            />
          ) : (
            q.options.map((o) => {
              const on = picked.includes(o.label);
              return (
                <label
                  key={o.label}
                  className={clsx(
                    "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors",
                    on ? "border-brand bg-brand/10 text-foreground" : "border-border hover:bg-accent",
                  )}
                >
                  <input
                    type={q.kind === "single" ? "radio" : "checkbox"}
                    name={q.id}
                    checked={on}
                    onChange={() => toggle(o.label)}
                    className="accent-[var(--brand)]"
                  />
                  {o.label}
                </label>
              );
            })
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            {q.answered && (
              <button className="btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
            <button className="btn-primary" disabled={!answer || busy} onClick={submit}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {q.answered ? "Change answer" : "Answer"}
            </button>
          </div>
        </div>
      ) : (
        last && (
          <div className="flex items-center gap-3 px-4 pb-4 pl-12 pt-2 text-sm">
            <span className="rounded-md bg-secondary px-2.5 py-1 font-medium text-secondary-foreground">
              {last.text}
            </span>
            {last.state === "pending" && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            {(last.state === "queued" || last.state === "failed") && <SyncBadge a={last} />}
            <button className="btn-ghost ml-auto" onClick={() => setEditing(true)}>
              Change
            </button>
          </div>
        )
      )}
    </div>
  );
}
