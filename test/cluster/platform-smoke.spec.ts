/**
 * Tier 2 — multi-replica PLATFORM smoke, end to end on a real k3d cluster.
 *
 * The distribution/routing/rollout topology (#254/#255/#256) shipped with NO cluster
 * coverage — it was validated only manually on odin. This is the CI guard: with the full
 * platform deployed (agent-host DEPLOYMENT + conversation-controller + conversation-router,
 * fakeAgent), a conversation POSTed through the front-door `agent-host` Service (which fronts
 * the ROUTER) must be:
 *   1. created (the agent-host registers a Conversation CR),
 *   2. ASSIGNED a host by the controller (status.hostPod), AND
 *   3. given a routing address (status.hostIP) — the field the router proxies to.
 *
 * That exercises the whole loop the pod-IP-routing PR introduced: CR create → controller
 * reconcile (writes hostPod + hostIP) → the router's CRD watch. If the topology regresses
 * (agent-host back to a StatefulSet, controller not assigning, hostIP dropped), this fails.
 *
 * The workflow deploys the platform + waits for the Deployments before running this; the spec
 * talks to the already-live `agent-sandbox` namespace. Gated: RUN_CLUSTER_TESTS=1.
 */

import { describe, it, expect, beforeAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;

const NS = process.env.PLATFORM_NS ?? "agent-sandbox";
// The public front door (Service `agent-host` → the router). A conversation POSTed here is
// routed to the owning pod by IP — the same path the UI/broker/webhooks use.
const AGENT_HOST = `http://agent-host.${NS}.svc.cluster.local:8080`;

type ConversationCR = {
  status?: { phase?: string; hostPod?: string; hostIP?: string; generation?: number };
};

maybe("multi-replica platform smoke", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ namespace: NS });
  });

  it("a conversation routed through the front door is assigned a hostPod + hostIP", async () => {
    const threadId = `smoke-${Date.now()}`;

    // POST /agui through the front-door Service (→ router → a ready pod, since it's unassigned
    // at first). The fakeAgent replies deterministically; we only need the run to START so the
    // agent-host registers the Conversation CR.
    const body = await cluster.curlInCluster(`${AGENT_HOST}/agui`, {
      method: "POST",
      headers: ["Content-Type: application/json", "Accept: text/event-stream"],
      body: JSON.stringify({
        threadId,
        runId: "r1",
        messages: [{ id: "m1", role: "user", content: "hello" }],
      }),
      timeoutMs: 60_000,
    });
    // The stream should at least have begun (RUN_STARTED) — the CR is registered on start().
    expect(body).toContain("RUN_STARTED");

    // The controller must ASSIGN it: status.hostPod (owner name) AND status.hostIP (routing
    // address) both populated. Poll the CR until the reconcile lands (interval ~5s).
    const cr = await cluster.waitFor<ConversationCR>(
      "Conversation",
      threadId,
      (c) => !!c.status?.hostPod && !!c.status?.hostIP,
      90_000,
      NS,
    );

    expect(cr.status?.phase).toBe("Assigned");
    expect(cr.status?.hostPod, "controller assigned an owner pod").toBeTruthy();
    // hostIP is the ROUTING address — an IPv4 dotted quad (the pod IP the router proxies to).
    expect(cr.status?.hostIP, "controller wrote a routing IP").toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(cr.status?.generation ?? 0).toBeGreaterThanOrEqual(1);
  });
});
