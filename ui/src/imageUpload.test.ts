/**
 * UI unit test — the composer image-upload helpers (multimodal, stage 4).
 * imagesFromContent pulls image parts out of a message; parseDataUrl/base64Bytes
 * are the small utilities; downscaleImage passes through in a non-DOM context (the
 * server still enforces the cap). See docs/MULTIMODAL_IMAGES.md.
 */

import { describe, it, expect } from "vitest";

import {
  imagesFromContent,
  parseDataUrl,
  base64Bytes,
  downscaleImage,
} from "./imageUpload.js";

describe("parseDataUrl", () => {
  it("splits a base64 data URL into mime + data", () => {
    expect(parseDataUrl("data:image/png;base64,QUJD")).toEqual({ mimeType: "image/png", data: "QUJD" });
  });
  it("returns null for a non-data-url", () => {
    expect(parseDataUrl("https://x/y.png")).toBeNull();
    expect(parseDataUrl("nonsense")).toBeNull();
  });
});

describe("base64Bytes", () => {
  it("computes the decoded byte size", () => {
    expect(base64Bytes("QUJD")).toBe(3); // "ABC"
    expect(base64Bytes("QUI=")).toBe(2); // "AB"
    expect(base64Bytes("QQ==")).toBe(1); // "A"
  });
});

describe("imagesFromContent", () => {
  it("extracts assistant-ui image parts (data-url) and our {data,mimeType} parts", () => {
    const out = imagesFromContent([
      { type: "text", text: "look" },
      { type: "image", image: "data:image/png;base64,QUJD" },
      { type: "image", data: "ZZZ", mimeType: "image/webp" },
    ]);
    expect(out).toEqual([
      { mimeType: "image/png", data: "QUJD" },
      { mimeType: "image/webp", data: "ZZZ" },
    ]);
  });

  it("ignores non-array content + non-image parts", () => {
    expect(imagesFromContent("just text")).toEqual([]);
    expect(imagesFromContent([{ type: "text", text: "x" }])).toEqual([]);
    expect(imagesFromContent(undefined)).toEqual([]);
  });

  it("skips a non-data-url image (e.g. a remote URL we can't inline)", () => {
    expect(imagesFromContent([{ type: "image", image: "https://x/y.png" }])).toEqual([]);
  });
});

describe("downscaleImage (non-DOM passthrough)", () => {
  it("returns the source image unchanged when no canvas is available (SSR/tests)", async () => {
    const out = await downscaleImage("data:image/png;base64,QUJD");
    expect(out).toEqual({ mimeType: "image/png", data: "QUJD" });
  });
  it("returns null for a non-data-url", async () => {
    expect(await downscaleImage("not-a-data-url")).toBeNull();
  });
});
