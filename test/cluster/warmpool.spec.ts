/**
 * Tier 2 — generic warm-pool fast path.
 *
 * Warm pools serve GENERIC capacity (no per-conversation SA/PVCs). Proves a
 * claim from a warm pool is materially faster than a cold start. RED.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;

maybe("warm-pool fast path", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: "agent-sandbox-test" });
    await cluster.apply({ __warmPool: { name: "generic", replicas: 2 } });
    // wait for pool to be warm
    await cluster.waitFor("SandboxWarmPool", "generic", (p: any) => (p.status?.availableReplicas ?? 0) >= 1, 180_000);
  });

  it("claims a warm sandbox within the fast-path latency budget", async () => {
    const t0 = Date.now();
    await cluster.apply({ __claim: { name: "claim-1", warmPool: "generic" } });
    await cluster.waitFor("SandboxClaim", "claim-1", (c: any) => !!c.status?.assignedSandboxName, 60_000);
    const elapsed = Date.now() - t0;

    // Warm claim should beat a cold start comfortably. Budget tuned at impl.
    expect(elapsed).toBeLessThan(15_000);
  });
});
