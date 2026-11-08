/** Resume and restart re-render a Sandbox's whole pod template. */

import { describe, it, expect } from "vitest";

import {
  PENDING_ANNOTATION,
  TEMPLATE_HASH_ANNOTATION,
  createK8sProvisioner,
  templateDiff,
  templateHash,
  type K8sProvisionerOptions,
} from "../../src/session/k8sProvisioner.js";

const THREAD = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff";
const ref = { name: "conv-5a515e73", namespace: "agent-manager" };
const small = { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "1", memory: "2Gi" } };

/** The forge proxy overlay, shaped as modules/platform.nix renders it. */
const FORGE_OVERLAY = {
  spec: {
    podTemplate: {
      spec: {
        containers: [
          {
            name: "sandbox",
            env: [
              { name: "FORGE_PROXY_ADDR", value: "agent-broker.agent-manager.svc.cluster.local:3129" },
              { name: "HTTPS_PROXY", value: "http://127.0.0.1:3128" },
            ],
            volumeMounts: [{ name: "forge-ca", mountPath: "/etc/scooter/forge-ca", readOnly: true }],
          },
        ],
        volumes: [{ name: "forge-ca", configMap: { name: "scooter-forge-ca", optional: true } }],
      },
    },
  },
};

type Op = { op: string; path: string; value?: unknown };

/** Applies the JSON-patch subset the provisioner sends (test / add / replace). */
function applyJsonPatch(doc: Record<string, any>, ops: Op[]) {
  for (const { op, path, value } of ops) {
    const keys = path.split("/").slice(1).map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = keys.pop()!;
    let parent: any = doc;
    for (const k of keys) parent = parent[k];
    if (op === "test") {
      if (JSON.stringify(parent?.[last]) !== JSON.stringify(value)) throw Object.assign(new Error("test failed"), { code: 422 });
    } else if (op === "add" || op === "replace") {
      parent[last] = structuredClone(value);
    } else {
      throw new Error(`unsupported op ${op}`);
    }
  }
}

