import { useMemo, useState } from "react";
import { File, type LineAnnotation, type SelectedLineRange } from "@pierre/diffs/react";
import { outbox, type Thread } from "./api";
import { Composer, ThreadCard } from "./Thread";
import { useNarrow } from "./media";

type Meta = { kind: "thread"; thread: Thread } | { kind: "draft"; range: SelectedLineRange };

const MAX_QUOTE = 4000;

/** The anchor for a selected range: its first line, and its text as the quote. */
function anchorOf(lines: string[], range: SelectedLineRange) {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  let quote = lines.slice(start - 1, end).join("\n");
  if (new TextEncoder().encode(quote).length > MAX_QUOTE) quote = lines[start - 1] ?? "";
  return { line: start, end, quote };
}

export function CodePane({
  path,
  body,
  threads,
  dark,
  onChange,
}: {
  path: string;
  body: string;
  threads: Thread[];
  dark: boolean;
  onChange: () => void;
}) {
  const [draft, setDraft] = useState<SelectedLineRange | null>(null);
  const lines = useMemo(() => body.split("\n"), [body]);
  // A phone has no room to scroll code sideways.
  const narrow = useNarrow();

  const annotations = useMemo(() => {
    const out: LineAnnotation<Meta>[] = threads
      .filter((t) => !t.stale)
      .map((t) => ({ lineNumber: t.endLine, metadata: { kind: "thread", thread: t } }));
    if (draft) out.push({ lineNumber: Math.max(draft.start, draft.end), metadata: { kind: "draft", range: draft } });
    return out;
  }, [threads, draft]);

  return (
    <File<Meta>
      file={{ name: path, contents: body, cacheKey: `${path}:${body.length}` }}
      selectedLines={draft}
      lineAnnotations={annotations}
      options={{
        theme: { dark: "solarized-dark", light: "solarized-light" },
        themeType: dark ? "dark" : "light",
        overflow: narrow ? "wrap" : "scroll",
        disableFileHeader: true,
        lineHoverHighlight: "both",
        enableLineSelection: true,
        enableGutterUtility: true,
        onGutterUtilityClick: (range) => setDraft(range),
        onLineSelectionEnd: (range) => range && setDraft(range),
      }}
      renderAnnotation={(a) => {
        const m = a.metadata;
        if (m.kind === "thread")
          return (
            <div className="max-w-4xl px-3 py-2">
              <ThreadCard thread={m.thread} path={path} onChange={onChange} />
            </div>
          );
        const anchor = anchorOf(lines, m.range);
        return (
          <div className="m-2 max-w-4xl rounded-lg border border-border bg-card p-3 font-sans text-sm shadow-sm">
            <p className="mb-2 text-xs text-muted-foreground">
              Comment on {anchor.line === anchor.end ? `line ${anchor.line}` : `lines ${anchor.line}–${anchor.end}`}
            </p>
            <Composer
              autoFocus
              placeholder="Leave a comment for the agent…"
              submitLabel="Comment"
              onCancel={() => setDraft(null)}
              onSubmit={async (text) => {
                await outbox.add({ path, line: anchor.line, quote: anchor.quote, text });
                setDraft(null);
                onChange();
              }}
            />
          </div>
        );
      }}
    />
  );
}
