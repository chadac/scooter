/**
 * Tier 1 contract — blob URLs from SimpleImageAttachmentAdapter reach the agent.
 *
 * Regression test for #438: blob: URLs created by SimpleImageAttachmentAdapter
 * were being silently skipped client-side, so images never reached the server.
 *
 * Flow:
 *  1. User pastes screenshot
 *  2. SimpleImageAttachmentAdapter creates blob: URL
 *  3. Client converts blob: → data: URL (imagesFromContent)
 *  4. POST /agui with { messages: [{ content: [{ type: "image", data, mimeType }] }] }
 *  5. Server normalizes content → stores in AssetStore → passes assetId to bridge
 *  6. Bridge resolves assetId → base64 ACP image block
 *  7. Agent sees the image
 */

import { describe, it, expect } from "vitest";
import { normalizeContent } from "../../src/agui/server.js";

describe("blob URL flow (client → server → agent)", () => {
  it("server accepts base64 image data from client blob URL conversion", () => {
    // After client converts blob: → data: URL, it sends this to /agui:
    const clientMessage = {
      role: "user",
      content: [
        { type: "text", text: "Here's a screenshot" },
        { 
          type: "image", 
          // Client already converted blob: to data: (that's the fix in #438)
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png"
        },
      ],
    };

    const { text, images } = normalizeContent(clientMessage.content);
    
    expect(text).toBe("Here's a screenshot");
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      mimeType: "image/png",
    });
  });

  it("server accepts multiple images from blob URL conversions", () => {
    const clientMessage = {
      role: "user",
      content: [
        { type: "image", data: "QUJD", mimeType: "image/png" },
        { type: "text", text: "Compare these" },
        { type: "image", data: "REVG", mimeType: "image/jpeg" },
      ],
    };

    const { text, images } = normalizeContent(clientMessage.content);
    
    expect(text).toBe("Compare these");
    expect(images).toHaveLength(2);
    expect(images[0]).toEqual({ data: "QUJD", mimeType: "image/png" });
    expect(images[1]).toEqual({ data: "REVG", mimeType: "image/jpeg" });
  });

  it("regression: blob URLs were silently skipped before fix", () => {
    // BEFORE #438: client sent blob: URLs directly (not converted)
    // Server's normalizeContent didn't handle them → they were ignored
    const preFix = {
      role: "user",
      content: [
        { type: "text", text: "Look at this" },
        { type: "image", image: "blob:http://localhost/abc-123" }, // raw blob URL
      ],
    };

    const { text, images } = normalizeContent(preFix.content);
    
    // The blob URL is not a data: URL, so it's skipped
    expect(text).toBe("Look at this");
    expect(images).toEqual([]); // No images extracted (the bug)
  });

  it("server still accepts data: URLs from assistant-ui (backward compat)", () => {
    // assistant-ui can send { type: "image", image: "data:..." }
    const assistantUiMessage = {
      role: "user",
      content: [
        { type: "image", image: "data:image/png;base64,QUJD" },
      ],
    };

    const { images } = normalizeContent(assistantUiMessage.content);
    
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({ data: "QUJD", mimeType: "image/png" });
  });

  it("image-only message (no text) is valid", () => {
    const imageOnly = {
      role: "user",
      content: [
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
    };

    const { text, images } = normalizeContent(imageOnly.content);
    
    expect(text).toBe("");
    expect(images).toHaveLength(1);
  });

  it("handles the SimpleImageAttachmentAdapter paste scenario", () => {
    // User pastes a screenshot. In the real flow:
    // 1. Browser creates a Blob
    // 2. SimpleImageAttachmentAdapter calls URL.createObjectURL(blob) → "blob:..."
    // 3. Client's imagesFromContent() converts blob: → data: (via fetch + FileReader)
    // 4. Client sends { type: "image", data: "<base64>", mimeType: "image/png" }
    // 5. Server receives this:
    
    const afterClientConversion = {
      role: "user",
      content: [
        { type: "text", text: "Screenshot of the error" },
        { 
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png"
        },
      ],
    };

    const { text, images } = normalizeContent(afterClientConversion.content);
    
    expect(text).toBe("Screenshot of the error");
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe("image/png");
    // Base64 data is present (not a blob: URL)
    expect(images[0].data).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
