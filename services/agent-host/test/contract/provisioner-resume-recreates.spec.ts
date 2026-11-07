/**
 * resume() recreates a Sandbox that is gone instead of surfacing the 404. A conversation
 * can outlive its Sandbox (the conversation-controller's zombie escalation force-deletes
 * one it cannot reconcile) while its work lives on the workspace PVC.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

/** A fake Sandbox API whose mode patch and get can be told to fail. */
function fakeKc(opts: { modePatchError?: number; sandboxGetError?: number } = {}) {
  const calls: string[] = [];
  const api = {
    createNamespacedServiceAccount: async () => ({}),
    createNamespacedConfigMap: async () => ({}),
    readNamespacedConfigMap: async () => {
      throw Object.assign(new Error("nf"), { code: 404 });
    },
    getNamespacedCustomObject: async () => {
      if (opts.sandboxGetError) throw Object.assign(new Error("api"), { code: opts.sandboxGetError });
      // No warm-store volume, so the heal path is a no-op.
      return { spec: { podTemplate: { spec: { volumes: [{ name: "workspace" }] } } } };
    },
    createNamespacedCustomObject: async () => {
      calls.push("create:sandbox");
      return {};
    },
    patchNamespacedCustomObject: async () => {
      calls.push("patch:mode");
      if (opts.modePatchError) throw Object.assign(new Error("api"), { code: opts.modePatchError });
      return {};
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, calls };
}

const provisioner = (kc: never) =>
  createK8sProvisioner({ namespace: "agent-manager", sandboxImage: "img", kubeConfig: kc });

describe("k8sProvisioner.resume — a GONE Sandbox is recreated", () => {
  it("THE REGRESSION: a 404 on the mode patch recreates the Sandbox instead of throwing", async () => {
    const { kc, calls } = fakeKc({ modePatchError: 404 });
    const ref = await provisioner(kc).resume({ name: "conv-abc", namespace: "agent-manager" }, "thread-1");
    expect(ref.name).toBe("conv-abc");
    expect(calls).toContain("patch:mode");
    expect(calls).toContain("create:sandbox");
  });

  it("a healthy resume does NOT create — it is just the mode flip", async () => {
    const { kc, calls } = fakeKc();
    await provisioner(kc).resume({ name: "conv-abc", namespace: "agent-manager" });
    expect(calls).toContain("patch:mode");
    expect(calls).not.toContain("create:sandbox");
  });

  it("a NON-404 patch error still throws — do not mask a real failure as a recreate", async () => {
    const { kc, calls } = fakeKc({ modePatchError: 500 });
    await expect(
      provisioner(kc).resume({ name: "conv-abc", namespace: "agent-manager" }),
    ).rejects.toMatchObject({ code: 500 });
    expect(calls).not.toContain("create:sandbox");
  });

  it("recreating derives the conversation id from the Sandbox name", async () => {
    // sandboxName is `conv-${id}`, so the recreate must strip that prefix.
    const { kc } = fakeKc({ modePatchError: 404 });
    const ref = await provisioner(kc).resume({ name: "conv-abc", namespace: "agent-manager" }, "thread-1");
    expect(ref.name).toBe("conv-abc");
  });

  it("a Sandbox unreadable by any other call still recreates", async () => {
    // A gone Sandbox 404s every read, not just the mode patch.
    const { kc, calls } = fakeKc({ sandboxGetError: 404, modePatchError: 404 });
    const ref = await provisioner(kc).resume({ name: "conv-abc", namespace: "agent-manager" }, "thread-1");
    expect(ref.name).toBe("conv-abc");
    expect(calls).toContain("create:sandbox");
  });

  it("marks a recreated Sandbox fresh, and a plain resume not", async () => {
    const gone = fakeKc({ modePatchError: 404 });
    expect((await provisioner(gone.kc).resume({ name: "conv-abc", namespace: "agent-manager" })).fresh).toBe(true);
    const live = fakeKc();
    expect((await provisioner(live.kc).resume({ name: "conv-abc", namespace: "agent-manager" })).fresh).toBeUndefined();
  });
});
