/**
 * Hybrid AssetStore — metadata in Postgres, bytes on dedicated PVC.
 *
 * METADATA (conversation_assets table):
 *  - conversation_id, asset_id, mime_type, size_bytes, sha256_hash, created_at
 *  - Queryable, transactional, part of conversation lifecycle
 *  - DELETE from metadata triggers GC of orphaned bytes (future job)
 *
 * BYTES (dedicated PVC at /var/lib/agent-assets):
 *  - Raw image data, keyed by asset_id
 *  - Content-addressed (SHA-256), so identical uploads dedupe
 *  - No metadata duplication, just the blobs
 *
 * WHY:
 *  - Referential integrity (metadata tied to conversation)
 *  - Efficient queries (find all assets, total size, orphans)
 *  - Efficient storage (PVC for blobs, DB for structure)
 *  - Simple GC (delete metadata → cleanup job removes orphaned bytes)
 */

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { createPgPool } from "../db/pgPool.js";
import { logger } from "../log.js";
import type { SessionId } from "../types.js";
import type { AssetStore, AssetBytes, StoredAsset, AssetReject } from "./assetStore.js";
import { AssetError, ALLOWED_IMAGE_MIME, DEFAULT_ASSET_MAX_BYTES } from "./assetStore.js";

const log = logger("hybridAssetStore");
const { conversationAssets } = agent_host;

/** file extension for a stored blob, from its MIME (for a tidy on-disk name). */
function extFor(mime: string): string {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" })[mime] ?? "bin";
}

export interface HybridAssetStoreOpts {
  /** Postgres connection string. */
  dsn: string;
  /** Override the database handle (tests). */
  db?: NodePgDatabase;
  /** Root dir for asset BYTES (dedicated PVC, e.g. /var/lib/agent-assets). */
  bytesRoot: string;
  /** Per-image byte cap. Default DEFAULT_ASSET_MAX_BYTES (5MB). */
  maxBytes?: number;
  /** Allowed MIME types. Default ALLOWED_IMAGE_MIME. */
  allowedMime?: Set<string>;
}

export function createHybridAssetStore(opts: HybridAssetStoreOpts): AssetStore {
  const maxBytes = opts.maxBytes ?? DEFAULT_ASSET_MAX_BYTES;
  const allowed = opts.allowedMime ?? ALLOWED_IMAGE_MIME;
  const ownPool = opts.db ? undefined : createPgPool("assetStore", { connectionString: opts.dsn, max: 2 });
  const db: NodePgDatabase = opts.db ?? drizzle(ownPool!);

  // Bytes are stored flat in the root dir, keyed by asset_id (content-addressed).
  // NOT per-conversation subdirs: asset_id is globally unique (SHA-256), and flat
  // is simpler for GC (walk the dir, check each id against the metadata table).
  const bytesPath = (assetId: string) => join(opts.bytesRoot, assetId);

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

      // Content-addressed id (dedupes identical uploads across conversations).
      const hash = createHash("sha256").update(data).digest("hex");
      const assetId = `${hash.slice(0, 32)}.${extFor(mimeType)}`;

      // Write bytes to PVC (idempotent: if the file exists, same content).
      await mkdir(opts.bytesRoot, { recursive: true });
      const path = bytesPath(assetId);
      if (!existsSync(path)) {
        await writeFile(path, data);
        log.debug("wrote asset bytes", { assetId, bytes: data.length });
      }

      // Write metadata to Postgres (ON CONFLICT DO NOTHING: same conversation pasting
      // the same image twice is idempotent; different conversations referencing the
      // same asset_id is the dedup at work).
      await db
        .insert(conversationAssets)
        .values({
          conversationId,
          assetId,
          mimeType,
          sizeBytes: data.length,
          sha256Hash: hash,
        })
        .onConflictDoNothing()
        .catch((e) => {
          log.error("failed to insert asset metadata", { conversationId, assetId, error: e });
          throw e;
        });

      return { assetId, mimeType, url: urlFor(conversationId, assetId) };
    },

    async read(conversationId, assetId) {
      // Guard against path traversal — an assetId is a bare hash.ext, no separators.
      if (assetId.includes("/") || assetId.includes("..")) return null;

      // Check metadata exists for this conversation (authorization: only assets
      // belonging to this conversation are readable).
      const row = await db
        .select({ mimeType: conversationAssets.mimeType })
        .from(conversationAssets)
        .where(and(eq(conversationAssets.conversationId, conversationId), eq(conversationAssets.assetId, assetId)))
        .limit(1)
        .then((rows) => rows[0]);

      if (!row) return null;

      // Read bytes from PVC.
      const path = bytesPath(assetId);
      if (!existsSync(path)) {
        log.warn("asset metadata exists but bytes missing (orphaned metadata?)", { conversationId, assetId });
        return null;
      }

      const data = await readFile(path);
      return { data, mimeType: row.mimeType };
    },

    async clear(conversationId) {
      // Delete metadata rows for this conversation. Orphaned bytes (asset_id on disk
      // with no referencing metadata) are cleaned by a separate GC job (future).
      await db.delete(conversationAssets).where(eq(conversationAssets.conversationId, conversationId)).catch((e) => {
        log.error("failed to clear asset metadata", { conversationId, error: e });
      });
    },
  };
}
