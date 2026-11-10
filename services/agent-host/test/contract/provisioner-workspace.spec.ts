/** The provisioner reads and grows the workspace claim. */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

type Obj = Record<string, any>;

function fakeKc(opts: { pvc?: Obj | null; events?: Obj[] } = {}) {
  const reads: Obj[] = [];
  const patches: Obj[] = [];
  const api = {
    readNamespacedPersistentVolumeClaim: async (p: Obj) => {
      reads.push(p);
      if (!opts.pvc) throw Object.assign(new Error("not found"), { code: 404 });
      return opts.pvc;
    },
    patchNamespacedPersistentVolumeClaim: async (p: Obj) => {
      patches.push(p);
      return {};
    },
    listNamespacedEvent: async () => ({ items: opts.events ?? [] }),
  };
  return { kc: { makeApiClient: () => api as never } as never, reads, patches };
}

const provisioner = (kc: never) => createK8sProvisioner({ namespace: "agent-sandbox", sandboxImage: "img", kubeConfig: kc });

const pvc = (requested: string, capacity?: string, conditions: Obj[] = []): Obj => ({
  spec: { resources: { requests: { storage: requested } } },
  status: { ...(capacity ? { capacity: { storage: capacity } } : {}), conditions },
});

const event = (reason: string, at: string, message = reason): Obj => ({ reason, message, lastTimestamp: at });

describe("k8sProvisioner workspace volume", () => {
  it("reads the claim agent-sandbox names after the Sandbox", async () => {
    const { kc, reads } = fakeKc({ pvc: pvc("10Gi", "10Gi") });
    expect(await provisioner(kc).getWorkspace("abc")).toEqual({ requested: "10Gi", capacity: "10Gi" });
    expect(reads[0]).toEqual({ name: "workspace-conv-abc", namespace: "agent-sandbox" });
  });

  it("is undefined without a claim", async () => {
    expect(await provisioner(fakeKc().kc).getWorkspace("abc")).toBeUndefined();
  });

  it("reports a resize in flight by its condition", async () => {
    const { kc } = fakeKc({ pvc: pvc("20Gi", "10Gi", [{ type: "FileSystemResizePending", status: "True" }]) });
    expect(await provisioner(kc).getWorkspace("abc")).toMatchObject({ requested: "20Gi", capacity: "10Gi", pending: "FileSystemResizePending" });
  });

  it("reports a failure only when it is newer than any success", async () => {
    const failed = event("VolumeResizeFailed", "2026-11-10T10:00:00Z", "rate exceeded");
    const ok = event("FileSystemResizeSuccessful", "2026-11-10T11:00:00Z");
    expect((await provisioner(fakeKc({ pvc: pvc("20Gi", "10Gi"), events: [ok, failed] }).kc).getWorkspace("abc"))?.failure).toBeUndefined();
    const later = event("VolumeResizeFailed", "2026-11-10T12:00:00Z", "rate exceeded");
    expect((await provisioner(fakeKc({ pvc: pvc("20Gi", "10Gi"), events: [ok, later] }).kc).getWorkspace("abc"))?.failure).toBe("rate exceeded");
  });

  it("grows by merge-patching only the claim's request", async () => {
    const { kc, patches } = fakeKc();
    await provisioner(kc).growWorkspace("abc", "50Gi");
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      name: "workspace-conv-abc",
      namespace: "agent-sandbox",
      body: { spec: { resources: { requests: { storage: "50Gi" } } } },
    });
  });
});
