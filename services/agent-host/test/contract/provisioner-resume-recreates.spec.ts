/**
 * Tier 1 contract — resume() must RECREATE a Sandbox that is gone, not surface the 404.
 *
 * WHY: a conversation can legitimately outlive its Sandbox. The conversation-controller's
 * zombie escalation force-deletes a Sandbox it cannot reconcile, and suspend() already
 * tolerates a missing one ("already gone == already suspended"). resume() had no such
 * tolerance, so every later prompt patched operatingMode on a nonexistent object and threw
 * a raw k8s 404 at the user.
 *
 * Observed on scooter.chadac.me: conv-1ribob force-deleted at 03:59:35 after a 5-minute
 * zombie loop, still erroring at 15:44 — ~12 hours of RUN_ERROR, retrying every ~90s, with
 * no path to recovery. The work was never lost (it lives on the workspace PVC, which
 * outlives the Sandbox); only the Sandbox object was missing.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

/** Sandbox get/patch/create, with the mode-patch tellable from the heal-path patch. */
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
      // No warm-store volume -> the heal path is a no-op and we land on the mode patch.
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
    expect(ref.name).toBe("conv-abc"); // same name -> the conversation keeps its identity
    expect(calls).toContain("patch:mode"); // tried the cheap path first
    expect(calls).toContain("create:sandbox"); // then recreated
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
    // sandboxName is `conv-${id}`, so the recreate must strip that prefix or it would
    // build `conv-conv-abc` and strand the conversation under a second identity.
    const { kc } = fakeKc({ modePatchError: 404 });
    const ref = await provisioner(kc).resume({ name: "conv-abc", namespace: "agent-manager" }, "thread-1");
    expect(ref.name).toBe("conv-abc");
  });

  it("a Sandbox unreadable by any other call still recreates", async () => {
    // A gone Sandbox 404s every read, not just the mode patch — none of that may
    // short-circuit the recovery.
    const { kc, calls } = fakeKc({ sandboxGetError: 404, modePatchError: 404 });
    const ref = await provisioner(kc).resume({ name: "conv-abc", namespace: "agent-manager" }, "thread-1");
    expect(ref.name).toBe("conv-abc");
    expect(calls).toContain("create:sandbox");
  });
});
