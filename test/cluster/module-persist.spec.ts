/**
 * Tier 2 — a self-modified environment PERSISTS across suspend/resume.
 *
 * self-modify.spec proves the live SWITCH works on a bare pod. This proves the
 * full DURABILITY path the user hit as broken ("modify env doesn't persist; after
 * hibernate it's the original config"):
 *
 *   1. create a real Sandbox via the provisioner (mounts the per-conversation
 *      module ConfigMap at the boot re-converge path),
 *   2. persist a module via writeModule (the PVC-sourced CM sync) + apply it,
 *   3. suspend (pod dropped) then resume (fresh pod),
 *   4. the module's tool is STILL present on the resumed pod — because the boot
 *      re-converge read the persisted CM.
 *
 * Also checks ensureModuleMount is idempotent against a real (already-mounting)
 * Sandbox. Drives the real provisioner + controller. Needs the overlay image (the
 * in-pod nix build for the re-converge). Gated: RUN_CLUSTER_TESTS=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";
import { createK8sProvisioner } from "../../services/agent-host/src/session/k8sProvisioner.js";
import type { SandboxProvisioner } from "../../services/agent-host/src/session/manager.js";
import type { SandboxRef } from "../../services/agent-host/src/types.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-modpersist-test";
// The re-converge needs the writable overlay upper (in-pod nix build), so use the
// overlay image, and the provisioner must enable the overlay + systemd container.
const IMAGE = process.env.OVERLAY_IMAGE ?? "agent-sandbox-os-overlay:latest";
const id = "modpersist1";
const SELECTOR = `agents.x-k8s.io/sandbox-name=conv-${id}`;

type SandboxStatus = {
  status?: { conditions?: Array<{ type: string; status: string; message?: string }> };
};
const cond = (s: SandboxStatus, t: string) => s.status?.conditions?.find((c) => c.type === t);
const readyP = (s: SandboxStatus) => {
  const c = cond(s, "Ready");
  return c?.status === "True" && !/replicas is 0/i.test(c.message ?? "");
};
const suspendedP = (s: SandboxStatus) =>
  /replicas is 0|pod does not exist/i.test(cond(s, "Ready")?.message ?? "");

// A GOOD module declaring a lazy tool `modpersist-demo` -> hello (light; resolves
// on first call, no eager build at switch).
const MODULE = `{ ... }: {
  programs.lazyTools.tools.modpersist-demo = { package = "hello"; bin = "hello"; };
}`;

maybe("a self-modified environment persists across suspend/resume", () => {
  let cluster: Cluster;
  let provisioner: SandboxProvisioner;
  let ref: SandboxRef;

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: NS });
    provisioner = createK8sProvisioner({
      namespace: NS,
      sandboxImage: IMAGE,
      systemdImage: true,
      overlayStore: true,
    });
    ref = await provisioner.create(id);
    await cluster.waitFor("Sandbox", `conv-${id}`, readyP, 180_000, NS);
  }, 240_000);

  afterAll(async () => {
    await provisioner?.destroy(ref).catch(() => {});
  });

  it("create() mounts the module CM (ensureModuleMount is then a no-op)", async () => {
    // A freshly-created Sandbox already mounts the module CM, so the self-heal is a
    // no-op — it must not throw or needlessly re-patch.
    await expect(provisioner.ensureModuleMount!(id)).resolves.toBeUndefined();
    const sb = await cluster.get<{ spec: { podTemplate: { spec: { volumes: Array<{ name: string }> } } } }>(
      "Sandbox",
      `conv-${id}`,
      NS,
    );
    expect(sb.spec.podTemplate.spec.volumes.some((v) => v.name === "scooter-conv")).toBe(true);
  });

  it("persists a module (writeModule) + applies it live", async () => {
    // Persist the module into the CM (the PVC-sourced sync path). The mounted CM
    // updates in-pod within the kubelet sync window; apply it now via the same
    // path the boot re-converge uses so the tool goes live immediately.
    await provisioner.writeModule!(id, MODULE);

    // Apply from the MOUNTED CM path (proves the CM delivery works), not a fresh
    // upload — this is what the boot re-converge reads on resume. Give the kubelet
    // a moment to project the updated CM, then apply.
    const applied = await (async () => {
      for (let i = 0; i < 30; i++) {
        const seen = await cluster.exec(
          SELECTOR,
          ["sh", "-c", "grep -q modpersist-demo /etc/agent-sandbox/scooter/module.nix && echo yes || echo no"],
          NS,
        );
        if (seen.stdout.trim() === "yes") return true;
        await new Promise((r) => setTimeout(r, 2000));
      }
      return false;
    })();
    expect(applied).toBe(true);

    const apply = await cluster.exec(SELECTOR, ["scooter-apply-module"], NS); // default: the mounted CM
    expect(apply.exitCode).toBe(0);
    const current = (await cluster.exec(SELECTOR, ["readlink", "-f", "/run/current-system"], NS)).stdout.trim();
    const run = await cluster.exec(SELECTOR, ["sh", "-lc", `${current}/sw/bin/modpersist-demo`], NS);
    expect(run.stdout).toContain("Hello, world!");
  }, 900_000);

  it("SURVIVES suspend -> resume: the tool is still there on the fresh pod", async () => {
    await provisioner.suspend(ref);
    await cluster.waitFor("Sandbox", `conv-${id}`, suspendedP, 120_000, NS);

    await provisioner.resume(ref);
    await cluster.waitFor("Sandbox", `conv-${id}`, readyP, 180_000, NS);

    // The resumed pod is BRAND NEW (suspend dropped the old one). Its boot
    // re-converge read the persisted CM and re-applied the module — so the tool is
    // present WITHOUT any re-apply from the test. This is the durability guarantee.
    const current = (await cluster.exec(SELECTOR, ["readlink", "-f", "/run/current-system"], NS)).stdout.trim();
    const run = await cluster.exec(SELECTOR, ["sh", "-lc", `${current}/sw/bin/modpersist-demo`], NS);
    expect(run.stdout).toContain("Hello, world!");
  }, 900_000);
});
