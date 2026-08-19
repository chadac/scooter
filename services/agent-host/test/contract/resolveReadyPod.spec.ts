/**
 * Tier 1 contract — pollForReadyPod's idle-suspend SELF-HEAL.
 *
 * Regression for scooter-bug-dangling-run-revive-leaves-sandbox-suspended: after a mid-run reassign +
 * idle-suspend, the Sandbox is operatingMode=Suspended (pod deleted) while a live bridge keeps issuing
 * tool calls — every exec failed "no ready pod" because nothing resumed the sandbox (every resume site
 * was gated on a MISSING bridge, and the bridge wasn't missing — only the pod was). The exec path now
 * self-heals: when the pod-readiness poll finds NO pod, it resumes the sandbox once and re-polls.
 */

import { describe, it, expect, vi } from "vitest";

import { pollForReadyPod } from "../../src/exec/k8sExec.js";
import type { SandboxRef } from "../../src/types.js";

const REF: SandboxRef = { name: "conv-qis9hm", namespace: "agent-manager" };
const readyPod = () => ({
  metadata: { name: "conv-qis9hm-abc" },
  status: { phase: "Running", containerStatuses: [{ ready: true }] },
});
const noSleep = async () => {};

describe("pollForReadyPod — idle-suspend self-heal", () => {
  it("resumes the sandbox (ensureRunning) ONCE when no pod exists, then returns the recreated pod", async () => {
    let resumed = false;
    // No pod until the sandbox is resumed — models a Suspended sandbox (controller deleted the pod).
    const listCandidates = vi.fn(async () => (resumed ? [readyPod()] : []));
    const ensureRunning = vi.fn(async () => {
      resumed = true; // resume → the controller recreates the pod → the next poll finds it
    });

    const pod = await pollForReadyPod(REF, { listCandidates, ensureRunning, sleep: noSleep });

    expect(ensureRunning).toHaveBeenCalledOnce(); // the fix: it resumed instead of timing out
    expect(pod.metadata?.name).toBe("conv-qis9hm-abc");
  });

  it("does NOT call ensureRunning when a ready pod already exists (no needless resume)", async () => {
    const ensureRunning = vi.fn(async () => {});
    const pod = await pollForReadyPod(REF, {
      listCandidates: async () => [readyPod()],
      ensureRunning,
      sleep: noSleep,
    });
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(pod.metadata?.name).toBe("conv-qis9hm-abc");
  });

  it("fires ensureRunning AT MOST once even if the pod is slow to come back", async () => {
    let polls = 0;
    const ensureRunning = vi.fn(async () => {});
    // Stay empty for a few polls after the resume, then finally return the pod.
    const listCandidates = vi.fn(async () => (++polls >= 4 ? [readyPod()] : []));
    const pod = await pollForReadyPod(REF, { listCandidates, ensureRunning, sleep: noSleep });
    expect(ensureRunning).toHaveBeenCalledOnce(); // once, not once-per-empty-poll
    expect(pod.metadata?.name).toBe("conv-qis9hm-abc");
  });

  it("without ensureRunning, an always-empty sandbox still times out with 'no ready pod' (unchanged)", async () => {
    await expect(
      pollForReadyPod(REF, { listCandidates: async () => [], sleep: noSleep, deadlineMs: -1 }),
    ).rejects.toThrow(/no ready pod for sandbox agent-manager\/conv-qis9hm/);
  });
});
