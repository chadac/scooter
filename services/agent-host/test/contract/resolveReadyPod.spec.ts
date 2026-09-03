/**
 * Tier 1 contract — pollForReadyPod's idle-suspend SELF-HEAL.
 *
 * Regression for scooter-bug-dangling-run-revive-leaves-sandbox-suspended: after a mid-run reassign +
 * idle-suspend, the Sandbox is operatingMode=Suspended (pod deleted) while a live bridge keeps issuing
 * tool calls — every exec failed "no ready pod" because nothing resumed the sandbox (every resume site
 * was gated on a MISSING bridge, and the bridge wasn't missing — only the pod was). The exec path now
 * self-heals: when the pod-readiness poll finds NO pod, it resumes the sandbox once and re-polls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("pollForReadyPod — the deadline warn is de-duped per sandbox", () => {
  // Every sweep re-probes a wedged sandbox, so an un-de-duped warn is one per
  // conversation per sweep, forever (~50k/24h from 2 sandboxes in production).
  const notReady = () => [
    { metadata: { name: "conv-qis9hm-abc" }, status: { phase: "Running", containerStatuses: [{ ready: false }] } },
  ];

  /** One deadline-expiring poll; reports which level logged. Spies the CONSOLE because
   *  logger() returns a fresh literal per call, so spying an instance misses the real one. */
  async function pollLevel(ref: SandboxRef = REF) {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await pollForReadyPod(ref, { listCandidates: async () => notReady() as never, sleep: noSleep, deadlineMs: -1 });
      const hit = (s: typeof err) => s.mock.calls.some((c) => String(c[0]).includes("ready-pod deadline expired"));
      return hit(err) ? "warn" : hit(out) ? "debug" : "none";
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  }

  beforeEach(async () => {
    process.env.DEBUG = "1"; // else the suppressed line is filtered and reads as "none"
    const log = await import("../../src/log.js");
    log.reconfigureLogging(); // minLevel is captured at import
    log.forgetWarned();
  });

  it("THE SPAM: one sandbox warns once, then drops to debug", async () => {
    expect([await pollLevel(), await pollLevel(), await pollLevel()]).toEqual(["warn", "debug", "debug"]);
  });

  it("a DIFFERENT sandbox still warns — one noisy wedge must not mask a new one", async () => {
    await pollLevel();
    expect(await pollLevel({ name: "conv-other", namespace: "agent-manager" })).toBe("warn");
  });
});
