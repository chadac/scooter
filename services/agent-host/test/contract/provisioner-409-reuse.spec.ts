/**
 * Tier 1 contract — create() must treat a 409 AlreadyExists on the Sandbox as REUSE
 * (adopt + resume the existing one), not an unhandled throw.
 *
 * WHY: a failed boot hydrate leaves the session map wrong → a prompt for an existing
 * conversation takes the CREATE path → createNamespacedCustomObject 409s. The old
 * code threw the 409 up to /agui, where the SSE 200 was already sent, so the client
 * got a truncated stream with no error and the conversation looked silently dead
 * (the hydrate-silent-drop outage). Adopting the existing Sandbox is the recovery.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

/** A fake k8s API where the Sandbox create can be told to 409, recording whether
 *  the provisioner then RESUMED (set operatingMode=Running) the existing Sandbox. */
function fakeKc(opts: { sandboxCreate409?: boolean } = {}) {
  const calls: string[] = [];
  const api = {
    createNamespacedServiceAccount: async () => ({}),
    createNamespacedConfigMap: async () => ({}),
    readNamespacedConfigMap: async () => { throw Object.assign(new Error("nf"), { code: 404 }); },
    createNamespacedCustomObject: async () => {
      calls.push("create:sandbox");
      if (opts.sandboxCreate409) throw Object.assign(new Error("exists"), { code: 409 });
      return {};
    },
    patchNamespacedCustomObject: async () => {
      calls.push("patch:mode"); // setOperatingMode("Running") = resume
      return {};
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, calls };
}

const provisioner = (kc: never) =>
  createK8sProvisioner({ namespace: "agent-manager", sandboxImage: "img", kubeConfig: kc });

describe("k8sProvisioner.create — 409 AlreadyExists = reuse", () => {
  it("adopts + resumes the existing Sandbox on a 409 (does NOT throw)", async () => {
    const { kc, calls } = fakeKc({ sandboxCreate409: true });
    // Must resolve to the ref, not throw the 409.
    const ref = await provisioner(kc).create("conv1", "conv1");
    expect(ref.name).toBe("conv-conv1");
    expect(calls).toContain("create:sandbox");
    expect(calls).toContain("patch:mode"); // resumed the adopted (maybe-suspended) Sandbox
  });

  it("a fresh create (no 409) does NOT resume — operatingMode=Running already", async () => {
    const { kc, calls } = fakeKc({ sandboxCreate409: false });
    const ref = await provisioner(kc).create("conv1", "conv1");
    expect(ref.name).toBe("conv-conv1");
    expect(calls).toContain("create:sandbox");
    expect(calls).not.toContain("patch:mode"); // fresh -> no adopt-resume
  });

  it("a NON-409 create error still throws (don't mask a real failure as reuse)", async () => {
    const api = {
      createNamespacedServiceAccount: async () => ({}),
      createNamespacedConfigMap: async () => ({}),
      readNamespacedConfigMap: async () => { throw Object.assign(new Error("nf"), { code: 404 }); },
      createNamespacedCustomObject: async () => { throw Object.assign(new Error("boom"), { code: 500 }); },
      patchNamespacedCustomObject: async () => ({}),
    };
    const kc = { makeApiClient: () => api as never } as never;
    await expect(provisioner(kc).create("conv1", "conv1")).rejects.toThrow();
  });
});
