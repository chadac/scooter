/**
 * Tier 1 contract test — the overlay-store PVC wiring in the rendered Sandbox.
 *
 * When overlayStore is on (the agent uses the overlay-store image so its runtime
 * re-converge / in-pod builds can write), the Sandbox podTemplate must mount a
 * disk-backed PVC upper at /nix/.scooter-rw and declare a matching
 * volumeClaimTemplate. When off, neither appears. Pins the wiring so it can't
 * silently regress.
 */

import { describe, it, expect } from "vitest";

import { sandboxManifest } from "../../src/session/k8sProvisioner.js";

type Manifest = {
  spec: {
    podTemplate: {
      spec: {
        containers: Array<{ volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
        volumes?: Array<{ name: string; configMap?: { name: string } }>;
      };
    };
    volumeClaimTemplates: Array<{ metadata: { name: string }; spec: { resources: { requests: { storage: string } } } }>;
  };
};

const render = (deploy: Record<string, unknown>) =>
  sandboxManifest("abc", "conv-abc", "sandbox-abc", "img:latest", "ns", "aud", "10Gi", undefined, true, deploy) as Manifest;

describe("sandboxManifest overlay-store wiring", () => {
  it("mounts the scooter-rw PVC upper at /nix/.scooter-rw when overlayStore is on", () => {
    const m = render({ overlayStore: true, overlayStorage: "25Gi" });
    const mounts = m.spec.podTemplate.spec.containers[0].volumeMounts ?? [];
    expect(mounts.find((v) => v.name === "scooter-rw")?.mountPath).toBe("/nix/.scooter-rw");

    const pvc = m.spec.volumeClaimTemplates.find((t) => t.metadata.name === "scooter-rw");
    expect(pvc).toBeDefined();
    expect(pvc!.spec.resources.requests.storage).toBe("25Gi");
  });

  it("defaults the upper PVC size to 20Gi", () => {
    const m = render({ overlayStore: true });
    const pvc = m.spec.volumeClaimTemplates.find((t) => t.metadata.name === "scooter-rw");
    expect(pvc!.spec.resources.requests.storage).toBe("20Gi");
  });

  it("adds NEITHER the mount nor the PVC when overlayStore is off", () => {
    const m = render({ overlayStore: false });
    const mounts = m.spec.podTemplate.spec.containers[0].volumeMounts ?? [];
    expect(mounts.find((v) => v.name === "scooter-rw")).toBeUndefined();
    expect(m.spec.volumeClaimTemplates.find((t) => t.metadata.name === "scooter-rw")).toBeUndefined();
  });
});

describe("sandboxManifest per-conversation module ConfigMap", () => {
  it("mounts the module CM read-only at the converge path + adds the volume", () => {
    const m = render({ moduleConfigMap: "conv-abc-module" });
    const mounts = m.spec.podTemplate.spec.containers[0].volumeMounts ?? [];
    const mount = mounts.find((v) => v.name === "scooter-conv");
    expect(mount?.mountPath).toBe("/etc/agent-sandbox/scooter");
    expect(mount?.readOnly).toBe(true);

    const vol = (m.spec.podTemplate.spec.volumes ?? []).find((v) => v.name === "scooter-conv");
    expect(vol?.configMap?.name).toBe("conv-abc-module");
  });

  it("does NOT mount the deployment scooter-tools at the same path when the module CM owns it", () => {
    // Both set: the per-conversation module CM wins the converge path (the host
    // renders the deployment's tools into the module).
    const m = render({ moduleConfigMap: "conv-abc-module", scooterConfigMap: "deploy-tools" });
    const mounts = m.spec.podTemplate.spec.containers[0].volumeMounts ?? [];
    const atPath = mounts.filter((v) => v.mountPath === "/etc/agent-sandbox/scooter");
    expect(atPath.map((v) => v.name)).toEqual(["scooter-conv"]); // not scooter-tools too
  });

  it("adds no module CM mount/volume when none is given", () => {
    const m = render({});
    const mounts = m.spec.podTemplate.spec.containers[0].volumeMounts ?? [];
    expect(mounts.find((v) => v.name === "scooter-conv")).toBeUndefined();
    expect((m.spec.podTemplate.spec.volumes ?? []).find((v) => v.name === "scooter-conv")).toBeUndefined();
  });
});
