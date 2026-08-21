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
  spec?: { sandboxRef?: string };
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

  // REGRESSION (odin 2026-08-20): GET /conversations was answered from ONE pod's IN-MEMORY session
  // map, so on a multi-replica fleet the user saw only the conversations that pod happened to host —
  // a different fraction each time the Service load-balanced elsewhere, which reads as
  // "my conversations vanished". Per-pod counts observed: 0,2,2,4,4,4,7,7,8,8 while 20 CRs existed.
  //
  // This asserts the FRONT DOOR returns the UNION across the fleet. It only has teeth when the
  // conversations actually land on DIFFERENT pods, which the CI job arranges with podCap=1 (see
  // ci.yml / the platform-smoke deploy): each new conversation fills a pod and forces the next onto
  // another. Repeated calls guard against a lucky load-balance passing a broken build.
  it("a SHORT-ID-addressed request routes to the OWNER, not a random pod", async () => {
    // The broker addresses its AWS approval-notify by the sandbox SHORT-ID
    // (POST /conversations/<shortId>/aws-request, from req.conversation_id), never the thread
    // UUID. The router's ownership cache used to be keyed ONLY by the CR name (the UUID), so that
    // lookup missed, resolveTarget fell back to the ClusterIP Service, and the raise landed on a
    // NON-OWNER — where getByShortId() misses and the interrupt is silently dropped. The user saw
    // a run start and finish with no Approve button.
    //
    // Unit tests cover the cache in isolation; only a MULTI-REPLICA cluster proves the request
    // actually reaches the owner, because with one pod the fallback IS the owner and the bug is
    // invisible. That is exactly how this shipped.
    const threadId = `shortid-${Date.now()}`;
    await cluster.curlInCluster(`${AGENT_HOST}/agui`, {
      method: "POST",
      headers: ["Content-Type: application/json", "Accept: text/event-stream"],
      body: JSON.stringify({
        threadId,
        runId: "r1",
        messages: [{ id: "m1", role: "user", content: "short-id routing" }],
      }),
      timeoutMs: 60_000,
    });

    // Wait for assignment so the CR carries both ids and a routing address.
    const cr = await cluster.waitFor<ConversationCR>(
      "Conversation",
      threadId,
      (c) => !!c.status?.hostIP && !!c.spec?.sandboxRef,
      90_000,
      NS,
    );
    const shortId = (cr.spec?.sandboxRef ?? "").replace(/^conv-/, "");
    expect(shortId, "the CR must carry a sandboxRef to derive a short-id from").toMatch(/\S/);

    // THE ASSERTION. Addressed by SHORT-ID through the front door, the request must reach the pod
    // that actually hosts the conversation. A 404 here is the bug: the router sent it to a
    // non-owner, which does not know this conversation.
    //
    // Repeated, because the failure was a COIN FLIP per request (fallback round-robin) — a single
    // attempt passes ~1/N of the time by luck even when routing is broken.
    for (let attempt = 0; attempt < 5; attempt++) {
      const out = await cluster.curlInCluster(
        `${AGENT_HOST}/conversations/${shortId}/aws-request`,
        {
          method: "POST",
          headers: ["Content-Type: application/json"],
          body: JSON.stringify({ requestId: `probe-${attempt}`, tool: "probe", scope: "read" }),
          timeoutMs: 30_000,
        },
      );
      expect(
        out,
        `attempt ${attempt + 1}: short-id ${shortId} did not reach its owner (routed to a non-owner?)`,
      ).not.toMatch(/not found|unknown conversation/i);
    }
  });

  it("GET /conversations returns EVERY conversation in the fleet, not one pod's slice", async () => {
    const ids = [1, 2, 3].map((n) => `fanout-${Date.now()}-${n}`);

    for (const threadId of ids) {
      await cluster.curlInCluster(`${AGENT_HOST}/agui`, {
        method: "POST",
        headers: ["Content-Type: application/json", "Accept: text/event-stream"],
        body: JSON.stringify({
          threadId,
          runId: "r1",
          messages: [{ id: "m1", role: "user", content: "fanout" }],
        }),
        timeoutMs: 60_000,
      });
      // Wait for assignment so the controller has spread it before creating the next one.
      await cluster.waitFor<ConversationCR>(
        "Conversation", threadId, (c) => !!c.status?.hostIP, 90_000, NS,
      );
    }

    // Sanity: the conversations really are spread across MORE THAN ONE pod, otherwise this test
    // would pass even with the single-pod bug present (that is exactly why CI missed it).
    const hosts = new Set<string>();
    for (const threadId of ids) {
      const cr = await cluster.waitFor<ConversationCR>(
        "Conversation", threadId, (c) => !!c.status?.hostPod, 30_000, NS,
      );
      if (cr.status?.hostPod) hosts.add(cr.status.hostPod);
    }
    expect(hosts.size, "conversations must span >1 pod for this regression to be meaningful").toBeGreaterThan(1);

    // The front door must list ALL of them, on EVERY call (not whichever pod answered).
    for (let attempt = 0; attempt < 5; attempt++) {
      const listed = JSON.parse(
        await cluster.curlInCluster(`${AGENT_HOST}/conversations`, { timeoutMs: 30_000 }),
      ) as Array<{ id: string }>;
      const got = new Set(listed.map((c) => c.id));
      for (const id of ids) {
        expect(got.has(id), `attempt ${attempt + 1}: /conversations omitted ${id} (single-pod view?)`).toBe(true);
      }
    }
  });
});
