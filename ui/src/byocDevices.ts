/**
 * BYOC device list — the client half of §P's "deregister a laptop" flow.
 *
 * The controller stores only PUBLIC keys and never returns key material, so this module deals in
 * summaries (`id`, `label`, `lastSeen`). Deregistering is a complete revocation: the laptop cannot
 * re-register without a fresh join token, which requires an authenticated session.
 *
 * Kept separate from client.ts because it targets the BYOC CONTROLLER, not the agent-host — the
 * two are different services with different auth surfaces (§L).
 */

export interface ByocDevice {
  id: string;
  label?: string;
  /** Seconds since epoch. */
  lastSeen: number;
}

export interface ByocDevicesConfig {
  /** Base URL of the BYOC surface (same origin in the deployed UI). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const base = (c: ByocDevicesConfig): string => (c.baseUrl ?? "").replace(/\/$/, "");

/** The caller's registered devices, most-recently-seen first. */
export async function loadDevices(config: ByocDevicesConfig = {}): Promise<ByocDevice[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const res = await doFetch(`${base(config)}/byoc/devices`, { credentials: "same-origin" });
  // 404 = device auth not enabled on this deployment; 401 = anonymous. Both mean "nothing to show"
  // rather than an error the user can act on, so the section simply stays empty.
  if (res.status === 404 || res.status === 401) return [];
  if (!res.ok) throw new Error(`Failed to load devices (${res.status})`);
  // A deployment WITHOUT the BYOC controller has no /byoc/* route, so the SPA's catch-all serves
  // index.html with a 200 — res.ok is true and res.json() then throws the parser's own message
  // ("Unexpected token '<', \"<!doctype \"..."), which surfaced VERBATIM in the settings UI.
  // Treat a non-JSON body as "device auth not available here", the same as a 404.
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("application/json")) return [];
  try {
    return (await res.json()) as ByocDevice[];
  } catch {
    // Content-Type claimed JSON but the body was not. Still not something the user can act on.
    return [];
  }
}

/** Revoke a device. The laptop's key stops working immediately. */
export async function deregisterDevice(id: string, config: ByocDevicesConfig = {}): Promise<void> {
  const doFetch = config.fetchImpl ?? fetch;
  const res = await doFetch(`${base(config)}/byoc/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok && res.status !== 204) throw new Error(`Failed to deregister (${res.status})`);
}

/** "3 minutes ago" — the settings list's only real formatting need. */
export function formatLastSeen(lastSeenSeconds: number, nowMs: number = Date.now()): string {
  const secs = Math.max(0, Math.floor(nowMs / 1000) - lastSeenSeconds);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
