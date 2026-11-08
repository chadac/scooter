/**
 * Tier 2: the warm /nix/store PVC pool on a real cluster.
 *
 * Two mechanisms are proved end to end. The warm round-trip: a warm Job boots the sandbox
 * image against a fresh PVC, its scooter-warm-store-seed unit builds the golden expr into the
 * overlay upper, stamps the clean-shutdown marker and powers off, and a fresh pod over the
 * same image then finds the warmed path valid with no fixup. The reserve CAS: two concurrent
 * claimRef patches from the same stale view of one idle PV, of which exactly one wins. The spec
 * applies its own namespace, PVCs, Job and pods; gated on RUN_CLUSTER_TESTS=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;

const NS = "warm-store-test";
const IMAGE = process.env.OVERLAY_IMAGE ?? "agent-sandbox-os:latest";
// "Never" for a side-loaded local cluster; "IfNotPresent" or "Always" for a registry-backed one.
const PULL_POLICY = process.env.OVERLAY_PULL_POLICY ?? "Never";
// A stable pool tag standing in for the image content tag the controller uses.
const TAG = "test-tag";
const UPPER = "/nix/.scooter-rw";
// A trivial offline derivation as the golden "tool".
const GOLDEN_EXPR =
  `--impure --expr 'derivation { name = "warm-canary"; system = builtins.currentSystem; ` +
  `builder = "/bin/sh"; args = [ "-c" "echo warmed > $out" ]; }'`;

const LBL = {
  warm: "scooter.io/warm-store",
};

maybe("warm /nix/store PVC pool (round-trip + reserve CAS)", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });
    await cluster
      .apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } })
      .catch(() => {});
  }, 60_000);

  afterAll(async () => {
    // Best-effort cleanup of the pods; PVCs and Jobs are left for inspection.
    await cluster.deletePod("warm-claim", NS).catch(() => {});
    await cluster.deletePod("warm-marker-check", NS).catch(() => {});
  });

  it("a warm Job builds the golden expr INTO the overlay upper, then a fresh claim finds it valid (no fixup)", async () => {
    const pvc = "warm-store-roundtrip";
    // 1. A fresh RWO pool PVC.
    await cluster.apply({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: pvc, namespace: NS, labels: { [LBL.warm]: TAG, "scooter.io/warm-seed": "true" } },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "5Gi" } } },
    });

    // 2. The warm Job, mirroring k8s.py _warm_job_manifest: the initContainer writes .warm-request and the sandbox's scooter-warm-store-seed builds it, stamps the marker and powers off.
    await cluster.apply({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "warm-roundtrip", namespace: NS },
      spec: {
        backoffLimit: 1,
        template: {
          spec: {
            restartPolicy: "OnFailure",
            initContainers: [
              {
                name: "warm-request",
                image: "busybox:1.36",
                command: ["sh", "-c", `printf %s "$G" > ${UPPER}/.warm-request`],
                env: [{ name: "G", value: GOLDEN_EXPR }],
                volumeMounts: [{ name: "up", mountPath: UPPER }],
              },
            ],
            containers: [
              {
                name: "sandbox",
                image: IMAGE,
                imagePullPolicy: PULL_POLICY,
                securityContext: { privileged: true },
                env: [{ name: "SCOOTER_IMAGE_TAG", value: TAG }],
                volumeMounts: [
                  { name: "up", mountPath: UPPER },
                  { name: "run", mountPath: "/run" },
                  { name: "tmp", mountPath: "/tmp" },
                ],
              },
            ],
            volumes: [
              { name: "up", persistentVolumeClaim: { claimName: pvc } },
              { name: "run", emptyDir: { medium: "Memory" } },
              { name: "tmp", emptyDir: { medium: "Memory" } },
            ],
          },
        },
      },
    });

    // 3. Wait for the Job to complete.
    await cluster.waitFor<{ status?: { succeeded?: number } }>(
      "Job",
      "warm-roundtrip",
      (j) => (j.status?.succeeded ?? 0) >= 1,
      300_000,
      NS,
    );

    // 3b. The clean-shutdown marker must be on the PVC before any claim pod boots and clears it, checked the way the controller's read_clean_marker does.
    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "warm-marker-check", namespace: NS, labels: { app: "warm-marker-check" } },
      spec: {
        restartPolicy: "Never",
        containers: [
          {
            name: "sandbox", // exec() targets the "sandbox" container
            image: "busybox:1.36",
            command: ["sh", "-c", `test -f ${UPPER}/.clean-shutdown && sleep 120 || (echo NOMARKER; sleep 120)`],
            volumeMounts: [{ name: "up", mountPath: UPPER, readOnly: true }],
          },
        ],
        volumes: [{ name: "up", persistentVolumeClaim: { claimName: pvc, readOnly: true } }],
      },
    });
    await cluster.waitFor<{ status: { phase: string } }>(
      "Pod",
      "warm-marker-check",
      (p) => p.status?.phase === "Running",
      120_000,
      NS,
    );
    const markerCheck = await cluster.exec(
      "app=warm-marker-check",
      ["sh", "-c", `test -f ${UPPER}/.clean-shutdown; echo $?`],
      NS,
    );
    expect(markerCheck.stdout.trim().split("\n").pop(), "warm seed stamped the clean marker").toBe("0");
    await cluster.deletePod("warm-marker-check", NS).catch(() => {});

    // 4. Claim: mount the same PVC in a fresh pod over the same image and prove the warmed path is valid.
    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "warm-claim", namespace: NS, labels: { app: "warm-claim" } },
      spec: {
        containers: [
          {
            name: "sandbox",
            image: IMAGE,
            imagePullPolicy: PULL_POLICY,
            securityContext: { privileged: true },
            volumeMounts: [
              { name: "up", mountPath: UPPER },
              { name: "run", mountPath: "/run" },
              { name: "tmp", mountPath: "/tmp" },
            ],
          },
        ],
        volumes: [
          { name: "up", persistentVolumeClaim: { claimName: pvc } },
          { name: "run", emptyDir: { medium: "Memory" } },
          { name: "tmp", emptyDir: { medium: "Memory" } },
        ],
      },
    });
    await cluster.waitFor<{ status: { phase: string } }>(
      "Pod",
      "warm-claim",
      (p) => p.status?.phase === "Running",
      180_000,
      NS,
    );
    // Wait for overlay-store-setup to re-mount the warmed upper over the same lower.
    for (let i = 0; i < 60; i++) {
      const s = await cluster.exec("app=warm-claim", ["systemctl", "is-active", "overlay-store-setup.service"], NS);
      if (s.stdout.trim() === "active") break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    // The warmed golden path is valid in the remounted store with no re-register.
    const found = await cluster.exec(
      "app=warm-claim",
      ["sh", "-c", `ls -d ${UPPER}/upper/*-warm-canary 2>/dev/null | head -1`],
      NS,
    );
    const upperPath = found.stdout.trim().split("\n").pop() ?? "";
    expect(upperPath, "the golden path is in the overlay upper").toMatch(/-warm-canary$/);
    const storePath = "/nix/store/" + upperPath.split("/").pop();
    const info = await cluster.exec("app=warm-claim", ["nix", "path-info", storePath], NS);
    expect(info.exitCode, "warmed path valid in the remounted store (no fixup)").toBe(0);
    // Its content reads back through the merged view.
    const content = await cluster.exec("app=warm-claim", ["cat", storePath], NS);
    expect(content.stdout.trim()).toBe("warmed");
  }, 600_000);

  it("two concurrent reservations race for one idle PV → the claimRef CAS lets exactly one win", async () => {
    const pv = `warm-store-cas-${Date.now()}`;
    await cluster.apply({
      apiVersion: "v1",
      kind: "PersistentVolume",
      metadata: { name: pv, labels: { [LBL.warm]: TAG, "scooter.io/pool": "warm" } },
      spec: {
        capacity: { storage: "1Gi" },
        accessModes: ["ReadWriteOnce"],
        persistentVolumeReclaimPolicy: "Retain",
        storageClassName: "warm-store-cas-test",
        hostPath: { path: `/tmp/${pv}` },
      },
    });
    // Wait out the PV controller's Available write; it bumps resourceVersion.
    const before = await cluster.waitFor<{ metadata: { resourceVersion: string }; status?: { phase?: string } }>(
      "PersistentVolume",
      pv,
      (p) => p.status?.phase === "Available",
      60_000,
    );

    // Both send ControllerK8s.reserve's patch from one stale view.
    const reserve = (sandbox: string) =>
      cluster.mergePatchPv(pv, {
        metadata: { resourceVersion: before.metadata.resourceVersion },
        spec: { claimRef: { apiVersion: "v1", kind: "PersistentVolumeClaim", namespace: NS, name: `scooter-rw-${sandbox}` } },
      });

    const results = await Promise.allSettled([reserve("conv-a"), reserve("conv-b")]);
    expect(results.filter((r) => r.status === "fulfilled").length, "exactly one reservation wins").toBe(1);
    expect(results.filter((r) => r.status === "rejected").length, "the other gets a 409").toBe(1);

    const after = await cluster.get<{ spec: { claimRef?: { name: string } } }>("PersistentVolume", pv);
    expect(["scooter-rw-conv-a", "scooter-rw-conv-b"]).toContain(after.spec.claimRef?.name);
    await cluster.mergePatchPv(pv, { spec: { claimRef: null } }).catch(() => {});
  }, 120_000);
});
