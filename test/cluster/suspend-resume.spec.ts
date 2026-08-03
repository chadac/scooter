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

  // The reliability fix: a web service the user had RUNNING before hibernate must be
  // running again after resume — otherwise the proxy 502s ("upstream failed"). This is
  // the real-PVC end-to-end for what nixos-tests/service-persist.nix proves hermetically.
  it("a service enabled before suspend is RUNNING again after resume (restore oneshot)", async () => {
    // Enable via `scooter-service` so the enabled set is recorded on the workspace PVC
    // (/workspace/.scooter/services.json). `terminal` (ttyd+tmux) is a lazy tool — the
    // first start does a `nix build` in-pod, so allow generous time.
    await cluster.exec(SELECTOR(id), ["scooter-service", "start", "terminal"], NS);
    await waitExec(cluster, id, ["systemctl", "is-active", "--quiet", "webservice-terminal.service"], 180_000);

    // The intent is persisted on the PVC (survives the pod recreate).
    const state = await cluster.exec(
      SELECTOR(id),
      ["cat", "/workspace/.scooter/services.json"],
      NS,
    );
    expect(JSON.parse(state.stdout).enabled?.terminal?.autostart).toBe(true);

    // Hibernate (pod dropped) then resume (fresh pod; every explicit-start unit dead).
    await provisioner.suspend(ref);
    await cluster.waitFor("Sandbox", `conv-${id}`, suspendedP, 120_000, NS);
    await provisioner.resume(ref);
    await cluster.waitFor("Sandbox", `conv-${id}`, readyP, 180_000, NS);

    // No one re-issued a start — the boot `scooter-service-restore` oneshot brought it
    // back from services.json. (Again allow for the lazy ttyd build on the new pod.)
    await waitExec(cluster, id, ["systemctl", "is-active", "--quiet", "webservice-terminal.service"], 180_000);
  });
});

/** Poll an in-pod command until it exits 0, or throw after `timeoutMs`. The cluster
 *  `exec` surfaces a non-zero exit as a rejection, so we retry on any failure. */
async function waitExec(
  cluster: Cluster,
  id: string,
  command: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await cluster.exec(SELECTOR(id), command, NS);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`waitExec timed out after ${timeoutMs}ms: ${command.join(" ")} — ${String(lastErr)}`);
}
