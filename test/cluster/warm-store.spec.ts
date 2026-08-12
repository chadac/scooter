/**
 * Tier 2 — the warm /nix/store PVC pool, on a real cluster. Proves the two NOVEL
 * mechanisms the pool adds (the store round-trip + the concurrent-claim CAS) end to end;
 * the pure reconcile decisions are covered by the controller's Tier-1 tests.
 *
 *   1. WARM ROUND-TRIP (the payoff + the de-risked core): a warm Job boots the sandbox
 *      image against a fresh PVC, its scooter-warm-store-seed unit builds the golden expr
 *      INTO the overlay upper (lands in upper/, registered in state/), stamps the
 *      clean-shutdown marker, and powers off. We then mount the SAME PVC in a fresh pod
 *      (a "claim") over the SAME image → the warmed path is VALID with NO fixup + the
 *      clean marker is present. This is the version-keyed "init once, reuse as-is" claim.
 *
 *   2. CLAIM CAS: two concurrent claimers racing for one `ready` PVC → exactly one wins
 *      the resourceVersion-guarded label flip; the other gets 409 (→ falls back to a
 *      fresh upper). Guards the cross-replica single-attach invariant.
 *
 * Self-sufficient (own namespace, applies its own PVCs/Job/pods — no platform needed).
 * Gated: RUN_CLUSTER_TESTS=1. Image: OVERLAY_IMAGE (defaults to the sole sandbox image,
 * which always has the overlay store on). Skipped if unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;

const NS = "warm-store-test";
const IMAGE = process.env.OVERLAY_IMAGE ?? "agent-sandbox-os:latest";
// "Never" for a side-loaded local cluster (k3d/kind); "IfNotPresent"/"Always" for a
// registry-backed one (odin). Default Never — the CI image-boot job side-loads.
const PULL_POLICY = process.env.OVERLAY_PULL_POLICY ?? "Never";
// A stable pool tag for the test (the real controller uses the image content tag).
const TAG = "test-tag";
const UPPER = "/nix/.scooter-rw";
// A trivial, OFFLINE derivation (builder /bin/sh is in the closure) — the golden "tool".
const GOLDEN_EXPR =
  `--impure --expr 'derivation { name = "warm-canary"; system = builtins.currentSystem; ` +
  `builder = "/bin/sh"; args = [ "-c" "echo warmed > $out" ]; }'`;

const LBL = {
  warm: "scooter.io/warm-store",
  state: "scooter.io/pool-state",
  claimedBy: "scooter.io/claimed-by",
};

maybe("warm /nix/store PVC pool (round-trip + claim CAS)", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });
    await cluster
      .apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } })
      .catch(() => {});
  }, 60_000);

  afterAll(async () => {
    // Best-effort cleanup of the pods the spec created (PVCs/Jobs left for inspection).
    await cluster.deletePod("warm-claim", NS).catch(() => {});
    await cluster.deletePod("warm-marker-check", NS).catch(() => {});
  });

  it("a warm Job builds the golden expr INTO the overlay upper, then a fresh claim finds it valid (no fixup)", async () => {
    const pvc = "warm-store-roundtrip";
    // 1. a fresh RWO pool PVC.
    await cluster.apply({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: pvc, namespace: NS, labels: { [LBL.warm]: TAG, [LBL.state]: "warming" } },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "5Gi" } } },
    });

    // 2. the warm Job: initContainer writes .warm-request (the golden expr) → the sandbox
    //    container boots systemd → scooter-warm-store-seed builds it into the overlay,
    //    stamps the marker, poweroffs. Mirrors k8s.py _warm_job_manifest.
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
                securityContext: { privileged: true }, // dev cluster: systemd + overlay mounts
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

    // 3. wait for the Job to complete (the seed built + poweroff'd).
    await cluster.waitFor<{ status?: { succeeded?: number } }>(
      "Job",
      "warm-roundtrip",
      (j) => (j.status?.succeeded ?? 0) >= 1,
      300_000,
      NS,
    );

    // 3b. the clean-shutdown marker the warm seed stamped must be present ON THE PVC now
    //     (before any claim pod boots — a claim clears it at boot for its own session). This
    //     is exactly what the controller's read_clean_marker checks to decide a clean return.
    //     A short-lived reader pod RO-mounts the PVC and tests the file (like read_clean_marker).
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

    // 4. CLAIM: mount the SAME PVC in a fresh pod over the SAME image (no fixup) and prove
    //    the warmed path is valid (the payoff). The claim pod clears the marker at boot for
    //    its own session — expected, so we don't re-check the marker here.
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
    // overlay-store-setup must have re-mounted the warmed upper over the same lower.
    for (let i = 0; i < 60; i++) {
      const s = await cluster.exec("app=warm-claim", ["systemctl", "is-active", "overlay-store-setup.service"], NS);
      if (s.stdout.trim() === "active") break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    // The warmed golden path is VALID in the remounted store with NO re-register — the
    // "no fixup" payoff. Find it in the upper, then `nix path-info` it through the store.
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
    // (c) and it RUNS / reads back its content through the merged view.
    const content = await cluster.exec("app=warm-claim", ["cat", storePath], NS);
    expect(content.stdout.trim()).toBe("warmed");
  }, 600_000);

  it("two concurrent claimers race for one ready PVC → exactly one wins the CAS", async () => {
    const pvc = "warm-store-cas";
    await cluster.apply({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: pvc, namespace: NS, labels: { [LBL.warm]: TAG, [LBL.state]: "ready" } },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } },
    });

    // Fire TWO claims concurrently, each a JSON-patch `test pool-state==ready` + flip — the
    // exact optimistic CAS claimWarmStorePvc does. Exactly one wins; the other's `test` fails.
    const claim = (who: string) =>
      cluster.patchPvcLabelsCAS(pvc, NS, LBL.state, "ready", {
        [LBL.state]: "claimed",
        [LBL.claimedBy]: who,
      });

    const results = await Promise.allSettled([claim("conv-a"), claim("conv-b")]);
    const won = results.filter((r) => r.status === "fulfilled").length;
    const lost = results.filter((r) => r.status === "rejected").length;
    expect(won, "exactly one claimer wins").toBe(1);
    expect(lost, "the other loses the CAS (test-op 422)").toBe(1);

    // The PVC ends up claimed by exactly one of them.
    const after = await cluster.get<{ metadata: { labels: Record<string, string> } }>(
      "PersistentVolumeClaim",
      pvc,
      NS,
    );
    expect(after.metadata.labels[LBL.state]).toBe("claimed");
    expect(["conv-a", "conv-b"]).toContain(after.metadata.labels[LBL.claimedBy]);
  }, 120_000);
});