/** Fake apiserver holding one Sandbox CR, its pod and the overlay ConfigMap. */
function fakeCluster() {
  const state: { cr?: Record<string, any>; overlay?: string; pod?: string; rv: number; uid: number } = { rv: 1, uid: 0 };
  const log: string[] = [];
  // A pod keeps the size it started with.
  const podResources = new Map<string, unknown>();
  const api = {
    createNamespacedServiceAccount: async () => ({}),
    readNamespacedConfigMap: async () => {
      if (!state.overlay) throw Object.assign(new Error("nf"), { code: 404 });
      return { data: { "contrib.yaml": state.overlay } };
    },
    createNamespacedCustomObject: async ({ body }: { body: Record<string, any> }) => {
      if (state.cr) throw Object.assign(new Error("exists"), { code: 409 });
      state.cr = structuredClone(body);
      state.cr.metadata.resourceVersion = String(state.rv++);
      if (body.spec.operatingMode !== "Suspended") state.pod = `pod-${++state.uid}`;
      return {};
    },
    getNamespacedCustomObject: async () => {
      if (!state.cr) throw Object.assign(new Error("nf"), { code: 404 });
      return structuredClone(state.cr);
    },
    patchNamespacedCustomObject: async ({ body }: { body: unknown }) => {
      const cr = state.cr!;
      if (Array.isArray(body)) {
        log.push(`jsonpatch:${(body as Op[]).filter((o) => o.op !== "test").map((o) => o.path).join(",")}`);
        applyJsonPatch(cr, body as Op[]);
      } else {
        const mode = (body as { spec?: { operatingMode?: string } }).spec?.operatingMode;
        if (mode) {
          log.push(`mode:${mode}`);
          cr.spec.operatingMode = mode;
          if (mode === "Suspended") state.pod = undefined;
          else state.pod ??= `pod-${++state.uid}`;
        } else {
          log.push("mergepatch");
          const containers = (body as { spec?: { podTemplate?: { spec?: { containers?: unknown[] } } } }).spec?.podTemplate?.spec?.containers;
          if (containers) cr.spec.podTemplate.spec.containers = structuredClone(containers);
        }
      }
      cr.metadata.resourceVersion = String(state.rv++);
      return {};
    },
    listNamespacedPod: async () => {
      if (!state.pod) return { items: [] };
      if (!podResources.has(state.pod)) podResources.set(state.pod, structuredClone(state.cr?.spec.podTemplate.spec.containers[0].resources));
      return {
        items: [
          {
            metadata: { name: ref.name, uid: state.pod },
            spec: { containers: [{ name: "sandbox", resources: podResources.get(state.pod) }] },
            status: { phase: "Running", containerStatuses: [{ ready: true }] },
          },
        ],
      };
    },
    deleteNamespacedPod: async () => {
      log.push("delete:pod");
      // The controller recreates a Running Sandbox's pod.
      state.pod = state.cr?.spec.operatingMode === "Suspended" ? undefined : `pod-${++state.uid}`;
      return {};
    },
    readNamespacedPod: async () => {
      throw Object.assign(new Error("nf"), { code: 404 });
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, state, log };
}

const base = (kc: never, extra: Partial<K8sProvisionerOptions> = {}) =>
  createK8sProvisioner({
    namespace: "agent-manager",
    sandboxImage: "sandbox-os:current",
    systemdImage: true,
    publicUrl: "https://scooter.example.com",
    manifestOverlayConfigMap: "scooter-sandbox-overlay",
    sandboxResources: { requests: { cpu: "2", memory: "4Gi" }, limits: { cpu: "2", memory: "4Gi" } },
    podPollMs: 1,
    reconcileRetryDelaysMs: [1, 1],
    kubeConfig: kc,
    ...extra,
  });

/** A pre-forge-proxy, pre-userns Sandbox, resized then suspended. */
async function legacySandbox() {
  const cluster = fakeCluster();
  const old = base(cluster.kc, { sandboxUserNamespace: false, sandboxImage: "sandbox-os:old" });
  await old.create("5a515e73", THREAD);
  await old.setSize("5a515e73", small);
  await old.suspend(ref);
  // Platform upgrade: forge proxy, user namespaces, new image and size.
  cluster.state.overlay = JSON.stringify(FORGE_OVERLAY);
  cluster.log.length = 0;
  const upgraded = base(cluster.kc, {
    sandboxUserNamespace: true,
    sandboxResources: { requests: { cpu: "8", memory: "16Gi" }, limits: { cpu: "8", memory: "16Gi" } },
  });
  return { cluster, upgraded };
}

const pod = (cr: Record<string, any>) => cr.spec.podTemplate.spec;
const ctr = (cr: Record<string, any>) => pod(cr).containers[0];
const env = (cr: Record<string, any>) => Object.fromEntries(ctr(cr).env.map((e: { name: string; value: string }) => [e.name, e.value]));

describe("k8sProvisioner: resume re-renders the pod template", () => {
  it("adopts the forge proxy and user namespace, keeping size, claims and conversation", async () => {
    const { cluster, upgraded } = await legacySandbox();
    const before = structuredClone(cluster.state.cr!);
    expect(pod(before).hostUsers).toBeUndefined();

    await upgraded.resume(ref);
    const cr = cluster.state.cr!;

    expect(pod(cr).hostUsers).toBe(false);
    expect(ctr(cr).securityContext.procMount).toBe("Unmasked");
    expect(env(cr).FORGE_PROXY_ADDR).toBe("agent-broker.agent-manager.svc.cluster.local:3129");
    expect(env(cr).HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    expect(pod(cr).volumes.map((v: { name: string }) => v.name)).toContain("forge-ca");
    expect(ctr(cr).volumeMounts.map((v: { name: string }) => v.name)).toContain("forge-ca");
    expect(ctr(cr).image).toBe("sandbox-os:current");
    // The conversation's own half is untouched.
    expect(ctr(cr).resources).toEqual(small);
    expect(env(cr).CONVERSATION_ID).toBe(THREAD);
    expect(env(cr).CONVERSATION_URL).toBe(`https://scooter.example.com/?thread=${THREAD}`);
    expect(cr.spec.volumeClaimTemplates).toEqual(before.spec.volumeClaimTemplates);
    expect(pod(cr).serviceAccountName).toBe("sandbox-5a515e73");
    expect(cr.metadata.annotations[TEMPLATE_HASH_ANNOTATION]).toBe(templateHash(cr.spec.podTemplate));
    // Suspended needs no cycle: Running starts the new template.
    expect(cluster.log).toEqual(["jsonpatch:/metadata/annotations/scooter.io~1template-hash,/spec/podTemplate", "mode:Running"]);
  });

  it("patches nothing when the recorded hash matches a fresh render", async () => {
    const { cluster, upgraded } = await legacySandbox();
    await upgraded.resume(ref);
    await upgraded.suspend(ref);
    cluster.log.length = 0;
    await upgraded.resume(ref);
    expect(cluster.log).toEqual(["mode:Running"]);
  });

  it("with the immediate policy, replaces a running pod by deleting it, never suspending the CR", async () => {
    const { cluster } = await legacySandbox();
    cluster.state.cr!.spec.operatingMode = "Running";
    cluster.state.pod = "pod-old";
    const r = await base(cluster.kc, { sandboxUserNamespace: true, updatePolicy: "immediate" }).resume(ref);
    expect(r.updatePending).toBeUndefined();
    expect(cluster.log).not.toContain("mode:Suspended");
    expect(cluster.log).toContain("delete:pod");
    expect(cluster.state.pod).not.toBe("pod-old");
  });

  it("only stamps the hash on a legacy CR whose template already matches, without a cycle", async () => {
    const cluster = fakeCluster();
    const p = base(cluster.kc);
    await p.create("5a515e73", THREAD);
    delete cluster.state.cr!.metadata.annotations;
    cluster.log.length = 0;
    await p.resume(ref);
    expect(cluster.log).toEqual(["jsonpatch:/metadata/annotations", "mode:Running"]);
    expect(cluster.state.cr!.metadata.annotations[TEMPLATE_HASH_ANNOTATION]).toBe(templateHash(cluster.state.cr!.spec.podTemplate));
  });

  it("keeps the CR's own claims when the deployment turns the overlay store on", async () => {
    const cluster = fakeCluster();
    await base(cluster.kc).create("5a515e73", THREAD);
    const claims = structuredClone(cluster.state.cr!.spec.volumeClaimTemplates);
    await base(cluster.kc, { overlayStore: true, sandboxUserNamespace: true }).resume(ref);
    const cr = cluster.state.cr!;
    expect(cr.spec.volumeClaimTemplates).toEqual(claims);
    // Mounting a missing claim would keep the pod from starting.
    expect(ctr(cr).volumeMounts.map((v: { name: string }) => v.name)).not.toContain("scooter-rw");
    expect(pod(cr).hostUsers).toBe(false);
  });
});

describe("k8sProvisioner: pendingRestart reports template drift", () => {
  it("names the changed fields before the resume and nothing after", async () => {
    const { upgraded } = await legacySandbox();
    const pending = await upgraded.pendingRestart(ref);
    expect(pending?.template).toEqual(expect.arrayContaining(["hostUsers", "volumes", "container.env", "container.image", "container.securityContext"]));
    await upgraded.resume(ref);
    expect(await upgraded.pendingRestart(ref)).toBeUndefined();
  });

  it("restart adopts the template, so restart_sandbox fixes an old sandbox too", async () => {
    const { cluster, upgraded } = await legacySandbox();
    cluster.state.cr!.spec.operatingMode = "Running";
    cluster.state.pod = "pod-old";
    const r = await upgraded.restart(ref);
    expect(r).toMatchObject({ toImage: "sandbox-os:current", imageCurrent: true, ready: true });
    expect(pod(cluster.state.cr!).hostUsers).toBe(false);
    expect(cluster.log).not.toContain("mode:Suspended");
    expect(await upgraded.pendingRestart(ref)).toBeUndefined();
  });
});

describe("k8sProvisioner: deferred updates keep the running pod", () => {
  /** A legacy Sandbox that was running when the platform upgraded. */
  async function runningLegacy() {
    const { cluster, upgraded } = await legacySandbox();
    cluster.state.cr!.spec.operatingMode = "Running";
    cluster.state.pod = "pod-old";
    return { cluster, upgraded };
  }

  it("patches the CR, keeps the pod, and reports the update as pending", async () => {
    const { cluster, upgraded } = await runningLegacy();
    const r = await upgraded.resume(ref);
    expect(r).toEqual({ ...ref, updatePending: true });
    expect(cluster.log).not.toContain("delete:pod");
    expect(cluster.state.pod).toBe("pod-old");
    expect(ctr(cluster.state.cr!).image).toBe("sandbox-os:current");
    expect(JSON.parse(cluster.state.cr!.metadata.annotations[PENDING_ANNOTATION])).toMatchObject({ podUid: "pod-old", fromImage: "sandbox-os:old" });
    const pending = await upgraded.pendingRestart(ref);
    expect(pending?.image).toEqual({ from: "sandbox-os:old", to: "sandbox-os:current" });
    expect(pending?.template).toEqual(expect.arrayContaining(["hostUsers", "container.image", "container.env"]));
  });

  it("does not report it again on the next resume", async () => {
    const { upgraded } = await runningLegacy();
    await upgraded.resume(ref);
    expect(await upgraded.resume(ref)).toEqual(ref);
    expect(await upgraded.pendingRestart(ref)).toBeDefined();
  });

  it("merges a second rollout into the same pending update", async () => {
    const { cluster, upgraded } = await runningLegacy();
    await upgraded.resume(ref);
    await base(cluster.kc, { sandboxUserNamespace: true, sandboxImage: "sandbox-os:newer" }).resume(ref);
    expect(cluster.state.pod).toBe("pod-old");
    const note = JSON.parse(cluster.state.cr!.metadata.annotations[PENDING_ANNOTATION]);
    expect(note.fromImage).toBe("sandbox-os:old");
    expect(note.changed).toEqual(expect.arrayContaining(["hostUsers", "container.image"]));
  });

  it("restart applies it and reports the pod's real starting image", async () => {
    const { cluster, upgraded } = await runningLegacy();
    await upgraded.resume(ref);
    const r = await upgraded.restart(ref);
    expect(r).toMatchObject({ fromImage: "sandbox-os:old", toImage: "sandbox-os:current", imageCurrent: true });
    expect(cluster.state.pod).not.toBe("pod-old");
    expect(await upgraded.pendingRestart(ref)).toBeUndefined();
  });

  it("counts as applied once the pod is replaced any other way", async () => {
    const { cluster, upgraded } = await runningLegacy();
    await upgraded.resume(ref);
    cluster.state.pod = "pod-evicted-replacement";
    expect(await upgraded.pendingRestart(ref)).toBeUndefined();
    await upgraded.suspend(ref);
    await upgraded.resume(ref);
    expect(await upgraded.pendingRestart(ref)).toBeUndefined();
  });
});

describe("templateDiff / templateHash", () => {
  const t = (extra: Record<string, unknown> = {}, cextra: Record<string, unknown> = {}) => ({
    spec: { serviceAccountName: "sa", ...extra, containers: [{ name: "sandbox", image: "a", ...cextra }] },
  });

  it("ignores container resources, which belong to the conversation", () => {
    expect(templateHash(t({}, { resources: small }))).toBe(templateHash(t()));
    expect(templateDiff(t({}, { resources: small }), t())).toEqual([]);
  });

  it("ignores key order", () => {
    const a = { spec: { containers: [{ image: "a", name: "sandbox" }], serviceAccountName: "sa" } };
    expect(templateHash(a)).toBe(templateHash(t()));
  });

  it("lists pod-level and container-level fields", () => {
    expect(templateDiff(t(), t({ hostUsers: false }, { image: "b" }))).toEqual(["hostUsers", "container.image"]);
  });
});
