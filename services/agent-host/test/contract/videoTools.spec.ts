/**
 * show_video: a sandbox video lands in the AssetStore and the result carries only a
 * reference the UI plays, never the bytes. The fake client runs the real in-pod script.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { handleShowVideo, videoMimeType, type VideoToolsWiring } from "../../src/agent/videoTools.js";
import { buildServer } from "../../src/agent/mcpServer.js";
import { createPvcAssetStore } from "../../src/session/assetStore.js";
import type { SandboxApiClient } from "../../src/exec/sandboxExec.js";
import type { ExecRequest } from "../../src/types.js";

const CLIP = Buffer.from("\x00\x00\x00\x18ftypmp42 not really a video", "binary");

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "scooter-show-video-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function hostClient(): { client: SandboxApiClient; reqs: ExecRequest[] } {
  const reqs: ExecRequest[] = [];
  const client: SandboxApiClient = {
    mode: "direct",
    async execute(req) {
      reqs.push(req);
      const r = spawnSync(req.command, req.args, { encoding: "utf8" });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    async download() { throw new Error("not used"); },
    async upload() { throw new Error("not used"); },
    async uploadBinary() { throw new Error("not used"); },
  };
  return { client, reqs };
}

function wiring(client: SandboxApiClient, maxBytes = 1024): VideoToolsWiring {
  return { client: () => client, assets: createPvcAssetStore({ root: tmpDir() }), maxBytes };
}

function tmpVideo(name: string, bytes: Buffer): string {
  const path = join(tmpDir(), name);
  writeFileSync(path, bytes);
  return path;
}

const texts = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "");

describe("show_video handler", () => {
  it("stores the file and returns a video ref, not the bytes", async () => {
    const path = tmpVideo("it's a $(id) clip.MP4", CLIP);
    const w = wiring(hostClient().client);
    const res = await handleShowVideo(w, "conv-7", { path });
    expect(res.isError).toBeUndefined();
    const ref = JSON.parse(texts(res)[0]);
    expect(ref).toMatchObject({ type: "video", mimeType: "video/mp4" });
    expect(ref.url).toBe(`/conversations/conv-7/assets/${ref.assetId}`);
    expect((await w.assets.read("conv-7", ref.assetId))?.data.equals(CLIP)).toBe(true);
    expect(JSON.stringify(res)).not.toContain(CLIP.toString("base64"));
  });

  it("refuses a video over the cap without storing it", async () => {
    const path = tmpVideo("big.webm", Buffer.alloc(2048));
    const res = await handleShowVideo(wiring(hostClient().client), "c", { path });
    expect(res.isError).toBe(true);
    expect(texts(res)[0]).toMatch(/re-encode/);
  });

  it("rejects a non-video path and an empty path without touching the sandbox", async () => {
    const { client, reqs } = hostClient();
    const w = wiring(client);
    expect((await handleShowVideo(w, "c", { path: "/workspace/clip.mov" })).isError).toBe(true);
    expect((await handleShowVideo(w, "c", { path: " " })).isError).toBe(true);
    expect(reqs).toHaveLength(0);
  });

  it("errors cleanly on a missing file", async () => {
    const res = await handleShowVideo(wiring(hostClient().client), "c", { path: "/nonexistent/a.mp4" });
    expect(res.isError).toBe(true);
  });

  it("maps the supported extensions to mime types", () => {
    expect(videoMimeType("/a/b.mp4")).toBe("video/mp4");
    expect(videoMimeType("/a/b.M4V")).toBe("video/mp4");
    expect(videoMimeType("/a/b.webm")).toBe("video/webm");
    expect(videoMimeType("/a/b.mov")).toBeUndefined();
  });
});

describe("show_video over MCP", () => {
  it("is registered only when wired, and returns the ref as text", async () => {
    const connect = async (videos?: VideoToolsWiring) => {
      const server = await buildServer("conv-1", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, videos);
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "t", version: "0" });
      await client.connect(clientT);
      return client;
    };
    expect((await (await connect()).listTools()).tools.map((t) => t.name)).not.toContain("show_video");

    const client = await connect(wiring(hostClient().client));
    const res = await client.callTool({ name: "show_video", arguments: { path: tmpVideo("a.webm", CLIP) } });
    expect(res.isError).toBeFalsy();
    const [ref] = res.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(ref.text)).toMatchObject({ type: "video", mimeType: "video/webm" });
  });
});
