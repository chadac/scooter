/**
 * Tier 1 contract — the remote agent registry + the `remote-personalized` provider's eligibility.
 *
 * Locks the BYO routing rules: a run is served by a remote agent ONLY when its OWNER has a live
 * agent AND the trigger is human (the compliance guardrail); cross-owner fencing; offline falls
 * through; latest-wins registration. See remoteAgentRegistry.ts + todo/docs/BYO_CLAUDE_REMOTE_AGENT.md.
 */

import { describe, it, expect } from "vitest";

import {
  createRemoteAgentRegistry,
  isHumanTrigger,
  HUMAN_TRIGGER_SOURCES,
  type AgentConnection,
} from "../../src/acp/remoteAgentRegistry.js";
import type { RemoteTransport } from "../../src/acp/remoteProtocol.js";
import type { RunContext } from "../../src/acp/provider.js";
import type { ExecBackend } from "../../src/types.js";

/** A stub transport that reports open/closed — the provider/registry only inspect isOpen()/close(). */
function stubTransport(): RemoteTransport & { setClosed: () => void } {
  let open = true;
  const closeCbs = new Set<() => void>();
  return {
    send: () => {},
    onFrame: () => () => {},
    isOpen: () => open,
    onClose: (cb) => {
      closeCbs.add(cb);
      return () => closeCbs.delete(cb);
    },
    close: () => {
      open = false;
      for (const cb of closeCbs) cb();
    },
    setClosed: () => {
      open = false;
    },
  };
}

const conn = (owner: string): AgentConnection & { transport: ReturnType<typeof stubTransport> } => {
  const transport = stubTransport();
  return { owner, transport };
};

const ctx = (over: Partial<RunContext>): RunContext => ({
  conversationId: "c1" as RunContext["conversationId"],
  ...over,
});

const fakeExec = {} as ExecBackend;

describe("HUMAN_TRIGGER_SOURCES / isHumanTrigger", () => {
  it("treats ui/slack/github/gitlab AND an undefined source (interactive) as human", () => {
    for (const s of ["ui", "slack", "github", "gitlab"]) expect(isHumanTrigger(s)).toBe(true);
    expect(isHumanTrigger(undefined)).toBe(true); // a plain interactive prompt
  });
  it("treats scheduler + any other automated source as NON-human (allowlist)", () => {
    expect(isHumanTrigger("scheduler")).toBe(false);
    expect(isHumanTrigger("webhook")).toBe(false);
    expect(isHumanTrigger("nudge")).toBe(false);
    expect(HUMAN_TRIGGER_SOURCES.has("scheduler")).toBe(false);
  });
});

describe("remote agent registry", () => {
  it("has()/get() reflect a registered, OPEN connection; a closed one is dropped", () => {
    const reg = createRemoteAgentRegistry();
    const c = conn("alice");
    reg.register(c);
    expect(reg.has("alice")).toBe(true);
    expect(reg.get("alice")?.owner).toBe("alice");

    c.transport.setClosed();
    expect(reg.has("alice")).toBe(false); // a dead connection is not routable
  });

  it("latest-wins: a re-register supersedes + closes the prior connection", () => {
    const reg = createRemoteAgentRegistry();
    const first = conn("alice");
    const second = conn("alice");
    reg.register(first);
    reg.register(second);
    expect(first.transport.isOpen()).toBe(false); // superseded → closed
    expect(reg.get("alice")?.transport).toBe(second.transport);
  });

  it("unregister only clears when THIS transport is still current (no evicting the new one)", () => {
    const reg = createRemoteAgentRegistry();
    const first = conn("alice");
    const second = conn("alice");
    reg.register(first);
    reg.register(second);
    // A late close of the SUPERSEDED first connection must not evict second.
    reg.unregister("alice", first.transport);
    expect(reg.has("alice")).toBe(true);
    expect(reg.get("alice")?.transport).toBe(second.transport);
  });

  it("fires onOnline/onOffline hooks for durable persistence (badge across replicas)", () => {
    const online: string[] = [];
    const offline: string[] = [];
    const reg = createRemoteAgentRegistry({
      onOnline: (o) => online.push(o),
      onOffline: (o) => offline.push(o),
    });
    const c = conn("alice");
    reg.register(c);
    expect(online).toEqual(["alice"]);

    reg.unregister("alice", c.transport);
    expect(offline).toEqual(["alice"]);

    // A late close of a SUPERSEDED connection must NOT fire offline (the reconnected owner stays
    // online) — onOffline fires only for the CURRENT transport.
    const first = conn("bob");
    const second = conn("bob");
    reg.register(first);
    reg.register(second);
    offline.length = 0;
    reg.unregister("bob", first.transport); // superseded → no offline
    expect(offline).toEqual([]);
  });
});

// The `remote-personalized` provider's eligibility now resolves through the BYOC CONTROLLER, not
// this per-pod registry — see remotePersonalizedController.spec.ts. A per-pod map cannot answer
// "does this owner have a container?" on a multi-replica fleet: a run scheduled on a pod that does
// not hold the socket logged `SKIP registered=false` and fell silently to the cloud floor, which
// was reproduced live at 5 replicas. The registry itself (register/get/has/replace) is still
// covered above; only the provider moved.
