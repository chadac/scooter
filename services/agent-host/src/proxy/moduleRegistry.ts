/**
 * ModuleRegistry — the agent-host's view of a conversation's Nix MODULES (the
 * `/etc/scooter/modules` + attached registry modules the sandbox re-converges).
 * Backs the Sandbox tab's module search/install + the settings "available modules"
 * list. Like WebServiceRegistry it reaches the pod ONLY via the exec API + the
 * in-pod scooter-* CLIs — no in-pod HTTP server:
 *   - SEARCH the broker catalog:  exec `agent-broker "modules?q=<q>"` (returns JSON).
 *   - LIST attached modules:      read `/etc/scooter/registry-modules.json` (names).
 *   - INSTALL a module:           exec `scooter-rebuild module add <ref>` (attaches +
 *                                 re-converges; needs the pod running).
 *
 * Everything needs a RUNNING pod (the CLIs run in-pod). When the pod is asleep the
 * list is empty and install throws — the UI gates on the Sandbox status.
 */

import type { SandboxRef } from "../types.js";
import type { ExecLike } from "./webServiceRegistry.js";

/** The file scooter-rebuild keeps the attached registry-module NAMES in. */
export const REGISTRY_IDS_PATH = "/etc/scooter/registry-modules.json";

/** One module as the broker registry returns it (GET /modules). */
export interface RegistryModule {
  id: number;
  name: string;
  description: string;
  visibility: "public" | "private";
  /** The publishing conversation id (may be omitted for the caller's own). */
  owner?: string;
}

export interface ModuleRegistryDeps {
  sandboxFor(conversationId: string): SandboxRef | undefined;
  connect(ref: SandboxRef): Promise<ExecLike>;
}

export interface ModuleRegistry {
  /** Search the broker catalog (caller's own + all public). Empty query = all. */
  search(conversationId: string, query: string): Promise<RegistryModule[]>;
  /** The registry modules currently ATTACHED to this conversation (their names). */
  attached(conversationId: string): Promise<string[]>;
  /** Attach a registry module by name-or-id and re-converge. Throws on failure
   *  (unknown module, pod asleep, switch error). Returns the CLI's message. */
  install(conversationId: string, ref: string): Promise<string>;
}

/** Parse the broker `GET /modules` JSON body, tolerating garbage. */
export function parseModuleList(json: string): RegistryModule[] {
  try {
    const data = JSON.parse(json) as { modules?: unknown };
    if (!data || !Array.isArray(data.modules)) return [];
    return data.modules.flatMap((m): RegistryModule[] => {
      if (typeof m !== "object" || m === null) return [];
      const o = m as Record<string, unknown>;
      if (typeof o.name !== "string" || typeof o.id !== "number") return [];
      return [{
        id: o.id,
        name: o.name,
        description: typeof o.description === "string" ? o.description : "",
        visibility: o.visibility === "private" ? "private" : "public",
        owner: typeof o.owner === "string" ? o.owner : undefined,
      }];
    });
  } catch {
    return [];
  }
}

export function createModuleRegistry(deps: ModuleRegistryDeps): ModuleRegistry {
  const connect = async (conversationId: string): Promise<ExecLike | null> => {
    const ref = deps.sandboxFor(conversationId);
    if (!ref) return null;
    try {
      return await deps.connect(ref);
    } catch {
      return null; // pod asleep / unreachable
    }
  };

  return {
    async search(conversationId, query) {
      const exec = await connect(conversationId);
      if (!exec) return [];
      try {
        // agent-broker is the authenticated broker curl wrapper baked into the pod;
        // the query is a substring the broker matches against name/description.
        const r = await exec.execute({ command: "agent-broker", args: [`modules?q=${encodeURIComponent(query)}`] });
        if (r.exitCode !== 0) return [];
        return parseModuleList(r.stdout);
      } catch {
        return [];
      }
    },

    async attached(conversationId) {
      const exec = await connect(conversationId);
      if (!exec) return [];
      try {
        const raw = await exec.download(REGISTRY_IDS_PATH);
        const arr = JSON.parse(raw) as unknown;
        return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return []; // no attached modules / pod asleep
      }
    },

    async install(conversationId, ref) {
      const exec = await connect(conversationId);
      if (!exec) throw new Error("sandbox isn't running — start it, then install the module");
      const r = await exec.execute({ command: "scooter-rebuild", args: ["module", "add", ref] });
      if (r.exitCode !== 0) {
        throw new Error(`install failed (${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
      }
      return (r.stdout || `attached ${ref}`).trim();
    },
  };
}
