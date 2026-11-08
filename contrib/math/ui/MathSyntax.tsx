// TeX elements drawn with KaTeX, which loads on first use.

import { Children, useEffect, useState, type ReactNode } from "react";

import type { MarkdownSyntax, MarkdownSyntaxElementProps } from "@/src/contrib/sdk";

import remarkTexMath from "./remarkTexMath";

type Katex = typeof import("katex").default;

// Longer TeX shows as source, so one message cannot stall.
const MAX_SOURCE = 5000;

let katex: Katex | undefined;
let loading: Promise<Katex> | undefined;
const loadKatex = () =>
  (loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => (katex = m.default)));

/** KaTeX's HTML, or undefined if `tex` will not parse. */
export function renderTex(k: Katex, tex: string, displayMode: boolean): string | undefined {
  if (tex.length > MAX_SOURCE) return undefined;
  try {
    return k.renderToString(tex, {
      displayMode,
      output: "htmlAndMathml",
      throwOnError: true,
      // Message text is untrusted: no links, images or classes.
      trust: false,
      strict: "ignore",
      maxSize: 50,
      maxExpand: 500,
    });
  } catch {
    return undefined;
  }
}

const textOf = (children: ReactNode): string =>
  Children.toArray(children)
    .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : ""))
    .join("");

function useKatex(): Katex | undefined {
  const [k, setK] = useState(katex);
  useEffect(() => {
    if (k) return;
    let live = true;
    loadKatex().then(
      (m) => live && setK(m),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [k]);
  return k;
}

function Tex({ children, display }: MarkdownSyntaxElementProps & { display: boolean }) {
  const tex = textOf(children);
  const k = useKatex();
  const html = k && renderTex(k, tex, display);
  const cls = display ? "math-display my-3 block overflow-x-auto overflow-y-hidden" : "math-inline";
  if (html === undefined) {
    return <code className={`${cls} font-mono text-[0.85em]`} data-tex-source="">{tex}</code>;
  }
  // Safe: trust is off, so KaTeX emits no links or scripts.
  return <span className={cls} title={tex} dangerouslySetInnerHTML={{ __html: html }} />;
}

const syntax: MarkdownSyntax = {
  remarkPlugins: [remarkTexMath],
  components: {
    "math-inline": ({ children }) => <Tex display={false}>{children}</Tex>,
    "math-display": ({ children }) => <Tex display>{children}</Tex>,
  },
};

export default syntax;
