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

import { sandboxManifest, imageTagOf } from "../../src/session/k8sProvisioner.js";

type Manifest = {
  spec: {
    podTemplate: {
      spec: {
        containers: Array<{ volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
        volumes?: Array<{ name: string; configMap?: { name: string }; persistentVolumeClaim?: { claimName: string } }>;
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

describe("sandboxManifest warm-store claimed PVC", () => {
  it("references a claimed pool PVC by claimName + emits NO scooter-rw volumeClaimTemplate", () => {
    const m = render({ overlayStore: true, overlayClaimName: "warm-store-latest-3" });
    // The scooter-rw upper is a NAMED volume pointing at the pooled PVC...
    const vol = (m.spec.podTemplate.spec.volumes ?? []).find((v) => v.name === "scooter-rw");
    expect(vol?.persistentVolumeClaim?.claimName).toBe("warm-store-latest-3");
    // ...and there is NO volumeClaimTemplate for scooter-rw (a same-name vct would
    // create a SECOND empty PVC and collide).
    expect(m.spec.volumeClaimTemplates.find((t) => t.metadata.name === "scooter-rw")).toBeUndefined();
    // The mount is unchanged — same path, whichever backing the volume has.
    const mounts = m.spec.podTemplate.spec.containers[0].volumeMounts ?? [];
    expect(mounts.find((v) => v.name === "scooter-rw")?.mountPath).toBe("/nix/.scooter-rw");
  });

  it("falls back to a fresh volumeClaimTemplate when NOT claimed (null)", () => {
    const m = render({ overlayStore: true, overlayClaimName: null });
    // No named PVC volume...
    expect((m.spec.podTemplate.spec.volumes ?? []).find((v) => v.name === "scooter-rw")).toBeUndefined();
    // ...the vct provides the fresh upper.
    expect(m.spec.volumeClaimTemplates.find((t) => t.metadata.name === "scooter-rw")).toBeDefined();
  });

  it("ignores overlayClaimName when overlayStore is off (no upper at all)", () => {
    const m = render({ overlayStore: false, overlayClaimName: "warm-store-latest-3" });
    expect((m.spec.podTemplate.spec.volumes ?? []).find((v) => v.name === "scooter-rw")).toBeUndefined();
    expect(m.spec.volumeClaimTemplates.find((t) => t.metadata.name === "scooter-rw")).toBeUndefined();
  });
});

describe("imageTagOf — the pool version key (must match kubenix + the controller)", () => {
  it("takes the tag after the last colon", () => {
    expect(imageTagOf("agent-sandbox-os:latest")).toBe("latest");
  });
  it("is not fooled by a registry port", () => {
    expect(imageTagOf("localhost:5000/agent-sandbox-os:scooter-git-abc")).toBe("scooter-git-abc");
  });
  it("returns '' for a registry-port ref with no tag", () => {
    expect(imageTagOf("localhost:5000/agent-sandbox-os")).toBe("");
  });
  it("strips a digest", () => {
    expect(imageTagOf("agent-sandbox-os:latest@sha256:deadbeef")).toBe("latest");
  });
  it("returns '' for an untagged / empty ref", () => {
    expect(imageTagOf("agent-sandbox-os")).toBe("");
    expect(imageTagOf("")).toBe("");
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

describe("sandboxManifest deployment config-files ConfigMap", () => {
  it("mounts the config-files CM read-only as a flat dir at /etc/agent-sandbox/config", () => {
    // File-based config injection: multi-line files (e.g. a nix.conf) survive the
    // CRD controller's env-var newline corruption because the kubelet mounts
    // ConfigMap data byte-for-byte.
    const m = render({ configFilesConfigMap: "deploy-config-files" });
    const mounts = m.spec.podTemplate.spec.containers[0].volumeMounts ?? [];
    const mount = mounts.find((v) => v.name === "deploy-config");
    expect(mount?.mountPath).toBe("/etc/agent-sandbox/config");
    expect(mount?.readOnly).toBe(true);

    const vol = (m.spec.podTemplate.spec.volumes ?? []).find((v) => v.name === "deploy-config");
    expect(vol?.configMap?.name).toBe("deploy-config-files");
  });

  it("adds no config-files mount/volume when none is given", () => {
    const m = render({});
    const mounts = m.spec.podTemplate.spec.containers[0].volumeMounts ?? [];
    expect(mounts.find((v) => v.name === "deploy-config")).toBeUndefined();
    expect((m.spec.podTemplate.spec.volumes ?? []).find((v) => v.name === "deploy-config")).toBeUndefined();
  });
});
