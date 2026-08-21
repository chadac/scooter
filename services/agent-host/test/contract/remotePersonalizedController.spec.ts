/**
 * Tier 1 contract — the `remote-personalized` provider resolving through the BYOC CONTROLLER.
 *
 * WHY THIS EXISTS. `byocTransport` was written, tested, and NEVER WIRED: `createByocTransport`
 * appeared only in its own file and its own spec. The provider still resolved the owner's socket
 * from a PER-POD in-memory registry, so with >1 agent-host replica a run scheduled on a pod that
 * does not hold the socket logs `SKIP … registered=false` and falls silently to the cloud floor.
 * That was reproduced live on a 5-replica fleet: same container, same prompt, BYO worked only at
 * replicas=1.
 *
 * The controller exists precisely so ownership is not per-pod: it holds every container socket and
 * answers `GET /byoc/status?owner=…` with that owner's session. Resolving through it makes ANY
 * replica able to drive ANY container — the §L design, and the whole point of the controller.
 *
 * These tests pin the seam that was missing, not the transport (covered in byocTransport.spec.ts).
 */

import { describe, it, expect, vi } from "vitest";

import { createRemotePersonalizedProvider } from "../../src/acp/remoteAgentRegistry.js";
import type { ExecBackend } from "../../src/types.js";

const exec = {} as ExecBackend;

/** A controller that reports `owner` as connected with `sessionId`. */
function controllerFetch(map: Record<string, { sessionId: string; status: string }>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const owner = new URL(url, "http://x").searchParams.get("owner") ?? "";
    const hit = map[owner];
    if (!hit) {
      return new Response(JSON.stringify({ status: "disconnected" }), { status: 200 });
    }
    return new Response(JSON.stringify(hit), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ctx = (owner?: string, source?: string) => ({ owner, source }) as never;

describe("remote-personalized resolving through the BYOC controller", () => {
  it("is ELIGIBLE when the controller reports the owner connected — no per-pod registry needed", async () => {
    const { impl } = controllerFetch({ alice: { sessionId: "sess-1", status: "connected" } });
    const p = createRemotePersonalizedProvider({
      exec,
      controllerUrl: "http://byoc-controller:8080",
      fetchImpl: impl,
    });
    // THE POINT: this pod never held a socket. Eligibility comes from the controller.
    await expect(p.eligible(ctx("alice"))).resolves.toBe(true);
  });

  it("is NOT eligible when the controller reports the owner disconnected", async () => {
    const { impl } = controllerFetch({});
    const p = createRemotePersonalizedProvider({ exec, controllerUrl: "http://c:8080", fetchImpl: impl });
    await expect(p.eligible(ctx("alice"))).resolves.toBe(false);
  });

  it("is NOT eligible for a NON-HUMAN trigger even when connected (the guardrail holds)", async () => {
    // A scheduled/webhook run must not silently consume the user's personal Claude subscription.
    const { impl } = controllerFetch({ alice: { sessionId: "sess-1", status: "connected" } });
    const p = createRemotePersonalizedProvider({ exec, controllerUrl: "http://c:8080", fetchImpl: impl });
    await expect(p.eligible(ctx("alice", "scheduler"))).resolves.toBe(false);
  });

  it("is NOT eligible without an owner (nothing to resolve)", async () => {
    const { impl } = controllerFetch({ alice: { sessionId: "s", status: "connected" } });
    const p = createRemotePersonalizedProvider({ exec, controllerUrl: "http://c:8080", fetchImpl: impl });
    await expect(p.eligible(ctx(undefined))).resolves.toBe(false);
  });

  it("asks the CONTROLLER, not a local map — the request carries the owner", async () => {
    const { impl, calls } = controllerFetch({ alice: { sessionId: "sess-1", status: "connected" } });
    const p = createRemotePersonalizedProvider({ exec, controllerUrl: "http://byoc-controller:8080", fetchImpl: impl });
    await p.eligible(ctx("alice"));
    expect(calls[0]).toContain("/byoc/status");
    expect(calls[0]).toContain("owner=alice");
  });

  it("a controller that is DOWN degrades to not-eligible, never throws", async () => {
    // The cloud floor must still answer. A BYO outage should cost the user their personal model
    // for that run, not the run itself.
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const p = createRemotePersonalizedProvider({ exec, controllerUrl: "http://c:8080", fetchImpl: impl });
    await expect(p.eligible(ctx("alice"))).resolves.toBe(false);
  });

  it("createClient builds a transport pointed at the RESOLVED session", async () => {
    const { impl } = controllerFetch({ alice: { sessionId: "sess-42", status: "connected" } });
    const p = createRemotePersonalizedProvider({ exec, controllerUrl: "http://byoc-controller:8080", fetchImpl: impl });
    await p.eligible(ctx("alice")); // resolve caches the session for this run
    const client = p.createClient(ctx("alice"));
    expect(client, "a resolved owner must yield a driveable client").toBeTruthy();
  });

  it("createClient THROWS when the owner was never resolved — fail loud, not a silent hang", () => {
    // eligible() gates this, but a race (container drops between resolve and create) must surface
    // as a RUN_ERROR rather than a client that never answers.
    const { impl } = controllerFetch({});
    const p = createRemotePersonalizedProvider({ exec, controllerUrl: "http://c:8080", fetchImpl: impl });
    expect(() => p.createClient(ctx("nobody"))).toThrow(/no live remote agent|not connected/i);
  });
});
