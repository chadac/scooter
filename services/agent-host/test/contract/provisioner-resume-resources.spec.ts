/**
 * Tier 1 contract — resume(ref, resources?) the "restart at new size" path.
 *
 * When an override is given, the provisioner must PATCH the Sandbox container
 * resources BEFORE flipping replicas 0→1 (so the recreated pod comes back at the
 * new cpu/memory/gpu), and a patch FAILURE must NOT flip replicas up into a
 * half-patched state (fail-safe — surface it, leave suspended). Without an
 * override, resume is the old behavior: replicas flip only.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";
import { GPU_RESOURCE } from "../../src/session/resources.js";

/** Records every patch body in call order; the resources patch is distinguished
 *  from the replicas patch by which spec key it carries. Can fail the FIRST patch
 *  (the resources one) to exercise the fail-safe. */
function fakeKc(opts: { failResourcePatch?: boolean } = {}) {
  const patches: Array<Record<string, unknown>> = [];
  const api = {
    // patchSandboxResources reads the Sandbox first (merge-patch replaces the
    // container array, so it read-modify-writes). Serve a minimal one-container CR.
    getNamespacedCustomObject: async () => ({
      spec: { podTemplate: { spec: { containers: [{ name: "sandbox", image: "img" }] } } },
    }),
    patchNamespacedCustomObject: async (params: { body: { spec?: Record<string, unknown> } }) => {
      const spec = params.body?.spec ?? {};
      patches.push(spec);
      // The resources patch is the one that does NOT carry `replicas`.
      const isResourcePatch = !("replicas" in spec);
      if (opts.failResourcePatch && isResourcePatch) throw Object.assign(new Error("patch failed"), { code: 500 });
      return {};
    },
  };
  const kc = { makeApiClient: () => api as never };
  return { kc: kc as never, patches };
}

const provisioner = (kc: never) =>
  createK8sProvisioner({ namespace: "agent-manager", sandboxImage: "img", kubeConfig: kc });

const ref = { name: "conv-abc", namespace: "agent-manager" };

describe("k8sProvisioner.resume(ref, resources?)", () => {
  it("without an override, flips replicas ONLY (no resource patch)", async () => {
    const { kc, patches } = fakeKc();
    await provisioner(kc).resume(ref);
    expect(patches).toEqual([{ replicas: 1 }]);
  });

  it("with an override, PATCHES resources FIRST, THEN flips replicas up", async () => {
    const { kc, patches } = fakeKc();
    await provisioner(kc).resume(ref, { limits: { memory: "8Gi" } });
    expect(patches).toHaveLength(2);
    // First patch carries container resources (not replicas); second flips replicas.
    expect("replicas" in patches[0]).toBe(false);
    expect(patches[1]).toEqual({ replicas: 1 });
  });

  it("renders gpu → nvidia.com/gpu in the resource patch", async () => {
    const { kc, patches } = fakeKc();
    await provisioner(kc).resume(ref, { limits: { gpu: 1 } });
    // The rendered nvidia.com/gpu key must appear somewhere in the first (resource) patch.
    expect(JSON.stringify(patches[0])).toContain(GPU_RESOURCE);
  });

  it("FAIL-SAFE: a resource-patch failure does NOT flip replicas up (never half-patched)", async () => {
    const { kc, patches } = fakeKc({ failResourcePatch: true });
    await expect(provisioner(kc).resume(ref, { limits: { memory: "8Gi" } })).rejects.toThrow();
    // Only the (failed) resource patch was attempted; replicas were NEVER flipped.
    expect(patches.some((p) => "replicas" in p)).toBe(false);
  });
});
