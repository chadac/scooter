/**
 * BYOC device list: the client half of deregistering a laptop. The controller stores
 * only public keys and never returns key material, so this module deals in summaries
 * (`id`, `label`, `lastSeen`); deregistering is a complete revocation, and the laptop
 * cannot re-register without a fresh join token. Kept separate from client.ts because
 * it targets the agent-host's /remote-agent routes, which relay to the BYOC controller.
 */

export interface ByocDevice {
  id: string;
  label?: string;
  /** Seconds since epoch. */
  lastSeen: number;
}

export interface ByocDevicesConfig {
  /** Base URL of the agent-host API (same origin in the deployed UI). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const base = (c: ByocDevicesConfig): string => (c.baseUrl ?? "").replace(/\/$/, "");

/** The caller's registered devices, most-recently-seen first. */
export async function loadDevices(config: ByocDevicesConfig = {}): Promise<ByocDevice[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const res = await doFetch(`${base(config)}/remote-agent/devices`, { credentials: "same-origin" });
  // 404 (device auth not enabled) and 401 (anonymous) both mean nothing to show, not an error.
  if (res.status === 404 || res.status === 401) return [];
  if (!res.ok) throw new Error(`Failed to load devices (${res.status})`);
  // A non-JSON 200 is the SPA fallback, so no device route.
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("application/json")) return [];
  try {
    return (await res.json()) as ByocDevice[];
  } catch {
    // Content-Type claimed JSON but the body was not.
    return [];
  }
}

/** Revoke a device; the laptop's key stops working immediately. */
export async function deregisterDevice(id: string, config: ByocDevicesConfig = {}): Promise<void> {
  const doFetch = config.fetchImpl ?? fetch;
  const res = await doFetch(`${base(config)}/remote-agent/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok && res.status !== 204) throw new Error(`Failed to deregister (${res.status})`);
}

/** "3 minutes ago" formatting for the settings list. */
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
