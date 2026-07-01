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

// A fake sandbox client that records uploads + execs and lets a test script the
// exit code of `scooter-apply-module`.
function fakeClient(opts: { applyExit?: number; applyStderr?: string } = {}) {
  const uploads: Array<{ path: string; content: string }> = [];
  const execs: ExecRequest[] = [];
  const client: SandboxApiClient = {
    mode: "k8s-exec",
    async upload(path, content) {
      uploads.push({ path, content });
    },
    async download() {
      return "";
    },
    async execute(req): Promise<ExecResult> {
      execs.push(req);
      const cmd = [req.command, ...req.args].join(" ");
      if (cmd.includes("scooter-apply-module")) {
        return { stdout: "", stderr: opts.applyStderr ?? "", exitCode: opts.applyExit ?? 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  return { client, uploads, execs };
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

  it("uploads the module, execs scooter-apply-module, and persists on success", async () => {
    const { client, uploads, execs } = fakeClient({ applyExit: 0 });
    const mgr = createModuleManager({ client: () => client, configMap: cm.writer });

    const res = await mgr.apply("conv1", MODULE);

    expect(res.ok).toBe(true);
    // uploaded the raw module to a writable (/run) path
    expect(uploads.length).toBe(1);
    expect(uploads[0].content).toBe(MODULE);
    expect(uploads[0].path).toMatch(/^\/run\//);
    // exec'd scooter-apply-module pointed at the uploaded path
    const apply = execs.find((e) => [e.command, ...e.args].join(" ").includes("scooter-apply-module"));
    expect(apply).toBeTruthy();
    expect([apply!.command, ...apply!.args].join(" ")).toContain(uploads[0].path);
    // persisted to the ConfigMap (durable) — only because it succeeded
    expect(cm.persisted).toEqual([{ id: "conv1", module: MODULE }]);
  });

  it("does NOT persist + returns the error when the apply fails (the gate)", async () => {
    const { client } = fakeClient({ applyExit: 1, applyStderr: "error: bad module" });
    const mgr = createModuleManager({ client: () => client, configMap: cm.writer });

    const res = await mgr.apply("conv1", MODULE);

    expect(res.ok).toBe(false);
    expect(res.error).toContain("bad module");
    expect(cm.persisted).toEqual([]); // CM untouched — never persisted a bad module
  });

  it("serializes applies per conversation (no overlapping switches)", async () => {
    // A client whose apply blocks until released, so we can observe ordering.
    let inFlight = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client: SandboxApiClient = {
      mode: "k8s-exec",
      async upload() {},
      async download() {
        return "";
      },
      async execute(req): Promise<ExecResult> {
        if ([req.command, ...req.args].join(" ").includes("scooter-apply-module")) {
          inFlight++;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await gate;
          inFlight--;
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const mgr = createModuleManager({ client: () => client, configMap: cm.writer });

    const a = mgr.apply("conv1", MODULE);
    const b = mgr.apply("conv1", MODULE);
    // both queued; release and let them finish
    release();
    await Promise.all([a, b]);
    expect(maxConcurrent).toBe(1); // never two switches at once in the same conv
  });

  it("reports whether a conversation has an apply in flight (for the idle sweep)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client: SandboxApiClient = {
      mode: "k8s-exec",
      async upload() {},
      async download() {
        return "";
      },
      async execute(req): Promise<ExecResult> {
        if ([req.command, ...req.args].join(" ").includes("scooter-apply-module")) await gate;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const mgr = createModuleManager({ client: () => client, configMap: cm.writer });

    expect(mgr.isApplying("conv1")).toBe(false);
    const p = mgr.apply("conv1", MODULE);
    expect(mgr.isApplying("conv1")).toBe(true);
    release();
    await p;
    expect(mgr.isApplying("conv1")).toBe(false);
  });
});
