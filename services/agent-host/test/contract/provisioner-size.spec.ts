/**
 * Tier 1 contract — the Sandbox CR is the SOURCE OF TRUTH for a conversation's size.
 *
 * There is no size table. The size lives in the CR's container `resources` block, which
 * outlives the pod (suspend keeps the CR) and is what a (re)start comes up with.
 *
 * Three things this pins:
 *
 *  1. RENDER/UN-RENDER ROUND-TRIP. A GPU is stored under its extended-resource name
 *     (`nvidia.com/gpu: "1"`, a STRING) because k8s demands it. The UI derives the
 *     selected preset by comparing cpu/memory/gpu against the catalog, so a gpu read
 *     back as the rendered string matches no preset and the picker silently shows
 *     "Custom" for a size that IS a preset. getSize must invert the render.
 *
 *  2. COLD-CREATE. Sizing a conversation whose Sandbox does not exist yet (a size
 *     picked before the first turn) must create the CR Suspended so the size has
 *     somewhere durable to live — not silently do nothing.
 *
 *  3. A READ FAILURE IS NOT "NO SIZE". A 403/500 on the CR read must propagate, never
 *     be mistaken for an unsized conversation and quietly reset the pod to the default.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

type Obj = Record<string, any>;

/** A fake k8s API: one CR in "the cluster" (or none), recording creates + patches. */
function fakeKc(opts: { cr?: Obj | null; getRejectCode?: number } = {}) {
  const patches: Obj[] = [];
  const creates: Obj[] = [];
  const api = {
    getNamespacedCustomObject: async () => {
      if (opts.getRejectCode) throw Object.assign(new Error("api"), { code: opts.getRejectCode });
      if (opts.cr === null || opts.cr === undefined) throw Object.assign(new Error("not found"), { code: 404 });
      return opts.cr;
    },
    patchNamespacedCustomObject: async (p: Obj) => {
      patches.push(p);
      return {};
    },
    createNamespacedCustomObject: async (p: Obj) => {
      creates.push(p);
      return {};
    },
    createNamespacedServiceAccount: async (p: Obj) => {
      creates.push(p);
      return {};
    },
    readNamespacedConfigMap: async () => {
      throw Object.assign(new Error("not found"), { code: 404 });
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, patches, creates };
}

const withResources = (resources: Obj): Obj => ({
  spec: { podTemplate: { spec: { containers: [{ name: "sandbox", image: "img", resources }] } } },
});

const provisioner = (kc: never, extra: Obj = {}) =>
  createK8sProvisioner({
    namespace: "agent-sandbox",
    sandboxImage: "img",
    kubeConfig: kc,
    sizePresetsJson: JSON.stringify({
      small: { cpu: "1", memory: "2Gi" },
      gpu1: { cpu: "4", memory: "16Gi", gpu: 1, hint: "local inference" },
    }),
    defaultSizeName: "small",
    ...extra,
  });

describe("k8sProvisioner size — the CR is the store", () => {
  it("reads the size back off the CR in the FRIENDLY shape", async () => {
    const { kc } = fakeKc({ cr: withResources({ requests: { cpu: "2", memory: "4Gi" }, limits: { cpu: "2", memory: "4Gi" } }) });
    expect(await provisioner(kc).getSize("abc")).toEqual({
      requests: { cpu: "2", memory: "4Gi" },
      limits: { cpu: "2", memory: "4Gi" },
    });
  });

  it("un-renders nvidia.com/gpu back to a NUMBER (else the UI shows Custom for a preset)", async () => {
    const { kc } = fakeKc({
      cr: withResources({
        requests: { cpu: "4", memory: "16Gi", "nvidia.com/gpu": "1" },
        limits: { cpu: "4", memory: "16Gi", "nvidia.com/gpu": "1" },
      }),
    });
    const size = await provisioner(kc).getSize("abc");
    expect(size?.limits?.gpu).toBe(1);
    expect(size?.requests?.gpu).toBe(1);
    // The extended-resource key must NOT leak into the friendly shape.
    expect(JSON.stringify(size)).not.toContain("nvidia.com/gpu");
  });

  it("returns undefined for a Sandbox that does not exist (no size, not an error)", async () => {
    const { kc } = fakeKc({ cr: null });
    expect(await provisioner(kc).getSize("abc")).toBeUndefined();
  });

  it("PROPAGATES a non-404 read failure — a 403 is not 'unsized'", async () => {
    const { kc } = fakeKc({ getRejectCode: 403 });
    await expect(provisioner(kc).getSize("abc")).rejects.toThrow();
  });

  it("writes a preset by name, rendering requests == limits onto the CR", async () => {
    const { kc, patches } = fakeKc({ cr: withResources({}) });
    await provisioner(kc).setSize("abc", { size: "small" });
    expect(patches).toHaveLength(1);
    const c = patches[0].body.spec.podTemplate.spec.containers[0];
    expect(c.resources).toEqual({ requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "1", memory: "2Gi" } });
    // The rest of the container is preserved — a patch must not drop the image.
    expect(c.image).toBe("img");
  });

  it("renders a GPU preset on BOTH sides (k8s rejects a request != limit)", async () => {
    const { kc, patches } = fakeKc({ cr: withResources({}) });
    await provisioner(kc).setSize("abc", { size: "gpu1" });
    const r = patches[0].body.spec.podTemplate.spec.containers[0].resources;
    expect(r.requests["nvidia.com/gpu"]).toBe("1");
    expect(r.limits["nvidia.com/gpu"]).toBe("1");
  });

  it("rejects an unknown preset and NAMES the valid ones", async () => {
    const { kc } = fakeKc({ cr: withResources({}) });
    await expect(provisioner(kc).setSize("abc", { size: "enormous" })).rejects.toThrow(/small, gpu1/);
  });

  it("rejects a malformed raw quantity at the boundary", async () => {
    const { kc, patches } = fakeKc({ cr: withResources({}) });
    await expect(provisioner(kc).setSize("abc", { limits: { memory: "8 gigabytes" } })).rejects.toThrow();
    expect(patches).toHaveLength(0); // nothing reached the CR
  });

  it("COLD-CREATES a Suspended Sandbox when sizing a conversation that has none", async () => {
    const { kc, creates, patches } = fakeKc({ cr: null });
    await provisioner(kc).setSize("abc", { size: "small" }, "thread-abc");
    expect(patches).toHaveLength(0);
    const sandbox = creates.find((c) => c.plural === "sandboxes");
    expect(sandbox).toBeTruthy();
    // Suspended: the CR + PVCs exist, no pod runs until the conversation starts.
    expect(sandbox!.body.spec.operatingMode).toBe("Suspended");
    expect(sandbox!.body.spec.podTemplate.spec.containers[0].resources).toEqual({
      requests: { cpu: "1", memory: "2Gi" },
      limits: { cpu: "1", memory: "2Gi" },
    });
    // The FULL thread id builds CONVERSATION_URL, not the short CR name.
    const env = Object.fromEntries(
      sandbox!.body.spec.podTemplate.spec.containers[0].env.map((e: Obj) => [e.name, e.value]),
    );
    expect(env.CONVERSATION_ID).toBe("thread-abc");
    // …and its ServiceAccount comes with it, else the pod can't get a broker token.
    expect(creates.some((c) => c.body?.metadata?.name === "sandbox-abc")).toBe(true);
  });

  it("exposes the deployment's preset catalog and default", () => {
    const { kc } = fakeKc({});
    const { sizes, default: def } = provisioner(kc).getSizes();
    expect(def).toBe("small");
    expect(sizes.gpu1).toEqual({ cpu: "4", memory: "16Gi", gpu: 1, hint: "local inference" });
  });

  it("reports NO presets (rather than throwing) when the deployment configures none", () => {
    const { kc } = fakeKc({});
    const p = createK8sProvisioner({ namespace: "agent-sandbox", sandboxImage: "img", kubeConfig: kc });
    expect(p.getSizes()).toEqual({ sizes: {}, default: null });
  });
});
