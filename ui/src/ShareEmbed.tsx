/**
 * ShareEmbed — renders a published static share (/s/<uuid>/) as a sandboxed,
 * fixed-width <iframe> inline in the conversation.
 *
 * Driven by a fenced markdown code block the agent emits:
 *
 *     ```scooter-embed
 *     share: 7f3c2a1e-1b2c-4d5e-8f90-abcdef012345   # uuid OR /s/<uuid>/ path
 *     width: 720      # optional px (clamped); default a fixed width
 *     height: 480     # optional px
 *     center: true    # optional — center the frame in the message
 *     ```
 *
 * Security posture (see also the broker's frame-ancestors CSP on /s/ responses):
 *   - The src is ALWAYS rebuilt as `<base>/s/<uuid>/` from a validated UUID, so an
 *     agent can never point this at an external site — only at a share.
 *   - `sandbox="allow-scripts allow-popups"` (NO allow-same-origin): interactive
 *     JS charts (Plotly, etc.) run, but in an opaque origin — the frame cannot read
 *     the parent, cookies, or same-origin storage.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 420;
const MIN_WIDTH = 160;
const MAX_WIDTH = 1200;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 4000;

// Absolute origin the broker serves shares from. Empty => relative `/s/<uuid>/`
// (works when the UI and the share serve path share an origin behind the ingress).
const SHARES_BASE = (import.meta.env.VITE_SHARES_BASE_URL ?? "").replace(/\/$/, "");

export interface ShareEmbedSpec {
  uuid: string;
  width: number;
  height: number;
  center: boolean;
}

export type ShareEmbedParse =
  | { ok: true; spec: ShareEmbedSpec }
  | { ok: false; error: string };

/** Pull a share UUID out of a bare uuid, a `/s/<uuid>/` path, or a full share URL. */
export function extractShareUuid(raw: string): string | null {
  const s = raw.trim();
  if (UUID_RE.test(s)) return s.toLowerCase();
  const m = s.match(/\/s\/([0-9a-fA-F-]{36})(?:[/?#]|$)/);
  if (m && UUID_RE.test(m[1])) return m[1].toLowerCase();
  return null;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Parse a `scooter-embed` fence body (simple `key: value` lines). */
export function parseShareEmbed(body: string): ShareEmbedParse {
  const fields: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(":");
    if (i === -1) continue;
    fields[t.slice(0, i).trim().toLowerCase()] = t.slice(i + 1).trim();
  }
  const uuid = extractShareUuid(fields.share ?? fields.uuid ?? fields.src ?? "");
  if (!uuid) {
    return { ok: false, error: "scooter-embed: `share:` must be a share UUID or a /s/<uuid>/ path" };
  }
  return {
    ok: true,
    spec: {
      uuid,
      width: clampInt(fields.width, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH),
      height: clampInt(fields.height, DEFAULT_HEIGHT, MIN_HEIGHT, MAX_HEIGHT),
      center: /^(true|yes|1|center|centre)$/i.test(fields.center ?? ""),
    },
  };
}

export function ShareEmbed({ body }: { body: string }) {
  const parsed = parseShareEmbed(body);
  if (!parsed.ok) {
    return (
      <div
        data-testid="share-embed-error"
        className="my-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        {parsed.error}
      </div>
    );
  }
  const { uuid, width, height, center } = parsed.spec;
  const src = `${SHARES_BASE}/s/${uuid}/`;
  return (
    <div
      data-testid="share-embed"
      className="my-3"
      style={center ? { display: "flex", justifyContent: "center" } : undefined}
    >
      <iframe
        src={src}
        title={`shared page ${uuid}`}
        loading="lazy"
        referrerPolicy="no-referrer"
        // NO allow-same-origin: keep the frame in an opaque origin.
        sandbox="allow-scripts allow-popups"
        className="aui-share-embed rounded-xl border border-border/60 bg-background"
        style={{ width, height, maxWidth: "100%" }}
      />
    </div>
  );
}
