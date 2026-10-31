/**
 * Images the agent produces reach the UI as asset references. An image in a tool result or
 * an agent message chunk is staged into the AssetStore, and the event log carries only
 * {assetId, url}; withStaging's read() waits for a staged write so the UI never 404s.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionBridge } from "../../src/bridge.js";
import type { AcpClient } from "../../src/acp/client.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { createPvcAssetStore, withStaging, assetIdFor, type StagingAssetStore } from "../../src/session/assetStore.js";
import { replaceInlineImages } from "../../src/session/mediaRefs.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const PNG_B64 = PNG.toString("base64");

/** An AcpClient whose prompt() replays the given session updates. */
function scriptedAcp(updates: unknown[]): AcpClient {
  let updateCb: ((sid: string, u: unknown) => void) | undefined;
  return {
    initialize: async () => ({ protocolVersion: 1 }),
    newSession: async () => ({ sessionId: "acp-1" }),
    async prompt() {
      for (const u of updates) updateCb?.("acp-1", u);
      return { stopReason: "end_turn" };
    },
    cancel: async () => {},
    killActiveTerminals: async () => {},
    onSessionUpdate: (cb) => { updateCb = cb as never; return () => {}; },
    onTerminalCreated: () => () => {},
    onPermissionRequest: () => {},
    isAlive: () => true,
    close: async () => {},
  };
}

const baseCfg = () => ({
  config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
  exec: createSandboxExecBackend(createFakeSandboxApi()),
});

describe("agent-produced media", () => {
  let root: string;
  let assets: StagingAssetStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "media-"));
    assets = withStaging(createPvcAssetStore({ root, maxBytes: 1024 }), { maxBytes: 1024 });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function run(updates: unknown[]) {
    const events: Array<Record<string, unknown>> = [];
    const bridge = createSessionBridge({
      ...baseCfg(),
      acpClient: scriptedAcp(updates),
      stageAsset: (b) => assets.stage("conv-1", b),
    });
    bridge.onPersist((e) => events.push(e as never));
    await bridge.start();
    await bridge.prompt({ threadId: "conv-1", text: "go" });
    return events;
  }

  it("a tool result's image becomes an asset ref, and the logged result carries no base64", async () => {
    const events = await run([
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "view_image", rawInput: { path: "/workspace/a.png" } },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] },
    ]);
    const result = events.find((e) => e.type === "TOOL_CALL_RESULT")!;
    expect(result.content as string).not.toContain(PNG_B64);
    const parsed = JSON.parse(result.content as string);
    const id = assetIdFor(PNG, "image/png");
    expect(parsed).toEqual([{ type: "image", mimeType: "image/png", assetId: id, url: `/conversations/conv-1/assets/${id}` }]);
    // The bytes are readable straight away (read waits for the staged write).
    const got = await assets.read("conv-1", id);
    expect(got?.data.equals(PNG)).toBe(true);
  });

  it("handles goose's nested ACP tool content shape", async () => {
    const events = await run([
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "screenshot" },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "image", data: PNG_B64, mimeType: "image/png" } }] },
    ]);
    const parsed = JSON.parse(events.find((e) => e.type === "TOOL_CALL_RESULT")!.content as string);
    expect(parsed[0].content).toMatchObject({ type: "image", assetId: assetIdFor(PNG, "image/png") });
  });

  it("an oversize image is kept as an omitted marker, never base64", async () => {
    const big = Buffer.alloc(2048, 7).toString("base64");
    const events = await run([
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "x" },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: [{ type: "image", data: big, mimeType: "image/png" }] },
    ]);
    const content = events.find((e) => e.type === "TOOL_CALL_RESULT")!.content as string;
    expect(content).not.toContain(big);
    expect(JSON.parse(content)).toEqual([{ type: "image", mimeType: "image/png", omitted: "too-large" }]);
  });

  it("an image message chunk attaches MESSAGE_IMAGES to the assistant message", async () => {
    const events = await run([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Here it is:" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "image", data: PNG_B64, mimeType: "image/png" } },
    ]);
    const start = events.find((e) => e.type === "TEXT_MESSAGE_START" && e.role === "assistant")!;
    const imgs = events.find((e) => e.type === "MESSAGE_IMAGES" && e.messageId === start.messageId);
    expect(imgs).toBeTruthy();
    expect((imgs!.images as Array<{ assetId: string }>)[0].assetId).toBe(assetIdFor(PNG, "image/png"));
    expect(JSON.stringify(events)).not.toContain(PNG_B64);
  });

  it("without a store an image chunk degrades to a text marker", async () => {
    const events: Array<Record<string, unknown>> = [];
    const bridge = createSessionBridge({
      ...baseCfg(),
      acpClient: scriptedAcp([{ sessionUpdate: "agent_message_chunk", content: { type: "image", data: PNG_B64, mimeType: "image/png" } }]),
    });
    bridge.onPersist((e) => events.push(e as never));
    await bridge.start();
    await bridge.prompt({ threadId: "conv-1", text: "go" });
    expect(events.some((e) => e.type === "MESSAGE_IMAGES")).toBe(false);
    const text = events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta).join("");
    expect(text).toContain("image not shown");
  });
});

describe("replaceInlineImages", () => {
  it("returns the same reference when there is nothing to replace", () => {
    const v = [{ type: "text", text: "hi" }, { nested: { a: 1 } }];
    expect(replaceInlineImages(v, undefined).value).toBe(v);
  });

  it("accepts the Messages-API base64 source shape", () => {
    const { value, refs } = replaceInlineImages(
      [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }],
      () => ({ assetId: "a.png", mimeType: "image/png", url: "/u" }),
    );
    expect(refs).toHaveLength(1);
    expect(value).toEqual([{ type: "image", mimeType: "image/png", assetId: "a.png", url: "/u" }]);
  });
});

describe("withStaging", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "stage-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("rejects synchronously what put() would refuse", () => {
    const s = withStaging(createPvcAssetStore({ root, maxBytes: 4 }), { maxBytes: 4 });
    expect(s.stage("c", { data: Buffer.alloc(0), mimeType: "image/png" })).toEqual({ rejected: "empty" });
    expect(s.stage("c", { data: PNG, mimeType: "image/png" })).toEqual({ rejected: "too-large" });
    expect(s.stage("c", { data: Buffer.from([1]), mimeType: "image/svg+xml" })).toEqual({ rejected: "unsupported-type" });
  });

  it("mints the same id put() does", async () => {
    const inner = createPvcAssetStore({ root });
    const s = withStaging(inner);
    const staged = s.stage("c", { data: PNG, mimeType: "image/png" });
    const put = await inner.put("c", { data: PNG, mimeType: "image/png" });
    expect(staged).toEqual(put);
  });
});
