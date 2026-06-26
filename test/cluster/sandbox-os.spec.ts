/**
 * Tier 2 — the NixOS dev-environment sandbox image boots systemd as PID 1 in a
 * REAL Kubernetes pod, and is exec-able.
 *
 * This covers exactly what the nixosTests CANNOT: the OCI packaging + the k8s
 * privilege/cgroup boot. nixosTest proves the NixOS *config* (units, stubs,
 * services) in a VM; here we prove the *image* actually starts systemd PID 1
 * under containerd with a privileged securityContext, `kubectl exec` works, and
 * `systemctl is-system-running` reports a healthy system.
 *
 * Privileged on dev is accepted (see docs/DEV_ENVIRONMENT.md): systemd PID 1
 * needs a writable cgroup + CAP_SYS_ADMIN; we run the pod privileged to remove
 * the cgroup-delegation unknown.
 *
 * Gated: RUN_CLUSTER_TESTS=1. Image: SANDBOX_OS_IMAGE (built + imported by
 * cluster-up). Skipped if that image isn't available.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-test";
const IMAGE = process.env.SANDBOX_OS_IMAGE ?? "agent-sandbox-os:latest";
const POD = "sandbox-os-boot";
const SELECTOR = "app=sandbox-os-boot";

maybe("NixOS sandbox image boots systemd PID 1 in a pod", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });

    // A bare privileged pod running the OS image — isolates the image-boot
    // concern from the agent-sandbox controller (the controller path is covered
    // by provision.spec). The container is named "sandbox" so cluster.exec()
    // (which targets that container) works.
    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: POD, namespace: NS, labels: { app: "sandbox-os-boot" } },
      spec: {
        // systemd PID 1 wants a writable cgroup + CAP_SYS_ADMIN; privileged on
        // dev removes the delegation unknown.
        containers: [
          {
            name: "sandbox",
            image: IMAGE,
            imagePullPolicy: "Never", // imported into the node, never pulled
            securityContext: { privileged: true },
            // tmpfs where systemd needs to write (CONTAINER_INTERFACE).
            volumeMounts: [
              { name: "run", mountPath: "/run" },
              { name: "tmp", mountPath: "/tmp" },
            ],
          },
        ],
        volumes: [
          { name: "run", emptyDir: { medium: "Memory" } },
          { name: "tmp", emptyDir: { medium: "Memory" } },
        ],
      },
    });
  }, 60_000);

  afterAll(async () => {
    await cluster?.deletePod(POD, NS).catch(() => {});
  });

  it("reaches Ready (systemd PID 1 came up under containerd)", async () => {
    const pod = await cluster.waitFor<{ status: { phase: string } }>(
      "Pod",
      POD,
      (p) => p.status?.phase === "Running",
      180_000,
      NS,
    );
    expect(pod.status.phase).toBe("Running");
  });

  it("PID 1 is systemd and the system is running (not offline/failed)", async () => {
    const pid1 = await cluster.exec(SELECTOR, ["ps", "-o", "comm=", "-p", "1"], NS);
    expect(pid1.exitCode).toBe(0);
    expect(pid1.stdout.trim()).toBe("systemd");

    // is-system-running exits 0 only for "running"; "degraded" exits non-zero but
    // is acceptable (some unit may be inactive in a bare pod). Reject offline/
    // initializing — those mean systemd didn't really boot.
    const state = await cluster.exec(SELECTOR, ["systemctl", "is-system-running"], NS);
    expect(["running", "degraded"]).toContain(state.stdout.trim());
  });

  it("the in-pod nix daemon is up (the agent can build/install)", async () => {
    const r = await cluster.exec(SELECTOR, ["systemctl", "is-active", "nix-daemon.socket"], NS);
    expect(r.stdout.trim()).toBe("active");
  });

  it("a systemd service is controllable via systemctl (start/stop)", async () => {
    // The sample service is enabled in the base config; prove it's manageable.
    const status = await cluster.exec(SELECTOR, ["systemctl", "is-active", "sample-dev-service.service"], NS);
    expect(status.stdout.trim()).toBe("active");

    const stop = await cluster.exec(SELECTOR, ["systemctl", "stop", "sample-dev-service.service"], NS);
    expect(stop.exitCode).toBe(0);
    const after = await cluster.exec(SELECTOR, ["systemctl", "is-active", "sample-dev-service.service"], NS);
    expect(after.stdout.trim()).not.toBe("active");
  });
});
