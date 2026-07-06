/**
 * moduleManager — the agent-self-modify apply orchestrator (runs in the agent-host,
 * the "brain", outside the pod).
 *
 * The agent requests an environment change with a raw NixOS `module.nix`. The
 * agent-host OWNS that module: it applies it live in the sandbox AND persists it
 * to the per-conversation ConfigMap so it survives suspend/resume. Flow per apply:
 *
 *   1. upload the module to a writable in-pod path (/run is tmpfs) — the live path,
 *      bypassing the ~60s kubelet ConfigMap-sync lag;
 *   2. exec `scooter-apply-module --module <path>` — the in-pod build is the
 *      validation gate; it registers a generation, switches, and auto-rolls-back a
 *      bad switch (the spike). A bad module fails the build and never switches;
 *   3. persist the module to the ConfigMap ONLY on exit 0 (build-before-persist),
 *      so the CM always holds a switch-clean module. On failure we return the
 *      build/switch stderr to the agent and leave the CM untouched.
 *
 * Applies are SERIALIZED per conversation (never two concurrent switches in one
 * pod), and `isApplying(id)` lets the idle sweep avoid suspending mid-switch.
 */

import type { SandboxApiClient } from "../exec/sandboxExec.js";
import type { SessionId } from "../types.js";

/** Persists the agent-authored module durably (the per-conversation ConfigMap in
 *  prod; a fake in tests). */
export interface ConfigMapWriter {
  writeModule(id: SessionId, module: string): Promise<void>;
}

export interface ApplyResult {
  ok: boolean;
  /** Build/switch stderr (or a host-side error) when ok is false. */
  error?: string;
}

export interface ModuleManager {
  /** Apply a raw NixOS module live to the conversation's sandbox; persist on
   *  success. Serialized per conversation. */
  apply(id: SessionId, module: string): Promise<ApplyResult>;
  /** True while an apply (switch) is in flight for this conversation — the idle
   *  sweep checks this so it never suspends a pod mid-switch. */
  isApplying(id: SessionId): boolean;
}

export interface ModuleManagerDeps {
  /** Resolve a conversation's exec client (the same one the bridge uses). */
  client: (id: SessionId) => SandboxApiClient | Promise<SandboxApiClient>;
  configMap: ConfigMapWriter;
  /** Persist the module to the DURABLE PVC store (source of truth). The CM is
   *  synced from this. Optional so tests/fakes can omit it. */
  saveModule?: (id: SessionId, module: string) => Promise<void>;
  /** In-pod path to upload the module to before applying (tmpfs, writable). */
  uploadPath?: string;
}

const DEFAULT_UPLOAD_PATH = "/run/agent-sandbox/scooter-conv/module.nix";

export function createModuleManager(deps: ModuleManagerDeps): ModuleManager {
  const uploadPath = deps.uploadPath ?? DEFAULT_UPLOAD_PATH;
  // Per-conversation serialization: the tail of each conversation's apply chain.
  const chains = new Map<SessionId, Promise<unknown>>();
  // Per-conversation count of queued+in-flight applies — incremented SYNCHRONOUSLY
  // in apply() so the idle sweep sees it immediately, decremented as each settles.
  const pending = new Map<SessionId, number>();
  const decr = (id: SessionId) => {
    const n = (pending.get(id) ?? 1) - 1;
    if (n <= 0) pending.delete(id);
    else pending.set(id, n);
  };

  const runApply = async (id: SessionId, module: string): Promise<ApplyResult> => {
    try {
      const client = await deps.client(id);

      // 1. Upload the raw module to a writable path (mkdir -p the parent first).
      const dir = uploadPath.slice(0, uploadPath.lastIndexOf("/"));
      await client.execute({ command: "mkdir", args: ["-p", dir] });
      await client.upload(uploadPath, module);

      // 2. Build + switch + rollback in-pod. The exit code is the gate.
      const res = await client.execute({
        command: "scooter-apply-module",
        args: ["--module", uploadPath],
      });
      if (res.exitCode !== 0) {
        return { ok: false, error: (res.stderr || res.stdout || "apply failed").trim() };
      }

      // 3. Clean switch -> persist. The PVC is the DURABLE source of truth
      //    (survives suspend/resume + agent-host restart); the ConfigMap is the
      //    in-pod delivery copy the boot re-converge reads. Write the PVC FIRST
      //    (it can't 404), then eagerly sync it into the CM. A CM sync failure is
      //    non-fatal to the live apply — the change already switched in-pod and the
      //    PVC holds it, so revive() will re-sync the CM next time.
      await deps.saveModule?.(id, module);
      try {
        await deps.configMap.writeModule(id, module);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[moduleManager] CM sync failed for ${id} (PVC persisted; revive will re-sync):`, e);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  };

  return {
    apply(id, module) {
      // Count this apply SYNCHRONOUSLY (before any await) so the idle sweep sees it
      // the instant apply() is called, even while it's queued behind a prior one.
      pending.set(id, (pending.get(id) ?? 0) + 1);
      // Chain after any in-flight apply for this conversation so switches never
      // overlap in the same pod. A prior failure must not break the chain.
      const prev = chains.get(id) ?? Promise.resolve();
      const result = prev.catch(() => {}).then(() => runApply(id, module));
      // The returned promise resolves AFTER the pending count is decremented, so a
      // caller that awaits apply() then checks isApplying() sees an accurate flag.
      const settled = result.then(
        (r) => {
          decr(id);
          return r;
        },
        (e) => {
          decr(id);
          throw e;
        },
      );
      chains.set(id, settled.catch(() => {}));
      return settled;
    },

    isApplying(id) {
      return (pending.get(id) ?? 0) > 0;
    },
  };
}
