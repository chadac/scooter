/**
 * Tier 2 — suspend-don't-delete persistence.
 *
 * Proves the core revival guarantee (verified in the controller source):
 * suspend drops the Pod but keeps the PVCs; resume re-mounts them; workspace
 * data survives. Drives the real provisioner. RED until a cluster is up.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";
import { createK8sProvisioner } from "../../services/agent-host/src/session/k8sProvisioner.js";
import type { SandboxProvisioner } from "../../services/agent-host/src/session/manager.js";
import type { SandboxRef } from "../../services/agent-host/src/types.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-test";
const IMAGE = process.env.SANDBOX_IMAGE ?? "agent-sandbox-os:latest";
const SELECTOR = (id: string) => `agents.x-k8s.io/sandbox-name=conv-${id}`;
type SandboxStatus = {
  status?: { conditions?: Array<{ type: string; status: string; reason?: string; message?: string }> };
};
const cond = (s: SandboxStatus, type: string) =>
  s.status?.conditions?.find((c) => c.type === type);
// v1beta1: Ready=True (reason DependenciesReady) once the pod is up.
const readyP = (s: SandboxStatus) => cond(s, "Ready")?.status === "True";
// v1beta1: operatingMode=Suspended drops the pod → Ready flips to False (reason
// DependenciesNotReady / pod gone). Detect the not-ready state (or an explicit
// pod-gone message) rather than a v1alpha1 "replicas is 0" string.
const suspendedP = (s: SandboxStatus) => {
  const c = cond(s, "Ready");
  return c?.status === "False" || /pod does not exist|not.?ready/i.test(c?.message ?? c?.reason ?? "");
};

maybe("suspend / resume workspace persistence", () => {
  let cluster: Cluster;
  let provisioner: SandboxProvisioner;
  let ref: SandboxRef;
  const id = "testpersist1";

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: NS });
    provisioner = createK8sProvisioner({ namespace: NS, sandboxImage: IMAGE });
    ref = await provisioner.create(id);
    await cluster.waitFor("Sandbox", `conv-${id}`, readyP, 180_000, NS);
  }, 240_000);

  afterAll(async () => {
    await provisioner?.destroy(ref).catch(() => {});
  });

  it("retains the workspace PVC across suspend (pod dropped, PVC kept)", async () => {
    await cluster.exec(SELECTOR(id), ["sh", "-c", "echo marker > /workspace/marker.txt"], NS);

    await provisioner.suspend(ref);
    await cluster.waitFor("Sandbox", `conv-${id}`, suspendedP, 120_000, NS);

    const pvc = await cluster.get<{ status: { phase: string } }>(
      "PersistentVolumeClaim",
      `workspace-conv-${id}`,
      NS,
    );
    expect(pvc.status.phase).toBe("Bound");
  });

  it("restores workspace data on resume", async () => {
    await provisioner.resume(ref);
    await cluster.waitFor("Sandbox", `conv-${id}`, readyP, 180_000, NS);

    const { stdout } = await cluster.exec(SELECTOR(id), ["cat", "/workspace/marker.txt"], NS);
    expect(stdout.trim()).toBe("marker");
  });
});
