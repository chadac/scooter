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
  /** True when the apply was LAUNCHED asynchronously (the switch runs in the
   *  background; poll status()). The agent gets its turn back immediately. */
  async?: boolean;
}

/** The env-switch status the agent (and the completion watcher) poll. Mirrors the
 *  in-pod scooter-env-status states. */
export type EnvSwitchState = "building" | "switching" | "done" | "failed" | "idle";
export interface EnvSwitchStatus {
  state: EnvSwitchState;
  /** The failure summary when state is "failed". */
  error?: string;
  /** The full build/switch log (surfaced on failure so the agent can fix its module). */
  log?: string;
}

export interface ModuleManager {
  /** Launch an apply of a raw NixOS module in the conversation's sandbox. The
   *  build+switch runs in the BACKGROUND (--detach): this returns as soon as it's
   *  launched (async: true), so the agent's turn isn't blocked. A completion watcher
   *  persists the module once the switch reports `done` (build-before-persist). */
  apply(id: SessionId, module: string): Promise<ApplyResult>;
  /** Read the conversation's current env-switch status (for the agent's poll + the
   *  completion watcher). */
  status(id: SessionId): Promise<EnvSwitchStatus>;
  /** Run one completion-watcher pass for a conversation NOW (persist-on-done /
   *  notify-on-failed). The interval watcher calls this; exposed so tests drive it
   *  deterministically without waiting on the timer. No-op if nothing is in flight. */
  pollNow(id: SessionId): Promise<void>;
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
  /** Poll interval (ms) for the completion watcher. Default 5000; 0 disables the
   *  watcher (tests drive completion manually). */
  watchIntervalMs?: number;
  /** Notified when an async apply finishes: ok=true persisted (done), ok=false left
   *  unpersisted (failed) with the log. Optional (e.g. feed a note to the agent). */
  onApplied?: (id: SessionId, res: ApplyResult) => void;
}

const DEFAULT_UPLOAD_PATH = "/run/agent-sandbox/scooter-conv/module.nix";
/** In-pod status dir written by scooter-apply-module (must match runtime-converge.nix). */
const STATUS_DIR = "/run/scooter/env-switch";

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

  // Modules whose switch is IN FLIGHT (launched --detach, not yet done): the module
  // text to PERSIST once the watcher sees `done` (build-before-persist — a failed
  // switch never persists). Keyed by conversation.
  const inFlight = new Map<SessionId, string>();

  const readStatus = async (id: SessionId): Promise<EnvSwitchStatus> => {
    const client = await deps.client(id);
    const read = async (f: string): Promise<string> => {
      try {
        return (await client.download(`${STATUS_DIR}/${f}`)).trim();
      } catch {
        return "";
      }
    };
    const state = ((await read("status")) || "idle") as EnvSwitchState;
    if (state === "failed") {
      return { state, error: (await read("error")) || undefined, log: (await read("log")) || undefined };
    }
    return { state };
  };

  // Persist a successfully-switched module. The PVC is the DURABLE source of truth
  // (survives suspend/resume + restart); the CM is the in-pod delivery copy. Write
  // the PVC FIRST, then eagerly sync the CM (a CM sync failure is non-fatal — the
  // change already switched + the PVC holds it; revive() re-syncs).
  const persist = async (id: SessionId, module: string): Promise<void> => {
    await deps.saveModule?.(id, module);
    try {
      await deps.configMap.writeModule(id, module);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[moduleManager] CM sync failed for ${id} (PVC persisted; revive will re-sync):`, e);
    }
  };

  // LAUNCH the apply in the background and return immediately. The agent's turn is
  // freed; the completion watcher (below) finishes the persist/notify.
  const runLaunch = async (id: SessionId, module: string): Promise<ApplyResult> => {
    try {
      const client = await deps.client(id);
      // Upload the raw module to a writable path (mkdir -p the parent first).
      const dir = uploadPath.slice(0, uploadPath.lastIndexOf("/"));
      await client.execute({ command: "mkdir", args: ["-p", dir] });
      await client.upload(uploadPath, module);
      // --detach: build+switch runs in the background; this returns as soon as it's
      // launched. A non-zero exit here is a LAUNCH failure (e.g. a switch already in
      // flight → exit 3), surfaced now; the switch's own success/failure comes via
      // the status the watcher polls.
      const res = await client.execute({ command: "scooter-apply-module", args: ["--module", uploadPath, "--detach"] });
      if (res.exitCode !== 0) {
        return { ok: false, error: (res.stderr || res.stdout || "launch failed").trim() };
      }
      inFlight.set(id, module); // remember what to persist when it reports `done`
      return { ok: true, async: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  };

  // The completion watcher: poll each conversation with an in-flight async apply;
  // on `done` persist the module + notify; on `failed` notify with the log (leave
  // unpersisted). Reuses the jobManager pollCompletions shape.
  const settleInFlight = async (id: SessionId): Promise<void> => {
    let st: EnvSwitchStatus;
    try {
      st = await readStatus(id);
    } catch {
      return; // pod gone / unreachable — try again next tick (or drop on revive)
    }
    if (st.state === "building" || st.state === "switching") return; // still running
    const module = inFlight.get(id);
    if (module === undefined) return;
    inFlight.delete(id);
    if (st.state === "done") {
      await persist(id, module).catch((e) => console.error(`[moduleManager] persist failed for ${id}:`, e));
      deps.onApplied?.(id, { ok: true, async: true });
    } else if (st.state === "failed") {
      deps.onApplied?.(id, { ok: false, async: true, error: st.error ?? st.log ?? "environment switch failed" });
    }
  };

  const watchIntervalMs = deps.watchIntervalMs ?? 5000;
  let watcher: ReturnType<typeof setInterval> | undefined;
  if (watchIntervalMs > 0) {
    watcher = setInterval(() => {
      for (const id of [...inFlight.keys()]) void settleInFlight(id);
    }, watchIntervalMs);
    (watcher as { unref?: () => void }).unref?.();
  }

  return {
    apply(id, module) {
      // Count the LAUNCH synchronously (before any await) so the idle sweep sees it
      // the instant apply() is called. It's decremented when the launch settles; the
      // in-flight SWITCH (inFlight map) keeps isApplying() true until the watcher
      // sees done/failed — so the sweep never suspends a pod mid-switch.
      pending.set(id, (pending.get(id) ?? 0) + 1);
      // Chain launches per conversation so a new apply can't upload/launch while a
      // prior launch is still uploading. (The switches themselves don't overlap: the
      // in-pod --detach refuses a second switch while one is building/switching.)
      const prev = chains.get(id) ?? Promise.resolve();
      const result = prev.catch(() => {}).then(() => runLaunch(id, module));
      const settled = result.then(
        (r) => { decr(id); return r; },
        (e) => { decr(id); throw e; },
      );
      chains.set(id, settled.catch(() => {}));
      return settled;
    },

    status(id) {
      return readStatus(id);
    },

    pollNow(id) {
      return settleInFlight(id);
    },

    isApplying(id) {
      // A launch is queued/running OR a switch is in flight (not yet settled).
      return (pending.get(id) ?? 0) > 0 || inFlight.has(id);
    },
  };
}
