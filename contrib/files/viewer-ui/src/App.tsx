import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, CircleHelp, Code2, Eye, FileSearch, MessageSquare, Moon, PanelLeft, RefreshCw, Sun } from "lucide-react";
import clsx from "clsx";
import { api, CONVERSATION_URL, threadsOf, type Annotation, type FileView, type Question } from "./api";
import { Tree } from "./Tree";
import { CodePane } from "./CodePane";
import { MarkdownPane } from "./MarkdownPane";
import { ImagePane } from "./ImagePane";
import { HtmlPane } from "./HtmlPane";
import { RetryAll } from "./Thread";
import { current, navigate, onNavigate } from "./nav";
import { useNarrow } from "./media";

function useDark() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("files-theme");
    return saved ? saved === "dark" : media.matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const toggle = () =>
    setDark((d) => {
      localStorage.setItem("files-theme", d ? "light" : "dark");
      return !d;
    });
  return [dark, toggle] as const;
}

/** A doc's first `# ` heading, outside code fences. */
function mdTitle(body: string): string {
  let fence = "";
  for (const line of body.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = "";
      continue;
    }
    if (fence) continue;
    const h = /^\s{0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h)
      return h[1]
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[`*_~]/g, "")
        .trim();
  }
  return "";
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function useLive() {
  const [live, setLive] = useState(() => localStorage.getItem("files-live") !== "off");
  const toggle = () =>
    setLive((l) => {
      localStorage.setItem("files-live", l ? "off" : "on");
      return !l;
    });
  return [live, toggle] as const;
}

export function App() {
  const [{ path, hash }, setLoc] = useState(current);
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState("");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [source, setSource] = useState(false);
  const narrow = useNarrow();
  const [wideTree, setWideTree] = useState(true);
  // Narrow: a drawer, open only while no file is shown.
  const [drawer, setDrawer] = useState(!path);
  useEffect(() => setDrawer(!path), [path]);
  const tree = narrow ? drawer : wideTree;
  const setTree = narrow ? setDrawer : setWideTree;
  const [dark, toggleDark] = useDark();

  useEffect(() => {
    // Rewrite an old-style `#/<file>` link to the canonical address once.
    if (path && !new URLSearchParams(location.search).has("path")) navigate(path, hash, { replace: true });
    return onNavigate(() => setLoc(current()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The open file's etag, so a poll asks only whether it changed.
  const etag = useRef("");
  const shown = useRef(path);
  shown.current = path;

  /** Body, comments and questions together, so question lines always index the body shown. */
  const load = useCallback(async (p: string, fresh = false) => {
    const [f, a, q] = await Promise.all([
      fresh || !etag.current ? api.file(p) : api.fileIfChanged(p, etag.current),
      api.annotations(p).catch(() => [] as Annotation[]),
      api.questions(p).catch(() => ({ questions: [] as Question[], etag: "" })),
    ]);
    // The file moved between the two reads; fetch it again rather than misplace questions.
    let next = f;
    const have = next?.etag ?? etag.current;
    if (q.etag && have && q.etag !== have) next = await api.file(p);
    if (shown.current !== p) return;
    if (next) {
      etag.current = next.etag ?? "";
      setFile(next);
    }
    setAnnotations((old) => (same(old, a) ? old : a));
    setQuestions((old) => (same(old, q.questions) ? old : q.questions));
  }, []);

  useEffect(() => {
    if (!path) return;
    setError("");
    etag.current = "";
    load(path, true).catch((e) => {
      setFile(null);
      setError(String(e.message ?? e));
    });
  }, [path, load]);

  const [live, toggleLive] = useLive();

  // Pending comments flip to delivered once the broker acks. Live, the ack arrives as
  // an event; otherwise poll fast while any are pending.
  useEffect(() => {
    if (!path || live || !annotations.some((a) => a.state === "pending")) return;
    const t = setTimeout(() => load(path).catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [annotations, path, load, live]);

  // Live: the server pushes an event when the file or its notes change, and the page
  // refetches through the ordinary routes (the file costs nothing if it is unchanged).
  useEffect(() => {
    if (!path || !live) return;
    // One load at a time; events that land mid-load fold into one more.
    let busy = false;
    let again = false;
    const refetch = async () => {
      if (busy) return void (again = true);
      busy = true;
      do {
        again = false;
        await load(path).catch(() => {});
      } while (again);
      busy = false;
    };
    let opened = false;
    const es = api.events(path);
    // EventSource reconnects by itself; anything missed while it was down is picked
    // up by refetching on every reopen after the first.
    es.onopen = () => {
      if (opened) refetch();
      opened = true;
    };
    es.addEventListener("file", refetch);
    es.addEventListener("notes", refetch);
    return () => es.close();
  }, [path, live, load]);

  const threads = useMemo(() => threadsOf(annotations), [annotations]);
  const refresh = () => {
    load(path).catch(() => {});
  };
  const md = file?.renderer === "markdown";
  const image = file?.renderer === "image";
  const html = file?.renderer === "html";
  // Rendered by default, with a Source toggle: markdown, HTML, and SVGs (images with a body).
  const previewable = md || html || (image && !!file?.body);
  const open = threads.filter((t) => !t.resolved).length;
  const unanswered = questions.filter((q) => !q.answered).length;

  // Tab title: the doc's heading, else the filename.
  const shownFile = file && file.path === path ? file : null;
  const docTitle = useMemo(() => {
    if (shownFile?.renderer === "markdown") return mdTitle(shownFile.body);
    if (shownFile?.renderer === "html") return new DOMParser().parseFromString(shownFile.body, "text/html").title.trim();
    return "";
  }, [shownFile]);
  useEffect(() => {
    const name = path.split("/").pop() || "";
    const label = docTitle || name;
    document.title = label ? `${label} · Files` : "Files";
  }, [path, docTitle]);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-header px-2 font-sans text-sm md:px-3">
        {CONVERSATION_URL && (
          <>
            <a className="icon-btn gap-1 md:w-auto md:px-2" href={CONVERSATION_URL} title="Back to the conversation">
              <ArrowLeft className="size-4" />
              <span className="max-md:sr-only">Conversation</span>
            </a>
            <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
          </>
        )}
        <button className="icon-btn" onClick={() => setTree(!tree)} title="Toggle file tree">
          <PanelLeft className="size-4" />
        </button>
        <nav aria-label="Path" className="flex min-w-0 items-center gap-0.5 text-muted-foreground">
          {/* Narrow, only the filename fits; the tree shows its folder. */}
          {(path ? path.split("/") : ["Files"]).slice(narrow ? -1 : 0).map((part, i, all) => (
            <span key={i} className={clsx("flex items-center gap-0.5", i === all.length - 1 ? "min-w-0" : "shrink-0")}>
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 opacity-50" />}
              <span className={clsx("truncate", i === all.length - 1 && "font-medium text-foreground")}>{part}</span>
            </span>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-2">
          {unanswered > 0 && (
            <span className="pill flex items-center gap-1 bg-brand/15 text-brand" title={`${unanswered} unanswered`}>
              <CircleHelp className="size-3 md:hidden" />
              {unanswered}
              <span className="max-md:sr-only">question{unanswered > 1 ? "s" : ""}</span>
            </span>
          )}
          {/* The preview's rail shows its own count. */}
          {open > 0 && !(md && !source) && (
            <span className="pill flex items-center gap-1 bg-warning/15 text-warning" title={`${open} open`}>
              <MessageSquare className="size-3 md:hidden" />
              {open}
              <span className="max-md:sr-only">open comment{open > 1 ? "s" : ""}</span>
            </span>
          )}
          <RetryAll failed={annotations.filter((a) => a.state === "failed")} onChange={refresh} />
          {previewable && (
            <div className="flex rounded-md border border-border p-0.5">
              <button className={clsx("seg", !source && "seg-on")} onClick={() => setSource(false)} title="Preview">
                <Eye className="size-3.5" />
                <span className="max-md:sr-only">Preview</span>
              </button>
              <button className={clsx("seg", source && "seg-on")} onClick={() => setSource(true)} title="Source">
                <Code2 className="size-3.5" />
                <span className="max-md:sr-only">Source</span>
              </button>
            </div>
          )}
          <span aria-hidden className="mx-0.5 h-5 w-px bg-border max-md:hidden" />
          <button
            className={clsx("icon-btn", live && "text-brand")}
            onClick={toggleLive}
            title={live ? "Auto-refresh on: click to pause" : "Auto-refresh paused: click to resume"}
            aria-pressed={live}
          >
            <RefreshCw className="size-4" />
          </button>
          <button className="icon-btn" onClick={toggleDark} title="Toggle theme">
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {tree && narrow && path && (
          <div aria-hidden className="absolute inset-0 z-30 bg-black/30" onClick={() => setDrawer(false)} />
        )}
        {tree && (
          <aside
            className={clsx(
              "shrink-0 overflow-y-auto border-r border-border bg-sidebar p-2",
              narrow ? "absolute inset-y-0 left-0 z-40 w-[min(20rem,85vw)] shadow-xl" : "w-64",
            )}
          >
            <Tree
              selected={path}
              onSelect={(p) => {
                setDrawer(false);
                navigate(p);
              }}
            />
          </aside>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          {error && <p className="m-6 font-sans text-sm text-destructive">{error}</p>}
          {!path && !error && (
            <div className="m-auto flex flex-col items-center gap-2 font-sans text-sm text-muted-foreground">
              <FileSearch className="size-8 opacity-40" />
              Pick a file from the tree.
            </div>
          )}
          {file && file.path === path && (file.renderer === "binary" || file.renderer === "too-large") && (
            <div className="m-auto font-sans text-sm text-muted-foreground">
              {file.renderer === "binary" ? "Binary file, not shown." : "Too large to show."}
            </div>
          )}
          {file && file.path === path && image && !(previewable && source) && <ImagePane file={file} />}
          {file && file.path === path && html && !source && <HtmlPane path={path} body={file.body} />}
          {file && file.path === path && md && !source && (
            <MarkdownPane
              path={path}
              hash={hash}
              body={file.body}
              threads={threads}
              questions={questions}
              onChange={refresh}
            />
          )}
          {file && file.path === path && (file.renderer === "code" || (previewable && source)) && (
            <div className="min-h-0 flex-1 overflow-auto">
              <CodePane path={path} body={file.body} threads={threads} dark={dark} onChange={refresh} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
