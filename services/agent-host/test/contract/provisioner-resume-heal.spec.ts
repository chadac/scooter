/**
 * Tier 1 contract — resume() HEALS a warm-store claim that no longer exists.
 *
 * THE INCIDENT (odin, 2026-08-22). A suspended sandbox's spec referenced
 * `warm-store-scooter-git-c302957-t6656` — a pooled PVC from an OLD image version that the
 * warm-store pool had since reclaimed. resume() only flips operatingMode, so the controller
 * recreated the pod pointing at a PVC that does not exist: Pending forever, no error surfaced
 * anywhere, the conversation simply never woke. 28 more suspended sandboxes on odin reference
 * GC'd volumes from nine old versions — every one of them was a silent revive time bomb.
 *
 * DECISION (locked): heal on resume. The warm volume is a CACHE of /nix/store (the workspace
 * PVC holds the real work); its contents are already gone whatever we do. So resume() checks
 * the claim and, when the PVC is missing, re-binds: claim a fresh current-version pool volume,
 * or create a plain upper if the pool has none. Resume must NEVER produce a pod that cannot
 * schedule, and must never fail outright for a heal-path error (fail-open to the plain flip —
 * a revive that comes up degraded beats one that hangs).
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

type Vol = { name: string; persistentVolumeClaim?: { claimName: string } };

/** One union API stub: Sandbox get/patch + PVC read/list/patch/create. */
function fakeKc(opts: {
  volumes?: Vol[];                 // the Sandbox spec's podTemplate volumes
  pvcExists?: boolean;             // does the referenced warm-store PVC still exist?
  pvcReadError?: number;           // non-404 error code for the PVC read probe
  pvcLabels?: Record<string, string>; // labels on the referenced PVC (ownership check)
  pvcDeleting?: boolean;           // PVC exists but has a deletionTimestamp (TERMINATING)
  casFailsFor?: string;            // CAS patches on THIS pvc name lose the race (422)
  poolReady?: string[];            // ready current-tag pool PVC names
  sandboxGetError?: number;        // fail the Sandbox read itself
  poolListError?: number;          // fail the pool LIST (option 3) — an unreadable pool, not a cold one
}) {
  const sandboxPatches: Array<Record<string, unknown>> = [];
  const pvcCreates: string[] = [];
  const pvcPatches: string[] = [];
  const api = {
    getNamespacedCustomObject: async () => {
      if (opts.sandboxGetError) throw Object.assign(new Error("api"), { code: opts.sandboxGetError });
      return { spec: { podTemplate: { spec: { volumes: opts.volumes ?? [] } } } };
    },
    patchNamespacedCustomObject: async (params: { body?: unknown }) => {
      sandboxPatches.push(params.body as Record<string, unknown>);
      return {};
    },
    readNamespacedPersistentVolumeClaim: async () => {
      if (opts.pvcReadError) throw Object.assign(new Error("api"), { code: opts.pvcReadError });
      if (!opts.pvcExists) throw Object.assign(new Error("not found"), { code: 404 });
      return {
        metadata: {
          labels: opts.pvcLabels ?? {},
          // A TERMINATING PVC still READS 200 (a finalizer holds it) — the deletionTimestamp
          // is the only signal it is going away.
          ...(opts.pvcDeleting ? { deletionTimestamp: "2026-08-27T23:00:00Z" } : {}),
        },
      };
    },
    listNamespacedPersistentVolumeClaim: async () => {
      if (opts.poolListError) throw Object.assign(new Error("api"), { code: opts.poolListError });
      return { items: (opts.poolReady ?? []).map((name) => ({ metadata: { name, labels: {} } })) };
    },
    patchNamespacedPersistentVolumeClaim: async (params: { name: string; body?: unknown }) => {
      pvcPatches.push(params.name); // the CAS claim / last-used stamp
      // A JSON-patch body with a `test` op models the CAS; casFailsFor makes the CAS on
      // that ONE pvc lose (a fresh-pool claim on a different pvc still wins).
      if (opts.casFailsFor === params.name && Array.isArray(params.body)) {
        throw Object.assign(new Error("test failed"), { code: 422 });
      }
      return {};
    },
    createNamespacedPersistentVolumeClaim: async (params: { body: { metadata: { name: string } } }) => {
      pvcCreates.push(params.body.metadata.name);
      return {};
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, sandboxPatches, pvcCreates, pvcPatches };
}

const provisioner = (kc: never) =>
  createK8sProvisioner({
    namespace: "ns",
    sandboxImage: "reg/sandbox:scooter-git-9312b26",
    overlayStore: true,
    warmStorePool: true,
    kubeConfig: kc,
  });

const WARM = (claim: string): Vol => ({ name: "scooter-rw", persistentVolumeClaim: { claimName: claim } });

/** The operatingMode patches vs the volume-rebind patches, told apart by body shape. */
const modePatches = (ps: Array<Record<string, unknown>>) =>
  ps.filter((b) => JSON.stringify(b).includes("operatingMode"));
const volumePatches = (ps: Array<Record<string, unknown>>) =>
  ps.filter((b) => JSON.stringify(b).includes("volumes"));

describe("k8sProvisioner.resume — warm-store heal", () => {
  it("THE REGRESSION: a MISSING warm-store claim is re-bound to a fresh pool volume", async () => {
    const { kc, sandboxPatches, pvcPatches } = fakeKc({
      volumes: [WARM("warm-store-scooter-git-c302957-t6656")],
      pvcExists: false,
      poolReady: ["warm-store-scooter-git-9312b26-sxddp"],
    });
    await provisioner(kc).resume({ name: "conv-toeurt", namespace: "ns" });

    // A pool volume was claimed (the CAS patch ran)...
    expect(pvcPatches).toContain("warm-store-scooter-git-9312b26-sxddp");
    // ...the Sandbox volume was re-pointed at it...
    const vp = volumePatches(sandboxPatches);
    expect(vp, "the Sandbox spec must be re-bound — else the pod Pendings forever").toHaveLength(1);
    expect(JSON.stringify(vp[0])).toContain("warm-store-scooter-git-9312b26-sxddp");
    expect(JSON.stringify(vp[0])).not.toContain("c302957");
    // ...and the mode flip still happened.
    expect(modePatches(sandboxPatches)).toHaveLength(1);
  });

  it("an EMPTY pool falls back to CREATING a fresh upper PVC — resume never yields an unschedulable pod", async () => {
    const { kc, sandboxPatches, pvcCreates } = fakeKc({
      volumes: [WARM("warm-store-scooter-git-c302957-t6656")],
      pvcExists: false,
      poolReady: [],
    });
    await provisioner(kc).resume({ name: "conv-toeurt", namespace: "ns" });

    expect(pvcCreates).toHaveLength(1);
    const vp = volumePatches(sandboxPatches);
    expect(vp).toHaveLength(1);
    expect(JSON.stringify(vp[0])).toContain(pvcCreates[0]);
  });

  it("a HEALTHY claim (exists AND claimed by THIS sandbox) is left alone", async () => {
    const { kc, sandboxPatches, pvcCreates } = fakeKc({
      volumes: [WARM("warm-store-scooter-git-9312b26-live")],
      pvcExists: true,
      pvcLabels: { "scooter.io/pool-state": "claimed", "scooter.io/claimed-by": "conv-ok" },
    });
    await provisioner(kc).resume({ name: "conv-ok", namespace: "ns" });
    expect(volumePatches(sandboxPatches)).toHaveLength(0);
    expect(pvcCreates).toHaveLength(0);
    expect(modePatches(sandboxPatches)).toHaveLength(1);
  });

  it("THE OWNERSHIP GUARANTEE: a PVC claimed by ANOTHER sandbox is NEVER mounted — re-bind", async () => {
    // Return-on-suspend makes this the NORMAL path, not an edge: a cleanly-suspended
    // sandbox's PVC goes back to the pool (`ready`, claimed-by cleared) and another
    // sandbox can CAS-claim it. The suspended spec still NAMES it, and RWO does not stop
    // a same-node double-mount — two overlay uppers on one disk is store corruption.
    // Existence is not ownership: resume must verify claimed-by == self.
    const { kc, sandboxPatches } = fakeKc({
      volumes: [WARM("warm-store-scooter-git-9312b26-p1")],
      pvcExists: true,
      pvcLabels: { "scooter.io/pool-state": "claimed", "scooter.io/claimed-by": "conv-somebody-else" },
      poolReady: ["warm-store-scooter-git-9312b26-fresh"],
    });
    await provisioner(kc).resume({ name: "conv-toeurt", namespace: "ns" });

    const vp = volumePatches(sandboxPatches);
    expect(vp, "must re-bind away from the contested volume").toHaveLength(1);
    expect(JSON.stringify(vp[0])).toContain("warm-store-scooter-git-9312b26-fresh");
    expect(JSON.stringify(vp[0])).not.toContain("-p1");
    expect(modePatches(sandboxPatches)).toHaveLength(1);
  });

  it("THE DOMINANT LIVE VARIANT: a TERMINATING claim (exists, deletionTimestamp set, labelled OURS) is re-bound, never mounted", async () => {
    // 3 of 4 live wedges one evening said "persistentvolumeclaim … is being deleted", only 1
    // a plain "not found". A PVC with a deletionTimestamp still READS 200 with its labels
    // intact (a finalizer holds it), so a probe that keys on 404 alone would see claimed-by ==
    // self, call it "ours", and bind a pod that can NEVER schedule. deletionTimestamp must beat
    // ownership: a claim that is GOING is as lost as one that is GONE.
    const { kc, sandboxPatches } = fakeKc({
      volumes: [WARM("warm-store-scooter-git-9312b26-term")],
      pvcExists: true,
      pvcDeleting: true,
      pvcLabels: { "scooter.io/pool-state": "claimed", "scooter.io/claimed-by": "conv-toeurt" },
      poolReady: ["warm-store-scooter-git-9312b26-fresh"],
    });
    await provisioner(kc).resume({ name: "conv-toeurt", namespace: "ns" });

    const vp = volumePatches(sandboxPatches);
    expect(vp, "a terminating claim must be re-bound, not adopted").toHaveLength(1);
    expect(JSON.stringify(vp[0])).toContain("warm-store-scooter-git-9312b26-fresh");
    expect(JSON.stringify(vp[0])).not.toContain("-term");
    expect(modePatches(sandboxPatches)).toHaveLength(1);
  });

  it("a TERMINATING claim labelled RECLAIMABLE (ready/unclaimed) is still re-bound, NOT CAS-reclaimed", async () => {
    // deletionTimestamp is checked before the reclaimable branch, so we never CAS-win a volume
    // that is being deleted (winning it would just re-strand the pod).
    const { kc, sandboxPatches, pvcPatches } = fakeKc({
      volumes: [WARM("warm-store-scooter-git-9312b26-term2")],
      pvcExists: true,
      pvcDeleting: true,
      pvcLabels: { "scooter.io/pool-state": "ready" },
      poolReady: ["warm-store-scooter-git-9312b26-fresh"],
    });
    await provisioner(kc).resume({ name: "conv-toeurt", namespace: "ns" });

    // No CAS on the terminating volume itself...
    expect(pvcPatches).not.toContain("warm-store-scooter-git-9312b26-term2");
    // ...re-bound to a fresh one instead.
    const vp = volumePatches(sandboxPatches);
    expect(vp).toHaveLength(1);
    expect(JSON.stringify(vp[0])).toContain("warm-store-scooter-git-9312b26-fresh");
    expect(modePatches(sandboxPatches)).toHaveLength(1);
  });

  it("a RETURNED-but-unclaimed PVC is CAS re-claimed IN PLACE — the sandbox gets its own store back", async () => {
    // The self-enriching pool returned this volume on suspend and nobody took it: the best
    // outcome is to win it back (same claimName, installs intact) rather than grab a fresh one.
    const { kc, sandboxPatches, pvcPatches } = fakeKc({
      volumes: [WARM("warm-store-scooter-git-9312b26-p1")],
      pvcExists: true,
      pvcLabels: { "scooter.io/pool-state": "ready" },
    });
    await provisioner(kc).resume({ name: "conv-toeurt", namespace: "ns" });

    expect(pvcPatches).toContain("warm-store-scooter-git-9312b26-p1"); // the CAS ran on IT
    expect(volumePatches(sandboxPatches), "same claimName — no re-point needed").toHaveLength(0);
    expect(modePatches(sandboxPatches)).toHaveLength(1);
  });

  it("losing the re-claim CAS race falls through to a fresh re-bind (never a shared mount)", async () => {
    // Between the label read and the CAS, another creator claimed it. The 422 is the race
    // telling us we lost — take a different volume.
    const { kc, sandboxPatches } = fakeKc({
      volumes: [WARM("warm-store-scooter-git-9312b26-p1")],
      pvcExists: true,
      pvcLabels: { "scooter.io/pool-state": "ready" },
      casFailsFor: "warm-store-scooter-git-9312b26-p1",
      poolReady: ["warm-store-scooter-git-9312b26-fresh"],
    });
    await provisioner(kc).resume({ name: "conv-toeurt", namespace: "ns" });
    const vp = volumePatches(sandboxPatches);
    expect(vp).toHaveLength(1);
    expect(JSON.stringify(vp[0])).toContain("-fresh");
  });

  it("a sandbox with NO warm-store volume (fresh-vct shape) is untouched", async () => {
    const { kc, sandboxPatches } = fakeKc({ volumes: [{ name: "workspace" }] as Vol[] });
    await provisioner(kc).resume({ name: "conv-vct", namespace: "ns" });
    expect(volumePatches(sandboxPatches)).toHaveLength(0);
    expect(modePatches(sandboxPatches)).toHaveLength(1);
  });

  // FAIL-CLOSED. These previously asserted fail-OPEN: a probe error swallowed, the mode
  // flipped anyway. That is what turns an outage into a silent Pending pod — the wake
  // "succeeds", the conversation never comes back, and nothing surfaces. We cannot tell a
  // transient blip from a real one, so we must not GUESS that the volume is fine: waking
  // onto a claim we could not verify is the exact failure this whole path exists to prevent.
  // Throw instead, so resume() fails and the error reaches the caller (and the UI).

  it("FAIL-CLOSED: an unverifiable PVC probe (non-404) throws instead of waking blind", async () => {
    const { kc, sandboxPatches } = fakeKc({
      volumes: [WARM("warm-store-scooter-git-9312b26-live")],
      pvcReadError: 503,
    });
    await expect(provisioner(kc).resume({ name: "conv-blip", namespace: "ns" })).rejects.toMatchObject({ code: 503 });
    // Critically: the mode was NOT flipped — no pod is created against an unverified claim.
    expect(modePatches(sandboxPatches)).toHaveLength(0);
    expect(volumePatches(sandboxPatches)).toHaveLength(0);
  });

  it("FAIL-CLOSED: a failed Sandbox read throws and does NOT flip the mode", async () => {
    const { kc, sandboxPatches } = fakeKc({ sandboxGetError: 500 });
    await expect(provisioner(kc).resume({ name: "conv-x", namespace: "ns" })).rejects.toMatchObject({ code: 500 });
    expect(modePatches(sandboxPatches)).toHaveLength(0);
  });

  it("FAIL-CLOSED: exhausting every option (pool unreadable) throws rather than waking", async () => {
    // Own claim is GONE (404) -> option 3 (any ready pool volume) errors -> nothing left.
    // The cycle must surface that, not quietly wake onto a claim that does not exist.
    const { kc, sandboxPatches } = fakeKc({
      volumes: [WARM("warm-store-scooter-git-9312b26-gone")],
      pvcReadError: 404,
      poolListError: 503,
    });
    await expect(provisioner(kc).resume({ name: "conv-dry", namespace: "ns" })).rejects.toMatchObject({ code: 503 });
    expect(modePatches(sandboxPatches)).toHaveLength(0);
  });
});
