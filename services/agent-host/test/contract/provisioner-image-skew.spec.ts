/**
 * A Sandbox left on a previous platform version's image is reconciled onto the current
 * one in a single cycle. A Sandbox CR is rendered once at conversation-create time and a
 * platform upgrade touches no Sandbox, so resume and adoption patch the image themselves.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

interface FakeOpts {
  /** The image the existing Sandbox carries (undefined means no container at all). */
  image?: string;
  operatingMode?: string;
  /** Sandbox creation 409s because the conversation's Sandbox already exists. */
  conflict?: boolean;
  /** How many pod polls still report the old pod before it disappears. */
  podsLive?: number;
}

function fakeKc(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  let podsLive = opts.podsLive ?? 0;
  const api = {
    createNamespacedServiceAccount: async () => ({}),
    createNamespacedCustomObject: async () => {
      calls.push("create:sandbox");
      if (opts.conflict) throw Object.assign(new Error("exists"), { code: 409 });
      return {};
    },
    getNamespacedCustomObject: async () => ({
      spec: {
        operatingMode: opts.operatingMode ?? "Running",
        podTemplate: { spec: { containers: opts.image ? [{ name: "sandbox", image: opts.image }] : [] } },
      },
    }),
    patchNamespacedCustomObject: async (args: { body: Record<string, unknown> }) => {
      calls.push("patch");
      patches.push(args.body);
      return {};
    },
    listNamespacedPod: async () => {
      calls.push("pods");
      return { items: podsLive-- > 0 ? [{ metadata: { name: "conv-abc", uid: "old" } }] : [] };
    },
    deleteNamespacedPod: async () => {
      calls.push("delete:pod");
      return {};
    },
    readNamespacedPod: async () => {
      throw Object.assign(new Error("nf"), { code: 404 });
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, calls, patches };
}

const provisioner = (kc: never, updatePolicy?: "deferred" | "immediate") =>
  createK8sProvisioner({ namespace: "agent-manager", sandboxImage: "sandbox-os:new", kubeConfig: kc, updatePolicy });

/** The container images carried by the recorded patch bodies. */
const patchedImages = (patches: Array<Record<string, unknown>>) =>
  patches.flatMap((b) => {
    const spec = b.spec as { podTemplate?: { spec?: { containers?: Array<{ image?: string }> } } };
    return (spec.podTemplate?.spec?.containers ?? []).map((c) => c.image);
  });

/** The operatingMode values, in order, that the recorded patches set. */
const patchedModes = (patches: Array<Record<string, unknown>>) =>
  patches
    .map((b) => (b.spec as { operatingMode?: string }).operatingMode)
    .filter((m): m is string => Boolean(m));

const ref = { name: "conv-abc", namespace: "agent-manager" };

describe("k8sProvisioner — sandbox image skew after a platform upgrade", () => {
  it("resume adopts the current image, so ONE suspend/resume is enough", async () => {
    const { kc, patches } = fakeKc({ image: "sandbox-os:old", operatingMode: "Suspended" });
    await provisioner(kc).resume(ref);
    // The image is reconciled first; the flip to Running then brings the pod up on it.
    expect(patchedImages(patches)).toEqual(["sandbox-os:new"]);
    expect(patchedModes(patches)).toEqual(["Running"]);
  });

  it("a RUNNING sandbox on a stale image keeps its pod by default, recording the pending update", async () => {
    const { kc, calls, patches } = fakeKc({ image: "sandbox-os:old", operatingMode: "Running", podsLive: 1 });
    expect(await provisioner(kc).resume(ref)).toEqual({ ...ref, updatePending: true });
    expect(patchedImages(patches)).toEqual(["sandbox-os:new"]);
    expect(calls).not.toContain("delete:pod");
    const annotations = (patches[0].metadata as { annotations: Record<string, string> }).annotations;
    expect(JSON.parse(annotations["scooter.io/pending-template"])).toEqual({ podUid: "old", fromImage: "sandbox-os:old", changed: ["container.image"] });
  });

  it("with the immediate policy, a RUNNING sandbox on a stale image has its pod replaced", async () => {
    const { kc, calls, patches } = fakeKc({ image: "sandbox-os:old", operatingMode: "Running", podsLive: 1 });
    await provisioner(kc, "immediate").resume(ref);
    expect(patchedImages(patches)).toEqual(["sandbox-os:new"]);
    // Deleted, not suspended; the old pod is waited out.
    expect(patchedModes(patches)).toEqual(["Running"]);
    expect(calls).toContain("delete:pod");
    expect(calls.filter((c) => c === "pods").length).toBeGreaterThan(1);
  });

  it("a current image is left alone — no image patch, no cycle", async () => {
    const { kc, calls, patches } = fakeKc({ image: "sandbox-os:new", operatingMode: "Running" });
    await provisioner(kc).resume(ref);
    expect(patchedImages(patches)).toEqual([]);
    expect(patchedModes(patches)).toEqual(["Running"]);
    expect(calls).not.toContain("pods");
  });

  it("ADOPTING an existing Sandbox (409) reconciles its image", async () => {
    // After an upgrade the agent-host hydrates the conversation and create() finds the Sandbox already there.
    const { kc, patches } = fakeKc({ conflict: true, image: "sandbox-os:old", operatingMode: "Suspended" });
    await provisioner(kc).create("abc", "thread-1");
    expect(patchedImages(patches)).toEqual(["sandbox-os:new"]);
    expect(patchedModes(patches)).toEqual(["Running"]);
  });
});
