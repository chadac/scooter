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
    expect(normalizeContent("hello")).toEqual({ text: "hello", images: [] });
  });

  it("undefined -> empty", () => {
    expect(normalizeContent(undefined)).toEqual({ text: "", images: [] });
  });

  it("splits text + image parts ({data, mimeType})", () => {
    const out = normalizeContent([
      { type: "text", text: "look at this" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ]);
    expect(out.text).toBe("look at this");
    expect(out.images).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
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
