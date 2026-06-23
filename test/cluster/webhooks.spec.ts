/**
 * Tier 2 — webhooks spawn-from-event, end to end on the cluster.
 *
 * Proves the full loop: POST /webhooks/test -> webhooks spawns a conversation in
 * the agent-host via /agui -> the (dummy) agent runs in a real sandbox -> the
 * result flows back -> webhooks returns it. Also asserts the conversation shows
 * up in the agent-host management API.
 *
 * Requires the platform deployed with the webhooks test webhook + fakeAgent
 * agent-host (so spawns are deterministic, no model needed).
 *
 * Gated: RUN_CLUSTER_TESTS=1 RUN_WEBHOOKS_TESTS=1.
 */

import { describe, it, expect, beforeAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const enabled = clusterTestsEnabled() && process.env.RUN_WEBHOOKS_TESTS === "1";
const maybe = enabled ? describe : describe.skip;

const NS = process.env.PLATFORM_NS ?? "agent-sandbox";
const WEBHOOKS = `http://agent-webhooks.${NS}.svc.cluster.local:8080`;
const AGENT_HOST = `http://agent-host.${NS}.svc.cluster.local:8080`;

maybe("webhooks spawn-from-event", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ namespace: NS });
  });

  it("POST /webhooks/test spawns a conversation and returns the agent result", async () => {
    const marker = "wh-spawn-marker";
    const body = await cluster.curlInCluster(`${WEBHOOKS}/webhooks/test`, {
      method: "POST",
      headers: ["Content-Type: application/json"],
      body: JSON.stringify({ task: `!echo ${marker}`, title: "wh-e2e" }),
      timeoutMs: 40_000,
    });

    const resp = JSON.parse(body);
    expect(resp.conversation_id).toBeTruthy();
    // The dummy agent ran `echo <marker>` in a real sandbox; result flows back.
    expect(resp.result).toContain(marker);

    // The spawned conversation is visible in the agent-host management API.
    const listed = JSON.parse(await cluster.curlInCluster(`${AGENT_HOST}/conversations`));
    const ids = (listed as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(resp.conversation_id);
  });
});
