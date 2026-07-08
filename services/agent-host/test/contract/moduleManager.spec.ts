/**
 * Tier 1 contract test — the agent-self-modify apply orchestrator.
 *
 * moduleManager.apply(convId, rawModule) drives the live re-converge:
 *   1. upload the module to a writable in-pod path,
 *   2. exec `scooter-apply-module --module <path>` (build -> switch -> rollback),
 *   3. persist the module to the per-conversation ConfigMap ONLY on a clean apply
 *      (exit 0) — build-before-persist, so the CM always holds a switch-clean
 *      module; a failed build/switch returns the error and leaves the CM untouched.
 * Applies are serialized per conversation (no concurrent switches in one pod).
 *
 * Uses fake SandboxApiClient + fake ConfigMap writer — no cluster, deterministic.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createModuleManager, type ConfigMapWriter } from "../../src/session/moduleManager.js";
import type { SandboxApiClient } from "../../src/exec/sandboxExec.js";
import type { ExecRequest, ExecResult } from "../../src/types.js";

// A fake sandbox client. The apply is now ASYNC (--detach): the `scooter-apply-module`
// exec LAUNCHES + returns fast (launchExit); the switch's outcome is read from the
// in-pod status files via download(). `setStatus` scripts what a subsequent poll sees.
function fakeClient(opts: { launchExit?: number; launchStderr?: string } = {}) {
  const uploads: Array<{ path: string; content: string }> = [];
  const execs: ExecRequest[] = [];
  const files = new Map<string, string>(); // /run/scooter/env-switch/{status,error,log}
  const client: SandboxApiClient = {
    mode: "k8s-exec",
    async upload(path, content) {
      uploads.push({ path, content });
    },
    async download(path) {
      const v = files.get(path);
      if (v === undefined) throw new Error(`no such file: ${path}`);
      return v;
    },
    async execute(req): Promise<ExecResult> {
      execs.push(req);
      const cmd = [req.command, ...req.args].join(" ");
      if (cmd.includes("scooter-apply-module")) {
        return { stdout: "", stderr: opts.launchStderr ?? "", exitCode: opts.launchExit ?? 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const setStatus = (state: string, extra: { error?: string; log?: string } = {}) => {
    files.set("/run/scooter/env-switch/status", state);
    if (extra.error !== undefined) files.set("/run/scooter/env-switch/error", extra.error);
    if (extra.log !== undefined) files.set("/run/scooter/env-switch/log", extra.log);
  };
  return { client, uploads, execs, setStatus };
}

function fakeConfigMap() {
  const persisted: Array<{ id: string; module: string }> = [];
  const writer: ConfigMapWriter = {
    async writeModule(id, module) {
      persisted.push({ id, module });
    },
  };
  return { writer, persisted };
}

const MODULE = `{ ... }: { environment.systemPackages = [ ]; }`;

describe("moduleManager.apply", () => {
  let cm: ReturnType<typeof fakeConfigMap>;
  beforeEach(() => {
    cm = fakeConfigMap();
  });

  // watchIntervalMs: 0 disables the auto-poll timer; tests drive completion via
  // pollNow() so they're deterministic (no waiting on the 5s interval).
  const mkMgr = (client: SandboxApiClient) =>
    createModuleManager({ client: () => client, configMap: cm.writer, watchIntervalMs: 0 });

  it("LAUNCHES scooter-apply-module --detach (async) and returns without waiting", async () => {
    const { client, uploads, execs } = fakeClient({ launchExit: 0 });
    const mgr = mkMgr(client);

    const res = await mgr.apply("conv1", MODULE);

    expect(res.ok).toBe(true);
    expect(res.async).toBe(true); // launched, not awaited
    // uploaded the raw module to a writable (/run) path
    expect(uploads.length).toBe(1);
    expect(uploads[0].content).toBe(MODULE);
    expect(uploads[0].path).toMatch(/^\/run\//);
    // exec'd scooter-apply-module --detach pointed at the uploaded path
    const apply = execs.find((e) => [e.command, ...e.args].join(" ").includes("scooter-apply-module"));
    expect([apply!.command, ...apply!.args]).toContain("--detach");
    expect([apply!.command, ...apply!.args].join(" ")).toContain(uploads[0].path);
    // NOT persisted yet — the switch is still building in the background.
    expect(cm.persisted).toEqual([]);
  });

  it("persists the module ONLY when the background switch reports `done` (build-before-persist)", async () => {
    const { client, setStatus } = fakeClient({ launchExit: 0 });
    const mgr = mkMgr(client);

    await mgr.apply("conv1", MODULE);
    // While still building, a poll does NOT persist.
    setStatus("building");
    await mgr.pollNow("conv1");
    expect(cm.persisted).toEqual([]);
    // Now the switch completes -> the next poll persists.
    setStatus("done");
    await mgr.pollNow("conv1");
    expect(cm.persisted).toEqual([{ id: "conv1", module: MODULE }]);
  });

  it("does NOT persist and reports the log when the switch reports `failed`", async () => {
    const { client, setStatus } = fakeClient({ launchExit: 0 });
    const applied: Array<{ ok: boolean; error?: string }> = [];
    const mgr = createModuleManager({
      client: () => client, configMap: cm.writer, watchIntervalMs: 0,
      onApplied: (_id, r) => applied.push(r),
    });

    await mgr.apply("conv1", MODULE);
    setStatus("failed", { error: "switch introduced failed units: foo.service", log: "…full build log…" });
    await mgr.pollNow("conv1");

    expect(cm.persisted).toEqual([]); // never persist a failed switch
    expect(applied).toHaveLength(1);
    expect(applied[0].ok).toBe(false);
    expect(applied[0].error).toContain("foo.service");
  });

  it("status() reads the in-pod env-switch state (+ error/log on failure)", async () => {
    const { client, setStatus } = fakeClient();
    const mgr = mkMgr(client);
    setStatus("switching");
    expect((await mgr.status("conv1")).state).toBe("switching");
    setStatus("failed", { error: "boom", log: "log-text" });
    const st = await mgr.status("conv1");
    expect(st.state).toBe("failed");
    expect(st.error).toBe("boom");
    expect(st.log).toBe("log-text");
  });

  it("surfaces a LAUNCH failure (e.g. a switch already in flight) as ok:false", async () => {
    const { client } = fakeClient({ launchExit: 3, launchStderr: "a switch is already in progress" });
    const mgr = mkMgr(client);
    const res = await mgr.apply("conv1", MODULE);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("already in progress");
    expect(cm.persisted).toEqual([]);
  });

  it("isApplying stays true from launch until the switch settles (idle sweep guard)", async () => {
    const { client, setStatus } = fakeClient({ launchExit: 0 });
    const mgr = mkMgr(client);

    expect(mgr.isApplying("conv1")).toBe(false);
    await mgr.apply("conv1", MODULE);
    expect(mgr.isApplying("conv1")).toBe(true); // switch in flight, though launch returned
    setStatus("done");
    await mgr.pollNow("conv1");
    expect(mgr.isApplying("conv1")).toBe(false);
  });
});
