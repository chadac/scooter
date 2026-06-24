/**
 * Production SandboxProvisioner — creates the cold per-conversation Sandbox via
 * the agent-sandbox CRD, mirroring modules/conversation.nix.
 *
 * Per conversation:
 *   - ServiceAccount sandbox-{id}     (unique broker identity)
 *   - Sandbox conv-{id}               (SA + workspace PVC + broker token volume)
 * Suspend/resume flip spec.replicas (0/1) on the v1alpha1 Sandbox (controller
 * drops/recreates the Pod, keeps PVCs). Destroy deletes the Sandbox + SA.
 *
 * The conversation-state PVC (Goose state + event log) is mounted by the
 * agent-host itself and is managed separately (see ConversationStore).
 */

import { existsSync } from "node:fs";

import {
  KubeConfig,
  CoreV1Api,
  CustomObjectsApi,
  setHeaderOptions,
  PatchStrategy,
} from "@kubernetes/client-node";

import type { SandboxRef } from "../types.js";
import type { SandboxProvisioner } from "./manager.js";

const GROUP = "agents.x-k8s.io";
// agent-sandbox v0.4.x serves v1alpha1, where suspend/resume is `spec.replicas`
// (0 = suspended, 1 = running) — there is no operatingMode field yet.
const VERSION = "v1alpha1";
const PLURAL = "sandboxes";
const SANDBOX_NAME_LABEL = "agents.x-k8s.io/sandbox-name";

export interface K8sProvisionerOptions {
  namespace: string;
  /** Generic Nix sandbox image ref. */
  sandboxImage: string;
  /** Workspace PVC size, e.g. "10Gi". */
  workspaceStorage?: string;
  /** Broker token audience (projected SA token). */
  brokerAudience?: string;
  kubeConfig?: KubeConfig;
}

export function createK8sProvisioner(opts: K8sProvisionerOptions): SandboxProvisioner {
  const kc = opts.kubeConfig ?? defaultKubeConfig();
  const core = kc.makeApiClient(CoreV1Api);
  const custom = kc.makeApiClient(CustomObjectsApi);
  const ns = opts.namespace;
  const audience = opts.brokerAudience ?? "agent-broker";
  const storage = opts.workspaceStorage ?? "10Gi";

  const sandboxName = (id: string) => `conv-${id}`;
  const saName = (id: string) => `sandbox-${id}`;

  // v1alpha1: replicas 0 = suspended (pod dropped, PVCs kept), 1 = running.
  // A plain-object body negotiates application/merge-patch+json.
  const setReplicas = async (ref: SandboxRef, replicas: 0 | 1) => {
    await custom.patchNamespacedCustomObject(
      {
        group: GROUP,
        version: VERSION,
        namespace: ref.namespace,
        plural: PLURAL,
        name: ref.name,
        body: { spec: { replicas } },
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
  };

  return {
    async create(id: string): Promise<SandboxRef> {
      // 1. per-conversation ServiceAccount (broker identity). Idempotent:
      // tolerate an SA left behind by a prior run (AlreadyExists / 409).
      await core
        .createNamespacedServiceAccount({
          namespace: ns,
          body: { metadata: { name: saName(id), namespace: ns } },
        })
        .catch((e: { code?: number }) => {
          if (e?.code !== 409) throw e;
        });

      // 2. the cold Sandbox (SA + workspace PVC + projected broker token)
      const name = sandboxName(id);
      await custom.createNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: ns,
        plural: PLURAL,
        body: sandboxManifest(id, name, saName(id), opts.sandboxImage, ns, audience, storage),
      });

      return { name, namespace: ns };
    },

    async suspend(ref: SandboxRef): Promise<void> {
      await setReplicas(ref, 0);
    },

    async resume(ref: SandboxRef): Promise<SandboxRef> {
      await setReplicas(ref, 1);
      return ref;
    },

    async destroy(ref: SandboxRef): Promise<void> {
      const id = ref.name.replace(/^conv-/, "");
      await custom
        .deleteNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: ref.namespace,
          plural: PLURAL,
          name: ref.name,
        })
        .catch(() => {});
      await core
        .deleteNamespacedServiceAccount({ name: saName(id), namespace: ref.namespace })
        .catch(() => {});
    },
  };
}

/** The Sandbox CR body — mirror of modules/conversation.nix. */
function sandboxManifest(
  id: string,
  name: string,
  sa: string,
  image: string,
  namespace: string,
  audience: string,
  storage: string,
): object {
  return {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: "Sandbox",
    metadata: { name, namespace, labels: { [SANDBOX_NAME_LABEL]: name } },
    spec: {
      replicas: 1,
      podTemplate: {
        metadata: { labels: { [SANDBOX_NAME_LABEL]: name } },
        spec: {
          serviceAccountName: sa,
          automountServiceAccountToken: false,
          containers: [
            {
              name: "sandbox",
              image,
              imagePullPolicy: "IfNotPresent",
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "broker-token", mountPath: "/var/run/secrets/broker", readOnly: true },
              ],
              env: [
                {
                  name: "BROKER_URL",
                  value: `http://agent-broker.${namespace}.svc.cluster.local:8080`,
                },
                { name: "BROKER_TOKEN_PATH", value: "/var/run/secrets/broker/token" },
                // git config --global (entrypoint) + the agent's exec'd git
                // commands must agree on $HOME so the broker credential helper is
                // configured for both. The image has no /etc/passwd, so HOME
                // would default to "/" (often read-only) — pin it to the
                // writable workspace volume.
                { name: "HOME", value: "/workspace" },
                // git host -> broker provider map for git-credential-broker.
                // github.com/gitlab.com are the built-in defaults; test-git.local
                // -> test lets the cluster e2e exercise the path via the test
                // provider (harmless in prod — that provider is gated off).
                {
                  name: "GIT_BROKER_HOST_MAP",
                  value: "github.com=github,gitlab.com=gitlab,test-git.local=test",
                },
              ],
            },
          ],
          volumes: [
            {
              name: "broker-token",
              projected: {
                sources: [{ serviceAccountToken: { audience, path: "token" } }],
              },
            },
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "workspace" },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage } },
          },
        },
      ],
    },
  };
}

function defaultKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  // In-cluster only when the projected SA token is actually present; otherwise
  // loadFromCluster() yields a broken config (invalid URL) instead of throwing.
  if (existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token")) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc;
}
