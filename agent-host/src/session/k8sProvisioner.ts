/**
 * Production SandboxProvisioner — creates the cold per-conversation Sandbox via
 * the agent-sandbox CRD, mirroring modules/conversation.nix.
 *
 * Per conversation:
 *   - ServiceAccount sandbox-{id}     (unique broker identity)
 *   - Sandbox conv-{id}               (SA + workspace PVC + broker token volume)
 * Suspend/resume flip spec.operatingMode (controller drops/recreates the Pod,
 * keeps PVCs). Destroy deletes the Sandbox + SA.
 *
 * The conversation-state PVC (Goose state + event log) is mounted by the
 * agent-host itself and is managed separately (see ConversationStore).
 */

import {
  KubeConfig,
  CoreV1Api,
  CustomObjectsApi,
} from "@kubernetes/client-node";

import type { SandboxRef } from "../types.js";
import type { SandboxProvisioner } from "./manager.js";

const GROUP = "agents.x-k8s.io";
const VERSION = "v1beta1";
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

  const setMode = async (ref: SandboxRef, mode: "Running" | "Suspended") => {
    await custom.patchNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: ref.namespace,
      plural: PLURAL,
      name: ref.name,
      body: { spec: { operatingMode: mode } },
    });
  };

  return {
    async create(id: string): Promise<SandboxRef> {
      // 1. per-conversation ServiceAccount (broker identity)
      await core.createNamespacedServiceAccount({
        namespace: ns,
        body: { metadata: { name: saName(id), namespace: ns } },
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
      await setMode(ref, "Suspended");
    },

    async resume(ref: SandboxRef): Promise<SandboxRef> {
      await setMode(ref, "Running");
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
      operatingMode: "Running",
      podTemplate: {
        metadata: { labels: { [SANDBOX_NAME_LABEL]: name } },
        spec: {
          serviceAccountName: sa,
          automountServiceAccountToken: false,
          containers: [
            {
              name: "sandbox",
              image,
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
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }
  return kc;
}
