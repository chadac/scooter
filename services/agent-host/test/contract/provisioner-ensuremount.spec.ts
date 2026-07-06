/**
 * Tier 1 contract test — ensureModuleMount self-heals an old Sandbox podTemplate.
 *
 * Sandboxes created before module-CM provisioning don't mount the module CM, so a
 * CM sync never reaches their pod → modify_environment can't persist across
 * suspend/resume for them. ensureModuleMount patches the Sandbox podTemplate to add
 * the module-CM volume + read-only mount when absent, and is a no-op when already
 * present (no needless generation bump). A 404 (no Sandbox yet) is benign.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

const MOUNT_PATH = "/etc/agent-sandbox/scooter";
const VOL = "scooter-conv";

/** Fake KubeConfig backing a single Sandbox object. `sandbox` is the CR the GET
 *  returns (or null → 404). Records the patch body sent (if any). */
function fakeKc(sandbox: unknown | null) {
  const state = { patchBody: undefined as unknown, getCalled: false, patched: false };
  const api = {
    getNamespacedCustomObject: async () => {
      state.getCalled = true;
      if (sandbox === null) throw Object.assign(new Error("not found"), { code: 404 });
      return sandbox;
    },
    patchNamespacedCustomObject: async (p: { body?: unknown }) => {
      state.patched = true;
      state.patchBody = p.body;
      return {};
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, state };
}

const provisioner = (kc: never) =>
  createK8sProvisioner({ namespace: "agent-manager", sandboxImage: "img", kubeConfig: kc });

/** A Sandbox CR whose podTemplate has the given volumes + container mounts. */
const sandboxWith = (volumes: Array<{ name: string }>, mounts: Array<{ name: string }>) => ({
  spec: { podTemplate: { spec: { volumes, containers: [{ name: "sandbox", volumeMounts: mounts }] } } },
});

describe("k8sProvisioner.ensureModuleMount", () => {
  it("ADDS the module volume + mount when the old podTemplate lacks them", async () => {
    const { kc, state } = fakeKc(sandboxWith([{ name: "workspace" }], [{ name: "workspace" }]));
    await provisioner(kc).ensureModuleMount!("fixtest-1");

    expect(state.patched).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spec = (state.patchBody as any).spec.podTemplate.spec;
    // The augmented volumes include the module CM volume, referencing conv-<id>-module.
    const vol = spec.volumes.find((v: { name: string }) => v.name === VOL);
    expect(vol).toBeTruthy();
    expect(vol.configMap.name).toBe("conv-fixtest-1-module");
    // The container gains the read-only mount at the boot re-converge path.
    const mount = spec.containers[0].volumeMounts.find((m: { name: string }) => m.name === VOL);
    expect(mount).toEqual({ name: VOL, mountPath: MOUNT_PATH, readOnly: true });
    // Existing volume/mount are preserved (read-modify-write, not replace).
    expect(spec.volumes.some((v: { name: string }) => v.name === "workspace")).toBe(true);
    expect(spec.containers[0].volumeMounts.some((m: { name: string }) => m.name === "workspace")).toBe(true);
  });

  it("is a NO-OP when the podTemplate already mounts the module CM (no generation bump)", async () => {
    const { kc, state } = fakeKc(
      sandboxWith([{ name: "workspace" }, { name: VOL }], [{ name: "workspace" }, { name: VOL }]),
    );
    await provisioner(kc).ensureModuleMount!("fixtest-1");
    expect(state.getCalled).toBe(true);
    expect(state.patched).toBe(false); // already wired → do not patch
  });

  it("is benign when the Sandbox doesn't exist yet (404 → no patch)", async () => {
    const { kc, state } = fakeKc(null);
    await expect(provisioner(kc).ensureModuleMount!("fixtest-1")).resolves.toBeUndefined();
    expect(state.patched).toBe(false);
  });
});
