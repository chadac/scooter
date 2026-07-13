/**
 * WebServiceRegistry — reads a conversation's declared web services from the
 * in-pod discovery manifest (/run/scooter/web-services.json, rendered by the
 * `webServices` NixOS option) via the exec API, and drives their systemd
 * units (is-active / start). Descriptors are cached per conversation; the cache is
 * invalidated on suspend/resume and after a start.
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
      }];
    });
  } catch {
    return [];
  }
}

export function createWebServiceRegistry(deps: WebServiceRegistryDeps): WebServiceRegistry {
  // conversationId -> descriptors (cached). undefined = not yet loaded.
  const cache = new Map<string, WebServiceDescriptor[]>();

  async function load(conversationId: string): Promise<WebServiceDescriptor[]> {
    const cached = cache.get(conversationId);
    if (cached) return cached;
    const ref = deps.sandboxFor(conversationId);
    if (!ref) return [];
    let descriptors: WebServiceDescriptor[] = [];
    try {
      const exec = await deps.connect(ref);
      descriptors = parseManifest(await exec.download(MANIFEST_PATH));
    } catch {
      descriptors = []; // pod asleep / manifest missing — nothing declared
    }
    cache.set(conversationId, descriptors);
    return descriptors;
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
      const r = await exec.execute({ command: "systemctl", args: ["start", u] });
      if (r.exitCode !== 0) {
        throw new Error(`systemctl start ${u} failed (${r.exitCode}): ${r.stderr.trim()}`);
      }
      // A start may reveal a freshly-enabled service; drop the cache so a re-list
      // re-reads the manifest.
      cache.delete(conversationId);
    },
    invalidate(conversationId) {
      cache.delete(conversationId);
    },
  };
}
