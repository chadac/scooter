/**
 * UI unit test — the scooter-embed parser + ShareEmbed render (pure). Covers UUID
 * extraction from uuid/path/url, width/height clamping + centering, and the security
 * invariants: the iframe src is a /s/<uuid>/ path (never external) and it is sandboxed
 * without allow-same-origin.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ShareEmbed, parseShareEmbed, extractShareUuid } from "./ShareEmbed.js";

const UUID = "7f3c2a1e-1b2c-4d5e-8f90-abcdef012345";

describe("extractShareUuid", () => {
  it("accepts a bare uuid", () => {
    expect(extractShareUuid(UUID)).toBe(UUID);
  });
  it("accepts a /s/<uuid>/ path and a full url", () => {
    expect(extractShareUuid(`/s/${UUID}/`)).toBe(UUID);
    expect(extractShareUuid(`https://scooter.example.com/s/${UUID}/report.html`)).toBe(UUID);
  });
  it("rejects non-share input (no external urls)", () => {
    expect(extractShareUuid("https://evil.com/")).toBeNull();
    expect(extractShareUuid("not-a-uuid")).toBeNull();
  });
});

describe("parseShareEmbed", () => {
  it("parses share + width/height/center, clamping oversize width", () => {
    const p = parseShareEmbed(`share: ${UUID}\nwidth: 99999\nheight: 300\ncenter: true`);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.spec.uuid).toBe(UUID);
      expect(p.spec.width).toBe(1200); // clamped to MAX_WIDTH
      expect(p.spec.height).toBe(300);
      expect(p.spec.center).toBe(true);
    }
  });
  it("defaults width/height and ignores comments/blank lines", () => {
    const p = parseShareEmbed(`# a chart\n\nshare: ${UUID}\n`);
    expect(p.ok).toBe(true);
    if (p.ok) expect([p.spec.width, p.spec.height, p.spec.center]).toEqual([640, 420, false]);
  });
  it("errors when no valid share is given", () => {
    const p = parseShareEmbed(`share: https://evil.com/`);
    expect(p.ok).toBe(false);
  });
});

describe("ShareEmbed render", () => {
  it("renders a sandboxed iframe whose src is the share path, not external", () => {
    const html = renderToStaticMarkup(createElement(ShareEmbed, { body: `share: ${UUID}` }));
    expect(html).toContain(`/s/${UUID}/`);
    expect(html).toContain('sandbox="allow-scripts allow-popups"');
    expect(html).not.toContain("allow-same-origin");
  });
  it("shows an error (not an iframe) for a bad spec", () => {
    const html = renderToStaticMarkup(createElement(ShareEmbed, { body: "share: nope" }));
    expect(html).toContain('data-testid="share-embed-error"');
    expect(html).not.toContain("<iframe");
  });
});
