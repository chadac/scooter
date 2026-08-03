/**
 * UI unit — the marimo-embed payload parsing + the invalid-fallback render. The DOM
 * hydration (head injection + island innerHTML) runs in the browser and is verified
 * live on odin; here we lock the pure decode + the graceful fallback.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarimoEmbed, parseEmbedPayload } from "./MarimoEmbed.js";

const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");

describe("parseEmbedPayload", () => {
  it("decodes a valid base64 island payload", () => {
    const body = encode({ islandHtml: "<marimo-island>x</marimo-island>", headHtml: "<script></script>", title: "Chart" });
    expect(parseEmbedPayload(body)).toEqual({
      islandHtml: "<marimo-island>x</marimo-island>",
      headHtml: "<script></script>",
      title: "Chart",
    });
  });

  it("defaults a missing title to null", () => {
    const body = encode({ islandHtml: "<i>", headHtml: "<h>" });
    expect(parseEmbedPayload(body)?.title).toBeNull();
  });

  it("returns null for non-base64 / non-JSON", () => {
    expect(parseEmbedPayload("not base64 @@@")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseEmbedPayload(encode({ islandHtml: "<i>" }))).toBeNull();
    expect(parseEmbedPayload(encode({ headHtml: "<h>" }))).toBeNull();
  });
});

describe("MarimoEmbed (static render)", () => {
  it("renders the figure host for a valid payload (island mounts client-side)", () => {
    const body = encode({ islandHtml: "<marimo-island>x</marimo-island>", headHtml: "<script></script>", title: "My chart" });
    const html = renderToStaticMarkup(createElement(MarimoEmbed, { base64Body: body }));
    expect(html).toContain('data-testid="marimo-embed"');
    expect(html).toContain('data-testid="marimo-embed-host"');
    expect(html).toContain("My chart");
  });

  it("shows the raw body (not silently lost) for an invalid payload", () => {
    const html = renderToStaticMarkup(createElement(MarimoEmbed, { base64Body: "garbage" }));
    expect(html).toContain('data-testid="marimo-embed-invalid"');
    expect(html).toContain("garbage");
  });
});
