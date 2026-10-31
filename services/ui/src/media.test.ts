/**
 * UI unit tests for inline media: tool results' image refs split out for the tool card,
 * assistant images attached after conversion, and the markdown image policy that only
 * loads the conversation's own assets by default.
 */

import { describe, it, expect } from "vitest";

import { splitResultImages } from "./mediaRefs.js";
import { toRepositorySnapshot, attachAssistantImages } from "./messageRepository.js";
import { classifyImageSrc, markdownUrlTransform } from "./markdownImagePolicy.js";

const URL1 = "/conversations/c1/assets/aaa.png";
const URL2 = "/conversations/c1/assets/bbb.gif";

describe("splitResultImages", () => {
  it("takes image refs out of a result and leaves the text", () => {
    const r = splitResultImages(
      [{ type: "image", mimeType: "image/png", assetId: "aaa.png", url: URL1 }, { type: "text", text: "note" }],
      "/base",
    );
    expect(r.images).toEqual([{ src: "/base" + URL1, mimeType: "image/png" }]);
    expect(r.rest).toBe("note");
  });

  it("an image-only result leaves nothing to print", () => {
    const r = splitResultImages([{ type: "image", mimeType: "image/png", assetId: "aaa.png", url: URL1 }]);
    expect(r.images).toHaveLength(1);
    expect(r.rest).toBeUndefined();
  });

  it("unwraps goose's ACP {type:'content'} wrapper and MCP {content:[...]}", () => {
    const r = splitResultImages({ content: [{ type: "content", content: { type: "image", mimeType: "image/gif", url: URL2 } }] });
    expect(r.images.map((i) => i.src)).toEqual([URL2]);
    expect(r.rest).toBeUndefined();
  });

  it("reports omitted images", () => {
    const r = splitResultImages([{ type: "image", mimeType: "image/png", omitted: "too-large" }]);
    expect(r.images).toEqual([]);
    expect(r.omitted).toEqual(["too-large"]);
  });

  it("never renders a url outside the assets route", () => {
    const r = splitResultImages([{ type: "image", mimeType: "image/png", url: "https://evil.example/x.png" }]);
    expect(r.images).toEqual([]);
    expect(r.omitted).toHaveLength(1);
  });

  it("returns the original result untouched when it has no images", () => {
    const res = { stdout: "hi", list: [1, 2] };
    expect(splitResultImages(res).rest).toBe(res);
    expect(splitResultImages("plain").rest).toBe("plain");
  });
});

describe("attachAssistantImages", () => {
  const imgs = (id: string) => (id === "a1" ? [{ assetId: "aaa.png", mimeType: "image/png", url: URL1 }] : undefined);

  it("appends image file parts to the matching assistant message", () => {
    const out = attachAssistantImages(
      [{ id: "a1", role: "assistant", content: [{ type: "text", text: "here" }] }],
      imgs,
      "/b",
    ) as Array<{ content: unknown[] }>;
    expect(out[0].content).toEqual([{ type: "text", text: "here" }, { type: "file", mimeType: "image/png", data: "/b" + URL1, filename: "aaa.png" }]);
  });

  it("an image-only assistant message (empty string content) gets just the file part", () => {
    const out = attachAssistantImages([{ id: "a1", role: "assistant", content: "" }], imgs, "") as Array<{ content: unknown[] }>;
    expect(out[0].content).toEqual([{ type: "file", mimeType: "image/png", data: URL1, filename: "aaa.png" }]);
  });

  it("leaves user messages alone (their images are attachments)", () => {
    const m = { id: "a1", role: "user", content: "x" };
    expect(attachAssistantImages([m], imgs, "")[0]).toBe(m);
  });

  it("flows through toRepositorySnapshot", () => {
    const snap = toRepositorySnapshot(
      [{ id: "a1", role: "assistant", content: "look" }],
      undefined,
      { get: imgs, baseUrl: "" },
    );
    const content = snap.messages[0].message.content as Array<{ type: string; data?: string }>;
    expect(content.find((p) => p.type === "file")?.data).toBe(URL1);
    expect(content.find((p) => p.type === "text")).toBeTruthy();
  });
});

describe("classifyImageSrc", () => {
  it("allows the conversation's own assets, with the API base", () => {
    expect(classifyImageSrc(URL1, "/api")).toEqual({ kind: "allow", src: "/api" + URL1 });
    expect(classifyImageSrc("/api" + URL1, "/api")).toEqual({ kind: "allow", src: "/api" + URL1 });
  });

  it("allows raster data URLs but not SVG", () => {
    expect(classifyImageSrc("data:image/png;base64,QUJD").kind).toBe("allow");
    expect(classifyImageSrc("data:image/svg+xml;base64,QUJD").kind).toBe("invalid");
  });

  it("holds remote images for consent", () => {
    expect(classifyImageSrc("https://example.com/a.png?u=1")).toEqual({
      kind: "remote",
      src: "https://example.com/a.png?u=1",
      host: "example.com",
    });
  });

  it("refuses other schemes and protocol-relative URLs", () => {
    expect(classifyImageSrc("javascript:alert(1)").kind).toBe("invalid");
    expect(classifyImageSrc("//evil.example/x.png").kind).toBe("invalid");
    expect(classifyImageSrc("").kind).toBe("invalid");
  });

  it("treats sandbox paths and other same-origin paths as local, not loadable", () => {
    expect(classifyImageSrc("/workspace/shot.png")).toEqual({ kind: "local", path: "/workspace/shot.png" });
    expect(classifyImageSrc("/api/admin/delete").kind).toBe("local");
  });
});

describe("inline media fixes found in the live UI", () => {
  const imgs = () => [{ assetId: "aaa.png", mimeType: "image/png", url: URL1 }];

  it("keeps an assistant message's string text when it appends images", () => {
    const out = attachAssistantImages([{ id: "a1", role: "assistant", content: "look" }], imgs, "") as Array<{ content: unknown[] }>;
    expect(out[0].content[0]).toEqual({ type: "text", text: "look" });
  });

  it("a tool result left with only text after the images renders as text, not JSON", () => {
    const r = splitResultImages([
      { type: "content", content: { type: "text", text: "Captured 2 screenshots." } },
      { type: "content", content: { type: "image", mimeType: "image/png", assetId: "aaa.png", url: URL1 } },
    ]);
    expect(r.images).toHaveLength(1);
    expect(r.rest).toBe("Captured 2 screenshots.");
  });

  it("an MCP result with isError keeps its structure", () => {
    const r = splitResultImages({ isError: true, content: [{ type: "text", text: "x" }, { type: "image", mimeType: "image/png", url: URL1 }] });
    expect(r.rest).toEqual({ isError: true, content: [{ type: "text", text: "x" }] });
  });

  it("markdownUrlTransform keeps raster data: image srcs and drops the rest", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(markdownUrlTransform(png, "src")).toBe(png);
    expect(markdownUrlTransform(png, "href")).toBe("");
    expect(markdownUrlTransform("data:image/svg+xml;base64,PHN2Zz4=", "src")).toBe("");
    expect(markdownUrlTransform("javascript:alert(1)", "href")).toBe("");
    expect(markdownUrlTransform("https://x.example/a.png", "src")).toBe("https://x.example/a.png");
    expect(markdownUrlTransform("/conversations/c1/assets/a.png", "src")).toBe("/conversations/c1/assets/a.png");
  });

  it("refuses a remote .svg outright", () => {
    expect(classifyImageSrc("https://x.example/logo.svg").kind).toBe("invalid");
    expect(classifyImageSrc("https://x.example/logo.SVG?v=2").kind).toBe("invalid");
  });
});
