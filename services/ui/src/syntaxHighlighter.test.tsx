/**
 * The markdown SyntaxHighlighter slot (components/assistant-ui/syntax-highlighter.tsx):
 * a known language renders highlight.js token spans inside the thread's Pre/Code, an
 * unknown one renders the raw text, and code is always escaped, never injected.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SyntaxHighlighter, preloadHighlighter } from "@/components/assistant-ui/syntax-highlighter";

const components = {
  Pre: (p: ComponentProps<"pre">) => createElement("pre", { ...p, className: "aui-md-pre" }),
  Code: (p: ComponentProps<"code">) => createElement("code", p),
};

function render(language: string, code: string): string {
  return renderToStaticMarkup(createElement(SyntaxHighlighter, { components, language, code }));
}

describe("SyntaxHighlighter", () => {
  it("renders a block plain until the highlighter chunk has loaded", () => {
    // Nothing has imported the chunk yet, so a static render is the raw code.
    const html = render("python", "def f(x):\n    return x\n");
    expect(html).toBe('<pre class="aui-md-pre"><code>def f(x):\n    return x\n</code></pre>');
  });

  describe("once the highlighter is loaded", () => {
    beforeAll(async () => {
      await preloadHighlighter();
    });

  it("renders a Python block as hljs tokens inside the thread's pre/code", () => {
    const html = render("python", "def f(x):\n    return x\n");
    expect(html).toMatch(/^<pre class="aui-md-pre"><code class="hljs" data-highlighted="python">/);
    expect(html).toContain('<span class="hljs-keyword">def</span>');
    expect(html).toContain('<span class="hljs-title function_">f</span>');
    expect(html).toContain('<span class="hljs-keyword">return</span>');
  });

  it("renders C++, Rust and JavaScript with language-specific tokens", () => {
    expect(render("cpp", "#include <vector>\n")).toContain('<span class="hljs-meta">');
    expect(render("rust", "let mut x: u32 = 1;")).toContain('<span class="hljs-type">u32</span>');
    expect(render("js", "const x = 1;")).toContain('<span class="hljs-keyword">const</span>');
  });

  it("renders an unknown language as the raw code, with no token markup", () => {
    const html = render("unknown", "just some text <b>");
    expect(html).toBe('<pre class="aui-md-pre"><code>just some text &lt;b&gt;</code></pre>');
  });

  it("escapes code: a script tag in a block is text, not markup", () => {
    const html = render("html", '<script>alert("x")</script>');
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;");
    expect(html).toContain('<span class="hljs-tag">');
  });
  });
});
