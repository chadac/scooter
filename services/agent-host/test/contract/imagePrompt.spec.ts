/**
 * Tier 1 contract — images reach goose (multimodal, stage 2).
 *
 * Two seams:
 *  - normalizeContent: the /agui message `content` (string | ContentPart[]) splits
 *    into prompt text + inbound images; a plain string stays text-only (back-compat).
 *  - the bridge resolves attached image refs (readAsset -> base64) into ACP `image`
 *    content blocks appended after the text; a text-only prompt is unchanged.
 * See docs/MULTIMODAL_IMAGES.md.
 */

import { describe, it, expect, vi } from "vitest";

import { normalizeContent } from "../../src/agui/server.js";
import { createSessionBridge } from "../../src/bridge.js";
import type { AcpClient, PromptParams, ContentBlock } from "../../src/acp/client.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";

// --- normalizeContent (the /agui content split) ------------------------------

describe("normalizeContent", () => {
  it("a plain string is text-only (the unchanged path)", () => {
    expect(normalizeContent("hello")).toEqual({ text: "hello", images: [], files: [] });
  });

  it("undefined -> empty", () => {
    expect(normalizeContent(undefined)).toEqual({ text: "", images: [], files: [] });
  });

  it("splits text + image parts ({data, mimeType})", () => {
    const out = normalizeContent([
      { type: "text", text: "look at this" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ]);
    expect(out.text).toBe("look at this");
    expect(out.images).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
    expect(out.files).toEqual([]);
  });

  it("splits a file part ({name, data, mimeType}) into files", () => {
    const out = normalizeContent([
      { type: "text", text: "here is a report" },
      { type: "file", name: "report.pdf", data: "UERG", mimeType: "application/pdf" },
    ]);
    expect(out.text).toBe("here is a report");
    expect(out.images).toEqual([]);
    expect(out.files).toEqual([{ name: "report.pdf", data: "UERG", mimeType: "application/pdf" }]);
  });

  it("a file part missing name/data is ignored", () => {
    const out = normalizeContent([
      { type: "file", data: "UERG" } as never, // no name
      { type: "file", name: "x.bin" } as never, // no data
    ]);
    expect(out.files).toEqual([]);
  });

  it("defaults a file part's mimeType to application/octet-stream", () => {
    const out = normalizeContent([{ type: "file", name: "a.bin", data: "QQ==" }]);
    expect(out.files).toEqual([{ name: "a.bin", data: "QQ==", mimeType: "application/octet-stream" }]);
  });

  it("accepts an assistant-ui image data URL ({image})", () => {
    const out = normalizeContent([
      { type: "image", image: "data:image/jpeg;base64,QUJD" },
    ]);
    expect(out.images).toEqual([{ mimeType: "image/jpeg", data: "QUJD" }]);
  });

  it("joins multiple text parts and ignores unknown part types", () => {
    const out = normalizeContent([
      { type: "text", text: "a" },
      { type: "reasoning", text: "ignored" } as never,
      { type: "text", text: "b" },
    ]);
    expect(out.text).toBe("a\n\nb");
    expect(out.images).toEqual([]);
  });
});

// --- the bridge builds an ACP image block from an attached ref ---------------

/** A minimal AcpClient that captures the prompt blocks + drives a trivial run. */
function capturingAcp(): { client: AcpClient; lastPrompt: () => PromptParams | undefined } {
  let last: PromptParams | undefined;
  let updateCb: ((sid: string, u: unknown) => void) | undefined;
  const client: AcpClient = {
    initialize: async () => ({ protocolVersion: 1 }),
    newSession: async () => ({ sessionId: "acp-1" }),
    async prompt(params) {
      last = params;
      // Emit a tiny assistant chunk so the run produces a message, then end.
      updateCb?.("acp-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
      return { stopReason: "end_turn" };
    },
    cancel: async () => {},
    killActiveTerminals: async () => {},
    onSessionUpdate: (cb) => { updateCb = cb as never; return () => {}; },
    onTerminalCreated: () => () => {},
    onPermissionRequest: () => {},
    close: async () => {},
  };
  return { client, lastPrompt: () => last };
}

describe("bridge: image content blocks", () => {
  const cfg = {
    config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
    exec: createSandboxExecBackend(createFakeSandboxApi()),
  };

  it("resolves an attached image ref -> a base64 ACP image block after the text", async () => {
    const { client, lastPrompt } = capturingAcp();
    const readAsset = vi.fn(async (assetId: string) =>
      assetId === "img1.png" ? { data: Buffer.from([1, 2, 3, 4]), mimeType: "image/png" } : null,
    );
    const bridge = createSessionBridge({ ...cfg, acpClient: client, readAsset });
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "what is this?", images: [{ assetId: "img1.png", mimeType: "image/png" }] });

    const blocks = lastPrompt()!.prompt as ContentBlock[];
    // text first, image block after.
    expect(blocks[0]).toMatchObject({ type: "text", text: "what is this?" });
    const img = blocks.find((b) => b.type === "image") as { type: "image"; data: string; mimeType: string };
    expect(img).toBeTruthy();
    expect(img.mimeType).toBe("image/png");
    expect(Buffer.from(img.data, "base64").equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(readAsset).toHaveBeenCalledWith("img1.png");
  });

  it("persists a MESSAGE_IMAGES ref event (assetId+url, NOT bytes) after the user message", async () => {
    const { client } = capturingAcp();
    const readAsset = vi.fn(async () => ({ data: Buffer.from([9]), mimeType: "image/png" }));
    const bridge = createSessionBridge({ ...cfg, acpClient: client, readAsset });
    const persisted: Array<Record<string, unknown>> = [];
    bridge.onPersist((e) => persisted.push(e as never));
    await bridge.start();
    await bridge.prompt({ threadId: "conv-9", text: "see", images: [{ assetId: "img1.png", mimeType: "image/png" }] });

    const ev = persisted.find((e) => e.type === "MESSAGE_IMAGES") as
      | { messageId: string; images: Array<{ assetId: string; url: string; mimeType: string }> }
      | undefined;
    expect(ev).toBeTruthy();
    expect(ev!.images[0]).toMatchObject({ assetId: "img1.png", mimeType: "image/png", url: "/conversations/conv-9/assets/img1.png" });
    // The ref carries NO base64 bytes (keeps the log compact).
    expect(JSON.stringify(ev)).not.toContain("data");
    // It follows a user TEXT_MESSAGE_END with the same messageId.
    const endIdx = persisted.findIndex((e) => e.type === "TEXT_MESSAGE_END" && e.messageId === ev!.messageId);
    const imgIdx = persisted.indexOf(ev as never);
    expect(imgIdx).toBeGreaterThan(endIdx);
  });

  it("a text-only prompt persists NO MESSAGE_IMAGES event", async () => {
    const { client } = capturingAcp();
    const bridge = createSessionBridge({ ...cfg, acpClient: client, readAsset: vi.fn() });
    const persisted: Array<Record<string, unknown>> = [];
    bridge.onPersist((e) => persisted.push(e as never));
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "no images" });
    expect(persisted.some((e) => e.type === "MESSAGE_IMAGES")).toBe(false);
  });

  it("a text-only prompt sends NO image block (unchanged path)", async () => {
    const { client, lastPrompt } = capturingAcp();
    const bridge = createSessionBridge({ ...cfg, acpClient: client, readAsset: vi.fn() });
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "just text" });
    const blocks = lastPrompt()!.prompt as ContentBlock[];
    expect(blocks.some((b) => b.type === "image")).toBe(false);
  });

  it("skips an unreadable asset (best-effort) without failing the turn", async () => {
    const { client, lastPrompt } = capturingAcp();
    const bridge = createSessionBridge({ ...cfg, acpClient: client, readAsset: vi.fn(async () => null) });
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "hi", images: [{ assetId: "gone.png", mimeType: "image/png" }] });
    const blocks = lastPrompt()!.prompt as ContentBlock[];
    expect(blocks.some((b) => b.type === "image")).toBe(false); // dropped, turn still ran
    expect(blocks[0]).toMatchObject({ type: "text" });
  });
});

