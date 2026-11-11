/**
 * FoldedContent: a closed fold keeps its content in the DOM (hidden, for find-in-page)
 * rather than unmounting it; an open one shows it.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FoldedContent } from "./FoldedContent.js";

describe("FoldedContent", () => {
  it("renders closed content hidden but present, so the browser can find it", () => {
    const html = renderToStaticMarkup(
      createElement(FoldedContent, { open: false, onReveal: () => {}, className: "body" }, "needle in the output"),
    );
    expect(html).toBe('<div hidden="" data-state="closed" class="body">needle in the output</div>');
  });

  it("renders open content visible", () => {
    const html = renderToStaticMarkup(
      createElement(FoldedContent, { open: true, onReveal: () => {} }, "shown"),
    );
    expect(html).toBe('<div data-state="open">shown</div>');
  });
});
