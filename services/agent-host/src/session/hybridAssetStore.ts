/**
 * Hybrid AssetStore: metadata in Postgres (conversation_assets: conversation_id,
 * asset_id, mime_type, size_bytes, sha256_hash, created_at), bytes on a dedicated PVC
 * keyed by content-addressed asset_id so identical uploads dedupe. Deleting the
 * metadata is what frees the bytes for a GC job.
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
import { AssetError, ALLOWED_IMAGE_MIME, DEFAULT_ASSET_MAX_BYTES, extFor } from "./assetStore.js";

const log = logger("hybridAssetStore");
const { conversationAssets } = agent_host;


export interface HybridAssetStoreOpts {
  /** Postgres connection string. */
  dsn: string;
  /** Override the database handle (tests). */
  db?: NodePgDatabase;
  /** Root dir for asset bytes (a dedicated PVC, e.g. /var/lib/agent-assets). */
  bytesRoot: string;
  /** Per-image byte cap; default DEFAULT_ASSET_MAX_BYTES. */
  maxBytes?: number;
  /** Allowed MIME types; default ALLOWED_IMAGE_MIME. */
  allowedMime?: Set<string>;
}

export function createHybridAssetStore(opts: HybridAssetStoreOpts): AssetStore {
  const maxBytes = opts.maxBytes ?? DEFAULT_ASSET_MAX_BYTES;
  const allowed = opts.allowedMime ?? ALLOWED_IMAGE_MIME;
  const ownPool = opts.db ? undefined : createPgPool("assetStore", { connectionString: opts.dsn, max: 2 });
  const db: NodePgDatabase = opts.db ?? drizzle(ownPool!);

  // Bytes are stored flat in the root dir keyed by the globally unique asset_id, which keeps GC a
  // simple directory walk.
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

      // Content-addressed id, so identical uploads dedupe across conversations.
      const hash = createHash("sha256").update(data).digest("hex");
      const assetId = `${hash.slice(0, 32)}.${extFor(mimeType)}`;

      // Idempotent: an existing file has the same content.
      await mkdir(opts.bytesRoot, { recursive: true });
      const path = bytesPath(assetId);
      if (!existsSync(path)) {
        await writeFile(path, data);
        log.debug("wrote asset bytes", { assetId, bytes: data.length });
      }

      // ON CONFLICT DO NOTHING: re-pasting the same image is idempotent, and another conversation
      // referencing the same asset_id is the dedup at work.
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
      // Guard against path traversal: an assetId is a bare hash.ext.
      if (assetId.includes("/") || assetId.includes("..")) return null;

      // Only assets belonging to this conversation are readable.
      const row = await db
        .select({ mimeType: conversationAssets.mimeType })
        .from(conversationAssets)
        .where(and(eq(conversationAssets.conversationId, conversationId), eq(conversationAssets.assetId, assetId)))
        .limit(1)
        .then((rows) => rows[0]);

      if (!row) return null;

      const path = bytesPath(assetId);
      if (!existsSync(path)) {
        log.warn("asset metadata exists but bytes missing (orphaned metadata?)", { conversationId, assetId });
        return null;
      }

      const data = await readFile(path);
      return { data, mimeType: row.mimeType };
    },

    async clear(conversationId) {
      // Orphaned bytes are left for a separate GC job.
      await db.delete(conversationAssets).where(eq(conversationAssets.conversationId, conversationId)).catch((e) => {
        log.error("failed to clear asset metadata", { conversationId, error: e });
      });
    },
  };
}
