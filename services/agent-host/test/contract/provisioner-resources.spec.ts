/**
 * Tier 1 contract — the sandbox container carries resource requests/limits.
 *
 * WHY: without requests the scheduler treats a sandbox as ~free and packs many onto
 * one node; a burst of in-pod nix builds then overwhelms the container runtime and the
 * kubelet's PLEG stalls the whole node (the node-death we hit). The Sandbox podTemplate
 * must carry the resources the provisioner is given, and omit the block entirely when
 * none are configured (so it can't accidentally reserve nothing/everything).
 */

import { describe, it, expect } from "vitest";

import { sandboxManifest } from "../../src/session/k8sProvisioner.js";

type Container = {
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
};
type Manifest = { spec: { podTemplate: { spec: { containers: Container[] } } } };

const render = (deploy: Record<string, unknown>) =>
  sandboxManifest("abc", "conv-abc", "sandbox-abc", "img:latest", "ns", "aud", "10Gi", undefined, true, deploy) as Manifest;

describe("sandboxManifest resource requests/limits", () => {
  it("applies the passed resources to the sandbox container", () => {
    const resources = { requests: { cpu: "500m", memory: "1Gi" }, limits: { memory: "4Gi" } };
    const c = render({ resources }).spec.podTemplate.spec.containers[0];
    expect(c.resources).toEqual(resources);
    // Memory-limit-only profile: no cpu limit is emitted (bursty builds use spare CPU).
    expect(c.resources?.limits?.cpu).toBeUndefined();
  });

  it("emits NO resources block when none are configured", () => {
    const c = render({}).spec.podTemplate.spec.containers[0];
    expect(c.resources).toBeUndefined();
  });
});
