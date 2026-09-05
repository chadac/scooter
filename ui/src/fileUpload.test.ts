/**
 * UI unit test — the composer FILE-upload helpers (non-image attachments). Mirrors
 * imageUpload.test.ts: filesFromContent/filesFromMessage pull file parts out of a
 * message; base64Bytes is the size utility; SandboxFileAttachmentAdapter turns a File
 * into a `{type:"file"}` content part and enforces the client size cap.
 */

import { describe, it, expect, vi } from "vitest";

import {
  filesFromContent,
  filesFromMessage,
  base64Bytes,
  SandboxFileAttachmentAdapter,
  type OutboundFile,
} from "./fileUpload.js";

describe("base64Bytes", () => {
  it("computes the decoded byte size", () => {
    expect(base64Bytes("QUJD")).toBe(3); // "ABC"
    expect(base64Bytes("QQ==")).toBe(1); // "A"
    expect(base64Bytes("")).toBe(0);
  });
});

describe("filesFromContent", () => {
  it("pulls a file part ({filename, data, mimeType}) out", () => {
    const out = filesFromContent([
      { type: "text", text: "here" },
      { type: "file", filename: "report.pdf", data: "UERG", mimeType: "application/pdf" },
    ]);
    expect(out).toEqual([{ name: "report.pdf", data: "UERG", mimeType: "application/pdf" }]);
  });

  it("ignores image + text parts", () => {
    const out = filesFromContent([
      { type: "text", text: "hi" },
      { type: "image", image: "data:image/png;base64,QUJD" },
    ]);
    expect(out).toEqual([]);
  });

  it("strips a data-url prefix from data, defaults a missing mime", () => {
    const out = filesFromContent([{ type: "file", filename: "a.bin", data: "data:application/octet-stream;base64,QQ==" }]);
    expect(out).toEqual([{ name: "a.bin", data: "QQ==", mimeType: "application/octet-stream" }]);
  });

  it("skips a file part with no data", () => {
    expect(filesFromContent([{ type: "file", filename: "x.bin" }])).toEqual([]);
  });

  it("non-array content -> empty", () => {
    expect(filesFromContent("just text")).toEqual([]);
    expect(filesFromContent(undefined)).toEqual([]);
  });
});

describe("filesFromMessage", () => {
  it("unions message.content AND message.attachments[].content", () => {
    const msg = {
      content: [{ type: "text", text: "see files" }],
      attachments: [
        { content: [{ type: "file", filename: "a.pdf", data: "QUJD", mimeType: "application/pdf" }] },
        { content: [{ type: "file", filename: "b.zip", data: "QQ==", mimeType: "application/zip" }] },
      ],
    };
    const out = filesFromMessage(msg);
    expect(out).toEqual<OutboundFile[]>([
      { name: "a.pdf", data: "QUJD", mimeType: "application/pdf" },
      { name: "b.zip", data: "QQ==", mimeType: "application/zip" },
    ]);
  });

  it("a text-only message yields no files", () => {
    expect(filesFromMessage({ content: "hello", attachments: [] })).toEqual([]);
  });
});

describe("SandboxFileAttachmentAdapter", () => {
  const makeFile = (name: string, type: string, size: number): File =>
    ({
      name,
      type,
      size,
      // Minimal stub used only by fileToBase64's FileReader (mocked below).
    }) as unknown as File;

  it("uses the composite wildcard accept ('*'), not '*/*'", () => {
    expect(new SandboxFileAttachmentAdapter().accept).toBe("*");
  });

  it("add() returns a pending document attachment", async () => {
    const a = new SandboxFileAttachmentAdapter();
    const pending = await a.add({ file: makeFile("report.pdf", "application/pdf", 10) });
    expect(pending).toMatchObject({
      type: "document",
      name: "report.pdf",
      contentType: "application/pdf",
      status: { type: "requires-action", reason: "composer-send" },
    });
  });

  it("add() rejects a file over the cap with a clear message", async () => {
    const a = new SandboxFileAttachmentAdapter(100); // 100-byte cap
    await expect(a.add({ file: makeFile("big.bin", "application/octet-stream", 101) })).rejects.toThrow(/too large/);
  });

  it("send() reads the file into a base64 file content part", async () => {
    // Stub FileReader so fileToBase64 resolves to a known data URL.
    const origFR = globalThis.FileReader;
    class FakeFileReader {
      result: string | null = null;
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.result = "data:application/pdf;base64,UERG";
        this.onloadend?.();
      }
    }
    // @ts-expect-error test stub
    globalThis.FileReader = FakeFileReader;
    try {
      const a = new SandboxFileAttachmentAdapter();
      const pending = await a.add({ file: makeFile("report.pdf", "application/pdf", 4) });
      const complete = await a.send(pending);
      expect(complete.status).toEqual({ type: "complete" });
      expect(complete.content).toEqual([
        { type: "file", filename: "report.pdf", data: "UERG", mimeType: "application/pdf" },
      ]);
    } finally {
      globalThis.FileReader = origFR;
    }
  });
});
