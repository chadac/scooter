"use client";

/**
 * The SyntaxHighlighter slot of assistant-ui's markdown primitive: a fenced code block
 * rendered as highlight.js tokens (src/codeHighlight.ts) inside the thread's own
 * <Pre>/<Code> components, so the frame, copy header and padding are the plain block's.
 * The hast tree becomes React elements through the JSX runtime, never innerHTML. A
 * language with no grammar renders the raw text, as before.
 *
 * The highlighter (core + grammars) is its own chunk, fetched on the first fenced block
 * rather than with the app: that block renders plain for one round-trip, and every block
 * after is coloured synchronously, token by token while streaming.
 *
 * Token colours live in globals.css under `.aui-md .hljs-*`.
 */

import { Fragment, memo, useEffect, useMemo, useState, type FC } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";

type Highlighter = typeof import("@/src/codeHighlight");

let highlighter: Highlighter | undefined;
let loading: Promise<Highlighter> | undefined;

/** Load the highlighter chunk once; resolves to the module and keeps it for sync use. */
export function preloadHighlighter(): Promise<Highlighter> {
  return (loading ??= import("@/src/codeHighlight").then((m) => (highlighter = m)));
}

const SyntaxHighlighterImpl: FC<Omit<SyntaxHighlighterProps, "node">> = ({
  components: { Pre, Code },
  language,
  code,
}) => {
  const [ready, setReady] = useState(highlighter !== undefined);
  useEffect(() => {
    if (ready) return;
    let live = true;
    preloadHighlighter().then(
      () => live && setReady(true),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [ready]);

  const tree = useMemo(
    () => (ready && highlighter ? highlighter.highlightCode(language, code) : null),
    [ready, language, code],
  );
  const children = useMemo(
    () => (tree ? toJsxRuntime(tree, { Fragment, jsx, jsxs }) : code),
    [tree, code],
  );
  return (
    <Pre>
      <Code className={tree ? "hljs" : undefined} data-highlighted={tree ? language : undefined}>
        {children}
      </Code>
    </Pre>
  );
};

export const SyntaxHighlighter = memo(SyntaxHighlighterImpl);
