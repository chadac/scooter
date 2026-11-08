/**
 * The overlay-store PVC wiring in the rendered Sandbox: with overlayStore on, the
 * podTemplate mounts a PVC upper at /nix/.scooter-rw and declares a matching
 * volumeClaimTemplate; with it off, neither appears.
 */

import { describe, it, expect } from "vitest";

import { sandboxManifest, imageTagOf } from "../../src/session/k8sProvisioner.js";

type Manifest = {
  spec: {
    podTemplate: {
      spec: {
        terminationGracePeriodSeconds?: number;
        containers: Array<{ volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
        volumes?: Array<{ name: string; configMap?: { name: string }; persistentVolumeClaim?: { claimName: string } }>;
      };
    };
    volumeClaimTemplates: Array<{ metadata: { name: string }; spec: { resources: { requests: { storage: string } } } }>;
  };
};

const render = (deploy: Record<string, unknown>) =>
  sandboxManifest("abc", "conv-abc", "sandbox-abc", "img:latest", "ns", "aud", "10Gi", true, deploy) as Manifest;

describe("sandboxManifest overlay-store wiring", () => {
  it("mounts the scooter-rw PVC upper at /nix/.scooter-rw when overlayStore is on", () => {
    const m = render({ overlayStore: true, overlayStorage: "25Gi" });
    const mounts = m.spec.podTemplate.spec.containers[0].volumeMounts ?? [];
    expect(mounts.find((v) => v.name === "scooter-rw")?.mountPath).toBe("/nix/.scooter-rw");

    const pvc = m.spec.volumeClaimTemplates.find((t) => t.metadata.name === "scooter-rw");
    expect(pvc).toBeDefined();
    expect(pvc!.spec.resources.requests.storage).toBe("25Gi");
  });

  it("gives the shutdown GC pass a longer grace period only when overlayStore is on", () => {
    expect(render({ overlayStore: true }).spec.podTemplate.spec.terminationGracePeriodSeconds).toBe(150);
    expect(render({ overlayStore: false }).spec.podTemplate.spec.terminationGracePeriodSeconds).toBeUndefined();
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

describe("sandboxManifest overlay upper — ONE uniform shape, always the vct", () => {
  it("ALWAYS emits the scooter-rw vct and NEVER a named pool volume", () => {
    const m = render({ overlayStore: true });
    expect(m.spec.volumeClaimTemplates.find((t) => t.metadata.name === "scooter-rw")).toBeDefined();
    expect((m.spec.podTemplate.spec.volumes ?? []).find((v) => v.name === "scooter-rw")).toBeUndefined();
  });

  it("the mount is identical whichever PV backs the adopted claim", () => {
    const m = render({ overlayStore: true });
    const mounts = m.spec.podTemplate.spec.containers[0].volumeMounts ?? [];
    expect(mounts.find((v) => v.name === "scooter-rw")?.mountPath).toBe("/nix/.scooter-rw");
  });

  it("emits no upper at all when overlayStore is off", () => {
    const m = render({ overlayStore: false });
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

describe("sandboxManifest deployment config-files ConfigMap", () => {
  it("mounts the config-files CM read-only as a flat dir at /etc/agent-sandbox/config", () => {
    // The kubelet mounts ConfigMap data byte-for-byte, so multi-line files survive.
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
