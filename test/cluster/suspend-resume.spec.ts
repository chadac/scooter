/**
 * Tier 2 — suspend-don't-delete persistence.
 *
 * Proves the core revival guarantee verified in the controller source:
 * suspend drops the Pod but keeps the PVCs; resume re-mounts them; workspace
 * data survives. RED.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;

maybe("suspend / resume workspace persistence", () => {
  let cluster: Cluster;
  const id = "test-persist1";

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: "agent-sandbox-test" });
    await cluster.apply({ __conversation: id });
    await cluster.waitFor("Sandbox", `conv-${id}`, (s: any) =>
      s.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True"), 180_000);
  });

  it("retains the workspace PVC across suspend (pod dropped, PVC kept)", async () => {
    // write a marker file in the workspace
    await cluster.exec(`sandbox=conv-${id}`, ["sh", "-c", "echo marker > /workspace/marker.txt"]);

    // suspend: operatingMode -> Suspended
    await cluster.apply({ __patch: { kind: "Sandbox", name: `conv-${id}`, operatingMode: "Suspended" } });

    // pod gone...
    await cluster.waitFor("Sandbox", `conv-${id}`, (s: any) =>
      s.status?.conditions?.some((c: any) => c.type === "Suspended" && c.status === "True"), 120_000);
    // ...but PVC still Bound
    const pvc = await cluster.get<{ status: { phase: string } }>("PersistentVolumeClaim", `workspace-conv-${id}`);
    expect(pvc.status.phase).toBe("Bound");
  });

  it("restores workspace data on resume", async () => {
    await cluster.apply({ __patch: { kind: "Sandbox", name: `conv-${id}`, operatingMode: "Running" } });
    await cluster.waitFor("Sandbox", `conv-${id}`, (s: any) =>
      s.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True"), 180_000);

    const { stdout } = await cluster.exec(`sandbox=conv-${id}`, ["cat", "/workspace/marker.txt"]);
    expect(stdout.trim()).toBe("marker");
  });
});
