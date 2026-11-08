/** A pod stuck before Ready is described from its status and Warning events. */

import { describe, it, expect } from "vitest";

import { describePodWait, diagnosePodWait } from "../../src/exec/podDiagnosis.js";

const creating = {
  metadata: { name: "conv-abc", uid: "u1" },
  status: { phase: "Pending", containerStatuses: [{ name: "sandbox", ready: false, state: { waiting: { reason: "ContainerCreating" } } }] },
};
const attach = {
  type: "Warning",
  reason: "FailedAttachVolume",
  count: 12,
  lastTimestamp: new Date("2026-11-01T10:05:00Z"),
  message: 'AttachVolume.Attach failed for volume "pvc-1" : rpc error: code = DeadlineExceeded',
};
const mount = {
  type: "Warning",
  reason: "FailedMount",
  lastTimestamp: new Date("2026-11-01T10:04:00Z"),
  message: "Unable to attach or mount volumes: timed out waiting for the condition",
};

describe("describePodWait", () => {
  it("names the phase, waiting reason and newest warnings", () => {
    const older = { ...attach, count: 3, lastTimestamp: new Date("2026-11-01T10:00:00Z"), message: "old" };
    const normal = { type: "Normal", reason: "Scheduled", message: "assigned" };
    expect(describePodWait(creating as never, [mount, older, attach, normal] as never)).toBe(
      'pod Pending (ContainerCreating); FailedAttachVolume x12: AttachVolume.Attach failed for volume "pvc-1" : ' +
        "rpc error: code = DeadlineExceeded; FailedMount: Unable to attach or mount volumes: timed out waiting for the condition",
    );
  });

  it("falls back to the scheduling reason, and says when there is no pod", () => {
    const pending = { metadata: { name: "p" }, status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }] } };
    expect(describePodWait(pending as never)).toBe("pod Pending (Unschedulable)");
    expect(describePodWait(undefined)).toBe("no pod exists");
  });
});

describe("diagnosePodWait", () => {
  it("reads this pod incarnation's events, and still describes the pod without them", async () => {
    let selector = "";
    const core = {
      listNamespacedEvent: async (a: { namespace: string; fieldSelector: string }) => {
        selector = `${a.namespace}:${a.fieldSelector}`;
        return { items: [attach] };
      },
    };
    expect(await diagnosePodWait(core as never, "ns", [creating as never])).toMatch(/^pod Pending \(ContainerCreating\); FailedAttachVolume x12/);
    expect(selector).toBe("ns:involvedObject.kind=Pod,involvedObject.name=conv-abc,involvedObject.uid=u1");
    const forbidden = { listNamespacedEvent: async () => Promise.reject(Object.assign(new Error("forbidden"), { code: 403 })) };
    expect(await diagnosePodWait(forbidden as never, "ns", [creating as never])).toBe("pod Pending (ContainerCreating)");
  });
});
