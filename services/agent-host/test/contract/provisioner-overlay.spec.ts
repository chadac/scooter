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
    podTemplate: { spec: { containers: Array<{ volumeMounts?: Array<{ name: string; mountPath: string }> }> } };
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
