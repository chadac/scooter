/** Sandbox restart, pending-restart detection and reconcile retry. */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner, sameResources } from "../../src/session/k8sProvisioner.js";

type Resources = { requests?: Record<string, string>; limits?: Record<string, string> };

interface ClusterState {
  image: string;
  mode: "Running" | "Suspended";
  /** The CR's recorded resources. */
  resources?: Resources;
  /** The live pod and its resources, if any. */
  pod?: { resources?: Resources; uid?: string; stuck?: boolean };
}

/** Fake apiserver mimicking the agent-sandbox controller's pod lifecycle. */
function fakeCluster(init: ClusterState, opts: { failImagePatches?: number; failCode?: number } = {}) {
  const state: ClusterState = structuredClone(init);
  const modes: string[] = [];
  let imagePatchAttempts = 0;
  let deletes = 0;
  let uid = 0;
  let failuresLeft = opts.failImagePatches ?? 0;
  const podLabels: Record<string, string> = { "agents.x-k8s.io/sandbox-name-hash": "1a2b3c4d" };
  const matches = (selector?: string) =>
    !selector ||
    selector.split(",").every((kv) => {
      const [k, v] = kv.split("=");
      return podLabels[k] === v;
    });
  const pod = () => ({
    metadata: { name: "conv-abc", uid: state.pod?.uid ?? "pod-0", labels: podLabels },
    spec: { containers: [{ name: "sandbox", resources: state.pod?.resources }] },
    status: state.pod?.stuck
      ? { phase: "Pending", containerStatuses: [{ ready: false, state: { waiting: { reason: "ContainerCreating" } } }] }
      : { phase: "Running", containerStatuses: [{ ready: true }] },
  });
  let stuckPods = false;
  const api = {
    getNamespacedCustomObject: async () => ({
      spec: {
        operatingMode: state.mode,
        podTemplate: { spec: { containers: [{ name: "sandbox", image: state.image, resources: state.resources }] } },
      },
    }),
    patchNamespacedCustomObject: async (args: { body: { spec: Record<string, unknown> } }) => {
      const spec = args.body.spec as {
        operatingMode?: "Running" | "Suspended";
        podTemplate?: { spec?: { containers?: Array<{ image?: string; resources?: Resources }> } };
      };
      const containers = spec.podTemplate?.spec?.containers;
      if (containers) {
        imagePatchAttempts++;
        if (failuresLeft > 0) {
          failuresLeft--;
          throw Object.assign(new Error("Too Many Requests"), { code: opts.failCode ?? 429 });
        }
        state.image = containers[0].image ?? state.image;
      }
      if (spec.operatingMode) {
        modes.push(spec.operatingMode);
        state.mode = spec.operatingMode;
        if (state.mode === "Suspended") state.pod = undefined;
        else state.pod ??= { resources: structuredClone(state.resources), uid: `pod-${++uid}` };
      }
      return {};
    },
    // The controller strips agents.x-k8s.io/sandbox-name, so only a by-name read finds the pod.
    listNamespacedPod: async (args: { labelSelector?: string }) => ({
      items: state.pod && matches(args.labelSelector) ? [pod()] : [],
    }),
    deleteNamespacedPod: async () => {
      deletes++;
      state.pod = state.mode === "Running" ? { resources: structuredClone(state.resources), uid: `pod-${++uid}`, stuck: stuckPods } : undefined;
      return {};
    },
    readNamespacedPod: async () => {
      if (!state.pod) throw Object.assign(new Error("nf"), { code: 404 });
      return pod();
    },
    listNamespacedEvent: async () => ({
      items: [{ type: "Warning", reason: "FailedAttachVolume", count: 4, message: "attach timed out" }],
    }),
  };
  return {
    kc: { makeApiClient: () => api as never } as never,
    state,
    modes,
    imagePatchAttempts: () => imagePatchAttempts,
    deletes: () => deletes,
    stickNewPods: () => (stuckPods = true),
  };
}

const provisioner = (kc: never) =>
  createK8sProvisioner({
    namespace: "agent-manager",
    sandboxImage: "sandbox-os:new",
    kubeConfig: kc,
    podPollMs: 1,
    reconcileRetryDelaysMs: [1, 1],
  });

const ref = { name: "conv-abc", namespace: "agent-manager" };
const small: Resources = { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "1", memory: "2Gi" } };
const big: Resources = { requests: { cpu: "4", memory: "8Gi" }, limits: { cpu: "4", memory: "8Gi" } };

describe("sameResources", () => {
  it("compares cpu and memory by value, since the apiserver canonicalizes pod quantities", () => {
    expect(sameResources({ limits: { cpu: "1000m", memory: "1024Mi" } }, { limits: { cpu: "1", memory: "1Gi" } })).toBe(true);
    expect(sameResources({ limits: { cpu: "2" } }, { limits: { cpu: "1" } })).toBe(false);
    expect(sameResources(undefined, undefined)).toBe(true);
    expect(sameResources({ limits: { cpu: "1" } }, undefined)).toBe(false);
  });
});

