/**
 * Media references in tool results. The agent-host replaces each inline image in a tool
 * result with `{type:"image", mimeType, assetId, url}` (or `{..., omitted}` when it could not
 * be stored), and show_video returns a text block holding `{type:"video", mimeType, assetId,
 * url}` as JSON; the tool card renders those inline and shows the rest of the result as text.
 */

export interface ResultImage {
  /** Fetchable URL (API base + the assets route). */
  src: string;
  mimeType: string;
}

/** A video a tool result points at; same shape as an image. */
export type ResultVideo = ResultImage;

export interface SplitResult {
  images: ResultImage[];
  videos: ResultVideo[];
  /** Images that were not stored, by reason ("too-large", "unsupported-type", ...). */
  omitted: string[];
  /** The result with the image refs taken out, or undefined when nothing else is left. */
  rest: unknown;
}

const MAX_DEPTH = 8;

function isImageRef(v: unknown): v is { type: "image"; mimeType?: string; url?: string; omitted?: string } {
  if (!v || typeof v !== "object") return false;
  const o = v as { type?: unknown; url?: unknown; omitted?: unknown };
  return o.type === "image" && (typeof o.url === "string" || typeof o.omitted === "string");
}

/** Only the agent-host's own assets route is rendered, never an arbitrary URL in a result. */
const ASSET_PATH = /^\/conversations\/[^/]+\/assets\/[^/]+$/;

/** The video ref on `text`'s first line and the text after it, or null. A provider may
 *  join a result's text blocks into one string, so the ref need not stand alone. */
function videoRef(text: string): { video: { mimeType: string; url: string }; after: string } | null {
  if (!text.startsWith('{"type":"video"')) return null;
  const nl = text.indexOf("\n");
  try {
    const o = JSON.parse(nl < 0 ? text : text.slice(0, nl)) as { type?: unknown; mimeType?: unknown; url?: unknown };
    if (o.type !== "video" || typeof o.url !== "string" || !ASSET_PATH.test(o.url)) return null;
    const mimeType = typeof o.mimeType === "string" ? o.mimeType : "video";
    return { video: { mimeType, url: o.url }, after: nl < 0 ? "" : text.slice(nl + 1).trim() };
  } catch {
    return null;
  }
}

/** Pull the image and video refs out of a tool result (any nesting) and return what is left. */
export function splitResultImages(result: unknown, baseUrl = ""): SplitResult {
  const images: ResultImage[] = [];
  const videos: ResultVideo[] = [];
  const omitted: string[] = [];
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      const found = videoRef(v);
      if (!found) return v;
      videos.push({ src: baseUrl + found.video.url, mimeType: found.video.mimeType });
      return found.after || undefined;
    }
    if (depth > MAX_DEPTH || !v || typeof v !== "object") return v;
    const block = v as { type?: unknown; text?: unknown };
    if (block.type === "text" && typeof block.text === "string") {
      const text = walk(block.text, depth + 1);
      return text === block.text ? v : text === undefined ? undefined : { ...block, text };
    }
    if (isImageRef(v)) {
      if (typeof v.url === "string" && ASSET_PATH.test(v.url)) {
        images.push({ src: baseUrl + v.url, mimeType: v.mimeType ?? "image" });
      } else {
        omitted.push(v.omitted ?? "unavailable");
      }
      return undefined;
    }
    if (Array.isArray(v)) {
      const out = v.map((x) => walk(x, depth + 1)).filter((x) => x !== undefined);
      // An ACP `{type:"content", content:<image>}` wrapper left empty is dropped too.
      return out.length ? out : v.length ? undefined : v;
    }
    const o = v as Record<string, unknown>;
    if (o.type === "content" && "content" in o) {
      const inner = walk(o.content, depth + 1);
      return inner === undefined ? undefined : { ...o, content: inner };
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      const y = walk(x, depth + 1);
      if (y !== undefined) out[k] = y;
    }
    return out;
  };
  if (!result || (typeof result !== "object" && typeof result !== "string")) {
    return { images, videos, omitted, rest: result };
  }
  const rest = walk(result, 0);
  // Nothing found: hand back the original so the card renders it exactly as before.
  if (!images.length && !videos.length && !omitted.length) return { images, videos, omitted, rest: result };
  const empty = rest === undefined || (typeof rest === "object" && rest !== null && Object.keys(rest).length === 0);
  return { images, videos, omitted, rest: empty ? undefined : (textOnly(rest) ?? rest) };
}

/** The text of a result left holding only text blocks (MCP `{type:"text"}` or the ACP
 *  `{type:"content", content:{type:"text"}}` wrapper), else null, so the card shows the
 *  caption beside the images as prose rather than JSON. */
function textOnly(v: unknown): string | null {
  // An MCP result object flattens only when `content` is all it carries (isError etc. stay visible).
  const onlyContent = !!v && typeof v === "object" && Object.keys(v).length === 1 && "content" in v;
  const blocks = Array.isArray(v) ? v : onlyContent ? (v as { content: unknown }).content : undefined;
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const texts: string[] = [];
  for (const b of blocks) {
    const inner = (b as { type?: unknown; content?: unknown })?.type === "content" ? (b as { content: unknown }).content : b;
    const t = inner as { type?: unknown; text?: unknown };
    if (t?.type !== "text" || typeof t.text !== "string") return null;
    texts.push(t.text);
  }
  return texts.join("\n");
}
