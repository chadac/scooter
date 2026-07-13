/**
 * UI unit test — the Services panel (pure view).
 *
 * Renders NOTHING when no services are declared (invisible until an agent enables
 * one); when open, shows a Start button for a stopped service and an Open link for
 * a running one (explicit-start model).
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ServicesPanelView } from "./ServicesPanel.js";

const noop = () => {};

describe("ServicesPanelView", () => {
  it("renders NOTHING when there are no services", () => {
    const html = renderToStaticMarkup(
      createElement(ServicesPanelView, { services: [], open: false, starting: {}, onToggle: noop, onStart: noop }),
    );
    expect(html).toBe("");
  });

  it("shows the toggle with a count but no list when collapsed", () => {
    const html = renderToStaticMarkup(
      createElement(ServicesPanelView, {
        services: [{ name: "marimo", displayName: "marimo", url: "/c/x/marimo/", running: false }],
        open: false, starting: {}, onToggle: noop, onStart: noop,
      }),
    );
    expect(html).toContain("services-panel");
    expect(html).toContain("Services (1)");
    expect(html).not.toContain("service-item");
  });

  it("open: a stopped service shows Start; a running one shows an Open link", () => {
    const html = renderToStaticMarkup(
      createElement(ServicesPanelView, {
        services: [
          { name: "marimo", displayName: "marimo", url: "/c/x/marimo/", running: false },
          { name: "term", displayName: "Terminal", url: "/c/x/term/", running: true },
        ],
        open: true, starting: {}, onToggle: noop, onStart: noop,
      }),
    );
    expect(html).toContain("service-start"); // marimo (stopped)
    expect(html).toContain("service-open"); // term (running)
    expect(html).toContain('href="/c/x/term/"');
  });

  it("a service mid-start shows Starting… and is disabled", () => {
    const html = renderToStaticMarkup(
      createElement(ServicesPanelView, {
        services: [{ name: "marimo", displayName: "marimo", url: "/c/x/marimo/", running: false }],
        open: true, starting: { marimo: true }, onToggle: noop, onStart: noop,
      }),
    );
    expect(html).toContain("Starting…");
    expect(html).toContain("disabled");
  });
});
