import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageSquare, MessageSquarePlus, X } from "lucide-react";
import clsx from "clsx";
import { outbox, rawUrl, type Question, type Thread } from "./api";
import { hrefFor, isExternal, navigate, resolveRel, slug } from "./nav";
import { BLOCKS, blockAt, blockSource, findText, plainOf, previewOf, rehypeSourceLines, segments, sourceAnchor, remarkHtmlImages, remarkInlineImages } from "./markdown";
import { Composer, Quote, ThreadCard } from "./Thread";
import { QuestionCard } from "./Questions";
import { CodeBlock } from "./CodeBlock";
import { Diagram, diagramLang } from "./Diagram";
import { useMedia, useNarrow } from "./media";

const components: Components = {
  pre: ({ children, node, ...rest }) => {
    const code = node?.children[0];
    if (code?.type === "element" && code.tagName === "code") {
      const cls = (code.properties.className as string[] | undefined) ?? [];
      const lang = cls.find((c) => c.startsWith("language-"))?.slice(9) ?? "";
      const text = code.children
        .map((c) => (c.type === "text" ? c.value : ""))
        .join("")
        .replace(/\n$/, "");
      const diagram = diagramLang(lang);
      return (
        <div
          data-code
          data-line={rest["data-line" as keyof typeof rest] as string}
          data-line-end={rest["data-line-end" as keyof typeof rest] as string}
        >
          {diagram ? <Diagram lang={diagram} code={text} /> : <CodeBlock lang={lang} code={text} />}
        </div>
      );
    }
    return <pre {...rest}>{children}</pre>;
  },
  a: DocLink,
  img: DocImage,
};

/** The open document's path, which relative links and images resolve against. */
const DocPath = createContext("");

/** A link in a document: in-page anchors scroll, workspace files open in the viewer. */
function DocLink({ node: _n, href = "", ...props }: React.ComponentProps<"a"> & { node?: unknown }) {
  const path = useContext(DocPath);
  if (isExternal(href)) return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
  const [rel, frag = ""] = href.split("#");
  // `#x` stays in this document; anything else is a file under the workspace.
  const target = rel ? resolveRel(path, rel) : path;
  return (
    <a
      {...props}
      href={hrefFor(target, frag)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(target, frag, { replace: target === path });
      }}
    />
  );
}

/** Images in a document are workspace files, read through /api/raw. */
function DocImage({ node: _n, src, ...props }: React.ComponentProps<"img"> & { node?: unknown }) {
  const path = useContext(DocPath);
  // Absolute paths go as written: the server reads /workspace/… as a host path.
  const url =
    typeof src === "string" && src && !isExternal(src)
      ? rawUrl(src.startsWith("/") ? src : resolveRel(path, src))
      : src;
  return <img {...props} src={url} loading="lazy" />;
}

const Chunk = memo(function Chunk({ text, offset }: { text: string; offset: number }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkHtmlImages, remarkInlineImages]}
      rehypePlugins={[[rehypeSourceLines, { offset }]]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
});

type Draft = { line: number; quote: string };
type Heading = { id: string; text: string; level: number };

// Doc column (64rem) plus contents column (14rem).
const TOC_MIN_WIDTH = (64 + 14) * 16;

