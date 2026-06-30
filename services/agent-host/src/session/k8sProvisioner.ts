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

/** Delete-error policy (findings #7/#8): a 404 means the object is already gone
 *  (the delete's goal — fine to ignore); EVERY other error means the delete did
 *  NOT happen and must propagate, else we leak the Sandbox/SA/PVC silently.
 *  Throws the original error for non-404; returns void for 404. */
export function ignoreDeleteNotFound(e: { code?: number }): void {
  if (e?.code !== 404) throw e;
}

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
  /** Mount a writable PVC upper for the local-overlay Nix store (the agent's
   *  runtime re-converge + in-pod builds land here). Set when using the
   *  overlay-store-enabled image (agent-sandbox-os-overlay). The PVC persists
   *  runtime builds across suspend/resume; it MUST be disk-backed (a PVC), never
   *  tmpfs — a RAM upper charges every runtime closure to pod memory. */
  overlayStore?: boolean;
  /** Overlay-store upper PVC size, e.g. "20Gi" (module rebuild closures are
   *  hundreds of MB). Only used when overlayStore is true. */
  overlayStorage?: string;
  /** Broker token audience (projected SA token). */
  brokerAudience?: string;
  /** Mount the AWS account-registry ConfigMap (agent-broker-aws-accounts) so the
   *  sandbox renders ~/.aws/config — set when the AWS permissions broker is on. */
  awsAccountsConfigMap?: string;
  /** Run the sandbox container as a systemd-PID-1 NixOS dev environment: a
   *  privileged securityContext + tmpfs on /run + /tmp (what systemd needs).
   *  Set when sandboxImage is the agent-sandbox-os image. Default false keeps the
   *  legacy generic image behavior. */
  systemdImage?: boolean;
  /** A deployment's `.scooter` ConfigMap (its own injected Nix tools) to mount at
   *  /etc/agent-sandbox/scooter, where lazyTools `localFlake` builds them. The
   *  CONTENT is deployment-specific (this platform doesn't know what's in it). */
  scooterConfigMap?: string;
  /** Additional projected SA token audiences a deployment's tools authenticate
   *  with — each mounted at /var/run/secrets/<audience>/token. The audiences are
   *  DEPLOYMENT-supplied (this platform doesn't hardcode any). */
  extraTokenAudiences?: string[];
  /** Additional environment variables a deployment's tools need (e.g. a service
   *  URL). DEPLOYMENT-supplied; this platform sets none of its own here. */
  extraEnv?: Array<{ name: string; value: string }>;
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
  // The per-conversation module ConfigMap the agent-host owns: the agent's
  // self-authored module.nix lives here (durable across suspend/resume). Mounted
  // read-only into the pod; scooter-apply-module reads it.
  const moduleCmName = (id: string) => `conv-${id}-module`;

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

      // 1b. the per-conversation module ConfigMap (agent-host-owned), created
      // EMPTY now — it must exist before the Sandbox so the podTemplate can mount
      // it from pod birth (a ConfigMap created later won't appear as a volume; the
      // kubelet only live-updates the CONTENTS of an already-mounted CM). The
      // agent-host fills it in when the agent modifies its environment. Empty
      // module.nix = scooter-apply-module no-ops. Idempotent on 409.
      await core
        .createNamespacedConfigMap({
          namespace: ns,
          body: {
            metadata: { name: moduleCmName(id), namespace: ns },
            data: { "module.nix": "" },
          },
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
        body: sandboxManifest(id, name, saName(id), opts.sandboxImage, ns, audience, storage, opts.awsAccountsConfigMap, opts.systemdImage ?? false, {
          scooterConfigMap: opts.scooterConfigMap,
          extraTokenAudiences: opts.extraTokenAudiences ?? [],
          extraEnv: opts.extraEnv ?? [],
          overlayStore: opts.overlayStore ?? false,
          overlayStorage: opts.overlayStorage,
          moduleConfigMap: moduleCmName(id),
        }),
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

    async reconcile(): Promise<Array<{ ref: SandboxRef; running: boolean }>> {
      // List every per-conversation Sandbox in the namespace and report whether
      // its pod is running (replicas > 0). hydrate() uses this to avoid leaking
      // pods across an agent-host restart.
      const list = (await custom.listNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: ns,
        plural: PLURAL,
      })) as { items?: Array<{ metadata?: { name?: string }; spec?: { replicas?: number } }> };
      const out: Array<{ ref: SandboxRef; running: boolean }> = [];
      for (const item of list.items ?? []) {
        const name = item.metadata?.name;
        if (!name || !name.startsWith("conv-")) continue;
        out.push({ ref: { name, namespace: ns }, running: (item.spec?.replicas ?? 0) > 0 });
      }
      return out;
    },

    async destroy(ref: SandboxRef): Promise<void> {
      const id = ref.name.replace(/^conv-/, "");
      // Findings #7/#8: a bare .catch(() => {}) here swallowed EVERY delete error.
      // A 404 means the object is already gone — exactly the delete's goal — so
      // ignore that; but any OTHER failure (403/409/5xx/timeout) means the delete
      // did NOT happen, and silently swallowing it leaks the Sandbox CR + pod +
      // workspace PVC (#7) or the per-conversation ServiceAccount = the broker
      // identity (#8). Rethrow so end() doesn't report a clean teardown that
      // actually left live resources behind.
      await custom
        .deleteNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: ref.namespace,
          plural: PLURAL,
          name: ref.name,
        })
        .catch(ignoreDeleteNotFound);
      await core
        .deleteNamespacedServiceAccount({ name: saName(id), namespace: ref.namespace })
        .catch(ignoreDeleteNotFound);
      await core
        .deleteNamespacedConfigMap({ name: moduleCmName(id), namespace: ref.namespace })
        .catch(ignoreDeleteNotFound);
    },

    // Persist the agent's self-authored module into the per-conversation module
    // ConfigMap (durable across suspend/resume; the boot oneshot re-applies it on
    // a fresh pod). The agent-host calls this AFTER a clean live apply (the
    // moduleManager build-before-persist gate), so the CM only ever holds a
    // switch-clean module. Merge-patch just the module.nix key.
    async writeModule(conversationId: string, module: string): Promise<void> {
      await core.patchNamespacedConfigMap(
        {
          name: moduleCmName(conversationId),
          namespace: ns,
          body: { data: { "module.nix": module } },
        },
        setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
      );
    },
  };
}

