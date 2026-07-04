/**
 * Tier 1 contract test — suspend() namespace + not-found policy.
 *
 * Two production incidents this pins:
 *
 *  1. EMPTY-NAMESPACE → CLUSTER SCOPE 403. hydrateEntry() (manager.ts) hands out a
 *     placeholder ref { name, namespace: "" } for a conversation whose Sandbox is
 *     absent from reconcile. A k8s namespaced patch with namespace:"" is routed at
 *     the CLUSTER scope, which the namespaced Role can't authorize → the idle sweep
 *     floods "cannot patch sandboxes at the cluster scope" 403s. suspend() must
 *     fall back to the provisioner's own namespace for an empty ref namespace.
 *
 *  2. STALE HYDRATED ENTRY → 404 CHURN. A Sandbox that's already gone (GC'd) is,
 *     for suspend's purposes, already suspended. suspend() must SWALLOW a 404 so
 *     the sweep marks the conversation suspended and stops re-patching every tick.
 *     Any other error still propagates.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

/** A fake KubeConfig whose CustomObjectsApi records patch calls and can be told
 *  to reject with a given k8s-style error ({ code }). */
function fakeKc(opts: { patchRejectCode?: number }) {
  const patchCalls: Array<{ namespace?: string; name?: string }> = [];
  // A single union stub carrying both the CustomObjects and Core methods we touch,
  // returned for every makeApiClient() call — avoids brittle constructor-name
  // matching (the k8s client classes may be minified) and only suspend() runs here.
  const api = {
    patchNamespacedCustomObject: async (params: { namespace?: string; name?: string }) => {
      patchCalls.push({ namespace: params.namespace, name: params.name });
      if (opts.patchRejectCode) throw Object.assign(new Error("api"), { code: opts.patchRejectCode });
      return {};
    },
  };
  const kc = { makeApiClient: () => api as never };
  return { kc: kc as never, patchCalls };
}

const provisioner = (kc: never) =>
  createK8sProvisioner({
    namespace: "agent-manager",
    sandboxImage: "img",
    kubeConfig: kc,
  });

describe("k8sProvisioner.suspend", () => {
  it("patches in the provisioner namespace when the ref namespace is EMPTY (not the cluster scope)", async () => {
    const { kc, patchCalls } = fakeKc({});
    await provisioner(kc).suspend({ name: "conv-abc", namespace: "" });
    expect(patchCalls).toHaveLength(1);
    // The bug was namespace:"" reaching the API (→ cluster scope 403). It must be
    // normalized to the provisioner's own namespace.
    expect(patchCalls[0].namespace).toBe("agent-manager");
    expect(patchCalls[0].name).toBe("conv-abc");
  });

  it("keeps a real ref namespace as-is", async () => {
    const { kc, patchCalls } = fakeKc({});
    await provisioner(kc).suspend({ name: "conv-xyz", namespace: "other-ns" });
    expect(patchCalls[0].namespace).toBe("other-ns");
  });

  it("SWALLOWS a 404 (sandbox already gone — nothing to suspend, stop the churn)", async () => {
    const { kc } = fakeKc({ patchRejectCode: 404 });
    await expect(provisioner(kc).suspend({ name: "conv-gone", namespace: "" })).resolves.toBeUndefined();
  });

  it("PROPAGATES a non-404 error (e.g. a genuine 403/500 — do not hide it)", async () => {
    const { kc } = fakeKc({ patchRejectCode: 500 });
    await expect(provisioner(kc).suspend({ name: "conv-x", namespace: "agent-manager" })).rejects.toThrow();
  });
});
