/**
 * Tier 1 contract — the durable /workspace PVC is DECOUPLED from the Sandbox.
 *
 * Root cause of a real data-loss (sandbox conv-bpuwa2, 2026-09-03): the workspace
 * volume was a Sandbox `volumeClaimTemplate`, so the agent-sandbox controller made
 * the Sandbox the controller-OWNER of the PVC. When the Sandbox CR was deleted, k8s
 * GC cascade-deleted the PVC and local-path's Delete reclaim physically erased the
 * conversation's data on disk.
 *
 * Fix: the /workspace PVC is created STANDALONE by the agent-host (no Sandbox
 * ownerReference) and mounted via claimName, so it survives Sandbox delete/recreate;
 * only rebuildable caches (scooter-rw) remain as volumeClaimTemplates. These tests
 * pin that wiring so it cannot silently regress back to a template.
 */

import { describe, it, expect } from "vitest";

import { sandboxManifest, createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

type Manifest = {
  spec: {
    podTemplate: {
      spec: {
        volumes?: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }>;
      };
    };
    volumeClaimTemplates: Array<{ metadata: { name: string } }>;
  };
};

const render = (deploy: Record<string, unknown> = {}) =>
  sandboxManifest("abc", "conv-abc", "sandbox-abc", "img:latest", "ns", "aud", "10Gi", undefined, true, deploy) as Manifest;

describe("sandboxManifest — /workspace is a claimName volume, NOT a template", () => {
  it("mounts /workspace via a persistentVolumeClaim on the standalone PVC", () => {
    const vol = (render().spec.podTemplate.spec.volumes ?? []).find((v) => v.name === "workspace");
    expect(vol?.persistentVolumeClaim?.claimName).toBe("workspace-conv-abc");
  });

  it("NEVER emits a `workspace` volumeClaimTemplate (that would be Sandbox-owned)", () => {
    // overlayStore on or off, the workspace vct must never come back.
    for (const overlayStore of [true, false]) {
      const m = render({ overlayStore });
      expect(m.spec.volumeClaimTemplates.find((t) => t.metadata.name === "workspace")).toBeUndefined();
    }
  });
});

/** Records every k8s call so we can assert PVC lifecycle + ordering. */
function fakeKc(opts: { pvcCreate409?: boolean } = {}) {
  const calls: string[] = [];
  let pvcBody: { metadata?: { name?: string }; spec?: { storageClassName?: string } } | undefined;
  let pvcPatch: unknown;
  const api = {
    createNamespacedServiceAccount: async () => {
      calls.push("create:sa");
      return {};
    },
    createNamespacedPersistentVolumeClaim: async (p: { body?: unknown }) => {
      calls.push("create:pvc");
      pvcBody = p.body as typeof pvcBody;
      if (opts.pvcCreate409) throw Object.assign(new Error("exists"), { code: 409 });
      return {};
    },
    patchNamespacedPersistentVolumeClaim: async (p: { body?: unknown }) => {
      calls.push("patch:pvc");
      pvcPatch = p.body;
      return {};
    },
    createNamespacedConfigMap: async () => ({}),
    readNamespacedConfigMap: async () => {
      throw Object.assign(new Error("nf"), { code: 404 });
    },
    createNamespacedCustomObject: async () => {
      calls.push("create:sandbox");
      return {};
    },
    patchNamespacedCustomObject: async () => ({}),
    deleteNamespacedCustomObject: async () => {
      calls.push("delete:sandbox");
      return {};
    },
    deleteNamespacedServiceAccount: async () => {
      calls.push("delete:sa");
      return {};
    },
    deleteNamespacedPersistentVolumeClaim: async (p: { name?: string }) => {
      calls.push(`delete:pvc:${p.name}`);
      return {};
    },
    deleteNamespacedConfigMap: async () => ({}),
  };
  return { kc: { makeApiClient: () => api as never } as never, calls, pvc: () => pvcBody, patch: () => pvcPatch };
}

describe("k8sProvisioner — standalone workspace PVC lifecycle", () => {
  it("create() provisions the workspace PVC BEFORE the Sandbox", async () => {
    const { kc, calls, pvc } = fakeKc();
    const p = createK8sProvisioner({ namespace: "ns", sandboxImage: "img", kubeConfig: kc });
    await p.create("c1", "c1");
    expect(pvc()?.metadata?.name).toBe("workspace-conv-c1");
    // Ordering matters: the pod's claimName volume needs the PVC to exist first.
    expect(calls.indexOf("create:pvc")).toBeLessThan(calls.indexOf("create:sandbox"));
  });

  it("applies the configured StorageClass to the workspace PVC", async () => {
    const { kc, pvc } = fakeKc();
    const p = createK8sProvisioner({
      namespace: "ns",
      sandboxImage: "img",
      kubeConfig: kc,
      workspaceStorageClass: "scooter-retain",
    });
    await p.create("c1", "c1");
    expect(pvc()?.spec?.storageClassName).toBe("scooter-retain");
  });

  it("omits storageClassName when unset (cluster default), never an empty string", async () => {
    const { kc, pvc } = fakeKc();
    const p = createK8sProvisioner({ namespace: "ns", sandboxImage: "img", kubeConfig: kc });
    await p.create("c1", "c1");
    expect(pvc()?.spec && "storageClassName" in pvc()!.spec!).toBe(false);
  });

  it("REUSES a pre-existing PVC (409) and strips its Sandbox ownerReference", async () => {
    const { kc, calls, patch } = fakeKc({ pvcCreate409: true });
    const p = createK8sProvisioner({ namespace: "ns", sandboxImage: "img", kubeConfig: kc });
    // A 409 must NOT throw — reusing the existing volume is what preserves the data.
    await expect(p.create("c1", "c1")).resolves.toMatchObject({ name: "conv-c1" });
    expect(calls).toContain("patch:pvc");
    expect(patch()).toMatchObject({ metadata: { ownerReferences: [] } });
    // Still went on to create the Sandbox.
    expect(calls).toContain("create:sandbox");
  });

  it("destroy() explicitly deletes the standalone workspace PVC", async () => {
    const { kc, calls } = fakeKc();
    const p = createK8sProvisioner({ namespace: "ns", sandboxImage: "img", kubeConfig: kc });
    await p.destroy({ name: "conv-c1", namespace: "ns" });
    expect(calls).toContain("delete:pvc:workspace-conv-c1");
  });
});
