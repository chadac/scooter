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
  /** Resource requests/limits for the sandbox container. Without these the
   *  scheduler treats a sandbox as ~free and packs many onto one node; a burst of
   *  in-pod nix builds then overwhelms the container runtime and the kubelet's PLEG
   *  stalls the whole node (the node-death we hit). Default: request cpu 500m /
   *  memory 1Gi so the scheduler SPREADS sandboxes across nodes, limit memory 4Gi so
   *  a runaway build is OOM-killed instead of taking the node down, and NO cpu limit
   *  so bursty builds use spare node CPU freely. Deployment-overridable. */
  sandboxResources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
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
  /** A deployment's config-FILES ConfigMap (filename -> contents), mounted as a
   *  flat dir at /etc/agent-sandbox/config. File-based (vs SCOOTER_ENV) so multi-
   *  line config survives the sandbox CRD controller's env-var newline corruption. */
  configFilesConfigMap?: string;
  /** Additional projected SA token audiences a deployment's tools authenticate
   *  with — each mounted at /var/run/secrets/<audience>/token. The audiences are
   *  DEPLOYMENT-supplied (this platform doesn't hardcode any). */
  extraTokenAudiences?: string[];
  /** Additional environment variables a deployment's tools need (e.g. a service
   *  URL). DEPLOYMENT-supplied; this platform sets none of its own here. */
  extraEnv?: Array<{ name: string; value: string }>;
  /** Public base URL of the chat UI (e.g. https://scooter.example.com). When set,
   *  each sandbox gets CONVERSATION_URL = <publicUrl>/?thread=<id> — a ready
   *  shareable link to THIS conversation, so the agent can point a human at it
   *  (e.g. "approve my AWS request here") without knowing the deployment host. */
  publicUrl?: string;
  kubeConfig?: KubeConfig;
}

