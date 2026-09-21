/**
 * Tier 1 contract — a Sandbox left on a PREVIOUS platform version's image must be
 * reconciled onto the current one, and one cycle must be enough.
 *
 * WHY: a Sandbox CR is rendered once, at conversation-create time. `kubectl apply` of
 * an upgrade rolls every Deployment and touches no Sandbox, so a live conversation
 * kept booting the OLD sandbox image under a NEW agent-host — every run dead on
 * arrival, the queue filling and never draining. suspend/resume recreated the pod
 * from the unchanged spec, so the documented recovery recovered nothing: it took a
 * second, unrelated restart before the sandbox came up current. Issue #560.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

interface FakeOpts {
  /** The image the EXISTING Sandbox carries (undefined = no container at all). */
  image?: string;
  operatingMode?: string;
  /** Sandbox creation 409s — i.e. the conversation's Sandbox already exists. */
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
      return { items: podsLive-- > 0 ? [{}] : [] };
    },
    readNamespacedPod: async () => {
      throw Object.assign(new Error("nf"), { code: 404 });
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, calls, patches };
}

const provisioner = (kc: never) =>
  createK8sProvisioner({ namespace: "agent-manager", sandboxImage: "sandbox-os:new", kubeConfig: kc });

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
    // The image is reconciled FIRST; the flip to Running then brings the pod up on it.
    expect(patchedImages(patches)).toEqual(["sandbox-os:new"]);
    expect(patchedModes(patches)).toEqual(["Running"]);
  });

  it("a RUNNING sandbox on a stale image is cycled — a template patch alone never restarts a pod", async () => {
    const { kc, calls, patches } = fakeKc({ image: "sandbox-os:old", operatingMode: "Running", podsLive: 1 });
    await provisioner(kc).resume(ref);
    expect(patchedImages(patches)).toEqual(["sandbox-os:new"]);
    expect(patchedModes(patches)).toEqual(["Suspended", "Running"]);
    // …and the pod's disappearance is WAITED for in between: flipping straight back
    // lets the controller coalesce the two patches into no restart at all.
    expect(calls).toContain("pods");
  });

  it("a current image is left alone — no image patch, no cycle", async () => {
    const { kc, calls, patches } = fakeKc({ image: "sandbox-os:new", operatingMode: "Running" });
    await provisioner(kc).resume(ref);
    expect(patchedImages(patches)).toEqual([]);
    expect(patchedModes(patches)).toEqual(["Running"]);
    expect(calls).not.toContain("pods");
  });

  it("ADOPTING an existing Sandbox (409) reconciles its image", async () => {
    // The post-upgrade path: the agent-host rolls, hydrates the conversation, and
    // takes create() — which finds the Sandbox already there, on the old image.
    const { kc, patches } = fakeKc({ conflict: true, image: "sandbox-os:old", operatingMode: "Suspended" });
    await provisioner(kc).create("abc", "thread-1");
    expect(patchedImages(patches)).toEqual(["sandbox-os:new"]);
    expect(patchedModes(patches)).toEqual(["Running"]);
  });
});
