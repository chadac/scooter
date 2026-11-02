/**
 * Move inline image bytes out of agent output and into the AssetStore. A tool result (MCP,
 * ACP or Messages-API shaped) or an agent message chunk can carry base64 images; the event
 * log keeps only a reference ({type:"image", mimeType, assetId, url}) so it stays compact
 * and the UI renders the image from the assets route.
 */

import type { AssetReject, StoredAsset } from "./assetStore.js";

/** Stage bytes into the conversation's asset store (see StagingAssetStore.stage). */
export type StageAsset = (bytes: { data: Buffer; mimeType: string }) => StoredAsset | { rejected: AssetReject };

/** An image reference as it rides the event log in place of the bytes. */
export type ImageRef =
  | { type: "image"; mimeType: string; assetId: string; url: string }
  /** The bytes were dropped (too large, unsupported, or no store) and only this marker is kept. */
  | { type: "image"; mimeType: string; omitted: AssetReject | "unavailable" };

/** Recursion bound: tool results are shallow, so this only guards against pathological input. */
const MAX_DEPTH = 8;

/** The base64 bytes and mime of an inline image block, or null if `v` is not one. Accepts the
 *  MCP/ACP `{type:"image", data, mimeType}` and the Messages-API
 *  `{type:"image", source:{type:"base64", media_type, data}}` shapes. */
export function inlineImage(v: unknown): { data: string; mimeType: string } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { type?: unknown; data?: unknown; mimeType?: unknown; source?: { type?: unknown; data?: unknown; media_type?: unknown } };
  if (o.type !== "image") return null;
  if (typeof o.data === "string" && typeof o.mimeType === "string") return { data: o.data, mimeType: o.mimeType };
  const s = o.source;
  if (s && s.type === "base64" && typeof s.data === "string" && typeof s.media_type === "string") {
    return { data: s.data, mimeType: s.media_type };
  }
  return null;
}

/** Store one inline image and return the reference that replaces it. */
export function toImageRef(img: { data: string; mimeType: string }, stage: StageAsset | undefined): ImageRef {
  if (!stage) return { type: "image", mimeType: img.mimeType, omitted: "unavailable" };
  const r = stage({ data: Buffer.from(img.data, "base64"), mimeType: img.mimeType });
  if ("rejected" in r) return { type: "image", mimeType: img.mimeType, omitted: r.rejected };
  return { type: "image", mimeType: r.mimeType, assetId: r.assetId, url: r.url };
}

/**
 * Return a copy of `value` with every inline image replaced by an ImageRef, plus the refs that
 * were stored. Values without images come back as the same reference, so the common path
 * allocates nothing.
 */
export function replaceInlineImages(value: unknown, stage: StageAsset | undefined): { value: unknown; refs: ImageRef[] } {
  const refs: ImageRef[] = [];
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH || !v || typeof v !== "object") return v;
    const img = inlineImage(v);
    if (img) {
      const ref = toImageRef(img, stage);
      refs.push(ref);
      return ref;
    }
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = walk(x, depth + 1);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    let out: Record<string, unknown> | undefined;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const y = walk(x, depth + 1);
      if (y !== x) (out ??= { ...(v as Record<string, unknown>) })[k] = y;
    }
    return out ?? v;
  };
  return { value: walk(value, 0), refs };
}