describe("k8sProvisioner.pendingRestart", () => {
  it("is undefined when the image is current and the pod runs the recorded size", async () => {
    const { kc } = fakeCluster({ image: "sandbox-os:new", mode: "Running", resources: small, pod: { resources: small } });
    expect(await provisioner(kc).pendingRestart(ref)).toBeUndefined();
  });

  it("reports a stale image with both refs", async () => {
    const { kc } = fakeCluster({ image: "sandbox-os:old", mode: "Running", resources: small, pod: { resources: small } });
    expect(await provisioner(kc).pendingRestart(ref)).toEqual({ image: { from: "sandbox-os:old", to: "sandbox-os:new" } });
  });

  it("reports a recorded size the running pod lacks", async () => {
    const { kc } = fakeCluster({ image: "sandbox-os:new", mode: "Running", resources: big, pod: { resources: small } });
    expect(await provisioner(kc).pendingRestart(ref)).toEqual({ size: true });
  });

  it("does not report size for a suspended sandbox, which applies it on its next start anyway", async () => {
    const { kc } = fakeCluster({ image: "sandbox-os:new", mode: "Suspended", resources: big });
    expect(await provisioner(kc).pendingRestart(ref)).toBeUndefined();
  });
});

describe("k8sProvisioner.restart", () => {
  it("cycles a running pod onto the current image and recorded size and waits for it", async () => {
    const cluster = fakeCluster({ image: "sandbox-os:old", mode: "Running", resources: big, pod: { resources: small } });
    const r = await provisioner(cluster.kc).restart(ref);
    expect(r).toEqual({ fromImage: "sandbox-os:old", toImage: "sandbox-os:new", imageCurrent: true, sizeApplied: true, ready: true });
    // The CR never leaves Running.
    expect(cluster.modes).not.toContain("Suspended");
    expect(cluster.deletes()).toBe(1);
    expect(cluster.modes.at(-1)).toBe("Running");
    expect(cluster.state.pod?.resources).toEqual(big);
    expect(await provisioner(cluster.kc).pendingRestart(ref)).toBeUndefined();
  });

  it("restarts for a size-only change, which the image reconcile alone never cycles for", async () => {
    const cluster = fakeCluster({ image: "sandbox-os:new", mode: "Running", resources: big, pod: { resources: small } });
    const r = await provisioner(cluster.kc).restart(ref);
    expect(r.sizeApplied).toBe(true);
    expect(cluster.modes).toEqual(["Running"]);
    expect(cluster.deletes()).toBe(1);
    expect(cluster.state.pod?.resources).toEqual(big);
  });
});

describe("k8sProvisioner.restart — pod never Ready", () => {
  it("reports the pod's state and events", async () => {
    const cluster = fakeCluster({ image: "sandbox-os:new", mode: "Running", pod: {} });
    cluster.stickNewPods();
    const r = await createK8sProvisioner({ namespace: "agent-manager", sandboxImage: "sandbox-os:new", kubeConfig: cluster.kc, podPollMs: 1, podReadyTimeoutMs: 5 }).restart(ref);
    expect(r.ready).toBe(false);
    expect(r.notReadyReason).toBe("pod Pending (ContainerCreating); FailedAttachVolume x4: attach timed out");
  });
});

describe("k8sProvisioner — image reconcile retry", () => {
  it("retries a transient failure (an apiserver 429) and then adopts the image", async () => {
    const cluster = fakeCluster({ image: "sandbox-os:old", mode: "Suspended" }, { failImagePatches: 2 });
    await provisioner(cluster.kc).resume(ref);
    expect(cluster.imagePatchAttempts()).toBe(3);
    expect(cluster.state.image).toBe("sandbox-os:new");
    expect(cluster.state.mode).toBe("Running");
  });

  it("runs the sandbox as-is after the last try, and pendingRestart still reports the stale image", async () => {
    const cluster = fakeCluster({ image: "sandbox-os:old", mode: "Suspended" }, { failImagePatches: 99 });
    await provisioner(cluster.kc).resume(ref);
    expect(cluster.imagePatchAttempts()).toBe(3);
    expect(cluster.state.mode).toBe("Running");
    expect((await provisioner(cluster.kc).pendingRestart(ref))?.image).toEqual({ from: "sandbox-os:old", to: "sandbox-os:new" });
  });

  it("restart reports imageCurrent=false when every reconcile try fails", async () => {
    const cluster = fakeCluster({ image: "sandbox-os:old", mode: "Running", pod: {} }, { failImagePatches: 99 });
    const r = await provisioner(cluster.kc).restart(ref);
    expect(r.imageCurrent).toBe(false);
    expect(r.ready).toBe(true);
  });
});
