import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "./Markdown.js";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("Markdown", () => {
  it("renders GFM", () => {
    const html = render("**bold**\n\n- [x] done\n\n| a |\n| - |\n| b |");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table>");
  });

  it("never renders raw HTML, and drops comments", () => {
    const html = render("<script>alert(1)</script>\n\n<!-- hidden -->\n\nshown");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("hidden");
    expect(html).toContain("shown");
  });

  it("opens links in a new tab and refuses javascript: URLs", () => {
    expect(render("[docs](https://example.com)")).toContain('href="https://example.com" target="_blank" rel="noreferrer"');
    expect(render("[x](javascript:alert(1))")).not.toContain("javascript:");
  });

  it("shows an image as a link to it, so it never loads", () => {
    const html = render("![diagram](https://example.com/a.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="https://example.com/a.png" target="_blank" rel="noreferrer">diagram</a>');
  });
});
