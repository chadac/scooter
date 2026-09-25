/**
 * UI unit test — the linked-resources panel's collapse default.
 *
 * SSR render (the house style, no jsdom) of the pure `LinkedResourcesPanel`, which is
 * exactly what first paint shows: a short list is expanded, a long one (>= 5) starts
 * collapsed so it can't crowd out the session list beside it. Clicking the toggle is a
 * DOM interaction and is covered by the Playwright e2e.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LinkedResourcesPanel, AUTO_COLLAPSE_AT } from "./LinkedResources.js";
import type { ConversationLink } from "./client.js";

const links = (n: number): ConversationLink[] =>
  Array.from({ length: n }, (_, i) => ({
    source: "github",
    resourceType: "pull_request",
    url: `https://github.com/example-org/example-app/pull/${i + 1}`,
    title: `example-app #${i + 1}`,
  }));

const render = (n: number) => renderToStaticMarkup(createElement(LinkedResourcesPanel, { links: links(n) }));

describe("LinkedResourcesPanel", () => {
  it("renders nothing when there are no links", () => {
    expect(render(0)).toBe("");
  });

  it("starts expanded below the auto-collapse threshold", () => {
    const html = render(AUTO_COLLAPSE_AT - 1);
    expect(html).toContain('data-testid="linked-resources"');
    expect(html).toContain('aria-expanded="true"');
    expect(html.match(/data-testid="linked-resource"/g) ?? []).toHaveLength(AUTO_COLLAPSE_AT - 1);
  });

  it("starts collapsed at or above the threshold, still showing the count", () => {
    const html = render(AUTO_COLLAPSE_AT);
    expect(html).toContain('data-testid="linked-resources-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`Linked (${AUTO_COLLAPSE_AT})`);
    expect(html).not.toContain('data-testid="linked-resource"');
  });
});
