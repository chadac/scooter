/**
 * WebServiceRegistry — reads a conversation's declared web services from the
 * in-pod discovery manifest (/run/scooter/web-services.json, rendered by the
 * `webServices` NixOS option) via the exec API, and drives their systemd
 * units (is-active / start). Descriptors are cached per conversation with a
 * revalidation TTL: the manifest is a symlink to a content-addressed Nix store
 * path (the target changes iff content changes), so `readlink` is a cheap version
 * token. Cache is invalidated on suspend/resume and after a start.
 *
 * Kept separate from webServiceProxy.ts so the proxy stays pure/unit-testable
 * against a fake registry; this module owns the exec/k8s coupling.
 */

import type { SandboxRef } from "../types.js";
import type { WebServiceDescriptor, WebServiceRegistry } from "./webServiceProxy.js";

/** The manifest file the `webServices` option renders inside the pod. */
export const MANIFEST_PATH = "/run/scooter/web-services.json";

/**
 * Revalidation TTL: how often to check if the manifest symlink target changed.
 * A readlink is one cheap exec (~10-20ms); a full download is ~50-100ms + parse.
 * 10s bounds staleness (C2) while keeping steady-state cost low (C5).
 */
const REVALIDATE_MS = 10_000;

/** Minimal exec surface we need (a subset of SandboxApiClient). */
export interface ExecLike {
  execute(req: { command: string; args?: string[] }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  download(path: string): Promise<string>;
}

export interface WebServiceRegistryDeps {
  /** Resolve a conversation id -> its sandbox ref (SessionManager.get(...).sandbox). */
  sandboxFor(conversationId: string): SandboxRef | undefined;
  /** Connect an exec client for a sandbox (index.ts connectSandbox). */
  connect(ref: SandboxRef): Promise<ExecLike>;
}

/** Parse the manifest JSON into descriptors, tolerating a missing/garbage file. */
export function parseManifest(json: string): WebServiceDescriptor[] {
  try {
    const data = JSON.parse(json) as { services?: unknown };
    if (!data || !Array.isArray(data.services)) return [];
    return data.services.flatMap((s): WebServiceDescriptor[] => {
      if (typeof s !== "object" || s === null) return [];
      const o = s as Record<string, unknown>;
      if (typeof o.name !== "string" || typeof o.port !== "number") return [];
      return [{
        name: o.name,
        displayName: typeof o.displayName === "string" ? o.displayName : o.name,
        port: o.port,
        basePath: typeof o.basePath === "string" ? o.basePath : `/c/*/${o.name}`,
        unit: typeof o.unit === "string" ? o.unit : `webservice-${o.name}`,
        stripBasePath: o.stripBasePath === true,
      }];
    });
  } catch {
    return [];
  }
}

/** A cache entry: descriptors + the symlink target (version token) + last check time. */
interface CacheEntry {
  descriptors: WebServiceDescriptor[];
  /** The Nix store path the manifest symlink points to (content-addressed, changes iff content changes). */
  token: string;
  /** When we last checked/revalidated (Date.now()). */
  checkedAt: number;
}

export function createWebServiceRegistry(deps: WebServiceRegistryDeps): WebServiceRegistry {
  // conversationId -> cache entry. undefined = not yet loaded.
  const cache = new Map<string, CacheEntry>();

  /**
   * Read the symlink target (the Nix store path) as a version token.
   * Returns null on failure (pod unreachable, readlink failed, etc.).
   */
  async function getToken(exec: ExecLike): Promise<string | null> {
    try {
      const r = await exec.execute({ command: "readlink", args: [MANIFEST_PATH] });
      if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch {
      // readlink failed (pod suspended, exec timeout, etc.)
    }
    return null;
  }

  /**
   * Download and parse the manifest, returning descriptors + token.
   * Returns null on failure (pod unreachable, download failed, etc.).
   */
  async function downloadManifest(exec: ExecLike): Promise<{ descriptors: WebServiceDescriptor[]; token: string } | null> {
    try {
      const [content, token] = await Promise.all([
        exec.download(MANIFEST_PATH),
        getToken(exec),
      ]);
      if (!token) return null; // readlink failed even though download worked (unusual, but possible)
      const descriptors = parseManifest(content);
      return { descriptors, token };
    } catch {
      return null; // pod asleep / creating / manifest missing
    }
  }

  async function load(conversationId: string): Promise<WebServiceDescriptor[]> {
    const entry = cache.get(conversationId);
    const now = Date.now();

    // No entry: full download (cold start)
    if (!entry) {
      const ref = deps.sandboxFor(conversationId);
      if (!ref) return [];
      try {
        const exec = await deps.connect(ref);
        const result = await downloadManifest(exec);
        if (!result) return []; // download failed → return [] but DON'T cache (retry next time)
        const { descriptors, token } = result;
        // Only cache NON-EMPTY results (C4: empties never authoritative).
        // An empty [] almost always means "couldn't read the manifest yet" — the pod was
        // still ContainerCreating when download() threw, or it was asleep. Caching that
        // empty result made the Sandbox tab show "no services" forever, even once the
        // pod was ready (the bug). So we DON'T cache empties: an empty result is retried
        // on the next call, and only a successful non-empty read is memoized.
        if (descriptors.length > 0) {
          cache.set(conversationId, { descriptors, token, checkedAt: now });
        }
        return descriptors;
      } catch {
        return []; // pod unreachable → retry next time
      }
    }

    // Within TTL: return cached (C5: cheap steady state)
    if (now - entry.checkedAt < REVALIDATE_MS) {
      return entry.descriptors;
    }

    // Past TTL: revalidate via readlink (C1: freshness, C2: bounded staleness)
    const ref = deps.sandboxFor(conversationId);
    if (!ref) return entry.descriptors; // no sandbox → keep cached (C4: failure doesn't clobber)
    try {
      const exec = await deps.connect(ref);
      const token = await getToken(exec);
      
      if (!token) {
        // Readlink failed (pod suspended, exec timeout, etc.) → KEEP cached (C4: failure visible but not destructive)
        return entry.descriptors;
      }

      if (token === entry.token) {
        // Token unchanged: bump checkedAt, return cached (C5: one cheap readlink, no download)
        entry.checkedAt = now;
        return entry.descriptors;
      }

      // Token changed: re-download (C1: freshness, C3: removal honored)
      const result = await downloadManifest(exec);
      if (!result) {
        // Download failed after token changed (unusual) → KEEP old cached (C4)
        return entry.descriptors;
      }

      const { descriptors, token: newToken } = result;
      // Replace cache entry (C3: removal honored — old services disappear)
      cache.set(conversationId, { descriptors, token: newToken, checkedAt: now });
      return descriptors;
    } catch {
      // Connect/exec failed → KEEP cached (C4: failure doesn't clobber)
      return entry.descriptors;
    }
  }

  async function unit(conversationId: string, name: string): Promise<string | null> {
    const desc = (await load(conversationId)).find((d) => d.name === name);
    return desc?.unit ?? null;
  }

  return {
    async list(conversationId) {
      return load(conversationId);
    },
    async get(conversationId, name) {
      return (await load(conversationId)).find((d) => d.name === name) ?? null;
    },
    async isRunning(conversationId, name) {
      const u = await unit(conversationId, name);
      const ref = deps.sandboxFor(conversationId);
      if (!u || !ref) return false;
      try {
        const exec = await deps.connect(ref);
        // `systemctl is-active` exits 0 + prints "active" when running.
        const r = await exec.execute({ command: "systemctl", args: ["is-active", u] });
        return r.exitCode === 0 && r.stdout.trim() === "active";
      } catch {
        return false;
      }
    },
    async start(conversationId, name) {
      const u = await unit(conversationId, name);
      const ref = deps.sandboxFor(conversationId);
      if (!u || !ref) throw new Error(`no web service "${name}" for ${conversationId}`);
      const exec = await deps.connect(ref);
      // Go through `scooter-service` (NOT raw `systemctl start`) so the enabled set is
      // PERSISTED to /workspace/.scooter/services.json — that's how the boot restore
      // oneshot brings this service back after a suspend/resume pod recreate. Every
      // start path (UI Services panel, the proxy's auto-start, the agent's shell) then
      // records autostart identically. (`scooter-service` runs `systemctl start` under
      // the hood, so the unit still comes up the same way.)
      const r = await exec.execute({ command: "scooter-service", args: ["start", name] });
      if (r.exitCode !== 0) {
        throw new Error(`scooter-service start ${name} failed (${r.exitCode}): ${r.stderr.trim()}`);
      }
      // A start may reveal a freshly-enabled service; drop the cache so a re-list
      // re-reads the manifest (C6: invalidation fires).
      cache.delete(conversationId);
    },
    async stop(conversationId, name) {
      const u = await unit(conversationId, name);
      const ref = deps.sandboxFor(conversationId);
      if (!u || !ref) throw new Error(`no web service "${name}" for ${conversationId}`);
      const exec = await deps.connect(ref);
      // Via `scooter-service stop` so autostart is CLEARED in the state file — a service
      // the user deliberately stopped must not come back on the next resume.
      const r = await exec.execute({ command: "scooter-service", args: ["stop", name] });
      if (r.exitCode !== 0) {
        throw new Error(`scooter-service stop ${name} failed (${r.exitCode}): ${r.stderr.trim()}`);
      }
    },
    async logs(conversationId, name, lines = 50) {
      const u = await unit(conversationId, name);
      const ref = deps.sandboxFor(conversationId);
      if (!u || !ref) return "";
      try {
        const exec = await deps.connect(ref);
        // -n <lines> recent, no pager, no color; --no-hostname keeps it compact.
        // A never-started unit journals nothing → "" (harmless; the page shows the
        // spinner). Merge stderr in case journalctl warns but still prints.
        const r = await exec.execute({
          command: "journalctl",
          args: ["-u", u, "-n", String(lines), "--no-pager", "--no-hostname"],
        });
        return (r.stdout || r.stderr || "").trim();
      } catch {
        return ""; // pod asleep / creating / journalctl unavailable
      }
    },
    async ready(conversationId) {
      const ref = deps.sandboxFor(conversationId);
      if (!ref) return false; // no sandbox → not ready
      try {
        // Readiness = the pod is reachable via exec. Use the SAME proven path the
        // service list uses (connect + read the manifest file), rather than a bare
        // `execute` — download() succeeds only once the pod is Running+Ready and
        // throws while it's ContainerCreating/absent. (An empty manifest still means
        // "reachable" → ready; the point is the exec channel is live.)
        const exec = await deps.connect(ref);
        await exec.download(MANIFEST_PATH);
        return true;
      } catch {
        return false; // pod creating / asleep / unreachable
      }
    },
    invalidate(conversationId) {
      cache.delete(conversationId);
    },
  };
}
