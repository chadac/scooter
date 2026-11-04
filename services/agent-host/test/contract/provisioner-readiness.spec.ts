/**
 * When the systemd sandbox counts as Ready. /run is a fresh tmpfs on every boot, so until NixOS
 * activation links /run/current-system the image PATH has no coreutils: an exec that lands in that
 * window gets `touch: command not found`. The startup probe holds Ready back until the link exists.
 */

import { describe, it, expect } from "vitest";

import { ACTIVATED_PROBE, sandboxManifest } from "../../src/session/k8sProvisioner.js";

type Probe = { exec?: { command?: string[] }; periodSeconds?: number; failureThreshold?: number };
type Manifest = {
  spec: { podTemplate: { spec: { containers: Array<{ startupProbe?: Probe; readinessProbe?: Probe }> } } };
};

const sandbox = (systemdImage: boolean) =>
  (sandboxManifest("abc", "conv-abc", "sandbox-abc", "img:latest", "ns", "aud", "10Gi", systemdImage, {}) as Manifest).spec
    .podTemplate.spec.containers[0];

describe("sandboxManifest readiness", () => {
  it("holds the systemd sandbox un-Ready until the system profile is linked", () => {
    const probe = sandbox(true).startupProbe;
    expect(probe?.exec?.command).toEqual([ACTIVATED_PROBE]);
    expect(ACTIVATED_PROBE.startsWith("/run/current-system/sw/bin/")).toBe(true);
  });

  it("polls fast and tolerates a slow boot rather than restarting it", () => {
    const probe = sandbox(true).startupProbe!;
    expect(probe.periodSeconds).toBe(1);
    expect((probe.periodSeconds ?? 10) * (probe.failureThreshold ?? 3)).toBeGreaterThanOrEqual(300);
  });

  it("adds no steady-state probe, and none to the non-systemd image", () => {
    expect(sandbox(true).readinessProbe).toBeUndefined();
    expect(sandbox(false).startupProbe).toBeUndefined();
  });
});
