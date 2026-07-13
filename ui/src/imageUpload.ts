/**
 * Client-side image helpers for the composer upload path: pull image parts out of
 * an assistant-ui message's content, and downscale/re-encode them under a byte cap
 * before they're sent (the agent-host also hard-rejects over its cap; this keeps
 * the payload sane + avoids a rejected send). See docs/MULTIMODAL_IMAGES.md.
 */

/** An image ready to send: raw base64 (no data-url prefix) + its mime. */
export interface OutboundImage {
  data: string;
  mimeType: string;
}

/** Default client cap (~5MB) — should track the agent-host ASSET_MAX_BYTES. */
export const CLIENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Longest edge we downscale to before re-encoding (keeps large screenshots sane). */
const MAX_EDGE = 2000;

/** Split a `data:<mime>;base64,<data>` URL into { mimeType, data } (no prefix). */
export function parseDataUrl(url: string): OutboundImage | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return m ? { mimeType: m[1], data: m[2] } : null;
}

/** base64 length -> byte size (0.75 ratio, minus padding). */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * Pull the image parts out of an assistant-ui message content array. assistant-ui
 * stores an image part as { type: "image", image: <data-url> }; we also accept our
 * own { type: "image", data, mimeType } shape. Non-image parts are ignored.
 */
export function imagesFromContent(content: unknown): OutboundImage[] {
  if (!Array.isArray(content)) return [];
  const out: OutboundImage[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; image?: string; data?: string; mimeType?: string };
    if (p.type !== "image") continue;
    if (p.data && p.mimeType) out.push({ data: p.data, mimeType: p.mimeType });
    else if (typeof p.image === "string") {
      const parsed = p.image.startsWith("data:") ? parseDataUrl(p.image) : null;
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/**
 * Downscale + re-encode an image (data-url in) so its longest edge <= MAX_EDGE and
 * its bytes <= maxBytes, stepping JPEG quality down until it fits. Returns the
 * re-encoded OutboundImage, or null if it can't be loaded. Browser-only (uses
 * canvas); in a non-DOM context it returns the source unchanged.
 */
export async function downscaleImage(
  dataUrl: string,
  maxBytes = CLIENT_IMAGE_MAX_BYTES,
): Promise<OutboundImage | null> {
  const src = parseDataUrl(dataUrl);
  if (!src) return null;
  // No canvas (SSR/tests) — pass through; the server still enforces the cap.
  if (typeof document === "undefined" || typeof Image === "undefined") return src;
  // Already small enough and not huge-dimensioned -> keep as-is (avoid re-encode).
  if (base64Bytes(src.data) <= maxBytes) return src;

  const img = await loadImage(dataUrl).catch(() => null);
  if (!img) return src;
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return src;
  ctx.drawImage(img, 0, 0, w, h);

  for (const q of [0.9, 0.8, 0.7, 0.6]) {
    const out = parseDataUrl(canvas.toDataURL("image/jpeg", q));
    if (out && base64Bytes(out.data) <= maxBytes) return out;
  }
  // Last resort: the smallest-quality encode (server may still reject; UI warns).
  return parseDataUrl(canvas.toDataURL("image/jpeg", 0.5)) ?? src;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
