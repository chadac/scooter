/**
 * Tier 1 contract test — writeModule must UPSERT the per-conversation module CM.
 *
 * modify_environment persists the agent's module via writeModule. It used to
 * merge-PATCH the ConfigMap, which 404s when the CM doesn't exist — the case for
 * a conversation created before module-CM provisioning, or a hydrated/revived one
 * whose CM was GC'd. That surfaced to the agent as a bewildering k8s 404
 * (`configmaps "conv-…-module" not found`) even though its Nix build SUCCEEDED.
 * writeModule must fall back to CREATE on a 404 so the module persists; any other
 * error still propagates.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

/** Fake KubeConfig recording ConfigMap patch/create calls; patch can be told to
 *  reject with a k8s-style error ({ code }). */
function fakeKc(opts: { patchRejectCode?: number }) {
  const calls: string[] = [];
  const api = {
    patchNamespacedConfigMap: async (p: { name?: string }) => {
      calls.push(`patch:${p.name}`);
      if (opts.patchRejectCode) throw Object.assign(new Error("api"), { code: opts.patchRejectCode });
      return {};
    },
    createNamespacedConfigMap: async (p: { body?: { metadata?: { name?: string } } }) => {
      calls.push(`create:${p.body?.metadata?.name}`);
      return {};
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, calls };
}

const provisioner = (kc: never) =>
  createK8sProvisioner({ namespace: "agent-manager", sandboxImage: "img", kubeConfig: kc });

describe("k8sProvisioner.writeModule", () => {
  it("PATCHes when the ConfigMap exists (does NOT create)", async () => {
    const { kc, calls } = fakeKc({});
    await provisioner(kc).writeModule("fixtest-1", "{ }");
    expect(calls).toEqual(["patch:conv-fixtest-1-module"]);
  });

  it("CREATEs the ConfigMap when the patch 404s (upsert — module still persists)", async () => {
    const { kc, calls } = fakeKc({ patchRejectCode: 404 });
    await provisioner(kc).writeModule("fixtest-1", "{ environment.systemPackages = []; }");
    expect(calls).toEqual(["patch:conv-fixtest-1-module", "create:conv-fixtest-1-module"]);
  });

  it("PROPAGATES a non-404 patch error (e.g. 403/500 — don't mask it as an upsert)", async () => {
    const { kc } = fakeKc({ patchRejectCode: 403 });
    await expect(provisioner(kc).writeModule("fixtest-1", "{ }")).rejects.toThrow();
  });
});
