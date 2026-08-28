/**
 * Tier 1 contract — create()'s ADOPT-EXISTING (409) branch HEALS a dead warm-store claim,
 * exactly like resume() does.
 *
 * THE GAP (sibling of the resume-heal incident, odin 2026-08-22). resume() was taught to
 * re-bind a GC'd warm-store claim before waking a suspended sandbox (see
 * provisioner-resume-heal.spec.ts). But resume() is NOT the only path that flips a suspended
 * Sandbox back to Running: create()'s 409-adopt branch does too. When a boot reconcile fails
 * to see a conversation, the next prompt takes the create() path, hits a 409 (the Sandbox
 * still exists), adopts it, and flips operatingMode=Running. If that adopted spec references a
 * pool volume the warm-store controller has since GC'd, a plain mode flip strands the pod
 * Pending forever — the identical silent-never-wakes failure, on the adopt path.
 *
 * DECISION: the adopt branch shares resume()'s heal. These tests drive create() into the 409
 * adopt path and assert the same re-bind + fail-open guarantees.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

type Vol = { name: string; persistentVolumeClaim?: { claimName: string } };

/** One union API stub: SA create + Sandbox create/get/patch + PVC read/list/patch/create. */
function fakeKc(opts: {
  sandboxAlreadyExists?: boolean;  // Sandbox create 409s -> the adopt path
  volumes?: Vol[];                 // the adopted Sandbox spec's podTemplate volumes
  pvcExists?: boolean;             // does the referenced warm-store PVC still exist?
  pvcReadError?: number;           // non-404 error code for the PVC read probe
  pvcLabels?: Record<string, string>; // labels on the referenced PVC (ownership check)
  pvcDeleting?: boolean;           // PVC exists but has a deletionTimestamp (TERMINATING)
  poolReady?: string[];            // ready current-tag pool PVC names
}) {
  const sandboxPatches: Array<Record<string, unknown>> = [];
  const pvcCreates: string[] = [];
  const pvcPatches: string[] = [];
  const api = {
    createNamespacedServiceAccount: async () => ({}),
    createNamespacedCustomObject: async () => {
      if (opts.sandboxAlreadyExists) throw Object.assign(new Error("exists"), { code: 409 });
      return {};
    },
    getNamespacedCustomObject: async () => ({
      spec: { podTemplate: { spec: { volumes: opts.volumes ?? [] } } },
    }),
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
    listNamespacedPersistentVolumeClaim: async () => ({
      items: (opts.poolReady ?? []).map((name) => ({ metadata: { name, labels: {} } })),
    }),
    patchNamespacedPersistentVolumeClaim: async (params: { name: string }) => {
      pvcPatches.push(params.name);
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
    // overlayStore/warmStorePool OFF so the initial create attempt does NOT itself claim a pool
    // volume — the only PVC activity in these tests comes from the heal path we're exercising.
    kubeConfig: kc,
  });

const WARM = (claim: string): Vol => ({ name: "scooter-rw", persistentVolumeClaim: { claimName: claim } });

const modePatches = (ps: Array<Record<string, unknown>>) =>
  ps.filter((b) => JSON.stringify(b).includes("operatingMode"));
const volumePatches = (ps: Array<Record<string, unknown>>) =>
  ps.filter((b) => JSON.stringify(b).includes("volumes"));

describe("k8sProvisioner.create — adopt-existing warm-store heal", () => {
  it("THE REGRESSION: adopting a suspended Sandbox with a MISSING warm-store claim re-binds it before waking", async () => {
    const { kc, sandboxPatches, pvcPatches } = fakeKc({
      sandboxAlreadyExists: true,
      volumes: [WARM("warm-store-scooter-git-c302957-t6656")],
      pvcExists: false,
      poolReady: ["warm-store-scooter-git-9312b26-sxddp"],
    });
    await provisioner(kc).create("toeurt");

    // A fresh pool volume was CAS-claimed...
    expect(pvcPatches).toContain("warm-store-scooter-git-9312b26-sxddp");
    // ...the adopted Sandbox spec was re-pointed at it (else Pending forever)...
    const vp = volumePatches(sandboxPatches);
    expect(vp, "the adopted spec must be re-bound before the mode flip").toHaveLength(1);
    expect(JSON.stringify(vp[0])).toContain("warm-store-scooter-git-9312b26-sxddp");
    expect(JSON.stringify(vp[0])).not.toContain("c302957");
    // ...and the mode flip to Running still happened.
    expect(modePatches(sandboxPatches)).toHaveLength(1);
  });

  it("an EMPTY pool falls back to CREATING a fresh upper — adopt never yields an unschedulable pod", async () => {
    const { kc, sandboxPatches, pvcCreates } = fakeKc({
      sandboxAlreadyExists: true,
      volumes: [WARM("warm-store-scooter-git-c302957-t6656")],
      pvcExists: false,
      poolReady: [],
    });
    await provisioner(kc).create("toeurt");

    expect(pvcCreates).toHaveLength(1);
    const vp = volumePatches(sandboxPatches);
    expect(vp).toHaveLength(1);
    expect(JSON.stringify(vp[0])).toContain(pvcCreates[0]);
    expect(modePatches(sandboxPatches)).toHaveLength(1);
  });

  it("a HEALTHY claim on the adopted sandbox is left alone (only the mode flip runs)", async () => {
    const { kc, sandboxPatches, pvcCreates } = fakeKc({
      sandboxAlreadyExists: true,
      volumes: [WARM("warm-store-scooter-git-9312b26-live")],
      pvcExists: true,
      pvcLabels: { "scooter.io/pool-state": "claimed", "scooter.io/claimed-by": "conv-toeurt" },
    });
    await provisioner(kc).create("toeurt");
    expect(volumePatches(sandboxPatches)).toHaveLength(0);
    expect(pvcCreates).toHaveLength(0);
    expect(modePatches(sandboxPatches)).toHaveLength(1);
  });

  it("THE OWNERSHIP GUARANTEE: a PVC claimed by ANOTHER sandbox is NEVER adopted — re-bind", async () => {
    const { kc, sandboxPatches } = fakeKc({
      sandboxAlreadyExists: true,
      volumes: [WARM("warm-store-scooter-git-9312b26-p1")],
      pvcExists: true,
      pvcLabels: { "scooter.io/pool-state": "claimed", "scooter.io/claimed-by": "conv-somebody-else" },
      poolReady: ["warm-store-scooter-git-9312b26-fresh"],
    });
    await provisioner(kc).create("toeurt");

    const vp = volumePatches(sandboxPatches);
    expect(vp, "must re-bind away from the contested volume").toHaveLength(1);
    expect(JSON.stringify(vp[0])).toContain("warm-store-scooter-git-9312b26-fresh");
    expect(JSON.stringify(vp[0])).not.toContain("-p1");
    expect(modePatches(sandboxPatches)).toHaveLength(1);
  });

  it("THE DOMINANT LIVE VARIANT: adopting a sandbox whose claim is TERMINATING (deletionTimestamp, labelled OURS) re-binds it", async () => {
    // The failure that actually keeps recurring: "persistentvolumeclaim … is being deleted"
    // (3 of 4 live wedges), not a clean 404. A terminating PVC reads 200 with claimed-by ==
    // self, so an ownership-only probe would adopt it and Pending the pod forever. The adopt
    // branch shares the heal, so deletionTimestamp must beat ownership here too.
    const { kc, sandboxPatches } = fakeKc({
      sandboxAlreadyExists: true,
      volumes: [WARM("warm-store-scooter-git-9312b26-term")],
      pvcExists: true,
      pvcDeleting: true,
      pvcLabels: { "scooter.io/pool-state": "claimed", "scooter.io/claimed-by": "conv-toeurt" },
      poolReady: ["warm-store-scooter-git-9312b26-fresh"],
    });
    await provisioner(kc).create("toeurt");

    const vp = volumePatches(sandboxPatches);
    expect(vp, "a terminating claim must be re-bound, not adopted").toHaveLength(1);
    expect(JSON.stringify(vp[0])).toContain("warm-store-scooter-git-9312b26-fresh");
    expect(JSON.stringify(vp[0])).not.toContain("-term");
    expect(modePatches(sandboxPatches)).toHaveLength(1);
  });

  it("A FRESH create (no 409) neither heals nor flips the mode — a new Sandbox is already Running", async () => {
    const { kc, sandboxPatches, pvcCreates } = fakeKc({
      sandboxAlreadyExists: false,
      volumes: [WARM("warm-store-scooter-git-c302957-t6656")],
      pvcExists: false,
    });
    await provisioner(kc).create("brandnew");
    expect(volumePatches(sandboxPatches)).toHaveLength(0);
    expect(modePatches(sandboxPatches)).toHaveLength(0);
    expect(pvcCreates).toHaveLength(0);
  });

  // FAIL-CLOSED on the adopt path too — same reasoning as resume (see that spec): an
  // unverifiable claim must not be woken onto. create() throws, so the caller learns the
  // conversation could not be started instead of watching a pod Pend forever.
  it("FAIL-CLOSED: an unverifiable PVC probe (non-404) throws and does NOT flip the adopted sandbox", async () => {
    const { kc, sandboxPatches } = fakeKc({
      sandboxAlreadyExists: true,
      volumes: [WARM("warm-store-scooter-git-9312b26-live")],
      pvcReadError: 503,
    });
    await expect(provisioner(kc).create("blip")).rejects.toMatchObject({ code: 503 });
    expect(volumePatches(sandboxPatches)).toHaveLength(0);
    expect(modePatches(sandboxPatches)).toHaveLength(0);
  });
});
