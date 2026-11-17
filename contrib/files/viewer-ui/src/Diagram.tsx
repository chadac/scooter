import { useEffect, useState } from "react";
import { Code2, Eye } from "lucide-react";
import DOMPurify from "dompurify";
import { CodeBlock } from "./CodeBlock";
import { useDarkTheme } from "./media";

export type DiagramLang = "mermaid" | "dot";

const LANGS: Record<string, DiagramLang> = {
  mermaid: "mermaid",
  mmd: "mermaid",
  dot: "dot",
  gv: "dot",
  graphviz: "dot",
};

/** The diagram language a fence tag or file extension names, if any. */
export const diagramLang = (name: string): DiagramLang | undefined => LANGS[name.toLowerCase()];

type Rendered = { code: string; svg?: string; error?: string };

/** A Mermaid or Graphviz diagram, falling back to its source on errors. */
export function Diagram({ lang, code, toggle = true }: { lang: DiagramLang; code: string; toggle?: boolean }) {
  const dark = useDarkTheme();
  const [out, setOut] = useState<Rendered | null>(null);
  const [source, setSource] = useState(false);
  useEffect(() => {
    let live = true;
    (lang === "mermaid" ? mermaidSvg : dotSvg)(code, dark).then(
      (svg) => live && setOut({ code, svg }),
      (e: unknown) => live && setOut({ code, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [lang, code, dark]);

  const src = <CodeBlock lang={lang} code={code} />;
  if (out?.error && out.code === code)
    return (
      <div data-diagram-error>
        {src}
        <pre className="not-prose mt-1 whitespace-pre-wrap font-mono text-xs text-destructive">{out.error}</pre>
      </div>
    );
  return (
    <div className="group relative" data-diagram={lang}>
      {source || !out?.svg ? (
        src
      ) : (
        <div className="not-prose diagram" dangerouslySetInnerHTML={{ __html: out.svg }} />
      )}
      {toggle && out?.svg && (
        <button
          className="icon-btn absolute right-1 top-1 bg-card opacity-60 group-hover:opacity-100"
          onClick={() => setSource((s) => !s)}
          title={source ? "Show diagram" : "Show source"}
        >
          {source ? <Eye className="size-4" /> : <Code2 className="size-4" />}
        </button>
      )}
    </div>
  );
}

let seq = 0;
let mermaidQueue: Promise<unknown> = Promise.resolve();

// Mermaid's config is global, so renders take turns.
function mermaidSvg(code: string, dark: boolean): Promise<string> {
  const run = mermaidQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
    // Parse first: a failed render leaves an error graphic behind.
    await mermaid.parse(code);
    return (await mermaid.render(`diagram-${++seq}`, code)).svg;
  });
  mermaidQueue = run.catch(() => {});
  return run;
}

async function dotSvg(code: string, dark: boolean): Promise<string> {
  const { instance } = await import("@viz-js/viz");
  const ink = dark ? "#e7e5e4" : "#1c1917";
  // Defaults only: a graph's own colors still win.
  const attrs = { color: ink, fontcolor: ink, fontname: "sans-serif" };
  const svg = (await instance()).renderString(code, {
    format: "svg",
    graphAttributes: { ...attrs, bgcolor: "transparent" },
    nodeAttributes: attrs,
    edgeAttributes: attrs,
  });
  // Graphviz passes URL attributes through as links.
  const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  // Points as pixels: text then matches the page's size.
  return clean.replace(/<svg([^>]*?) width="([\d.]+)pt" height="([\d.]+)pt"/, '<svg$1 width="$2" height="$3"');
}
