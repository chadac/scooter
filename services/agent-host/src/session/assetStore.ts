/**
 * AssetStore — durable storage for a conversation's uploaded images (and, later,
 * other media). Images arrive base64 from an entrypoint (UI upload, Slack); we
 * store the BYTES once here and hand back a small `assetId`. Everything downstream
 * (the event log, the AG-UI stream, the ACP prompt reference) carries only the id
 * — never the base64 — so the log stays compact + checksum-stable. The bridge
 * reads the bytes back at the ACP boundary to build the image content block; the
 * UI fetches them via GET /conversations/:id/assets/:assetId for replay.
 *
 * Pluggable + configurable (docs/MULTIMODAL_IMAGES.md): a PVC backend ships first
 * (bytes on the conversation-state volume, alongside events.jsonl); an S3 backend
 * can implement the same interface later (sharding-clean). Size cap + a MIME
 * allow-list (images only) are enforced on put().
 */

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { SessionId } from "../types.js";

/** Image MIME types we accept. Other types are rejected on put(). */
export const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Default per-image byte cap (~5MB). Deployment-configurable (ASSET_MAX_BYTES). */
export const DEFAULT_ASSET_MAX_BYTES = 5 * 1024 * 1024;

export interface StoredAsset {
  assetId: string;
  mimeType: string;
  /** Same-origin path the UI fetches for replay (served by the management API). */
  url: string;
}

export interface AssetBytes {
  data: Buffer;
  mimeType: string;
}

/** The reason a put() was rejected (the caller maps these to 413 / 415 / an error). */
export type AssetReject = "too-large" | "unsupported-type" | "empty";

export interface AssetStore {
  /** Store image bytes for a conversation; returns a reference (assetId + url).
   *  Rejects (throws AssetError) when over the size cap, an unsupported MIME, or empty. */
  put(conversationId: SessionId, bytes: AssetBytes): Promise<StoredAsset>;
  /** Read an asset's bytes back (for the ACP image block + the replay route). null
   *  if unknown. */
  read(conversationId: SessionId, assetId: string): Promise<AssetBytes | null>;
  /** Drop all of a conversation's assets (called on destroy). */
  clear(conversationId: SessionId): Promise<void>;
  /** The same-origin URL for an asset (does not check existence). */
  urlFor(conversationId: SessionId, assetId: string): string;
}

export class AssetError extends Error {
  constructor(public reason: AssetReject, message: string) {
    super(message);
    this.name = "AssetError";
  }
}

export interface PvcAssetStoreOpts {
  /** Root dir (the conversation-state PVC — same as the fileStore root). */
  root: string;
  /** Per-image byte cap. Default DEFAULT_ASSET_MAX_BYTES. */
  maxBytes?: number;
  /** Allowed MIME types. Default ALLOWED_IMAGE_MIME. */
  allowedMime?: Set<string>;
}

/** file extension for a stored blob, from its MIME (for a tidy on-disk name). */
function extFor(mime: string): string {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" })[mime] ?? "bin";
}

export function createPvcAssetStore(opts: PvcAssetStoreOpts): AssetStore {
  const maxBytes = opts.maxBytes ?? DEFAULT_ASSET_MAX_BYTES;
  const allowed = opts.allowedMime ?? ALLOWED_IMAGE_MIME;
  const dir = (id: SessionId) => join(opts.root, id, "assets");
  // assetId -> the on-disk filename (assetId encodes the ext, so no index needed).
  const fileFor = (id: SessionId, assetId: string) => join(dir(id), assetId);

  const urlFor = (id: SessionId, assetId: string) =>
    `/conversations/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}`;

  return {
    urlFor,

    async put(conversationId, { data, mimeType }) {
      if (!data || data.length === 0) throw new AssetError("empty", "empty asset");
      if (!allowed.has(mimeType)) {
        throw new AssetError("unsupported-type", `unsupported image type: ${mimeType}`);
      }
      if (data.length > maxBytes) {
        throw new AssetError("too-large", `image is ${data.length} bytes (max ${maxBytes})`);
      }
      // Content-addressed id (dedupes identical uploads) + the ext for a tidy name.
      const hash = createHash("sha256").update(data).digest("hex").slice(0, 32);
      const assetId = `${hash}.${extFor(mimeType)}`;
      await mkdir(dir(conversationId), { recursive: true });
      await writeFile(fileFor(conversationId, assetId), data);
      return { assetId, mimeType, url: urlFor(conversationId, assetId) };
    },

    async read(conversationId, assetId) {
      // Guard against path traversal — an assetId is a bare hash.ext, no separators.
      if (assetId.includes("/") || assetId.includes("..")) return null;
      const path = fileFor(conversationId, assetId);
      if (!existsSync(path)) return null;
      const data = await readFile(path);
      const mimeType =
        ({ png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as Record<string, string>)[
          assetId.split(".").pop() ?? ""
        ] ?? "application/octet-stream";
      return { data, mimeType };
    },

    async clear(conversationId) {
      await rm(dir(conversationId), { recursive: true, force: true }).catch(() => {});
    },
  };
}
