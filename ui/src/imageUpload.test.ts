/**
 * UI unit test — the composer image-upload helpers (multimodal, stage 4).
 * imagesFromContent pulls image parts out of a message; parseDataUrl/base64Bytes
 * are the small utilities; downscaleImage passes through in a non-DOM context (the
 * server still enforces the cap).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  imagesFromContent,
  imagesFromMessage,
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
  it("extracts assistant-ui image parts (data-url) and our {data,mimeType} parts", async () => {
    const out = await imagesFromContent([
      { type: "text", text: "look" },
      { type: "image", image: "data:image/png;base64,QUJD" },
      { type: "image", data: "ZZZ", mimeType: "image/webp" },
    ]);
    expect(out).toEqual([
      { mimeType: "image/png", data: "QUJD" },
      { mimeType: "image/webp", data: "ZZZ" },
    ]);
  });

  it("ignores non-array content + non-image parts", async () => {
    expect(await imagesFromContent("just text")).toEqual([]);
    expect(await imagesFromContent([{ type: "text", text: "x" }])).toEqual([]);
    expect(await imagesFromContent(undefined)).toEqual([]);
  });

  it("skips a non-data-url image (e.g. a remote URL we can't inline)", async () => {
    expect(await imagesFromContent([{ type: "image", image: "https://x/y.png" }])).toEqual([]);
  });
});

describe("imagesFromMessage (the real composer shape)", () => {
  // @assistant-ui's composer sends { content: [text-only], attachments: [{content:[image]}] }.
  // The image is in attachments[], NOT content — the regression that silently dropped
  // every upload (PR #448). imagesFromMessage must union both.
  it("extracts an image the composer put in message.attachments, not message.content", async () => {
    const message = {
      role: "user",
      content: [{ type: "text", text: "what is this?" }],
      attachments: [
        {
          id: "a1",
          type: "image",
          name: "shot.png",
          contentType: "image/png",
          content: [{ type: "image", image: "data:image/png;base64,QUJD" }],
          status: { type: "complete" },
        },
      ],
    };
    expect(await imagesFromMessage(message)).toEqual([{ mimeType: "image/png", data: "QUJD" }]);
  });

  it("unions images from BOTH content and attachments", async () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "image", image: "data:image/png;base64,QQ==" },
      ],
      attachments: [
        { id: "a1", content: [{ type: "image", image: "data:image/webp;base64,ZZZ" }] },
      ],
    };
    expect(await imagesFromMessage(message)).toEqual([
      { mimeType: "image/png", data: "QQ==" },
      { mimeType: "image/webp", data: "ZZZ" },
    ]);
  });

  it("handles a text-only message (no attachments field)", async () => {
    expect(await imagesFromMessage({ role: "user", content: [{ type: "text", text: "hi" }] })).toEqual([]);
    expect(await imagesFromMessage({ content: "plain string" })).toEqual([]);
    expect(await imagesFromMessage(undefined)).toEqual([]);
  });

  it("handles multiple attachments", async () => {
    const message = {
      content: [],
      attachments: [
        { content: [{ type: "image", image: "data:image/png;base64,AAA=" }] },
        { content: [{ type: "image", image: "data:image/jpeg;base64,BBB=" }] },
      ],
    };
    expect(await imagesFromMessage(message)).toEqual([
      { mimeType: "image/png", data: "AAA=" },
      { mimeType: "image/jpeg", data: "BBB=" },
    ]);
  });
});

describe("imagesFromContent: blob URL conversion", () => {
  let originalFetch: typeof global.fetch;
  let blobUrls: Map<string, Blob>;

  beforeEach(() => {
    // Mock fetch to handle blob: URLs
    originalFetch = global.fetch;
    blobUrls = new Map();
    
    global.fetch = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.startsWith("blob:")) {
        const blob = blobUrls.get(urlStr);
        if (!blob) {
          throw new Error(`Blob URL not found: ${urlStr}`);
        }
        return new Response(blob);
      }
      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    }) as typeof global.fetch;

    // Mock FileReader
    const mockFileReader = {
      readAsDataURL: vi.fn(function (this: FileReader, blob: Blob) {
        // Simulate async FileReader
        setTimeout(() => {
          // Create a simple base64 data URL from the blob
          const result = `data:${blob.type};base64,bW9ja2VkYmxvYmRhdGE=`; // "mockedblobdata"
          Object.defineProperty(this, "result", { value: result, writable: true });
          this.onloadend?.({ target: this } as ProgressEvent<FileReader>);
        }, 0);
      }),
      onloadend: null as ((ev: ProgressEvent<FileReader>) => void) | null,
      onerror: null as ((ev: ProgressEvent<FileReader>) => void) | null,
      result: null as string | null,
    } as Partial<FileReader>;

    global.FileReader = vi.fn(() => mockFileReader) as never;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    blobUrls.clear();
  });

  it("converts a blob: URL to a data: URL", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    const blobUrl = "blob:http://localhost/abc-123";
    blobUrls.set(blobUrl, blob);

    const out = await imagesFromContent([
      { type: "image", image: blobUrl },
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].mimeType).toBe("image/png");
    expect(out[0].data).toBe("bW9ja2VkYmxvYmRhdGE=");
  });

  it("handles multiple blob URLs in one message", async () => {
    const blob1 = new Blob([new Uint8Array([1, 2])], { type: "image/png" });
    const blob2 = new Blob([new Uint8Array([3, 4])], { type: "image/jpeg" });
    const blobUrl1 = "blob:http://localhost/img1";
    const blobUrl2 = "blob:http://localhost/img2";
    blobUrls.set(blobUrl1, blob1);
    blobUrls.set(blobUrl2, blob2);

    const out = await imagesFromContent([
      { type: "image", image: blobUrl1 },
      { type: "text", text: "between" },
      { type: "image", image: blobUrl2 },
    ]);

    expect(out).toHaveLength(2);
    expect(out[0].mimeType).toBe("image/png");
    expect(out[1].mimeType).toBe("image/jpeg");
  });

  it("handles mixed blob URLs and data URLs", async () => {
    const blob = new Blob([new Uint8Array([5, 6])], { type: "image/webp" });
    const blobUrl = "blob:http://localhost/mixed";
    blobUrls.set(blobUrl, blob);

    const out = await imagesFromContent([
      { type: "image", image: "data:image/png;base64,QUJD" },
      { type: "image", image: blobUrl },
      { type: "image", data: "ZZZ", mimeType: "image/gif" },
    ]);

    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ mimeType: "image/png", data: "QUJD" });
    expect(out[1].mimeType).toBe("image/webp");
    expect(out[1].data).toBe("bW9ja2VkYmxvYmRhdGE=");
    expect(out[2]).toEqual({ mimeType: "image/gif", data: "ZZZ" });
  });

  it("skips a blob URL that fails to fetch (best-effort)", async () => {
    const out = await imagesFromContent([
      { type: "image", image: "blob:http://localhost/missing" },
      { type: "image", image: "data:image/png;base64,QUJD" },
    ]);

    // Failed blob is skipped, data URL succeeds
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ mimeType: "image/png", data: "QUJD" });
  });

  it("handles the SimpleImageAttachmentAdapter paste flow", async () => {
    // Simulate what SimpleImageAttachmentAdapter does:
    // 1. User pastes a screenshot
    // 2. Adapter creates a blob URL
    // 3. Message content has { type: "image", image: "blob:..." }
    // 4. imagesFromContent() converts it to data URL
    
    const pastedImageData = new Uint8Array([137, 80, 78, 71]); // PNG header
    const blob = new Blob([pastedImageData], { type: "image/png" });
    const blobUrl = URL.createObjectURL(blob);
    blobUrls.set(blobUrl, blob);

    const messageContent = [
      { type: "text", text: "Here's a screenshot" },
      { type: "image", image: blobUrl },
    ];

    const images = await imagesFromContent(messageContent);

    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe("image/png");
    expect(images[0].data).toBeTruthy();
    // Data should be base64, not the blob URL
    expect(images[0].data).not.toContain("blob:");
  });

  it("logs a message when converting blob URLs", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    const blobUrl = "blob:http://localhost/logged";
    blobUrls.set(blobUrl, blob);

    await imagesFromContent([{ type: "image", image: blobUrl }]);

    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("[imageUpload] Converting blob URL"),
      expect.any(String)
    );

    consoleLog.mockRestore();
  });

  it("logs a warning when blob URL conversion fails", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    
    await imagesFromContent([{ type: "image", image: "blob:http://localhost/will-fail" }]);

    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("[imageUpload] Failed to convert blob URL"),
      expect.any(Error)
    );

    consoleWarn.mockRestore();
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