// --- the bridge writes binary file attachments into /workspace/.slack ---------

describe("bridge: binary file attachments", () => {
  it("writes a file part to /workspace/.slack/<name> via exec (base64-decoded)", async () => {
    const { client, lastPrompt } = capturingAcp();
    const api = createFakeSandboxApi();
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec: createSandboxExecBackend(api),
      acpClient: client,
    });
    await bridge.start();
    await bridge.prompt({
      threadId: "t1",
      text: "see /workspace/.slack/report.pdf",
      files: [{ name: "report.pdf", data: "UERG", mimeType: "application/pdf" }],
    });

    // A shell exec ran that mkdir's the dir + writes the decoded bytes to the path.
    const shell = api.executed.map((e) => (e.args.length ? [e.command, ...e.args].join(" ") : e.command)).join("\n");
    expect(shell).toContain("/workspace/.slack");
    expect(shell).toContain("/workspace/.slack/report.pdf");
    expect(shell).toContain("base64 -d");
    expect(shell).toContain("UERG"); // the base64 payload piped in

    // The turn still ran (the ACP prompt was sent).
    expect(lastPrompt()).toBeTruthy();
    // No file block is sent to the model (files go to disk, not ACP content).
    const blocks = lastPrompt()!.prompt as ContentBlock[];
    expect(blocks.some((b) => (b as { type: string }).type === "file")).toBe(false);
  });

  it("a failed write is best-effort — the turn still completes", async () => {
    const { client, lastPrompt } = capturingAcp();
    const api = createFakeSandboxApi();
    api.whenExecute(() => ({ stdout: "", stderr: "disk full", exitCode: 1 }));
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec: createSandboxExecBackend(api),
      acpClient: client,
    });
    await bridge.start();
    await bridge.prompt({
      threadId: "t1",
      text: "hi",
      files: [{ name: "x.bin", data: "QQ==", mimeType: "application/octet-stream" }],
    });
    // The write failed (exit 1) but the ACP prompt was still sent — the turn ran.
    expect(lastPrompt()).toBeTruthy();
  });

  it("a prompt with no files writes nothing (unchanged path)", async () => {
    const { client } = capturingAcp();
    const api = createFakeSandboxApi();
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec: createSandboxExecBackend(api),
      acpClient: client,
    });
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "just text" });
    expect(api.executed.length).toBe(0);
  });

  it("sanitizes a traversal filename to a safe basename under /workspace/.slack", async () => {
    const { client } = capturingAcp();
    const api = createFakeSandboxApi();
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec: createSandboxExecBackend(api),
      acpClient: client,
    });
    await bridge.start();
    await bridge.prompt({
      threadId: "t1",
      text: "hi",
      files: [{ name: "../../etc/passwd", data: "QQ==", mimeType: "application/octet-stream" }],
    });
    const shell = api.executed.map((e) => (e.args.length ? [e.command, ...e.args].join(" ") : e.command)).join("\n");
    // No path escape: the write target stays inside /workspace/.slack.
    expect(shell).toContain("/workspace/.slack/passwd");
    expect(shell).not.toContain("../../etc/passwd");
  });
});
