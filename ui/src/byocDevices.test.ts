/**
 * Tier 1 (ui) — the BYOC device-list client (§P).
 *
 * The behaviours that matter to a user in Settings: their devices are listed newest-first,
 * deregistering actually revokes, and a deployment WITHOUT device auth degrades to an empty list
 * rather than an error banner.
 */

import { describe, it, expect, vi } from "vitest";

import { loadDevices, deregisterDevice, formatLastSeen } from "./byocDevices.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("byoc device list", () => {
  it("loads the caller's devices", async () => {
    const fetchImpl = vi.fn(async () => json([{ id: "d1", label: "laptop", lastSeen: 100 }])) as unknown as typeof fetch;
    const devices = await loadDevices({ fetchImpl });
    expect(devices).toHaveLength(1);
    expect(devices[0].label).toBe("laptop");
  });

  it("a deployment WITHOUT device auth (404) shows an empty list, not an error", async () => {
    // BYO device auth is optional per deployment. A 404 here means "not enabled", which the user
    // cannot act on — surfacing it as an error banner would be noise on every settings visit.
    const fetchImpl = vi.fn(async () => json({ error: "device auth not enabled" }, 404)) as unknown as typeof fetch;
    await expect(loadDevices({ fetchImpl })).resolves.toEqual([]);
  });

  it("an ANONYMOUS caller (401) also shows an empty list", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "authentication required" }, 401)) as unknown as typeof fetch;
    await expect(loadDevices({ fetchImpl })).resolves.toEqual([]);
  });

  it("a real server error DOES throw (the user should know the list is stale)", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "boom" }, 500)) as unknown as typeof fetch;
    await expect(loadDevices({ fetchImpl })).rejects.toThrow(/500/);
  });

  it("deregister DELETEs the right device", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await deregisterDevice("d1", { fetchImpl });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain("/byoc/devices/d1");
  });

  it("deregister URL-ENCODES the id (a crafted id must not escape the path)", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await deregisterDevice("../../admin", { fetchImpl });
    expect(calls[0]).not.toContain("../");
  });

  it("deregister surfaces a failure so the UI can say it did not work", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "nope" }, 403)) as unknown as typeof fetch;
    await expect(deregisterDevice("d1", { fetchImpl })).rejects.toThrow(/403/);
  });

  it("formats last-seen the way the list reads", () => {
    const now = 1_000_000_000_000; // ms
    const t = (secsAgo: number) => formatLastSeen(Math.floor(now / 1000) - secsAgo, now);
    expect(t(5)).toBe("just now");
    expect(t(60)).toBe("1 minute ago");
    expect(t(120)).toBe("2 minutes ago");
    expect(t(3600)).toBe("1 hour ago");
    expect(t(86_400)).toBe("1 day ago");
    expect(t(3 * 86_400)).toBe("3 days ago");
  });

  it("a clock skew into the future reads as 'just now', never a negative age", () => {
    const now = 1_000_000_000_000;
    expect(formatLastSeen(Math.floor(now / 1000) + 500, now)).toBe("just now");
  });
});
