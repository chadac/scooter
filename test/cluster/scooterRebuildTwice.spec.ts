/**
 * Tier-2 cluster — running `scooter-rebuild switch` TWICE in one pod.
 *
 * An agent reported that a second switch aborted with a dbus "Subscribe" rejection
 * (cleared by `systemctl daemon-reexec`). The boot converge only ever runs ONE
 * switch, so nothing covered the second.
 *
 * Worth a test beyond the abort itself: scooter-apply-module deliberately IGNORES
 * switch-to-configuration's exit code and decides success from a failed-unit diff.
 * An abort BEFORE any unit changes leaves that diff empty — so the switch reports
 * success having done nothing. A silent no-op is worse than a loud failure, so
 * every assertion here is on the OBSERVED EFFECT (did the marker change?), never on
 * the exit code or a log string.
 *
 * SECURITY: this pod is NOT privileged. A systemd-PID-1 pod under `privileged`
 * inherits the HOST cgroup namespace and churns /kubepods.slice, which destabilizes
 * the node and kills the host's login session. It runs under a cgroup-delegating
 * runtime (crun) with CAP_SYS_ADMIN instead — the same shape k8sProvisioner.ts uses
 * in production. The first test asserts the isolation actually holds before any
 * switch runs, so a cluster without crun fails loudly here instead of taking the
 * developer's session down.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-rebuild-twice";
const IMAGE = process.env.OVERLAY_IMAGE ?? "agent-sandbox-os:latest";
const POD = "rebuild-twice";
const SELECTOR = "app=rebuild-twice";
const UPPER = "/nix/.scooter-rw";
/** Cgroup-delegating runtime for the pod. Defaults to unset (the cluster default)
 *  so CI, which has no crun RuntimeClass, still runs this — a throwaway CI node is
 *  the one place a host-cgroup pod is acceptable. Set SANDBOX_RUNTIME_CLASS=crun
 *  when running against a cluster you care about, e.g. a local k3d on a workstation:
 *  the cgroup-isolation test below then passes instead of failing loudly. */
const RUNTIME_CLASS = process.env.SANDBOX_RUNTIME_CLASS;
/** Whether to REQUIRE cgroup isolation. On by default when a runtime class is set. */
const REQUIRE_ISOLATION = RUNTIME_CLASS !== undefined;

/** A module adding a marker, so each switch has a real diff to apply.
 *
 *  A systemd unit, NOT environment.etc: kubernetes bind-mounts /etc/hostname and
 *  /etc/hosts read-only, so NixOS's setup-etc.pl cannot rewrite /etc and an
 *  environment.etc marker never lands (it logs "could not create symlink" and
 *  carries on). The unit's fragment path under /run/systemd is writable, and
 *  `systemctl cat` reads back what the switch actually installed. */
const MARKER_UNIT = "scooter-switch-marker";
const moduleFor = (marker: string) => `{ config, lib, pkgs, ... }:
{
  systemd.services."${MARKER_UNIT}" = {
    description = "switch marker ${marker}";
    serviceConfig.Type = "oneshot";
    serviceConfig.RemainAfterExit = true;
    script = "echo ${marker}";
  };
}
`;

maybe("scooter-rebuild, run twice", () => {
  let cluster: Cluster;

  /** Write the marker module, switch, and report what actually landed. */
  async function switchTo(marker: string) {
    await cluster.exec(
      SELECTOR,
      ["sh", "-c", `mkdir -p /etc/scooter/modules && cat > /etc/scooter/modules/marker.nix <<'NIXEOF'\n${moduleFor(marker)}NIXEOF`],
      NS,
    );
    const r = await cluster.exec(SELECTOR, ["scooter-rebuild", "switch"], NS);
    // Read back what the switch INSTALLED, from the unit systemd now has loaded.
    const got = await cluster.exec(
      SELECTOR,
      ["sh", "-c", `systemctl cat ${MARKER_UNIT}.service 2>/dev/null | sed -n 's/^Description=switch marker //p'`],
      NS,
    );
    return { applied: got.stdout.trim(), out: `${r.stdout}\n${r.stderr}` };
  }

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });
    await cluster.apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } }).catch(() => {});
    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: POD, namespace: NS, labels: { app: "rebuild-twice" } },
      spec: {
        ...(RUNTIME_CLASS ? { runtimeClassName: RUNTIME_CLASS } : {}),
        containers: [
          {
            name: "sandbox",
            image: IMAGE,
            imagePullPolicy: "Never",
            // NOT privileged when a cgroup-delegating runtime is available:
            // CAP_SYS_ADMIN is all stage-2's specialfs mounts need, and under crun
            // the cap does not re-introduce the host cgroup namespace. Without a
            // runtime class (CI) fall back to privileged, which is how the sibling
            // cluster specs run.
            securityContext: RUNTIME_CLASS
              ? { capabilities: { add: ["SYS_ADMIN"] } }
              : { privileged: true },
            volumeMounts: [
              { name: "run", mountPath: "/run" },
              { name: "tmp", mountPath: "/tmp" },
              { name: "overlay-upper", mountPath: UPPER },
            ],
          },
        ],
        volumes: [
          { name: "run", emptyDir: { medium: "Memory" } },
          { name: "tmp", emptyDir: { medium: "Memory" } },
          { name: "overlay-upper", emptyDir: {} },
        ],
      },
    });
    await cluster.waitFor<{ status: { phase: string } }>(
      "Pod", POD, (p) => p.status?.phase === "Running", 180_000, NS,
    );
  }, 240_000);

  afterAll(async () => {
    await cluster?.deletePod(POD, NS).catch(() => {});
  });

  it("runs in its OWN cgroup namespace when a cgroup-delegating runtime is set", async () => {
    // The guard rail for local runs. A pod in the HOST cgroup namespace reports a
    // /kubepods/... path; its systemd then churns the host tree, which destabilizes
    // the node and kills the developer's login session. With crun the path is the
    // pod's own root. Skipped when no runtime class is configured (CI), where the
    // node is disposable.
    const r = await cluster.exec(SELECTOR, ["sh", "-c", "cat /proc/self/cgroup"], NS);
    if (!REQUIRE_ISOLATION) {
      expect(r.stdout.trim().length, "cgroup path should be readable").toBeGreaterThan(0);
      return;
    }
    expect(
      r.stdout.trim(),
      `pod is in the HOST cgroup namespace despite runtimeClassName=${RUNTIME_CLASS} — ` +
        "its systemd can churn the host cgroup tree and kill your session",
    ).not.toContain("kubepods");
  });

  it("applies a FIRST switch", async () => {
    const { applied, out } = await switchTo("one");
    expect(applied, `first switch did not apply:\n${out.slice(-2500)}`).toBe("one");
  }, 900_000);

  it("applies a SECOND switch in the same pod (the reported dbus-abort case)", async () => {
    const { applied, out } = await switchTo("two");
    expect(
      applied,
      `SECOND switch did not apply — dbus Subscribe abort? Note a no-op here can still ` +
        `report success (the health gate is a failed-unit diff, empty when the switch ` +
        `aborts before touching units).\n${out.slice(-4000)}`,
    ).toBe("two");
  }, 900_000);

  it("applies a THIRD switch (the state is not one-shot)", async () => {
    const { applied, out } = await switchTo("three");
    expect(applied, `THIRD switch did not apply:\n${out.slice(-2500)}`).toBe("three");
  }, 900_000);
});
