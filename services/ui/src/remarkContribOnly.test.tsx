// User text keeps its source, except contrib-claimed nodes.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

import remarkContribOnly from "./remarkContribOnly.js";

interface Node {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: Node[];
}

// A stand-in contrib syntax: inline code becomes an `x-code` element.
const remarkXCode = () => (tree: Node) => {
  const walk = (n: Node) => {
    if (n.type === "inlineCode") n.data = { hName: "x-code", hChildren: [{ type: "text", value: n.value }] };
    n.children?.forEach(walk);
  };
  walk(tree);
};

const html = (md: string) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkXCode, [remarkContribOnly, { tags: ["x-code"] }]]}
      components={{ p: ({ children }) => <>{children}</>, "x-code": ({ children }: { children?: React.ReactNode }) => <kbd>{children}</kbd> } as never}
    >
      {md}
    </ReactMarkdown>,
  );

describe("remarkContribOnly", () => {
  it("draws the claimed nodes and leaves every other character as typed", () => {
    expect(html("a *b* `c` # d")).toBe("a *b* <kbd>c</kbd> # d");
    expect(html("# title\n\n- item `x`\n> q")).toBe("# title\n\n- item <kbd>x</kbd>\n&gt; q");
  });

  it("is the source alone when nothing is claimed", () => {
    expect(html("**bold** <b>raw</b>")).toBe("**bold** &lt;b&gt;raw&lt;/b&gt;");
    expect(html("")).toBe("");
  });
});