export function createK8sProvisioner(opts: K8sProvisionerOptions): SandboxProvisioner {
  const kc = opts.kubeConfig ?? defaultKubeConfig();
  const core = kc.makeApiClient(CoreV1Api);
  const custom = kc.makeApiClient(CustomObjectsApi);
  const ns = opts.namespace;
  const audience = opts.brokerAudience ?? "agent-broker";
  const storage = opts.workspaceStorage ?? "10Gi";
  // Sandbox container resources (see the option doc): default requests spread pods
  // across nodes; a memory limit protects the node from a runaway build; no cpu
  // limit lets bursty nix builds use spare CPU.
  const sandboxResources = opts.sandboxResources ?? {
    requests: { cpu: "500m", memory: "1Gi" },
    limits: { memory: "4Gi" },
  };

  const sandboxName = (id: string) => `conv-${id}`;
  const saName = (id: string) => `sandbox-${id}`;
  // The per-conversation module ConfigMap the agent-host owns: the agent's
  // self-authored module.nix lives here (durable across suspend/resume). Mounted
  // read-only into the pod; scooter-apply-module reads it.
  const moduleCmName = (id: string) => `conv-${id}-module`;
  // The module CM volume + mount shape — MUST match sandboxManifest's (the
  // "scooter-conv" volume mounted read-only at scooterModule.dir). ensureModuleMount
  // patches these into an old Sandbox's podTemplate that predates the module CM.
  const MODULE_VOLUME_NAME = "scooter-conv";
  const MODULE_MOUNT_PATH = "/etc/agent-sandbox/scooter";

  // The deployment's BASE .scooter files — read from its scooterConfigMap. Used to
  // SEED each conversation's module CM so the deployment's injected tools land + the
  // boot converge has real content. Returns ALL data keys, not just module.nix: the
  // .scooter mount is a DIRECTORY (module.nix + flake.nix + the tool sources, e.g. a
  // review-app CLI script), and the LAZY tool path resolves
  // `path:/etc/agent-sandbox/scooter#<tool>` from the mounted flake — so module.nix
  // ALONE (the old behavior) declares a lazy stub whose `flake.nix` isn't there, and
  // the tool never lands on PATH (the deployment-scooter-injection bug: copy ALL keys,
  // not just module.nix). Best-effort: no CM configured, a missing CM, or a CM with an
  // empty/absent module.nix all yield {} (base config only) — a read failure must
  // never block conversation creation.
  const deploymentScooterFiles = async (cmName?: string): Promise<Record<string, string>> => {
    if (!cmName) return {};
    try {
      const cm = await core.readNamespacedConfigMap({ name: cmName, namespace: ns });
      const data = cm.data ?? {};
      // Treat an empty/whitespace module.nix as "nothing to seed" (base config only),
      // to preserve the prior semantics — don't seed sibling files onto a hollow module.
      if ((data["module.nix"] ?? "").trim() === "") return {};
      return data;
    } catch (e) {
      console.warn(`[k8sProvisioner] could not read deployment scooterConfigMap '${cmName}' to seed the module (using base config):`, e);
      return {};
    }
  };

  // A ref's namespace may be EMPTY: hydrateEntry() (manager.ts) hands out a
  // placeholder ref { name, namespace: "" } for a conversation whose Sandbox is
  // absent from reconcile (GC'd / suspended-and-gone). A k8s namespaced call with
  // namespace:"" is sent at the CLUSTER scope, which the namespaced Role can't
  // authorize → a 403 "cannot patch sandboxes at the cluster scope" that floods
  // every idle sweep. The provisioner only ever manages Sandboxes in its own `ns`,
  // so an empty ref namespace ALWAYS means `ns` — normalize it here. (If the
  // Sandbox is genuinely gone, the call then 404s in-namespace, which suspend()'s
  // callers already tolerate — far better than a cluster-scope auth failure.)
  const refNs = (ref: SandboxRef) => ref.namespace || ns;

  // v1alpha1: replicas 0 = suspended (pod dropped, PVCs kept), 1 = running.
  // A plain-object body negotiates application/merge-patch+json.
  const setReplicas = async (ref: SandboxRef, replicas: 0 | 1) => {
    await custom.patchNamespacedCustomObject(
      {
        group: GROUP,
        version: VERSION,
        namespace: refNs(ref),
        plural: PLURAL,
        name: ref.name,
        body: { spec: { replicas } },
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
  };

  return {
    async create(id: string, threadId?: string): Promise<SandboxRef> {
      // The URL deep-links on the FULL conversation id (threadId), NOT the short
      // DNS-safe hash used for resource names — else the shared link resolves to a
      // different (empty) conversation and permission prompts land in the wrong place.
      const urlThread = threadId ?? id;
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

      // 1b. the per-conversation module ConfigMap (agent-host-owned). It must exist
      // BEFORE the Sandbox so the podTemplate can mount it from pod birth (a CM
      // created later won't appear as a volume; the kubelet only live-updates the
      // CONTENTS of an already-mounted CM).
      //
      // SEED it from the deployment's .scooter files (the scooterConfigMap), NOT
      // empty. Because this per-conv CM OWNS the converge path
      // (/etc/agent-sandbox/scooter), the deployment's own scooter-tools mount is
      // skipped when it's present — so if we seeded "" the deployment's injected
      // tools (e.g. a review CLI) would NEVER land, and the boot converge would
      // no-op on a 0-byte module. Seed ALL keys (module.nix + flake.nix + the tool
      // sources): the lazy tool path resolves `path:/etc/agent-sandbox/scooter#<tool>`
      // from the mounted flake, so module.nix alone leaves the stub without its
      // flake.nix and the tool never lands on PATH. Always ensure a module.nix key
      // exists so the converge + the merge-patch path below have something to write.
      const seedFiles = await deploymentScooterFiles(opts.scooterConfigMap);
      await core
        .createNamespacedConfigMap({
          namespace: ns,
          body: {
            metadata: { name: moduleCmName(id), namespace: ns },
            data: { "module.nix": "", ...seedFiles },
          },
        })
        .catch((e: { code?: number }) => {
          if (e?.code !== 409) throw e;
        });

      // 2. the cold Sandbox (SA + workspace PVC + projected broker token)
      const name = sandboxName(id);
      let alreadyExisted = false;
      await custom
        .createNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: ns,
          plural: PLURAL,
          body: sandboxManifest(id, name, saName(id), opts.sandboxImage, ns, audience, storage, opts.awsAccountsConfigMap, opts.systemdImage ?? false, {
            scooterConfigMap: opts.scooterConfigMap,
            configFilesConfigMap: opts.configFilesConfigMap,
            extraTokenAudiences: opts.extraTokenAudiences ?? [],
            // A ready shareable link to THIS conversation (when a public URL is
            // configured), so the agent can point a human at its own conversation.
            extraEnv: [
              ...(opts.publicUrl
                ? [{ name: "CONVERSATION_URL", value: `${opts.publicUrl.replace(/\/$/, "")}/?thread=${encodeURIComponent(urlThread)}` }]
                : []),
              ...(opts.extraEnv ?? []),
            ],
            overlayStore: opts.overlayStore ?? false,
            overlayStorage: opts.overlayStorage,
            moduleConfigMap: moduleCmName(id),
            resources: sandboxResources,
          }),
        })
        .catch((e: { code?: number }) => {
          // 409 AlreadyExists = the Sandbox is already there. This is the recovery
          // for a WRONG hydrate map (a boot reconcile failed → this conversation
          // wasn't seen → we took the create path for a Sandbox that exists). Treat
          // it as REUSE: adopt the existing Sandbox rather than throw the 409 up to
          // /agui (where it became a silent no-run — the hydrate-silent-drop bug).
          if (e?.code !== 409) throw e;
          alreadyExisted = true;
        });

      // If it already existed it may be SUSPENDED (replicas=0) — ensure it's running
      // so the run can actually execute. setReplicas(1) is idempotent (a running
      // Sandbox stays running); a create-from-fresh already has replicas=1.
      if (alreadyExisted) {
        await setReplicas({ name, namespace: ns }, 1).catch((e) => {
          console.warn(`[k8sProvisioner] adopted existing Sandbox ${name} but resume failed (may already be running):`, e);
        });
      }

      return { name, namespace: ns };
    },

    async suspend(ref: SandboxRef): Promise<void> {
      // A Sandbox that's already GONE (GC'd / never re-created after a restart)
      // is, for suspend's purposes, already suspended — there is nothing to drop.
      // Swallow the 404 so the idle sweep marks the conversation suspended and
      // stops re-attempting every tick (a stale hydrated entry would otherwise
      // churn the same failing patch forever). Any other error still propagates.
      await setReplicas(ref, 0).catch(ignoreDeleteNotFound);
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
      // Same empty-namespace hazard as setReplicas: a placeholder ref would send
      // these deletes to the cluster scope (403). Normalize to the provisioner ns.
      const dns = refNs(ref);
      await custom
        .deleteNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: dns,
          plural: PLURAL,
          name: ref.name,
        })
        .catch(ignoreDeleteNotFound);
      await core
        .deleteNamespacedServiceAccount({ name: saName(id), namespace: dns })
        .catch(ignoreDeleteNotFound);
      await core
        .deleteNamespacedConfigMap({ name: moduleCmName(id), namespace: dns })
        .catch(ignoreDeleteNotFound);
    },

    // Persist the agent's self-authored module into the per-conversation module
    // ConfigMap (durable across suspend/resume; the boot oneshot re-applies it on
    // a fresh pod). The agent-host calls this AFTER a clean live apply (the
    // moduleManager build-before-persist gate), so the CM only ever holds a
    // switch-clean module. Merge-patch just the module.nix key.
    async writeModule(conversationId: string, module: string): Promise<void> {
      // UPSERT, not patch-only: a merge-patch 404s when the ConfigMap doesn't
      // exist, which happens for conversations created before module-CM
      // provisioning, or a hydrated/revived conversation whose CM was GC'd —
      // making modify_environment fail with a bewildering k8s 404 even though the
      // Nix build succeeded. Patch first (the common case: the CM exists and is
      // mounted, so a merge-patch propagates to the running pod live); on 404,
      // create it so the module at least persists for the next pod's boot
      // re-converge. NOTE: a CM created here is NOT mounted into an ALREADY-running
      // pod (kubelet only live-updates the contents of a CM mounted at pod birth)
      // — the durable persistence is the win; the live apply still needs the CM to
      // have existed at create() time.
      const cmName = moduleCmName(conversationId);
      await core
        .patchNamespacedConfigMap(
          { name: cmName, namespace: ns, body: { data: { "module.nix": module } } },
          setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
        )
        .catch(async (e: { code?: number }) => {
          if (e?.code !== 404) throw e;
          await core.createNamespacedConfigMap({
            namespace: ns,
            body: {
              metadata: { name: cmName, namespace: ns },
              data: { "module.nix": module },
            },
          });
        });
    },

    // Self-heal: ensure the Sandbox podTemplate MOUNTS the module CM so the boot
    // re-converge (which reads MODULE_MOUNT_PATH/module.nix) actually sees the
    // agent's module. Sandboxes created before module-CM provisioning have no such
    // volume/mount — a CM sync would never reach their pod. Idempotent: a Sandbox
    // that already mounts it is left untouched (no needless generation bump). Must
    // run BEFORE the pod boots (revive orders it ahead of resume) so the recreated
    // pod picks up the volume. Read-modify-write the arrays (a merge-patch REPLACES
    // arrays, so we must send the full, augmented lists).
    async ensureModuleMount(conversationId: string): Promise<void> {
      const name = sandboxName(conversationId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let sb: any;
      try {
        sb = await custom.getNamespacedCustomObject({
          group: GROUP, version: VERSION, namespace: ns, plural: PLURAL, name,
        });
      } catch (e) {
        // No Sandbox yet (never created / GC'd) — nothing to repair; create() will
        // make one WITH the mount. A 404 here is benign; anything else propagates.
        if ((e as { code?: number })?.code === 404) return;
        throw e;
      }
      const podSpec = sb?.spec?.podTemplate?.spec;
      if (!podSpec) return; // malformed / unexpected shape — leave it alone
      const volumes: Array<{ name: string }> = podSpec.volumes ?? [];
      const container = (podSpec.containers ?? [])[0];
      if (!container) return;
      const mounts: Array<{ name: string }> = container.volumeMounts ?? [];

      const hasVolume = volumes.some((v) => v.name === MODULE_VOLUME_NAME);
      const hasMount = mounts.some((m) => m.name === MODULE_VOLUME_NAME);
      if (hasVolume && hasMount) return; // already wired — idempotent no-op

      const newVolumes = hasVolume
        ? volumes
        : [...volumes, { name: MODULE_VOLUME_NAME, configMap: { name: moduleCmName(conversationId) } }];
      const newMounts = hasMount
        ? mounts
        : [...mounts, { name: MODULE_VOLUME_NAME, mountPath: MODULE_MOUNT_PATH, readOnly: true }];

      // Merge-patch the podTemplate.spec: replace volumes (top-level) and the
      // container list (the container array is atomic under merge-patch, so we send
      // the whole container[0] with its augmented volumeMounts).
      const patchedContainer = { ...container, volumeMounts: newMounts };
      await custom.patchNamespacedCustomObject(
        {
          group: GROUP, version: VERSION, namespace: ns, plural: PLURAL, name,
          body: {
            spec: {
              podTemplate: {
                spec: {
                  volumes: newVolumes,
                  containers: [patchedContainer, ...(podSpec.containers ?? []).slice(1)],
                },
              },
            },
          },
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
    configFilesConfigMap?: string;
    extraTokenAudiences?: string[];
    extraEnv?: Array<{ name: string; value: string }>;
    overlayStore?: boolean;
    overlayStorage?: string;
    moduleConfigMap?: string;
    resources?: {
      requests?: { cpu?: string; memory?: string };
      limits?: { cpu?: string; memory?: string };
    };
  } = {},
): object {
  const scooter = deploy.scooterConfigMap;
  // Deployment config files (filename -> contents) mounted as a flat dir. See the
  // deploy option type. Byte-for-byte via the kubelet, so multi-line config is safe.
  const configFilesCm = deploy.configFilesConfigMap;
  const configFilesMountPath = "/etc/agent-sandbox/config";
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
              // Requests spread sandboxes across nodes; the memory limit stops a
              // runaway build from OOM-ing the node. Omitted keys (e.g. no cpu limit)
              // simply aren't emitted.
              ...(deploy.resources ? { resources: deploy.resources } : {}),
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
                // Deployment config files (filename -> contents) as a flat read-only
                // dir. File-based so multi-line config survives the CRD controller.
                ...(configFilesCm
                  ? [{ name: "deploy-config", mountPath: configFilesMountPath, readOnly: true }]
                  : []),
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
            ...(configFilesCm
              ? [{ name: "deploy-config", configMap: { name: configFilesCm } }]
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
