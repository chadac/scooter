/**
 * OwnershipGuard fencing core — the multi-replica guard that stops a REASSIGNED pod from
 * appending to a conversation the new owner now drives. Pure (no k8s); the watch loop
 * feeds observe().
 */
import { describe, it, expect } from "vitest";

import { OwnershipTracker, allowAllGuard } from "../../src/session/ownershipGuard.js";
import type { SessionId } from "../../src/types.js";

const C = "conv-1" as SessionId;

describe("allowAllGuard (fencing disabled)", () => {
  it("always allows (single-replica default is a no-op)", () => {
    expect(allowAllGuard.canWrite(C)).toBe(true);
  });
});

describe("OwnershipTracker", () => {
  it("fails OPEN for an unobserved conversation (no CR yet)", () => {
    const t = new OwnershipTracker("agent-host-0");
    expect(t.canWrite(C)).toBe(true); // must be able to write before the CR exists
  });

  it("allows when THIS pod is the host", () => {
    const t = new OwnershipTracker("agent-host-0");
    t.observe("conv-1", { hostPod: "agent-host-0", generation: 1 });
    expect(t.canWrite(C)).toBe(true);
  });

  it("REFUSES when another pod is the host", () => {
    const t = new OwnershipTracker("agent-host-0");
    t.observe("conv-1", { hostPod: "agent-host-1", generation: 1 });
    expect(t.canWrite(C)).toBe(false);
  });

  it("refuses after being REASSIGNED away (the fencing case)", () => {
    const t = new OwnershipTracker("agent-host-0");
    t.observe("conv-1", { hostPod: "agent-host-0", generation: 1 }); // we host it
    expect(t.canWrite(C)).toBe(true);
    t.observe("conv-1", { hostPod: "agent-host-1", generation: 2 }); // reassigned away, gen++
    expect(t.canWrite(C)).toBe(false); // the stale owner must stop writing
  });

  it("allows again if reassigned BACK to this pod (gen advances)", () => {
    const t = new OwnershipTracker("agent-host-0");
    t.observe("conv-1", { hostPod: "agent-host-1", generation: 2 }); // owned elsewhere
    expect(t.canWrite(C)).toBe(false);
    t.observe("conv-1", { hostPod: "agent-host-0", generation: 3 }); // back to us
    expect(t.canWrite(C)).toBe(true);
  });

  it("treats a DELETED CR (null) as unobserved -> fail open", () => {
    const t = new OwnershipTracker("agent-host-0");
    t.observe("conv-1", { hostPod: "agent-host-1", generation: 1 });
    expect(t.canWrite(C)).toBe(false);
    t.observe("conv-1", null); // CR deleted
    expect(t.canWrite(C)).toBe(true);
  });

  it("announces a DELETED CR, and forgets the assignment with it", () => {
    const t = new OwnershipTracker("agent-host-0");
    const gone: string[] = [];
    t.onDeleted = (id) => gone.push(id);
    t.observe("conv-1", { hostPod: "agent-host-1", generation: 1 });
    t.observeDeleted("conv-1");
    expect(gone).toEqual(["conv-1"]);
    expect(t.canWrite(C)).toBe(true); // and the fence forgets it, as observe(null) does
  });

  it("does NOT announce a deletion for a CR that merely has no host yet", () => {
    // The watch calls observe(id, null) for an UNASSIGNED CR too. Reading that as "the
    // conversation is gone" would tear down a conversation that is only waiting to be
    // assigned — so only observeDeleted (the watch's DELETED event) fires the hook.
    const t = new OwnershipTracker("agent-host-0");
    const gone: string[] = [];
    t.onDeleted = (id) => gone.push(id);
    t.observe("conv-1", null);
    expect(gone).toEqual([]);
  });
});
