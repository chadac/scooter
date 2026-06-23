/**
 * Tier 2 — per-conversation cold Sandbox provisioning against a real cluster.
 *
 * Proves the kubenix conversation shape (modules/conversation.nix) actually
 * reconciles: unique SA, PVC(s), pod Ready, :8888 reachable. RED.
 *
 * Gated: RUN_CLUSTER_TESTS=1. Uses the fake-acp-agent sandbox image variant.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;

maybe("cold Sandbox per conversation", () => {
  let cluster: Cluster;
  const id = "test-abc123";

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: "agent-sandbox-test" });
    // Apply the per-conversation resources (mkConversation { id }).
    await cluster.apply({ __conversation: id }); // placeholder: real manifest at impl
  });

  it("creates a unique ServiceAccount sandbox-{id}", async () => {
    const sa = await cluster.waitFor("ServiceAccount", `sandbox-${id}`, () => true);
    expect(sa).toBeTruthy();
  });

  it("binds the workspace PVC", async () => {
    const pvc = await cluster.waitFor<{ status: { phase: string } }>(
      "PersistentVolumeClaim",
      `workspace-conv-${id}`,
      (p) => p.status?.phase === "Bound",
    );
    expect(pvc.status.phase).toBe("Bound");
  });

  it("brings the Sandbox pod to Ready with :8888 reachable", async () => {
    await cluster.waitFor<{ status: { conditions: Array<{ type: string; status: string }> } }>(
      "Sandbox",
      `conv-${id}`,
      (s) => !!s.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
      180_000,
    );
    const fwd = await cluster.portForward(`sandbox=conv-${id}`, 8888);
    const res = await fetch(`${fwd.url}/`);
    expect(res.ok).toBe(true);
    fwd.close();
  });

  it("projects a broker-audience SA token into the pod", async () => {
    const { stdout, exitCode } = await cluster.exec(
      `sandbox=conv-${id}`,
      ["cat", "/var/run/secrets/broker/token"],
    );
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });
});
