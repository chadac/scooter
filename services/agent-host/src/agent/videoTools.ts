/**
 * show_video: plays a video file from the conversation's sandbox inline in the chat. Models
 * cannot watch video, so the bytes go to the AssetStore and the tool result carries only a
 * reference the UI renders as a player.
 */

import type { SandboxApiClient } from "../exec/sandboxExec.js";
import { AssetError, type AssetStore } from "../session/assetStore.js";
import { readSandboxFileBase64, type ImageToolResult } from "./imageTools.js";

/** What buildServer needs to show a conversation's videos. */
export interface VideoToolsWiring {
  /** Resolve a conversation's exec client. */
  client: (conversationId: string) => SandboxApiClient | Promise<SandboxApiClient>;
  /** Where the video bytes are stored for the UI to fetch. */
  assets: AssetStore;
  /** Per-video byte cap. */
  maxBytes: number;
}

/** Video types browsers play natively, keyed by lower-case extension. */
const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
};

/** The video mime type for `path`, or undefined when it is not a playable video. */
export function videoMimeType(path: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? VIDEO_MIME[m[1].toLowerCase()] : undefined;
}

/** A video reference as a tool result carries it; the UI renders it as a player. */
export interface VideoRef {
  type: "video";
  mimeType: string;
  assetId: string;
  url: string;
}

const err = (text: string): ImageToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Store `path` from the sandbox as an asset and return a result the UI shows as a video. */
export async function handleShowVideo(
  wiring: VideoToolsWiring,
  conversationId: string,
  args: { path: string },
): Promise<ImageToolResult> {
  const raw = (args?.path ?? "").trim();
  if (!raw) return err("show_video: path is required.");
  const path = raw.startsWith("/") ? raw : `/workspace/${raw}`;
  const mimeType = videoMimeType(path);
  if (!mimeType) {
    return err(`show_video: ${path} is not a supported video (use .mp4, .m4v or .webm).`);
  }
  try {
    const client = await wiring.client(conversationId);
    const result = await readSandboxFileBase64(client, path, wiring.maxBytes);
    if ("error" in result) {
      return err(
        result.tooBig
          ? `show_video: ${result.error} Shorten or re-encode it first (e.g. ffmpeg -i in.mp4 -vf scale=1280:-2 -crf 30 out.mp4).`
          : `show_video failed for ${path}: ${result.error}`,
      );
    }
    const stored = await wiring.assets.put(conversationId, { data: Buffer.from(result.data, "base64"), mimeType });
    const ref: VideoRef = { type: "video", mimeType: stored.mimeType, assetId: stored.assetId, url: stored.url };
    // The UI recognizes a text block holding exactly this JSON as a player.
    return {
      content: [
        { type: "text", text: JSON.stringify(ref) },
        { type: "text", text: `Showing ${path} to the user as an inline video.` },
      ],
    };
  } catch (e) {
    if (e instanceof AssetError) return err(`show_video: ${e.message}`);
    return err(`show_video failed for ${path}: ${(e as Error)?.message ?? e}`);
  }
}
