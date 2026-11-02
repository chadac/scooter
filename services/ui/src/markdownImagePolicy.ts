/**
 * Which markdown `![alt](src)` images load by default. Agent-written markdown is untrusted
 * text, and an image URL is a request the browser makes on the reader's behalf: a remote one
 * can track the reader or leak data in its query string. So only the conversation's own
 * stored assets and inline raster data URLs load; anything else renders as a placeholder the
 * reader can choose to load.
 */

import { useSyncExternalStore } from "react";

export type ImageVerdict =
  /** Load it. `src` is what to fetch (the asset path with the API base prefixed). */
  | { kind: "allow"; src: string }
  /** A remote image: shown only once the reader asks. */
  | { kind: "remote"; src: string; host: string }
  /** A sandbox path or other relative reference the browser cannot fetch. */
  | { kind: "local"; path: string }
  /** Not an image reference we will ever load (javascript:, svg data:, ...). */
  | { kind: "invalid" };

const ASSET_PATH = /^\/conversations\/[^/?#]+\/assets\/[^/?#]+$/;
// SVG is excluded: it is a document that can carry script.
const DATA_RASTER = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

export function classifyImageSrc(raw: string | undefined, baseUrl = ""): ImageVerdict {
  const src = (raw ?? "").trim();
  if (!src) return { kind: "invalid" };
  if (ASSET_PATH.test(src)) return { kind: "allow", src: baseUrl + src };
  if (baseUrl && src.startsWith(baseUrl) && ASSET_PATH.test(src.slice(baseUrl.length))) return { kind: "allow", src };
  if (src.startsWith("data:")) return DATA_RASTER.test(src) ? { kind: "allow", src } : { kind: "invalid" };
  if (/^https?:\/\//i.test(src)) {
    try {
      const u = new URL(src);
      // An .svg is a document that can carry script, remote or not.
      if (/\.svgz?$/i.test(u.pathname)) return { kind: "invalid" };
      return { kind: "remote", src, host: u.host };
    } catch {
      return { kind: "invalid" };
    }
  }
  // Any other scheme (javascript:, file:, blob:, ...) is refused outright.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return { kind: "invalid" };
  return { kind: "local", path: src };
}

const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

/**
 * react-markdown's urlTransform. Its default drops every data: URL, which would blank an
 * inline raster image before classifyImageSrc sees it, so an image src keeps a raster data:
 * URL; everything else follows the default (relative or a safe protocol, else "").
 */
export function markdownUrlTransform(url: string, key: string): string {
  if (key === "src" && DATA_RASTER.test(url.trim())) return url.trim();
  const colon = url.indexOf(":");
  const q = url.indexOf("?");
  const hash = url.indexOf("#");
  const slash = url.indexOf("/");
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (q !== -1 && colon > q) ||
    (hash !== -1 && colon > hash) ||
    SAFE_PROTOCOL.test(url.slice(0, colon))
  ) {
    return url;
  }
  return "";
}

// Remote images the reader chose to load, for this page session only.
const allowed = new Set<string>();
const listeners = new Set<() => void>();

export const remoteImageConsent = {
  allow(src: string) {
    if (allowed.has(src)) return;
    allowed.add(src);
    for (const l of listeners) l();
  },
  has: (src: string) => allowed.has(src),
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

/** Whether the reader has chosen to load this remote image. */
export function useRemoteImageAllowed(src: string): boolean {
  return useSyncExternalStore(remoteImageConsent.subscribe, () => remoteImageConsent.has(src), () => false);
}
