/**
 * AssetStore: durable storage for a conversation's images and videos. Images arrive base64
 * from an entrypoint (UI upload, Slack); the bytes are stored once and everything
 * downstream (the event log, the AG-UI stream, the ACP prompt reference) carries only a
 * small `assetId`, so the log stays compact and checksum-stable. The bridge reads the
 * bytes back at the ACP boundary and the UI fetches them via
 * GET /conversations/:id/assets/:assetId. Per-kind size caps and a MIME allow-list are
 * enforced on put().
 */

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { SessionId } from "../types.js";

/** Image MIME types: the only assets a model prompt may carry. */
export const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Video MIME types the chat can play inline. */
export const ALLOWED_VIDEO_MIME = new Set(["video/mp4", "video/webm"]);

/** Every MIME type the store accepts by default. */
export const ALLOWED_ASSET_MIME = new Set([...ALLOWED_IMAGE_MIME, ...ALLOWED_VIDEO_MIME]);

/** Default per-image byte cap (~5MB), deployment-configurable via ASSET_MAX_BYTES. */
export const DEFAULT_ASSET_MAX_BYTES = 5 * 1024 * 1024;

/** Default per-video byte cap (~25MB), deployment-configurable via ASSET_VIDEO_MAX_BYTES. */
export const DEFAULT_VIDEO_MAX_BYTES = 25 * 1024 * 1024;

/** Byte caps by kind of asset. */
export interface AssetCaps {
  /** Per-image cap; default DEFAULT_ASSET_MAX_BYTES. */
  maxBytes?: number;
  /** Per-video cap; default DEFAULT_VIDEO_MAX_BYTES. */
  videoMaxBytes?: number;
}

/** The byte cap that applies to an asset of `mimeType`. */
export function capFor(mimeType: string, caps: AssetCaps): number {
  return ALLOWED_VIDEO_MIME.has(mimeType)
    ? (caps.videoMaxBytes ?? DEFAULT_VIDEO_MAX_BYTES)
    : (caps.maxBytes ?? DEFAULT_ASSET_MAX_BYTES);
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/** The MIME type an assetId's extension names, or octet-stream. */
export function mimeForAssetId(assetId: string): string {
  const ext = assetId.split(".").pop() ?? "";
  return Object.entries(MIME_EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
}

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

/** The reason a put() was rejected, mapped by the caller to 413 / 415 / an error. */
export type AssetReject = "too-large" | "unsupported-type" | "empty";

export interface AssetStore {
  /** Store asset bytes for a conversation and return a reference; throws AssetError when over the
   *  size cap, an unsupported MIME, or empty. */
  put(conversationId: SessionId, bytes: AssetBytes): Promise<StoredAsset>;
  /** Read an asset's bytes back, or null if unknown. */
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

export interface PvcAssetStoreOpts extends AssetCaps {
  /** Root dir (the conversation-state PVC, the same as the fileStore root). */
  root: string;
  /** Allowed MIME types; default ALLOWED_ASSET_MIME. */
  allowedMime?: Set<string>;
}

/** File extension for a stored blob, from its MIME. */
export function extFor(mime: string): string {
  return MIME_EXT[mime] ?? "bin";
}

/** The content-addressed assetId both stores mint for these bytes (sha256 prefix + ext), so a
 *  caller can know an asset's id before its put() has finished. */
export function assetIdFor(data: Buffer, mimeType: string): string {
  return `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${extFor(mimeType)}`;
}

export function createPvcAssetStore(opts: PvcAssetStoreOpts): AssetStore {
  const allowed = opts.allowedMime ?? ALLOWED_ASSET_MIME;
  const dir = (id: SessionId) => join(opts.root, id, "assets");
  // assetId encodes the ext, so no index is needed.
  const fileFor = (id: SessionId, assetId: string) => join(dir(id), assetId);

  const urlFor = (id: SessionId, assetId: string) =>
    `/conversations/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}`;

  return {
    urlFor,

    async put(conversationId, { data, mimeType }) {
      if (!data || data.length === 0) throw new AssetError("empty", "empty asset");
      if (!allowed.has(mimeType)) {
        throw new AssetError("unsupported-type", `unsupported asset type: ${mimeType}`);
      }
      const maxBytes = capFor(mimeType, opts);
      if (data.length > maxBytes) {
        throw new AssetError("too-large", `asset is ${data.length} bytes (max ${maxBytes})`);
      }
      // Content-addressed id, so identical uploads dedupe.
      const assetId = assetIdFor(data, mimeType);
      await mkdir(dir(conversationId), { recursive: true });
      await writeFile(fileFor(conversationId, assetId), data);
      return { assetId, mimeType, url: urlFor(conversationId, assetId) };
    },

    async read(conversationId, assetId) {
      // Guard against path traversal: an assetId is a bare hash.ext.
      if (assetId.includes("/") || assetId.includes("..")) return null;
      const path = fileFor(conversationId, assetId);
      if (!existsSync(path)) return null;
      const data = await readFile(path);
      return { data, mimeType: mimeForAssetId(assetId) };
    },

    async clear(conversationId) {
      await rm(dir(conversationId), { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** An AssetStore that can also stage an asset: validate it and mint its reference
 *  synchronously, write it in the background, and have read() wait for that write. */
export interface StagingAssetStore extends AssetStore {
  /** Validate the bytes and start storing them, returning the reference at once, or the reason
   *  they were refused. The bridge maps ACP updates to events synchronously, so this is how it
   *  emits an event pointing at an asset whose write is still in flight. */
  stage(conversationId: SessionId, bytes: AssetBytes): StoredAsset | { rejected: AssetReject };
}

export interface StagingOpts {
  /** Per-asset byte cap; default DEFAULT_ASSET_MAX_BYTES. Match the wrapped store's cap. */
  maxBytes?: number;
  /** Allowed MIME types; default ALLOWED_IMAGE_MIME, since stage() backs inline image blocks. */
  allowedMime?: Set<string>;
}

/**
 * Wrap a store with stage(). A read() of an asset whose staged write has not finished waits
 * for that write, so the UI never 404s on an image it learned about from the live stream.
 */
export function withStaging(store: AssetStore, opts: StagingOpts = {}): StagingAssetStore {
  const maxBytes = opts.maxBytes ?? DEFAULT_ASSET_MAX_BYTES;
  const allowed = opts.allowedMime ?? ALLOWED_IMAGE_MIME;
  const pending = new Map<string, Promise<unknown>>();
  const key = (id: SessionId, assetId: string) => `${id}/${assetId}`;

  return {
    urlFor: (id, assetId) => store.urlFor(id, assetId),
    put: (id, bytes) => store.put(id, bytes),
    clear: (id) => store.clear(id),

    stage(conversationId, bytes) {
      if (!bytes.data || bytes.data.length === 0) return { rejected: "empty" };
      if (!allowed.has(bytes.mimeType)) return { rejected: "unsupported-type" };
      if (bytes.data.length > maxBytes) return { rejected: "too-large" };
      const assetId = assetIdFor(bytes.data, bytes.mimeType);
      const k = key(conversationId, assetId);
      if (!pending.has(k)) {
        // A failed write surfaces as the asset's 404, the same as any unknown asset.
        const write = store
          .put(conversationId, bytes)
          .catch(() => {})
          .finally(() => pending.delete(k));
        pending.set(k, write);
      }
      return { assetId, mimeType: bytes.mimeType, url: store.urlFor(conversationId, assetId) };
    },

    async read(conversationId, assetId) {
      const inFlight = pending.get(key(conversationId, assetId));
      if (inFlight) await inFlight;
      return store.read(conversationId, assetId);
    },
  };
}
