/**
 * A readiness poll that can't find a Ready pod records the wait, so a command that times
 * out before reaching the pod says it never started, and conversation_status says so too.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { failedPodWait, formatPodWait, podWaitStatus, setPodWaitStatus } from "../../src/exec/podReadiness.js";
import { pollForReadyPod } from "../../src/exec/k8sExec.js";
import type { SandboxRef } from "../../src/types.js";

const REF: SandboxRef = { name: "conv-nt4eo0", namespace: "agent-manager" };
const pending = {
  metadata: { name: "conv-nt4eo0" },
  status: { phase: "Pending", containerStatuses: [{ ready: false, state: { waiting: { reason: "ContainerCreating" } } }] },
};

describe("pod readiness wait", () => {
  beforeEach(() => setPodWaitStatus(REF, undefined));

  it("records a failed wait for conversation_status", async () => {
    const err = await pollForReadyPod(REF, {
      listCandidates: async () => [pending as never],
      sleep: async () => {},
      deadlineMs: -1,
    }).catch((e: Error) => e);
    expect(String(err)).toMatch(/no ready pod for sandbox agent-manager\/conv-nt4eo0/);
    const w = podWaitStatus(REF);
    expect(w).toBeDefined();
    expect(formatPodWait(w!, w!.since + 12 * 60_000)).toBe("the sandbox pod has not been Ready for 12m");
  });

  it("carries the pod's diagnosis into the wait and the error", async () => {
    const err = await pollForReadyPod(REF, {
      listCandidates: async () => [pending as never],
      sleep: async () => {},
      deadlineMs: -1,
      diagnose: async () => "pod Pending (ContainerCreating); FailedAttachVolume x3: attach timed out",
    }).catch((e: Error) => e);
    expect(String(err)).toMatch(/conv-nt4eo0: pod Pending \(ContainerCreating\); FailedAttachVolume x3/);
    const w = podWaitStatus(REF)!;
    expect(formatPodWait(w, w.since + 40_000)).toBe(
      "the sandbox pod has not been Ready for 40s (pod Pending (ContainerCreating); FailedAttachVolume x3: attach timed out)",
    );
  });

  it("clears the wait once the pod is Ready", async () => {
    setPodWaitStatus(REF, { since: Date.now(), checkedAt: Date.now() });
    await pollForReadyPod(REF, {
      listCandidates: async () => [{ metadata: { name: "p" }, status: { phase: "Running", containerStatuses: [{ ready: true }] } } as never],
      sleep: async () => {},
    });
    expect(podWaitStatus(REF)).toBeUndefined();
  });

  it("forgets a wait not seen for 5 minutes", () => {
    setPodWaitStatus(REF, { since: Date.now(), checkedAt: Date.now() });
    expect(podWaitStatus(REF, Date.now() + 6 * 60_000)).toBeUndefined();
  });
});

describe("failedPodWait", () => {
  beforeEach(() => setPodWaitStatus(REF, undefined));
  const ready = { metadata: { name: "p" }, status: { phase: "Running", containerStatuses: [{ ready: true }] } };

  it("is unset while a wait is still inside its deadline", () => {
    setPodWaitStatus(REF, { since: Date.now(), checkedAt: Date.now(), reason: "pod Pending" });
    expect(failedPodWait(REF)).toBeUndefined();
  });

  it("names the reason once a wait hits its deadline, and keeps it through the next wait", async () => {
    const fail = (deadlineMs: number) =>
      pollForReadyPod(REF, {
        listCandidates: async () => [pending as never],
        sleep: async () => {},
        deadlineMs,
        diagnose: async () => "pod Pending (ContainerCreating)",
      }).catch(() => {});
    await fail(-1);
    expect(failedPodWait(REF)).toBe("pod Pending (ContainerCreating)");

    // An unexpired wait, cut short at its first sleep.
    await pollForReadyPod(REF, {
      listCandidates: async () => [pending as never],
      sleep: async () => {
        throw new Error("stop");
      },
      deadlineMs: 60_000,
      diagnose: async () => "pod Pending (ImagePullBackOff)",
    }).catch(() => {});
    expect(failedPodWait(REF)).toBe("pod Pending (ImagePullBackOff)");
  });

  it("clears once the pod is Ready", async () => {
    setPodWaitStatus(REF, { since: Date.now(), checkedAt: Date.now(), failedAt: Date.now() });
    await pollForReadyPod(REF, { listCandidates: async () => [ready as never], sleep: async () => {} });
    expect(failedPodWait(REF)).toBeUndefined();
  });
});
