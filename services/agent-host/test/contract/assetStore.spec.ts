/**
 * Tier 1 contract — the PVC AssetStore (multimodal images, stage 1). Stores image
 * bytes once, hands back a small assetId + url; enforces the size cap + MIME
 * allow-list; isolates per conversation; guards path traversal. See
 * docs/MULTIMODAL_IMAGES.md.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPvcAssetStore, AssetError, type AssetStore } from "../../src/session/assetStore.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // "PNG" magic + junk

describe("PVC AssetStore", () => {
  let root: string;
  let store: AssetStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "assets-"));
    store = createPvcAssetStore({ root, maxBytes: 1024 });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("put -> read round-trips the bytes + mime, and returns a same-origin url", async () => {
    const { assetId, mimeType, url } = await store.put("c1", { data: PNG, mimeType: "image/png" });
    expect(mimeType).toBe("image/png");
    expect(url).toBe(`/conversations/c1/assets/${assetId}`);
    const got = await store.read("c1", assetId);
    expect(got?.data.equals(PNG)).toBe(true);
    expect(got?.mimeType).toBe("image/png");
  });

  it("is content-addressed: the same bytes dedupe to the same assetId", async () => {
    const a = await store.put("c1", { data: PNG, mimeType: "image/png" });
    const b = await store.put("c1", { data: PNG, mimeType: "image/png" });
    expect(a.assetId).toBe(b.assetId);
  });

  it("rejects an image over the size cap (too-large)", async () => {
    const big = Buffer.alloc(2048, 7);
    await expect(store.put("c1", { data: big, mimeType: "image/png" })).rejects.toMatchObject({
      name: "AssetError",
      reason: "too-large",
    });
  });

  it("rejects an unsupported MIME type", async () => {
    await expect(store.put("c1", { data: PNG, mimeType: "application/pdf" })).rejects.toMatchObject({
      reason: "unsupported-type",
    });
  });

  it("rejects empty bytes", async () => {
    await expect(store.put("c1", { data: Buffer.alloc(0), mimeType: "image/png" })).rejects.toMatchObject({
      reason: "empty",
    });
  });

  it("isolates assets per conversation", async () => {
    const { assetId } = await store.put("c1", { data: PNG, mimeType: "image/png" });
    expect(await store.read("c2", assetId)).toBeNull(); // not visible from another conversation
    expect(await store.read("c1", assetId)).not.toBeNull();
  });

  it("read returns null for an unknown asset + guards path traversal", async () => {
    expect(await store.read("c1", "nope.png")).toBeNull();
    expect(await store.read("c1", "../../etc/passwd")).toBeNull();
    expect(await store.read("c1", "a/b")).toBeNull();
  });

  it("clear drops a conversation's assets", async () => {
    const { assetId } = await store.put("c1", { data: PNG, mimeType: "image/png" });
    expect(existsSync(join(root, "c1", "assets"))).toBe(true);
    await store.clear("c1");
    expect(await store.read("c1", assetId)).toBeNull();
  });

  it("AssetError carries the reason (for the 413/415 mapping)", async () => {
    try {
      await store.put("c1", { data: Buffer.alloc(2048), mimeType: "image/png" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AssetError);
      expect((e as AssetError).reason).toBe("too-large");
    }
  });
});
