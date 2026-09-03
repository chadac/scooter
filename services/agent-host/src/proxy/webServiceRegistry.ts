/**
 * WebServiceRegistry — reads a conversation's declared web services from the
 * in-pod discovery manifest (/run/scooter/web-services.json, rendered by the
 * `webServices` NixOS option) via the exec API, and drives their systemd
 * units (is-active / start). Descriptors are cached per conversation with a short
 * TTL, so a `scooter-rebuild` that declares a new service shows up without a
 * restart; start drops the entry, and list({force}) re-reads on demand.
 *
 * Kept separate from webServiceProxy.ts so the proxy stays pure/unit-testable
 * against a fake registry; this module owns the exec/k8s coupling.
 */

import type { SandboxRef } from "../types.js";
import type { WebServiceDescriptor, WebServiceRegistry } from "./webServiceProxy.js";

/** The manifest file the `webServices` option renders inside the pod. */
export const MANIFEST_PATH = "/run/scooter/web-services.json";

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

/** How long a successful manifest read stays authoritative. The manifest changes
 *  when the agent runs `scooter-rebuild` (switch-to-configuration re-applies the
 *  tmpfiles rule that points /run/scooter/web-services.json at the new store
 *  path), and nothing in the pod tells us. Without an expiry the list a
 *  conversation started with is served for the life of the process, so a service
 *  the agent just declared never appears. The read is one exec, so re-checking on
 *  this cadence is cheap next to being wrong. */
export const MANIFEST_TTL_MS = 10_000;

export function createWebServiceRegistry(
  deps: WebServiceRegistryDeps,
  opts: { ttlMs?: number; now?: () => number } = {},
): WebServiceRegistry {
  const ttlMs = opts.ttlMs ?? MANIFEST_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  // conversationId -> descriptors + when they were read. undefined = not yet loaded.
  const cache = new Map<string, { descriptors: WebServiceDescriptor[]; at: number }>();

  async function load(conversationId: string, force = false): Promise<WebServiceDescriptor[]> {
    const entry = cache.get(conversationId);
    const cached = !force && entry && now() - entry.at < ttlMs ? entry.descriptors : undefined;
    // Only a NON-EMPTY cached list is authoritative. An empty [] almost always means
    // "couldn't read the manifest yet" — the pod was still ContainerCreating when a
    // prior call ran (download() threw → []), or it was asleep. Caching that empty
    // result made the Sandbox tab show "no services" forever, even once the pod was
    // ready (the bug). So we DON'T cache empties: an empty result is retried on the
    // next call, and only a successful non-empty read is memoized.
    if (cached && cached.length > 0) return cached;
    const ref = deps.sandboxFor(conversationId);
    if (!ref) return [];
    let descriptors: WebServiceDescriptor[] = [];
    try {
      const exec = await deps.connect(ref);
      descriptors = parseManifest(await exec.download(MANIFEST_PATH));
    } catch {
      descriptors = []; // pod asleep / creating / manifest missing — retry next time
    }
    if (descriptors.length > 0) cache.set(conversationId, { descriptors, at: now() });
    return descriptors;
  }

  async function unit(conversationId: string, name: string): Promise<string | null> {
    const desc = (await load(conversationId)).find((d) => d.name === name);
    return desc?.unit ?? null;
  }

  return {
    async list(conversationId, opts) {
      return load(conversationId, opts?.force ?? false);
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
      // re-reads the manifest.
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