/** The document's h1–h3, linking each section and marking the one in view. */
function Contents({
  toc,
  active,
  path,
  inRail,
  folded,
}: {
  toc: Heading[];
  active: string;
  path: string;
  inRail?: boolean;
  folded?: boolean;
}) {
  const top = Math.min(...toc.map((h) => h.level));
  const list = (
    <ul className="flex flex-col gap-0.5 border-l border-border">
      {toc.map((h) => (
        <li key={h.id}>
          <a
            href={hrefFor(path, h.id)}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate(path, h.id, { replace: true });
              document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            style={{ paddingLeft: `${0.75 + (h.level - top) * 0.75}rem` }}
            className={clsx(
              "-ml-px block truncate border-l py-0.5 pr-2 transition-colors",
              h.id === active
                ? "border-brand font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            title={h.text}
          >
            {h.text}
          </a>
        </li>
      ))}
    </ul>
  );
  const label = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";
  // Narrow: a collapsible block atop the comment rail, rather than squeezing the doc.
  if (inRail)
    return (
      <details open={!folded} className="font-sans text-sm" aria-label="Contents">
        <summary className={clsx(label, "mb-2 cursor-pointer select-none")}>Contents</summary>
        <nav aria-label="Contents" className="max-h-64 overflow-y-auto">
          {list}
        </nav>
      </details>
    );
  return (
    <nav
      aria-label="Contents"
      className="sticky top-0 max-h-full w-56 shrink-0 self-start overflow-y-auto py-10 pl-6 font-sans text-sm"
    >
      <p className={clsx(label, "mb-2")}>Contents</p>
      {list}
    </nav>
  );
}
type Pop = { top: number; left: number; anchor: Draft };

// The server's quote cap; longer blocks quote their first line.
const MAX_QUOTE = 4000;

function blockAnchor(body: string, el: HTMLElement): Draft {
  const start = Number(el.dataset.line);
  const end = Number(el.dataset.lineEnd ?? start);
  let quote = blockSource(body, start, end);
  if (new TextEncoder().encode(quote).length > MAX_QUOTE) quote = blockSource(body, start, start);
  return { line: start, quote };
}

type Mark = { top: number; ids: string[]; open: number };
type Hover = { top: number; el: HTMLElement };

export function MarkdownPane({
  path,
  hash,
  body,
  threads,
  questions,
  onChange,
}: {
  path: string;
  hash: string;
  body: string;
  threads: Thread[];
  questions: Question[];
  onChange: () => void;
}) {
  const doc = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [active, setActive] = useState<string | null>(null);
  // Counted, so re-picking a thread unfolds it again. Card clicks don't count.
  const [reveal, setReveal] = useState<{ id: string; n: number }>({ id: "", n: 0 });
  const narrow = useNarrow();
  // No hover to find the margin button by, so a tap shows it.
  const touch = useMedia("(pointer: coarse)");
  // Narrow, the comment rail is a bottom sheet over the doc.
  const [sheet, setSheet] = useState(false);
  /** Selects a thread and brings its card into view. */
  const pick = (id: string) => {
    setActive(id);
    setReveal((r) => ({ id, n: r.n + 1 }));
    setSheet(true);
    // Next frame: cards in a hidden sheet have no box.
    requestAnimationFrame(() =>
      document.getElementById(`thread-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
  };
  const ranges = useRef(new Map<string, Range>());
  // Block threads: no highlight and no click-to-jump; the margin marker shows them.
  const whole = useRef(new Set<string>());
  const [marks, setMarks] = useState<Mark[]>([]);
  const [hover, setHover] = useState<Hover | null>(null);
  const segs = useMemo(() => segments(body), [body]);
  // By id, not line: an agent's edit above a block moves its line but not its id.
  const qById = useMemo(() => new Map(questions.map((q) => [q.id, q])), [questions]);
  const [toc, setToc] = useState<Heading[]>([]);

  // Heading ids, set on the DOM across every chunk so two "Design" sections get
  // design and design-2, then the address's #heading is scrolled to.
  useLayoutEffect(() => {
    const root = doc.current;
    if (!root) return;
    const seen = new Map<string, number>();
    root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach((h) => {
      const base = slug(h.textContent ?? "");
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      h.id = n > 1 ? `${base}-${n}` : base;
    });
    const found = [...root.querySelectorAll<HTMLElement>("h1, h2, h3")].map((h) => ({
      id: h.id,
      text: h.textContent ?? "",
      level: Number(h.tagName[1]),
    }));
    setToc((old) => (JSON.stringify(old) === JSON.stringify(found) ? old : found));
  }, [segs]);
  // Once per address, so an auto-refresh of the body never yanks the reader back.
  const scrolledTo = useRef("");
  useEffect(() => {
    const key = `${path}#${hash}`;
    if (!hash || scrolledTo.current === key) return;
    const el = document.getElementById(hash);
    if (!el) return;
    scrolledTo.current = key;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [path, hash, segs]);

  // Custom Highlight API, so React's DOM is untouched.
  useLayoutEffect(() => {
    const root = doc.current;
    const col = wrap.current;
    if (!root || !col) return;
    const paint = () => {
      ranges.current.clear();
      whole.current.clear();
      const open: Range[] = [];
      const done: Range[] = [];
      const top = col.getBoundingClientRect().top;
      const byBlock = new Map<HTMLElement, Mark>();
      const rangeOf = (line: number, quote: string) => {
        const block = blockAt(root, line);
        const q = plainOf(quote);
        const all = !q || (!!block && plainOf(blockAnchor(body, block).quote) === q);
        let r = q && !all ? (block && findText(block, q)) || findText(root, q) : null;
        if (!r && block) {
          r = document.createRange();
          r.selectNodeContents(block);
        }
        return { block, r, all: all || !q };
      };
      for (const t of threads) {
        if (t.stale) continue;
        const { block, r, all } = rangeOf(t.line, t.quote);
        if (!r) continue;
        ranges.current.set(t.id, r);
        if (all) whole.current.add(t.id);
        else (t.resolved ? done : open).push(r);
        if (block) {
          const m = byBlock.get(block) ?? { top: block.getBoundingClientRect().top - top, ids: [], open: 0 };
          m.ids.push(t.id);
          if (!t.resolved) m.open++;
          byBlock.set(block, m);
        }
      }
      const next = [...byBlock.values()];
      setMarks((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
      if (!("highlights" in CSS)) return;
      CSS.highlights.set("comment", new Highlight(...open));
      CSS.highlights.set("comment-resolved", new Highlight(...done));
      const a = (active && ranges.current.get(active)) || (draft && rangeOf(draft.line, draft.quote).r);
      if (a) CSS.highlights.set("comment-active", new Highlight(a));
      else CSS.highlights.delete("comment-active");
    };
    paint();
    // Repaint after async code highlighting and on reflow.
    const mo = new MutationObserver(paint);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(paint);
    ro.observe(root);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [threads, active, body, draft]);

  // By height, not e.target: the margin and gaps between blocks are in no block.
  const hoverAt = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-gutter]")) return;
    const root = doc.current;
    const col = wrap.current;
    if (!root || !col) return;
    const y = e.clientY;
    let best: HTMLElement | null = null;
    let bestH = Infinity;
    for (const el of root.querySelectorAll<HTMLElement>(BLOCKS)) {
      if (el.closest("[data-question]")) continue;
      const r = el.getBoundingClientRect();
      // Innermost, so a loose list item's <p> beats the <li>.
      if (y >= r.top && y <= r.bottom && r.height < bestH) {
        best = el;
        bestH = r.height;
      }
    }
    // In a gap, keep the last block so the button doesn't flicker.
    if (!best) return;
    const top = best.getBoundingClientRect().top - col.getBoundingClientRect().top;
    setHover((h) => (h?.el === best && h.top === top ? h : { el: best, top }));
  }, []);

  const onMouseUp = useCallback(() => {
    const sel = window.getSelection();
    const root = doc.current;
    const col = wrap.current;
    if (!sel || sel.isCollapsed || !root || !col || !root.contains(sel.anchorNode)) return setPop(null);
    const range = sel.getRangeAt(0);
    const start = range.startContainer;
    const el = (start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement) as HTMLElement | null;
    const block = el?.closest<HTMLElement>("[data-line]");
    if (!block) return setPop(null);
    const anchor = sourceAnchor(body, Number(block.dataset.line), sel.toString());
    const rect = range.getBoundingClientRect();
    const box = col.getBoundingClientRect();
    // Touch: below the selection, clear of the system copy menu.
    const top = touch ? rect.bottom - box.top + 12 : rect.top - box.top - 40;
    const left = Math.min(Math.max(rect.left - box.left + rect.width / 2, 60), box.width - 60);
    setPop({ top, left, anchor });
  }, [body, touch]);

  // Touch selections fire no mouseup; follow selectionchange instead.
  useEffect(() => {
    if (!touch) return;
    document.addEventListener("selectionchange", onMouseUp);
    return () => document.removeEventListener("selectionchange", onMouseUp);
  }, [touch, onMouseUp]);

  // New comments are written in the sheet, so open it.
  useEffect(() => {
    if (draft) setSheet(true);
  }, [draft]);

  const commentOnBlock = (el: HTMLElement) => {
    setActive(null);
    setPop(null);
    window.getSelection()?.removeAllRanges();
    setDraft(blockAnchor(body, el));
  };

  // A click inside a highlighted quote opens its thread.
  const onClick = useCallback((e: React.MouseEvent) => {
    const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    if (pos)
      for (const [id, r] of ranges.current)
        if (!whole.current.has(id) && r.isPointInRange(pos.offsetNode, pos.offset)) {
          pick(id);
          return;
        }
    if (touch) hoverAt(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touch, hoverAt]);

  const focusThread = (t: Thread) => {
    setActive(t.id);
    const r = ranges.current.get(t.id);
    const target = r?.startContainer.parentElement ?? (doc.current && blockAt(doc.current, t.line));
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const openThreads = threads.filter((t) => !t.resolved);

  // Contents sit beside the doc only when there is room; the tree and rail both take width.
  const scroller = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= TOC_MIN_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The section being read: the last heading scrolled past the top.
  const [current, setCurrent] = useState("");
  useEffect(() => {
    const el = scroller.current;
    if (!el || toc.length < 2) return;
    const onScroll = () => {
      const top = el.getBoundingClientRect().top + 24;
      let at = toc[0].id;
      for (const h of toc) {
        const node = document.getElementById(h.id);
        if (node && node.getBoundingClientRect().top <= top) at = h.id;
      }
      setCurrent(at);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [toc]);

  return (
    <div className="flex min-h-0 flex-1">
      <div ref={scroller} className="flex min-w-0 flex-1 overflow-y-auto">
        {wide && toc.length > 1 && <Contents toc={toc} active={current} path={path} />}
        <div
          ref={wrap}
          className="relative mx-auto min-w-0 max-w-5xl flex-1 self-start px-7 pb-24 pt-6 md:px-8 md:py-10"
          onMouseUp={onMouseUp}
          onClick={onClick}
          onMouseMove={touch ? undefined : hoverAt}
          onMouseLeave={touch ? undefined : () => setHover(null)}
        >
          <DocPath.Provider value={path}>
            <article
              ref={doc}
              className="prose prose-stone dark:prose-invert max-w-none prose-headings:scroll-mt-4 prose-pre:p-0"
            >
              {segs.map((s, i) => {
                const q = s.kind === "question" ? qById.get(s.id) : undefined;
                if (s.kind === "question" && q)
                  return (
                    <div key={`q:${s.id}`} data-line={s.line} className="not-prose my-6">
                      <QuestionCard path={path} question={q} onChange={onChange} />
                    </div>
                  );
                return <Chunk key={i} text={s.text} offset={s.offset} />;
              })}
            </article>
          </DocPath.Provider>
          {pop && (
            <button
              className="btn-primary absolute z-10 -translate-x-1/2 shadow-lg"
              style={{ top: pop.top, left: pop.left }}
              onMouseDown={(e) => e.preventDefault()}
              onMouseUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setDraft(pop.anchor);
                setPop(null);
              }}
            >
              <MessageSquarePlus className="size-3.5" /> Comment
            </button>
          )}
          {hover && (
            <button
              data-gutter
              aria-label="Comment on this paragraph"
              title="Comment on this paragraph"
              className="absolute left-0.5 flex size-6 md:left-1 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-brand"
              style={{ top: hover.top }}
              onMouseDown={(e) => e.preventDefault()}
              onMouseUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                commentOnBlock(hover.el);
              }}
            >
              <MessageSquarePlus className="size-4" />
            </button>
          )}
          {marks.map((m) => {
            const on = !!active && m.ids.includes(active);
            const n = m.open || m.ids.length;
            return (
              <button
                key={m.ids[0]}
                data-gutter
                data-mark
                aria-label={`${n} ${m.open ? "open " : "resolved "}comment${n === 1 ? "" : "s"}`}
                title={`${n} ${m.open ? "open" : "resolved"} comment${n === 1 ? "" : "s"}`}
                className={clsx(
                  "absolute right-0.5 flex h-6 md:right-1 min-w-6 items-center justify-center gap-0.5 rounded-full px-1.5 font-sans text-[11px] font-semibold transition-colors",
                  on
                    ? "bg-brand text-brand-foreground"
                    : m.open
                      ? "bg-warning/15 text-warning hover:bg-warning/25"
                      : "bg-muted text-muted-foreground hover:bg-accent",
                )}
                style={{ top: m.top }}
                onMouseUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  const t = threads.find((x) => m.ids.includes(x.id) && !x.resolved) ?? threads.find((x) => x.id === m.ids[0]);
                  if (!t) return;
                  pick(t.id);
                }}
              >
                <MessageSquare className="size-3" />
                {n > 1 && n}
              </button>
            );
          })}
        </div>
      </div>

      {narrow && !sheet && (
        <button
          className="btn-primary fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 rounded-full px-4 py-2.5 text-sm shadow-lg"
          onClick={() => setSheet(true)}
          aria-label="Show comments"
        >
          <MessageSquare className="size-4" />
          {openThreads.length || "Comments"}
        </button>
      )}
      {narrow && sheet && (
        <div aria-hidden className="fixed inset-0 z-30 bg-black/30" onClick={() => setSheet(false)} />
      )}
      <aside
        data-comments
        className={clsx(
          "flex flex-col gap-3 overflow-y-auto border-border p-4",
          narrow
            ? "fixed inset-x-0 bottom-0 z-40 max-h-[75dvh] rounded-t-2xl border-t bg-sidebar pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl"
            : "w-[22rem] shrink-0 border-l bg-sidebar/50",
          narrow && !sheet && "hidden",
        )}
      >
        {narrow && (
          // Sticky, so closing never needs a scroll back up.
          <div className="sticky -top-4 z-10 -mx-4 -mt-4 flex items-center justify-end bg-sidebar px-2 pt-2">
            <span aria-hidden className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-border" />
            <button className="icon-btn" onClick={() => setSheet(false)} aria-label="Close comments">
              <X className="size-4" />
            </button>
          </div>
        )}
        {!wide && toc.length > 1 && <Contents toc={toc} active={current} path={path} inRail folded={narrow} />}
        <h2 className="flex items-center gap-2 font-sans text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Comments
          {openThreads.length > 0 && (
            <span className="pill bg-warning/15 normal-case tracking-normal text-warning">
              {openThreads.length} open
            </span>
          )}
          {threads.length > openThreads.length && (
            <span className="ml-auto font-normal normal-case tracking-normal">
              {threads.length - openThreads.length} resolved
            </span>
          )}
        </h2>
        {draft && (
          <div className="rounded-lg border border-brand bg-card p-3 font-sans text-sm shadow-sm ring-2 ring-brand/30">
            {draft.quote && <Quote text={previewOf(draft.quote)} className="mb-3" />}
            <Composer
              autoFocus
              placeholder="Leave a comment for the agent…"
              submitLabel="Comment"
              onCancel={() => setDraft(null)}
              onSubmit={async (text) => {
                await outbox.add({ path, line: draft.line, quote: draft.quote, text });
                setDraft(null);
                window.getSelection()?.removeAllRanges();
                onChange();
              }}
            />
          </div>
        )}
        {!draft && !threads.length && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center font-sans text-sm text-muted-foreground">
            <MessageSquarePlus className="size-5 opacity-60" />
            {touch ? "Tap a paragraph, then the comment icon in its margin" : "Hover a paragraph and click the comment icon in its margin"}, or
            select a passage to comment on just that.
          </div>
        )}
        {threads.map((t) => (
          <div key={t.id} id={`thread-${t.id}`} onClick={() => focusThread(t)}>
            <ThreadCard thread={t} path={path} onChange={onChange} showQuote active={active === t.id} reveal={reveal.id === t.id ? reveal.n : 0} />
          </div>
        ))}
      </aside>
    </div>
  );
}
