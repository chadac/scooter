// Which text becomes math, and which stays literal.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import katex from "katex";

import remarkTexMath from "./remarkTexMath";
import { renderTex } from "./MathSyntax";

const components = {
  "math-inline": ({ children }: { children?: React.ReactNode }) => <i data-m="">{children}</i>,
  "math-display": ({ children }: { children?: React.ReactNode }) => <b data-m="">{children}</b>,
} as never;

const html = (md: string) =>
  renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkTexMath]} components={components}>
      {md}
    </ReactMarkdown>,
  );

describe("remarkTexMath", () => {
  it("reads $$…$$ and \\(…\\) in a sentence as inline math", () => {
    expect(html("cost $$O(n \\log n)$$ here")).toBe('<p>cost <i data-m="">O(n \\log n)</i> here</p>');
    expect(html("so \\(a^2 + b^2\\) holds")).toBe('<p>so <i data-m="">a^2 + b^2</i> holds</p>');
  });

  it("reads $$ blocks, \\[…\\] and ```math fences as display math", () => {
    expect(html("$$\n\\sum_i x_i\n$$")).toBe('<b data-m="">\\sum_i x_i</b>');
    expect(html("\\[\nE = mc^2\n\\]")).toBe('<p><b data-m="">E = mc^2</b></p>');
    expect(html("```math\n\\int_0^1 x\\,dx\n```")).toBe('<b data-m="">\\int_0^1 x\\,dx</b>');
  });

  it("keeps a TeX line break and escaped brackets inside \\(…\\)", () => {
    expect(html("\\(a \\\\ b \\{c\\}\\)")).toBe('<p><i data-m="">a \\\\ b \\{c\\}</i></p>');
  });

  it("leaves single $, code and unclosed delimiters as text", () => {
    expect(html("costs $5 and $10")).toBe("<p>costs $5 and $10</p>");
    expect(html("echo $PATH")).toBe("<p>echo $PATH</p>");
    expect(html("`$$x$$` and `\\(y\\)`")).toBe("<p><code>$$x$$</code> and <code>\\(y\\)</code></p>");
    expect(html("an open \\( paren")).toBe("<p>an open ( paren</p>");
  });
});

describe("renderTex", () => {
  it("renders valid TeX and refuses what does not parse", () => {
    expect(renderTex(katex, "x^2", false)).toContain("katex");
    expect(renderTex(katex, "\\frac{", false)).toBeUndefined();
  });

  it("does not turn \\href into a link, since message text is untrusted", () => {
    const out = renderTex(katex, "\\href{javascript:alert(1)}{x}", false) ?? "";
    expect(out).not.toMatch(/<a[\s>]/);
    expect(out).not.toContain("href=");
  });

  it("shows oversized TeX as source rather than rendering it", () => {
    expect(renderTex(katex, "x".repeat(6000), false)).toBeUndefined();
  });
});
