/**
 * UI unit test — the linked-resource provider icons.
 *
 * This is the test that catches the `SiSlack` breakage: react-icons dropped the
 * Slack mark, so the import resolved to `undefined` and the sidebar icon broke
 * (only `tsc` caught it, and only in CI). We RENDER SourceBadge to static markup
 * for every known provider — rendering actually invokes the icon component, so a
 * dropped/renamed icon (an undefined `Icon`) throws here. A fast unit test now
 * guards it, not just the type-check.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { sourceLabel, SourceBadge } from "./sourceIcon.js";

const KNOWN = ["github", "gitlab", "slack", "jira"];

describe("sourceIcon", () => {
  it("RENDERS a real icon for every known provider (catches a dropped icon import)", () => {
    for (const source of KNOWN) {
      // renderToStaticMarkup invokes the icon component; an undefined Icon (the
      // SiSlack failure mode) throws here. We also assert non-empty SVG output.
      const html = renderToStaticMarkup(createElement(SourceBadge, { source }));
      expect(html).toContain("source-icon");
      expect(html).toContain("<svg"); // a real react-icons component renders an <svg>
    }
  });

  it("renders a fallback (no <svg>) for an unknown provider without throwing", () => {
    const html = renderToStaticMarkup(createElement(SourceBadge, { source: "bitbucket" }));
    expect(html).toContain("source-icon");
    expect(html).not.toContain("<svg");
  });

  it("sourceLabel returns the brand label for known providers", () => {
    expect(sourceLabel("github")).toBe("GitHub");
    expect(sourceLabel("gitlab")).toBe("GitLab");
    expect(sourceLabel("slack")).toBe("Slack");
    expect(sourceLabel("jira")).toBe("Jira");
  });

  it("sourceLabel falls back to the raw source for unknown providers", () => {
    expect(sourceLabel("bitbucket")).toBe("bitbucket");
  });
});
