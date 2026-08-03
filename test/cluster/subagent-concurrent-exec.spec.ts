/**
 * Tier 2 — subagents share ONE sandbox pod: N agent-host bridges exec CONCURRENTLY
 * into the same pod without collision (see todo/docs/SUBAGENTS.md).
 *
 * A subagent reuses its parent's SandboxRef, so two bridges point at ONE pod. This
 * drives the PRODUCTION exec path — connectSandbox(ref) per bridge, then
 * execute() — with TWO independent clients against one provisioned Sandbox, and
 * proves:
 *   1. Two execs run CONCURRENTLY (overlap in time; not serialized).
 *   2. They hit the SAME workspace (one writes, the other reads it back).
 *   3. No cross-talk — each exec gets its own stdout.
 *
 * Gated: RUN_CLUSTER_TESTS=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";
import { createK8sProvisioner } from "../../services/agent-host/src/session/k8sProvisioner.js";
import { connectSandbox } from "../../services/agent-host/src/exec/k8sExec.js";
import type { SandboxProvisioner } from "../../services/agent-host/src/session/manager.js";
import type { SandboxApiClient } from "../../services/agent-host/src/exec/sandboxExec.js";
import type { SandboxRef } from "../../services/agent-host/src/types.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-test";
const IMAGE = process.env.SANDBOX_IMAGE ?? "agent-sandbox-os:latest";

const sh = (script: string) => ({ command: "bash", args: ["-c", script] });

maybe("subagents share one pod — concurrent exec into a shared sandbox", () => {
  let cluster: Cluster;
  let provisioner: SandboxProvisioner;
  let ref: SandboxRef;
  // Two independent exec clients targeting the SAME ref — what a parent bridge and
  // its subagent's bridge each do (both got the parent's SandboxRef).
  let parentExec: SandboxApiClient;
  let subagentExec: SandboxApiClient;
  const id = "subagentexec1";

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: NS });
    provisioner = createK8sProvisioner({ namespace: NS, sandboxImage: IMAGE });
    ref = await provisioner.create(id);
    // Wait for the pod to be exec-able before connecting the clients.
    await cluster.waitFor<{ status: { conditions: Array<{ type: string; status: string }> } }>(
      "Sandbox",
      `conv-${id}`,
      (s) => !!s.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
      180_000,
      NS,
    );
    // TWO independent connections to the same pod (as two bridges would).
    parentExec = await connectSandbox(ref);
    subagentExec = await connectSandbox(ref);
  }, 240_000);

  afterAll(async () => {
    await provisioner?.destroy(ref).catch(() => {});
  });

  it("two clients exec CONCURRENTLY into the one pod (overlap, not serialized)", async () => {
    // Each writes a distinct marker AFTER a 2s sleep. If exec serialized, total
    // wall time would be ~4s; concurrent, it's ~2s. Assert well under the sum.
    const start = Date.now();
    const [a, b] = await Promise.all([
      parentExec.execute(sh("sleep 2 && echo parent-done")),
      subagentExec.execute(sh("sleep 2 && echo subagent-done")),
    ]);
    const elapsed = Date.now() - start;

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    // No cross-talk: each got ITS OWN stdout.
    expect(a.stdout.trim()).toBe("parent-done");
    expect(b.stdout.trim()).toBe("subagent-done");
    // Overlapped: two 2s sleeps finished in well under 4s.
    expect(elapsed).toBeLessThan(3_500);
  }, 60_000);

  it("both clients see the SAME /workspace (one writes, the other reads)", async () => {
    // The parent's exec writes a file; the subagent's exec reads it back — proving
    // they share the pod's workspace (the point of the shared-pod model).
    const marker = `shared-${Date.now()}`;
    const write = await parentExec.execute(sh(`echo ${marker} > /workspace/.subagent-share`));
    expect(write.exitCode).toBe(0);

    const read = await subagentExec.execute(sh("cat /workspace/.subagent-share"));
    expect(read.exitCode).toBe(0);
    expect(read.stdout.trim()).toBe(marker);
  }, 30_000);

  it("a long-running command on one client does not block a quick one on the other", async () => {
    // A subagent kicking off a slow build must not stall the parent's next command.
    const slow = parentExec.execute(sh("sleep 3 && echo slow-done"));
    const quickStart = Date.now();
    const quick = await subagentExec.execute(sh("echo quick"));
    const quickElapsed = Date.now() - quickStart;

    expect(quick.exitCode).toBe(0);
    expect(quick.stdout.trim()).toBe("quick");
    // The quick command returned promptly — it did NOT wait behind the 3s command.
    expect(quickElapsed).toBeLessThan(2_000);

    const slowRes = await slow; // let the slow one finish for a clean teardown
    expect(slowRes.stdout.trim()).toBe("slow-done");
  }, 30_000);
});
