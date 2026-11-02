/** describeSandboxDisruption turns a sandbox pod's status into a reason the agent can act on. */

import { describe, it, expect } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";

import { describeSandboxDisruption } from "../../src/exec/podDisruption.js";

const since = new Date("2026-11-02T05:00:00Z");

function pod(over: { terminated?: { reason: string; exitCode: number; finishedAt: Date }; status?: V1Pod["status"]; deleting?: boolean } = {}): V1Pod {
  return {
    metadata: { name: "conv-abc", deletionTimestamp: over.deleting ? new Date() : undefined },
    spec: { containers: [{ name: "sandbox", resources: { limits: { memory: "4Gi" } } }] },
    status: {
      containerStatuses: [
        {
          name: "sandbox",
          image: "img",
          imageID: "id",
          ready: true,
          restartCount: over.terminated ? 1 : 0,
          lastState: over.terminated ? { terminated: over.terminated } : {},
        },
      ],
      ...over.status,
    },
  };
}

describe("describeSandboxDisruption", () => {
  it("names an OOM kill and the memory limit", () => {
    const note = describeSandboxDisruption(
      pod({ terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: new Date("2026-11-02T05:00:30Z") } }),
      "sandbox",
      since,
    );
    expect(note).toContain("ran out of memory (limit 4Gi)");
    expect(note).toContain("set_sandbox_resources");
  });

  it("reports a non-OOM container restart with its reason", () => {
    const note = describeSandboxDisruption(
      pod({ terminated: { reason: "Unknown", exitCode: 255, finishedAt: new Date("2026-11-02T05:00:30Z") } }),
      "sandbox",
      since,
    );
    expect(note).toContain("restarted (reason Unknown, exit code 255)");
  });

  it("ignores a restart that predates the command", () => {
    const old = pod({ terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: new Date("2026-11-02T04:00:00Z") } });
    expect(describeSandboxDisruption(old, "sandbox", since)).toBeUndefined();
  });

  it("is silent when nothing happened to the sandbox", () => {
    expect(describeSandboxDisruption(pod(), "sandbox", since)).toBeUndefined();
  });

  it("explains a disruption condition such as consolidation", () => {
    const evicted = pod({
      deleting: true,
      status: { conditions: [{ type: "DisruptionTarget", status: "True", reason: "EvictionByEvictionAPI" }] },
    });
    expect(describeSandboxDisruption(evicted, "sandbox", since)).toContain("evicted (a node drain or consolidation)");
  });

  it("explains a lost node", () => {
    const tainted = pod({ status: { conditions: [{ type: "DisruptionTarget", status: "True", reason: "DeletionByTaintManager" }] } });
    expect(describeSandboxDisruption(tainted, "sandbox", since)).toContain("its node became unreachable");
  });

  it("explains a deleted pod", () => {
    expect(describeSandboxDisruption(undefined, "sandbox", since)).toContain("sandbox pod was deleted");
  });
});
