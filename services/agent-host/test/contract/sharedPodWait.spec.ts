/** Concurrent ready-pod waits on one sandbox share a single poll. */

import { describe, it, expect } from "vitest";

import { pollForReadyPod } from "../../src/exec/k8sExec.js";
import type { SandboxRef } from "../../src/types.js";

const pod = (ready: boolean) => ({
  metadata: { name: "conv-sh4red" },
  status: { phase: ready ? "Running" : "Pending", containerStatuses: [{ ready }] },
});

describe("shared ready-pod wait", () => {
  it("polls once for concurrent callers", async () => {
    const ref: SandboxRef = { name: "conv-sh4red", namespace: "agent-manager" };
    let lists = 0;
    let ready = false;
    const deps = {
      listCandidates: async () => (lists++, [pod(ready) as never]),
      sleep: () => new Promise<void>((r) => setTimeout(r, 5)),
      deadlineMs: 60_000,
    };
    const a = pollForReadyPod(ref, deps);
    const b = pollForReadyPod(ref, { ...deps, listCandidates: async () => { throw new Error("second poll"); } });
    await new Promise((r) => setTimeout(r, 30));
    ready = true;
    const [pa, pb] = await Promise.all([a, b]);
    expect(pa.metadata?.name).toBe("conv-sh4red");
    expect(pb).toBe(pa);
    expect(lists).toBeGreaterThan(1);
  });

  it("ends a short caller at its deadline while a longer one keeps polling", async () => {
    const ref: SandboxRef = { name: "conv-l0ngw8", namespace: "agent-manager" };
    let ready = false;
    const deps = {
      listCandidates: async () => [pod(ready) as never],
      sleep: () => new Promise<void>((r) => setTimeout(r, 5)),
    };
    const long = pollForReadyPod(ref, { ...deps, deadlineMs: 60_000 });
    const short = pollForReadyPod(ref, { ...deps, deadlineMs: 20 });
    await expect(short).rejects.toThrow(/call wait_for_sandbox, then retry/);
    ready = true;
    expect((await long).status?.phase).toBe("Running");
  });
});
