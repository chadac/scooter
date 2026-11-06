/**
 * Tier 2: the docker contrib in a user-namespaced pod (hostUsers: false, procMount: Unmasked), the
 * only posture it supports. Socket activation starts the nested dockerd, the nix-stubs shims
 * realize docker and crun on first use, and a container runs from an image tarred out of the
 * pod's own store, so no registry is involved. Gated on RUN_CLUSTER_TESTS=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-test";
const IMAGE = process.env.SANDBOX_OS_IMAGE ?? "agent-sandbox-os:latest";
const RUNTIME_CLASS = process.env.SANDBOX_RUNTIME_CLASS ?? "crun";
const POD = `sandbox-docker-${RUNTIME_CLASS || "default"}`;
const SELECTOR = `app=${POD}`;

maybe("docker in a user-namespaced sandbox", () => {
  let cluster: Cluster;

  const sh = (script: string) => cluster.exec(SELECTOR, ["bash", "-lc", script], NS);

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });
    await cluster
      .apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } })
      .catch(() => {});

    // The provisioner's systemd-sandbox shape with sandboxUserNamespace on.
    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: POD, namespace: NS, labels: { app: POD } },
      spec: {
        hostUsers: false,
        ...(RUNTIME_CLASS ? { runtimeClassName: RUNTIME_CLASS } : {}),
        containers: [
          {
            name: "sandbox",
            image: IMAGE,
            imagePullPolicy: "Never",
            securityContext: { capabilities: { add: ["SYS_ADMIN"] }, procMount: "Unmasked" },
            volumeMounts: [
              { name: "run", mountPath: "/run" },
              { name: "tmp", mountPath: "/tmp" },
              { name: "scooter-rw", mountPath: "/nix/.scooter-rw" },
              { name: "workspace", mountPath: "/workspace" },
            ],
          },
        ],
        volumes: [
          { name: "run", emptyDir: { medium: "Memory" } },
          { name: "tmp", emptyDir: { medium: "Memory" } },
          { name: "scooter-rw", emptyDir: {} },
          { name: "workspace", emptyDir: {} },
        ],
      },
    });
  }, 60_000);

  afterAll(async () => {
    // CI keeps the pod so its failure step can describe it and read its logs.
    if (process.env.KEEP_TEST_PODS === "1") return;
    await cluster?.deletePod(POD, NS).catch(() => {});
  });

  it("runs a container from a cold store", async () => {
    await cluster.waitFor<{ status: { phase: string } }>(
      "Pod", POD, (p) => p.status?.phase === "Running", 180_000, NS,
    );
    // sockets.target is up once the docker socket listens.
    const deadline = Date.now() + 180_000;
    while ((await sh("systemctl is-active scooter-docker.socket")).stdout.trim() !== "active") {
      if (Date.now() > deadline) throw new Error("scooter-docker.socket never became active");
      await new Promise((res) => setTimeout(res, 2000));
    }
    // Query the closure before docker runs: the stubs' realization holds the store DB.
    const r = await sh(
      "set -eo pipefail; " +
        'cu=$(dirname "$(dirname "$(readlink -f "$(type -P echo)")")"); ' +
        'paths=$(nix-store -qR "$cu"); ' +
        "docker version >/dev/null; " +
        "tar -cf - $paths 2>/dev/null | docker import - scooter-docker-probe >/dev/null; " +
        'docker run --rm scooter-docker-probe "$cu/bin/echo" docker-ok',
    );
    if (r.exitCode !== 0) {
      const why = await sh("journalctl -u scooter-docker --no-pager -o cat | tail -40");
      console.error("docker run failed:", r.stderr, "\n", why.stdout);
    }
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("docker-ok");
  }, 400_000);
});