/** The Sandbox CR body — mirror of modules/conversation.nix. */
export function sandboxManifest(
  id: string,
  name: string,
  sa: string,
  image: string,
  namespace: string,
  audience: string,
  storage: string,
  awsAccountsConfigMap?: string,
  systemdImage = false,
  deploy: {
    scooterConfigMap?: string;
    extraTokenAudiences?: string[];
    extraEnv?: Array<{ name: string; value: string }>;
    overlayStore?: boolean;
    overlayStorage?: string;
    moduleConfigMap?: string;
  } = {},
): object {
  const scooter = deploy.scooterConfigMap;
  const extraAudiences = deploy.extraTokenAudiences ?? [];
  const extraEnv = deploy.extraEnv ?? [];
  // Overlay-store writable upper: a disk-backed PVC at the module's upperPath
  // (/nix/.scooter-rw). Only when the overlay-store image is in use.
  const overlayStore = deploy.overlayStore ?? false;
  const overlayStorage = deploy.overlayStorage ?? "20Gi";
  // The agent-host-owned per-conversation module ConfigMap, mounted read-only at
  // the SAME path scooterModule.dir points at (/etc/agent-sandbox/scooter), so
  // scooter-apply-module reads the agent's self-authored module from it and the
  // boot oneshot re-applies it on a fresh pod -> survives suspend/resume. The
  // agent-host renders ONE final module here (deployment base + agent additions),
  // so this REPLACES the deployment scooter-tools mount as the converge source
  // when present.
  const moduleCm = deploy.moduleConfigMap;
  const moduleMountPath = "/etc/agent-sandbox/scooter";
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
              // Always pull so a re-pushed :latest sandbox image is picked up
              // (IfNotPresent would keep a node's stale cached image).
              imagePullPolicy: "Always",
              // The systemd NixOS dev image runs systemd as PID 1 — it needs a
              // privileged context (writable cgroup + CAP_SYS_ADMIN). Accepted on
              // dev; tighten post-PoC. The legacy generic image runs unprivileged.
              ...(systemdImage ? { securityContext: { privileged: true } } : {}),
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "broker-token", mountPath: "/var/run/secrets/broker", readOnly: true },
                ...(awsAccountsConfigMap
                  ? [{ name: "aws-accounts", mountPath: "/etc/agent-sandbox/aws", readOnly: true }]
                  : []),
                // systemd writes to /run + /tmp; back them with tmpfs.
                ...(systemdImage
                  ? [
                      { name: "run", mountPath: "/run" },
                      { name: "tmp", mountPath: "/tmp" },
                    ]
                  : []),
                // A deployment's injected .scooter tools (content is theirs).
                // Skipped when the per-conversation module CM owns this path (the
                // agent-host renders the deployment's tools into that module).
                ...(scooter && !moduleCm
                  ? [{ name: "scooter-tools", mountPath: "/etc/agent-sandbox/scooter", readOnly: true }]
                  : []),
                // Deployment-named extra SA tokens (this platform names none).
                ...extraAudiences.map((aud) => ({
                  name: `tok-${aud}`,
                  mountPath: `/var/run/secrets/${aud}`,
                  readOnly: true,
                })),
                // The local-overlay store's writable upper (disk-backed PVC). The
                // image's overlay-store-setup mounts the overlay onto /nix/store
                // using this as the upperdir; runtime nix builds (re-converge,
                // in-pod installs) land here and persist across suspend/resume.
                ...(overlayStore ? [{ name: "scooter-rw", mountPath: "/nix/.scooter-rw" }] : []),
                // The agent-host-owned per-conversation module ConfigMap (the
                // agent's self-authored module.nix). scooter-apply-module reads it.
                ...(moduleCm ? [{ name: "scooter-conv", mountPath: moduleMountPath, readOnly: true }] : []),
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
                ...(awsAccountsConfigMap
                  ? [{ name: "AWS_ACCOUNTS_FILE", value: "/etc/agent-sandbox/aws/accounts.json" }]
                  : []),
                // Generically useful to any deployment tool (e.g. one keyed by
                // conversation). The conversation id, not a deployment concept.
                { name: "CONVERSATION_ID", value: id },
                // Deployment-supplied env (e.g. a service URL). Platform-neutral.
                ...extraEnv,
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
            ...(awsAccountsConfigMap
              ? [{ name: "aws-accounts", configMap: { name: awsAccountsConfigMap } }]
              : []),
            ...(systemdImage
              ? [
                  { name: "run", emptyDir: { medium: "Memory" } },
                  { name: "tmp", emptyDir: { medium: "Memory" } },
                ]
              : []),
            ...(scooter && !moduleCm
              ? [{ name: "scooter-tools", configMap: { name: scooter } }]
              : []),
            ...(moduleCm
              ? [{ name: "scooter-conv", configMap: { name: moduleCm } }]
              : []),
            ...extraAudiences.map((aud) => ({
              name: `tok-${aud}`,
              projected: { sources: [{ serviceAccountToken: { audience: aud, path: "token" } }] },
            })),
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
        // The overlay-store upper PVC (disk-backed; persists runtime builds across
        // suspend/resume). Only when the overlay-store image is in use.
        ...(overlayStore
          ? [
              {
                metadata: { name: "scooter-rw" },
                spec: {
                  accessModes: ["ReadWriteOnce"],
                  resources: { requests: { storage: overlayStorage } },
                },
              },
            ]
          : []),
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
