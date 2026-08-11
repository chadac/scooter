/**
 * Tier 1 contract test — the sandbox pod's cgroup-isolation posture.
 *
 * The systemd NixOS dev image runs systemd as PID 1. It historically got
 * `securityContext.privileged: true` — but containerd runs privileged containers
 * in the HOST cgroup namespace, so the sandbox's systemd drives the host
 * /kubepods.slice cgroup tree, starving the kubelet's placement
 * ("Couldn't move process … to requested cgroup: Device or resource busy") and
 * destabilizing the node / killing the host graphical session.
 *
 * A NON-privileged pod already gets its OWN (private) cgroup namespace by default;
 * the ONLY thing privileged bought the sandbox is a writable /sys/fs/cgroup (systemd
 * PID 1 needs to build its cgroup subtree). The fix: run the sandbox under a
 * cgroup-delegating runtime (crun) NON-privileged, so it keeps its private cgroup ns
 * AND gets a writable cgroup subtree. SYS_ADMIN is added ONLY when overlayStore is on
 * (the runtime `mount -t overlay` on /nix/store needs it) — not otherwise.
 *
 * This test pins: systemd sandbox = not privileged, uses the sandbox runtimeClass
 * when configured, carries SYS_ADMIN ONLY with overlayStore; legacy generic image
 * stays plain unprivileged with no runtimeClass / no caps.
 */

import { describe, it, expect } from "vitest";

import { sandboxManifest } from "../../src/session/k8sProvisioner.js";

type SecCtx = {
  privileged?: boolean;
  capabilities?: { add?: string[]; drop?: string[] };
};
type Manifest = {
  spec: {
    podTemplate: {
      spec: {
        runtimeClassName?: string;
        containers: Array<{ securityContext?: SecCtx }>;
      };
    };
  };
};

const render = (systemdImage: boolean, deploy: Record<string, unknown> = {}) =>
  sandboxManifest("abc", "conv-abc", "sandbox-abc", "img:latest", "ns", "aud", "10Gi", undefined, systemdImage, deploy) as Manifest;

const podSpec = (m: Manifest) => m.spec.podTemplate.spec;
const ctxOf = (m: Manifest) => podSpec(m).containers[0].securityContext;

describe("sandboxManifest cgroup isolation", () => {
  it("does NOT run the systemd sandbox as privileged (privileged => host cgroup ns => node contention)", () => {
    expect(ctxOf(render(true))?.privileged).not.toBe(true);
  });

  it("sets the configured sandbox runtimeClass on the systemd sandbox (cgroup-delegating runtime, e.g. crun)", () => {
    const m = render(true, { sandboxRuntimeClass: "crun" });
    expect(podSpec(m).runtimeClassName).toBe("crun");
  });

  it("omits runtimeClassName when none is configured (cluster default runtime)", () => {
    expect(podSpec(render(true)).runtimeClassName).toBeUndefined();
  });

  it("grants SYS_ADMIN to the systemd sandbox (NixOS stage-2 specialfs mounts /proc,/dev,/run) — non-privileged", () => {
    // The mount capability is needed by the base NixOS activation itself, NOT just
    // the overlay remount: stage-2's `specialfs` snippet mounts /proc, /dev, /run.
    // crun keeps the pod in its private cgroup ns, so SYS_ADMIN here does NOT drag in
    // the host cgroup ns the way `privileged` did.
    const ctx = ctxOf(render(true, { sandboxRuntimeClass: "crun" }));
    expect(ctx?.capabilities?.add ?? []).toContain("SYS_ADMIN");
    expect(ctx?.privileged).not.toBe(true);
  });

  it("leaves the legacy generic (non-systemd) image plain: unprivileged, no runtimeClass, no caps", () => {
    const m = render(false, { sandboxRuntimeClass: "crun" });
    expect(ctxOf(m)?.privileged).not.toBe(true);
    expect(ctxOf(m)?.capabilities?.add ?? []).not.toContain("SYS_ADMIN");
    expect(podSpec(m).runtimeClassName).toBeUndefined();
  });
});
