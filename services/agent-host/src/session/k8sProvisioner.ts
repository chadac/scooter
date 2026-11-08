/**
 * Production SandboxProvisioner: creates the cold per-conversation Sandbox via the
 * agent-sandbox CRD, mirroring modules/conversation.nix. Each conversation gets a
 * ServiceAccount sandbox-{id} (its broker identity) and a Sandbox conv-{id} (SA +
 * workspace PVC + broker token volume); suspend/resume flip spec.operatingMode and
 * destroy deletes the Sandbox and SA. The conversation-state PVC is mounted by the
 * agent-host itself and managed by the ConversationStore.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import {
  KubeConfig,
  CoreV1Api,
  CustomObjectsApi,
  setHeaderOptions,
  PatchStrategy,
  type V1Pod,
} from "@kubernetes/client-node";

import type { SandboxRef } from "../types.js";
import type { PendingRestart, ProvisionedRef, SandboxProvisioner, SandboxRestartResult } from "./manager.js";
import { formatError, logger } from "../log.js";
import { diagnosePodWait } from "../exec/podDiagnosis.js";
import { applyOverlay, deepMerge, parseOverlay } from "./sandboxOverlay.js";
import { sandboxOrigin, type SandboxOrigins } from "../proxy/sandboxOrigin.js";
import { cpuToMillicores, memoryToBytes } from "./resourceFit.js";
import type { ReserveFn } from "./warmStore.js";
import {
  InvalidResourceError,
  type RenderedResources,
  type SandboxResources,
  type SandboxSizePreset,
  parsePresets,
  presetToResources,
  renderResources,
  unrenderResources,
  validateResources,
} from "./resources.js";

const log = logger("k8sProvisioner");

/** Delete-error policy: a 404 means the object is already gone and is ignored; every other error
 *  means the delete did not happen and is rethrown. */
export function ignoreDeleteNotFound(e: { code?: number }): void {
  if (e?.code !== 404) throw e;
}

const GROUP = "agents.x-k8s.io";
// agent-sandbox v0.5.x serves v1beta1, where suspend/resume is `spec.operatingMode`.
const VERSION = "v1beta1";
const PLURAL = "sandboxes";
const SANDBOX_NAME_LABEL = "agents.x-k8s.io/sandbox-name";
/** On a suspended overlay PVC: the controller may reclaim its PV. */
export const RELEASE_LABEL = "scooter.io/release";
/** The ConfigMap key holding the consumer manifest-overlay payload. */
const OVERLAY_KEY = "overlay.yaml";
/** The enabled contribs' sandbox-pod parts, in the same ConfigMap and overlay shape, merged under
 *  the consumer's key so a deployment wins a name collision. */
const CONTRIB_OVERLAY_KEY = "contrib.yaml";

/** How long to wait for a cycled sandbox's pod to disappear, and how often to look. */
const POD_GONE_TIMEOUT_MS = 60_000;
const POD_GONE_POLL_MS = 1_500;
/** How long restart() waits for the new pod. */
const POD_READY_TIMEOUT_MS = 180_000;
/** Backoff before each image-reconcile retry. */
const RECONCILE_RETRY_DELAYS_MS = [3_000, 6_000];

type EnvVar = { name: string; value?: string };
/** The container env vars `conversationEnv` owns; resume reconciles exactly these. */
const CONVERSATION_ENV = ["CONVERSATION_URL", "CONVERSATION_ID", "SCOOTER_SERVICES_ORIGIN"];
/** Exists only once NixOS activation has linked /run/current-system. */
export const ACTIVATED_PROBE = "/run/current-system/sw/bin/true";
/** Fits the image's 90s shutdown GC plus normal shutdown. */
const OVERLAY_GRACE_SECONDS = 150;
/** Annotation: hash of the platform template the podTemplate came from. */
export const TEMPLATE_HASH_ANNOTATION = "scooter.io/template-hash";

/** Sorted-key JSON, so equal values serialize identically. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

type PodTemplate = { metadata?: Record<string, unknown>; spec?: Record<string, any> };

/** Template minus resources: size belongs to the conversation. */
function platformPart(pt: PodTemplate | undefined): PodTemplate {
  const copy = structuredClone(pt ?? {}) as PodTemplate;
  for (const c of (copy.spec?.containers ?? []) as Array<Record<string, unknown>>) delete c.resources;
  return copy;
}

/** A short hash of the platform's half of a pod template. */
export function templateHash(pt: PodTemplate | undefined): string {
  return createHash("sha256").update(canonical(platformPart(pt))).digest("hex").slice(0, 16);
}

/** Differing pod spec keys, and `container.<key>` for the sandbox. */
export function templateDiff(have: PodTemplate | undefined, want: PodTemplate | undefined): string[] {
  const a = platformPart(have);
  const b = platformPart(want);
  const differ = (x: unknown, y: unknown) => canonical(x) !== canonical(y);
  const keys = (x: object | undefined, y: object | undefined) => [...new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])].sort();
  const out: string[] = [];
  if (differ(a.metadata, b.metadata)) out.push("metadata");
  const as = a.spec ?? {};
  const bs = b.spec ?? {};
  for (const k of keys(as, bs)) if (k !== "containers" && differ(as[k], bs[k])) out.push(k);
  const ac: Array<Record<string, unknown>> = as.containers ?? [];
  const bc: Array<Record<string, unknown>> = bs.containers ?? [];
  for (const k of keys(ac[0], bc[0])) if (differ(ac[0]?.[k], bc[0]?.[k])) out.push(`container.${k}`);
  if (differ(ac.slice(1), bc.slice(1))) out.push("containers");
  return out;
}

type ClaimTemplate = { metadata?: { name?: string } };
const claimNames = (vcts: ClaimTemplate[] | undefined) => (vcts ?? []).map((v) => v.metadata?.name ?? "").sort().join(",");

/** The tag portion of an OCI ref (the part after the last ':' that is not a registry port), or ""
 *  when untagged; agrees with the kubenix and controller derivations of the pool version key. */
export function imageTagOf(imageRef: string): string {
  if (!imageRef) return "";
  const ref = imageRef.split("@", 1)[0]; // strip any digest
  const idx = ref.lastIndexOf(":");
  if (idx < 0) return "";
  const tag = ref.slice(idx + 1);
  return tag.includes("/") ? "" : tag; // a ':' before a '/' is a registry port, not a tag
}

/** Compares cpu and memory by value, not string. */
export function sameResources(a: RenderedResources | undefined, b: RenderedResources | undefined): boolean {
  const norm = (k: string, v: string | undefined) =>
    v === undefined ? undefined : k === "cpu" ? cpuToMillicores(v) ?? v : k === "memory" ? memoryToBytes(v) ?? v : v;
  const side = (x: Record<string, string> | undefined, y: Record<string, string> | undefined) => {
    const keys = new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})]);
    for (const k of keys) if (norm(k, x?.[k]) !== norm(k, y?.[k])) return false;
    return true;
  };
  return side(a?.requests, b?.requests) && side(a?.limits, b?.limits);
}

export interface K8sProvisionerOptions {
  namespace: string;
  /** Generic Nix sandbox image ref. */
  sandboxImage: string;
  /** Workspace PVC size, e.g. "10Gi". */
  workspaceStorage?: string;
  /** Mount a disk-backed PVC as the writable upper of the local-overlay Nix store so runtime builds
   *  persist across suspend/resume; off means an ephemeral emptyDir upper. */
  overlayStore?: boolean;
  /** Overlay-store upper PVC size, e.g. "20Gi"; only used when overlayStore is true. */
  overlayStorage?: string;
  /** Resource requests/limits for the sandbox container; the default is requests == limits on cpu
   *  (2) and memory (4Gi) for Guaranteed QoS, so a runaway sandbox is hard-capped rather than
   *  starving its neighbours. */
  sandboxResources?: RenderedResources;
  /** The deployment's named size catalog as JSON (SANDBOX_SIZES_JSON), name -> {cpu, memory, gpu?,
   *  hint?}; empty means no presets. */
  sizePresetsJson?: string;
  /** Which preset is the default (SANDBOX_DEFAULT_SIZE_NAME), shown in the UI; the rendered default
   *  itself arrives as sandboxResources. */
  defaultSizeName?: string;
  /** Broker token audience (projected SA token). */
  brokerAudience?: string;
  /** Run the sandbox container as a systemd-PID-1 NixOS dev environment (tmpfs on /run and /tmp);
   *  set when sandboxImage is the agent-sandbox-os image. */
  systemdImage?: boolean;
  /** imagePullPolicy for the sandbox pod (SANDBOX_PULL_POLICY); default "Always", with
   *  "IfNotPresent"/"Never" for a side-loaded local cluster. */
  sandboxPullPolicy?: "Always" | "IfNotPresent" | "Never";
  /** A deployment's `.scooter` ConfigMap (its own injected Nix tools), mounted at
   *  /etc/agent-sandbox/scooter. */
  scooterConfigMap?: string;
  /** Name of the ConfigMap holding a consumer Sandbox-manifest overlay
   *  (SANDBOX_MANIFEST_OVERLAY_CONFIGMAP), read at every create so an edit lands on the next
   *  conversation; undefined = no overlay. */
  manifestOverlayConfigMap?: string;
  /** A deployment's config-files ConfigMap (filename -> contents), mounted as a flat dir at
   *  /etc/agent-sandbox/config. */
  configFilesConfigMap?: string;
  /** Additional deployment-supplied projected SA token audiences, each mounted at
   *  /var/run/secrets/<audience>/token. */
  extraTokenAudiences?: string[];
  /** Additional deployment-supplied environment variables for the sandbox. */
  extraEnv?: Array<{ name: string; value: string }>;
  /** Public base URL of the chat UI; when set each sandbox gets CONVERSATION_URL =
   *  <publicUrl>/?thread=<id>, a shareable link to its own conversation. */
  publicUrl?: string;
  /** Per-conversation service origins; when set each sandbox gets SCOOTER_SERVICES_ORIGIN, and its
   *  web services serve at /<service> instead of /c/<id>/<service>. */
  sandboxOrigins?: SandboxOrigins;
  /** RuntimeClass for the systemd sandbox pod (e.g. "crun"): a cgroup-delegating runtime gives
   *  systemd PID 1 a writable cgroup subtree without `privileged`; unset means the cluster default,
   *  and it is ignored for the generic image. */
  sandboxRuntimeClass?: string;
  /** Sandbox PVCs keyed by claim name (SANDBOX_VOLUME_CLAIMS), each replacing the built-in claim. */
  volumeClaims?: VolumeClaims;
  /** Backoff before each image-reconcile retry (default 3s, 6s). */
  reconcileRetryDelaysMs?: number[];
  /** Warm overlay pool: reserve on start, release on suspend. */
  warmStore?: {
    reserve: ReserveFn;
    /** Pool StorageClass for new overlay PVCs, to bind reserved PVs. */
    storageClass?: string;
  };
  /** Pod poll interval for restart (default 1.5s). */
  podPollMs?: number;
  /** How long restart waits for the new pod to be Ready. */
  podReadyTimeoutMs?: number;
  /** Run the systemd sandbox in its own user namespace (hostUsers: false) with an unmasked /proc, so
   *  its root and SYS_ADMIN map to an unprivileged host uid and Nix's build sandbox can run. */
  sandboxUserNamespace?: boolean;
  kubeConfig?: KubeConfig;
}

/** The size half of the provisioner (read/write a conversation's size, list the presets), keyed by
 *  the short conversation id rather than a SandboxRef. */
export interface SandboxSizeClient {
  /** The conversation's size read off its Sandbox CR; undefined when there is no Sandbox or no
   *  resources block. */
  getSize(id: string): Promise<SandboxResources | undefined>;
  /** Write the size (a preset name or raw resources), applied on the next sandbox restart;
   *  `threadId` is only needed when the Sandbox has to be created cold. */
  setSize(id: string, spec: SandboxResources | { size: string }, threadId?: string): Promise<void>;
  /** The deployment's named presets and which one is the default. */
  getSizes(): { sizes: Record<string, SandboxSizePreset>; default: string | null };
}

export type K8sProvisioner = SandboxProvisioner & SandboxSizeClient;

export function createK8sProvisioner(opts: K8sProvisionerOptions): K8sProvisioner {
  const kc = opts.kubeConfig ?? defaultKubeConfig();
  const core = kc.makeApiClient(CoreV1Api);
  const custom = kc.makeApiClient(CustomObjectsApi);
  const ns = opts.namespace;
  const audience = opts.brokerAudience ?? "agent-broker";
  const storage = opts.workspaceStorage ?? "10Gi";
  // Default is the "medium" preset (2 CPU / 4Gi, requests == limits for Guaranteed QoS).
  const sandboxResources = opts.sandboxResources ?? {
    requests: { cpu: "2", memory: "4Gi" },
    limits: { cpu: "2", memory: "4Gi" },
  };

  // The deployment's named size catalog and its default, offered by name to the agent and UI.
  const presets = parsePresets(opts.sizePresetsJson);

  const sandboxName = (id: string) => `conv-${id}`;
  /** Inverse of sandboxName: recover the conversation id from a Sandbox name. */
  const convIdOf = (name: string) => (name.startsWith("conv-") ? name.slice("conv-".length) : name);
  const saName = (id: string) => `sandbox-${id}`;
  // Reap-only: destroy() deletes this ConfigMap where a cluster still carries one.
  const moduleCmName = (id: string) => `conv-${id}-module`;


  // A placeholder ref from hydrateEntry() has an empty namespace, which k8s would send at the
  // cluster scope (a 403); the provisioner only manages Sandboxes in `ns`, so an empty namespace
  // always means `ns`.
  const refNs = (ref: SandboxRef) => ref.namespace || ns;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const podPollMs = opts.podPollMs ?? POD_GONE_POLL_MS;
  const podReadyTimeoutMs = opts.podReadyTimeoutMs ?? POD_READY_TIMEOUT_MS;
  const retryDelays = opts.reconcileRetryDelaysMs ?? RECONCILE_RETRY_DELAYS_MS;

  // operatingMode "Suspended" drops the pod and keeps the PVCs; a plain-object body negotiates
  // application/merge-patch+json.
  const setOperatingMode = async (ref: SandboxRef, operatingMode: "Running" | "Suspended") => {
    await custom.patchNamespacedCustomObject(
      {
        group: GROUP,
        version: VERSION,
        namespace: refNs(ref),
        plural: PLURAL,
        name: ref.name,
        body: { spec: { operatingMode } },
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
  };

  const overlayPvc = (ref: SandboxRef) => `scooter-rw-${ref.name}`;

  /** Set or clear the overlay PVC's release label; tolerates absence. */
  const labelOverlay = async (ref: SandboxRef, value: string | null) => {
    await core
      .patchNamespacedPersistentVolumeClaim(
        { name: overlayPvc(ref), namespace: refNs(ref), body: { metadata: { labels: { [RELEASE_LABEL]: value } } } },
        setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
      )
      .catch(ignoreDeleteNotFound);
  };

  /** Unrelease the overlay PVC and reserve a PV; best-effort. */
  const prepareOverlay = async (ref: SandboxRef): Promise<void> => {
    const ws = opts.warmStore;
    if (!ws) return;
    await labelOverlay(ref, null).catch((e) =>
      log.warn("could not clear the overlay release label", { sandbox: ref.name, error: formatError(e) }),
    );
    await ws.reserve(ref.name, imageTagOf(opts.sandboxImage));
  };

  // --- image skew ---------------------------------------------------------
  // Nothing re-renders a Sandbox CR, so every path to Running reconciles the image an upgrade left
  // stale.

  /** The sandbox container's image when it differs from the deployment's current one, else
   *  undefined; an unset image on either side is not skew. */
  const staleImage = (containers: Array<{ image?: string }>): string | undefined => {
    const have = containers[0]?.image;
    return have && opts.sandboxImage && have !== opts.sandboxImage ? have : undefined;
  };

  /** The env derived from the conversation, which resume reconciles like the image: a sandbox
   *  created before a platform change (e.g. sandbox origins) otherwise keeps its old values. */
  const conversationEnv = (urlThread: string): Array<{ name: string; value: string }> => {
    const origin = sandboxOrigin(urlThread, opts.sandboxOrigins);
    return [
      // A shareable link to this conversation, when a public URL is configured.
      ...(opts.publicUrl
        ? [{ name: "CONVERSATION_URL", value: `${opts.publicUrl.replace(/\/$/, "")}/?thread=${encodeURIComponent(urlThread)}` }]
        : []),
      // The full threadId, which web services read to serve under /c/$CONVERSATION_ID/<name>; always set.
      { name: "CONVERSATION_ID", value: urlThread },
      // This conversation's own services origin (https://<label>.<domain>), when configured.
      ...(origin ? [{ name: "SCOOTER_SERVICES_ORIGIN", value: origin }] : []),
    ];
  };

  /** The container env with the conversation-derived vars brought up to date, or undefined when
   *  they already are. The thread comes from the CR's own CONVERSATION_ID, so resume callers
   *  that don't know it still reconcile; an unset var the platform no longer sets is removed. */
  const staleEnv = (container: { env?: EnvVar[] } | undefined): EnvVar[] | undefined => {
    const env = container?.env ?? [];
    const thread = env.find((e) => e.name === "CONVERSATION_ID")?.value;
    if (!thread) return undefined;
    const want = conversationEnv(thread);
    const owned = (e: EnvVar) => CONVERSATION_ENV.includes(e.name);
    const key = (vs: EnvVar[]) => JSON.stringify(vs.filter(owned).map((e) => [e.name, e.value ?? null]).sort());
    if (key(env) === key(want)) return undefined;
    return [...env.filter((e) => !owned(e)), ...want];
  };

  /**
   * Read and parse the consumer manifest-overlay ConfigMap on every create (no caching),
   * treating an absent ConfigMap as no overlay and a malformed payload as an OverlayError.
   */
  const loadManifestOverlay = async (): Promise<Record<string, unknown> | undefined> => {
    const cmName = opts.manifestOverlayConfigMap;
    if (!cmName) return undefined;
    let cm: { data?: Record<string, string> };
    try {
      cm = await core.readNamespacedConfigMap({ name: cmName, namespace: ns });
    } catch (e) {
      if ((e as { code?: number })?.code !== 404) throw e;
      log.warn("manifest-overlay ConfigMap not found; no overlay applied", {
        configmap: cmName,
        namespace: ns,
      });
      return undefined;
    }
    // Contrib parts first, the consumer's patch merged on top, so a deployment overrides a
    // contrib's env or volume by name.
    const merged = deepMerge(
      parseOverlay(cm.data?.[CONTRIB_OVERLAY_KEY]),
      parseOverlay(cm.data?.[OVERLAY_KEY]),
    ) as Record<string, unknown>;
    return Object.keys(merged).length > 0 ? merged : undefined;
  };

  type SandboxCr = {
    metadata?: { resourceVersion?: string; annotations?: Record<string, string> };
    spec?: {
      operatingMode?: string;
      podTemplate?: PodTemplate & {
        spec?: { containers?: Array<{ image?: string; env?: EnvVar[]; resources?: RenderedResources }> };
      };
      volumeClaimTemplates?: ClaimTemplate[];
    };
  };
  const readCr = async (ref: SandboxRef): Promise<SandboxCr> =>
    (await custom.getNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: refNs(ref), plural: PLURAL, name: ref.name,
    })) as SandboxCr;
  const isRunning = (sb: SandboxCr) => (sb.spec?.operatingMode ?? "Running") !== "Suspended";

  /** A fresh render keeping size and conversation; undefined if claims differ. */
  const desiredTemplate = async (name: string, sb: SandboxCr, threadId?: string): Promise<PodTemplate | undefined> => {
    const c0 = sb.spec?.podTemplate?.spec?.containers?.[0];
    const id = convIdOf(name);
    const thread = c0?.env?.find((e) => e.name === "CONVERSATION_ID")?.value ?? threadId ?? id;
    const claims = sb.spec?.volumeClaimTemplates;
    // Use the CR's own claims, so a PVC never detaches.
    const overlayStore = (claims ?? []).some((v) => v.metadata?.name === "scooter-rw");
    const m = await manifestFor(id, thread, c0?.resources ?? sandboxResources, "Running", { overlayStore });
    if (claimNames(m.spec.volumeClaimTemplates) !== claimNames(claims)) return undefined;
    return m.spec.podTemplate as PodTemplate;
  };

  /** Fallback when re-render is impossible: patch image and env only. */
  const reconcileImageEnv = async (ref: SandboxRef, sb: SandboxCr): Promise<boolean> => {
    const containers = sb.spec?.podTemplate?.spec?.containers ?? [];
    const stale = staleImage(containers);
    const env = staleEnv(containers[0]);
    if (!stale && !env) return false;
    log.warn("sandbox template skew: adopting the deployment's current image and conversation env", {
      sandbox: ref.name,
      from_image: stale,
      to_image: stale ? opts.sandboxImage : undefined,
      env_changed: env ? CONVERSATION_ENV : undefined,
    });
    await custom.patchNamespacedCustomObject(
      {
        group: GROUP, version: VERSION, namespace: refNs(ref), plural: PLURAL, name: ref.name,
        body: {
          spec: {
            podTemplate: {
              spec: {
                containers: [
                  { ...containers[0], ...(stale ? { image: opts.sandboxImage } : {}), ...(env ? { env } : {}) },
                  ...containers.slice(1),
                ],
              },
            },
          },
        },
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
    return true;
  };

  /** Re-renders the pod template if the platform half changed. */
  const reconcileTemplate = async (
    ref: SandboxRef,
    threadId?: string,
  ): Promise<{ running: boolean; changed: boolean; overlay: boolean }> => {
    const sb = await readCr(ref);
    const running = isRunning(sb);
    const overlay = (sb.spec?.volumeClaimTemplates ?? []).some((v) => v.metadata?.name === "scooter-rw");
    let want: PodTemplate | undefined;
    try {
      want = await desiredTemplate(ref.name, sb, threadId);
      if (!want) log.warn("sandbox claims differ from the current render; adopting only image and env", { sandbox: ref.name });
    } catch (e) {
      log.warn("could not render the sandbox template; adopting only image and env", { sandbox: ref.name, error: formatError(e) });
    }
    if (!want) return { running, overlay, changed: await reconcileImageEnv(ref, sb) };

    const hash = templateHash(want);
    const annotations = sb.metadata?.annotations;
    if (annotations?.[TEMPLATE_HASH_ANNOTATION] === hash) return { running, overlay, changed: false };
    const current = sb.spec?.podTemplate;
    const changed = templateDiff(current, want);
    const ops: Array<{ op: string; path: string; value: unknown }> = [];
    // Fails on a concurrent resize; the caller retries.
    if (sb.metadata?.resourceVersion) ops.push({ op: "test", path: "/metadata/resourceVersion", value: sb.metadata.resourceVersion });
    ops.push(
      annotations
        ? { op: "add", path: `/metadata/annotations/${TEMPLATE_HASH_ANNOTATION.replace(/~/g, "~0").replace(/\//g, "~1")}`, value: hash }
        : { op: "add", path: "/metadata/annotations", value: { [TEMPLATE_HASH_ANNOTATION]: hash } },
    );
    // Never touch volumeClaimTemplates: that would detach existing PVCs.
    if (changed.length) ops.push({ op: "add", path: "/spec/podTemplate", value: want });
    await custom.patchNamespacedCustomObject(
      { group: GROUP, version: VERSION, namespace: refNs(ref), plural: PLURAL, name: ref.name, body: ops },
      setHeaderOptions("Content-Type", PatchStrategy.JsonPatch),
    );
    if (changed.length) {
      log.info("sandbox template adopted", {
        sandbox: ref.name,
        changed,
        from_image: current?.spec?.containers?.[0]?.image,
        to_image: (want.spec?.containers as Array<{ image?: string }> | undefined)?.[0]?.image,
        cycling_pod: running,
      });
    }
    return { running, overlay, changed: changed.length > 0 };
  };

  /** The sandbox's pods; the controller strips our label, so also read by name. */
  const sandboxPods = async (ref: SandboxRef): Promise<V1Pod[]> => {
    const namespace = refNs(ref);
    const pods = (await core.listNamespacedPod({ namespace, labelSelector: `${SANDBOX_NAME_LABEL}=${ref.name}` })).items;
    if (!pods.some((p) => p.metadata?.name === ref.name)) {
      const byName = await core.readNamespacedPod({ namespace, name: ref.name }).catch(() => undefined);
      if (byName) pods.push(byName);
    }
    return pods;
  };

  /** Deletes the pod so the CR stays Running throughout. */
  const cyclePod = async (ref: SandboxRef): Promise<void> => {
    const namespace = refNs(ref);
    const pods = await sandboxPods(ref);
    const uids = new Set(pods.map((p) => p.metadata?.uid).filter(Boolean));
    for (const p of pods) {
      if (p.metadata?.name) await core.deleteNamespacedPod({ namespace, name: p.metadata.name }).catch(ignoreDeleteNotFound);
    }
    if (!uids.size) return;
    const deadline = Date.now() + POD_GONE_TIMEOUT_MS;
    for (;;) {
      const now = await sandboxPods(ref).catch(() => undefined);
      if (now && !now.some((p) => uids.has(p.metadata?.uid))) return;
      if (Date.now() > deadline) {
        log.warn("sandbox pod did not terminate before the deadline; continuing", { sandbox: ref.name, timeout_ms: POD_GONE_TIMEOUT_MS });
        return;
      }
      await sleep(podPollMs);
    }
  };

  /** Waits for a ready pod; on timeout, says why it isn't. */
  const waitPodReady = async (ref: SandboxRef): Promise<{ ready: true } | { ready: false; reason: string }> => {
    const deadline = Date.now() + podReadyTimeoutMs;
    for (;;) {
      const pods = await sandboxPods(ref).catch(() => [] as V1Pod[]);
      const ready = pods.some(
        (p) => !p.metadata?.deletionTimestamp && p.status?.phase === "Running" && (p.status?.containerStatuses ?? []).every((c) => c.ready),
      );
      if (ready) return { ready: true };
      if (Date.now() > deadline) return { ready: false, reason: await diagnosePodWait(core, refNs(ref), pods) };
      await sleep(podPollMs);
    }
  };

  /** Brings the Sandbox to Running on the current template. */
  const runOnCurrentTemplate = async (ref: SandboxRef, o: { threadId?: string; forceCycle?: boolean } = {}): Promise<void> => {
    let result: { running: boolean; changed: boolean; overlay: boolean } | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await reconcileTemplate(ref, o.threadId);
        break;
      } catch (e) {
        // 404: the Sandbox is gone; resume() recreates it.
        if ((e as { code?: number })?.code === 404) throw e;
        const delay = retryDelays[attempt];
        if (delay === undefined) {
          log.warn("could not reconcile the sandbox template; running it as-is", {
            sandbox: ref.name,
            attempts: attempt + 1,
            error: formatError(e),
          });
          break;
        }
        log.info("sandbox template reconcile failed; retrying", { sandbox: ref.name, attempt: attempt + 1, error: formatError(e) });
        await sleep(delay);
      }
    }
    // A template patch never restarts a running pod.
    if (o.forceCycle || (result?.running && result.changed)) await cyclePod(ref);
    // Reserve before the pod exists, so the PVC binds the pooled PV.
    if (!result?.running && (result?.overlay ?? opts.overlayStore)) await prepareOverlay(ref);
    await setOperatingMode(ref, "Running");
  };

  /** The running pod's resources; null without a pod. */
  const podResources = async (ref: SandboxRef): Promise<RenderedResources | undefined | null> => {
    const pod = (await sandboxPods(ref))[0];
    if (!pod) return null; // no pod: nothing to compare against
    const containers = pod.spec?.containers ?? [];
    const c = containers.find((x) => x.name === "sandbox") ?? containers[0];
    return (c?.resources ?? undefined) as RenderedResources | undefined;
  };

  /** Whether the recorded size differs from the running pod's. */
  const sizePending = async (ref: SandboxRef, want: RenderedResources | undefined): Promise<boolean> => {
    const have = await podResources(ref);
    if (have === null) return false;
    return !sameResources(want, have);
  };

  /** Render the Sandbox manifest for a conversation; `operatingMode: "Suspended"` makes it cold
   *  (the CR and PVCs exist with no pod), which gives a size set before the first turn somewhere
   *  durable to live. */
  const manifestFor = async (
    id: string,
    urlThread: string,
    resources: RenderedResources | undefined,
    operatingMode: "Running" | "Suspended" = "Running",
    override: { overlayStore?: boolean } = {},
  ): Promise<Record<string, any>> => {
    const m = sandboxManifest(
      id, sandboxName(id), saName(id), opts.sandboxImage, ns, audience, storage,
      opts.systemdImage ?? false,
      {
        scooterConfigMap: opts.scooterConfigMap,
        configFilesConfigMap: opts.configFilesConfigMap,
        extraTokenAudiences: opts.extraTokenAudiences ?? [],
        extraEnv: [...conversationEnv(urlThread), ...(opts.extraEnv ?? [])],
        overlayStore: override.overlayStore ?? opts.overlayStore ?? false,
        overlayStorage: opts.overlayStorage,
        overlayStorageClass: opts.warmStore?.storageClass,
        pullPolicy: opts.sandboxPullPolicy,
        sandboxRuntimeClass: opts.sandboxRuntimeClass,
        volumeClaims: opts.volumeClaims,
        userNamespace: opts.sandboxUserNamespace ?? false,
        resources,
        overlay: await loadManifestOverlay(),
      },
    ) as Record<string, any>;
    if (operatingMode !== "Running") m.spec.operatingMode = operatingMode;
    m.metadata.annotations = { ...m.metadata.annotations, [TEMPLATE_HASH_ANNOTATION]: templateHash(m.spec.podTemplate) };
    return m;
  };

  /** The container `resources` block off a Sandbox CR, undefined when the CR is gone or carries no
   *  block; any other API error propagates so a 403 is not mistaken for "no size set". */
  const readSize = async (id: string): Promise<RenderedResources | undefined> => {
    try {
      const sb = (await custom.getNamespacedCustomObject({
        group: GROUP, version: VERSION, namespace: ns, plural: PLURAL, name: sandboxName(id),
      })) as { spec?: { podTemplate?: { spec?: { containers?: Array<{ resources?: RenderedResources }> } } } };
      return sb.spec?.podTemplate?.spec?.containers?.[0]?.resources;
    } catch (e) {
      if ((e as { code?: number })?.code === 404) return undefined;
      throw e;
    }
  };

  /** The size a (re)created Sandbox comes up at: the CR's own block if it has one, else the
   *  deployment default. */
  const desiredSize = async (id: string): Promise<RenderedResources | undefined> =>
    (await readSize(id)) ?? sandboxResources;

  return {
    async create(id: string, threadId?: string): Promise<ProvisionedRef> {
      // The URL deep-links on the full conversation id, not the short hash used for resource names.
      const urlThread = threadId ?? id;
      // 1. the per-conversation ServiceAccount (broker identity); a 409 from a prior run is
      // tolerated
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
      let alreadyExisted = false;
      // Reserve first: the Sandbox creates its overlay PVC immediately.
      if (opts.overlayStore) await prepareOverlay({ name, namespace: ns });
      await custom
        .createNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: ns,
          plural: PLURAL,
          body: await manifestFor(id, urlThread, await desiredSize(id)),
        })
        .catch((e: { code?: number }) => {
          // 409 AlreadyExists: adopt the existing Sandbox rather than fail the conversation.
          if (e?.code !== 409) throw e;
          alreadyExisted = true;
        });

      // An adopted Sandbox may be suspended or stale.
      if (alreadyExisted) {
        await runOnCurrentTemplate({ name, namespace: ns }, { threadId: urlThread }).catch((e) => {
          log.warn("adopted an existing Sandbox but resume failed (may already be running)", {
            sandbox: name,
            error: formatError(e),
          });
        });
      }

      return alreadyExisted ? { name, namespace: ns } : { name, namespace: ns, fresh: true };
    },

    async suspend(ref: SandboxRef): Promise<void> {
      // A Sandbox that is already gone counts as suspended, so the 404 is swallowed and the idle
      // sweep stops retrying; any other error propagates.
      await setOperatingMode(ref, "Suspended").catch(ignoreDeleteNotFound);
      // Unused once suspended; the controller reclaims it after the pod.
      if (opts.warmStore) {
        await labelOverlay(ref, "requested").catch((e) =>
          log.warn("could not mark the overlay PVC for release", { sandbox: ref.name, error: formatError(e) }),
        );
      }
    },

    async resume(ref: SandboxRef, threadId?: string): Promise<ProvisionedRef> {
      // A Sandbox that is gone cannot be patched, so recreate it: the conversation's work lives on
      // the workspace PVC, which outlives the Sandbox.
      try {
        // Resume adopts any platform template change.
        await runOnCurrentTemplate(ref, { threadId });
      } catch (e) {
        if ((e as { code?: number })?.code !== 404) throw e;
        log.warn("resume: the Sandbox is gone; recreating it", { sandbox: ref.name });
        return await this.create(convIdOf(ref.name), threadId);
      }
      return ref;
    },

    async reconcile(): Promise<Array<{ ref: SandboxRef; running: boolean }>> {
      // operatingMode is omitempty and defaults to Running server-side, so an absent value means
      // Running.
      const list = (await custom.listNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: ns,
        plural: PLURAL,
      })) as { items?: Array<{ metadata?: { name?: string }; spec?: { operatingMode?: string } }> };
      const out: Array<{ ref: SandboxRef; running: boolean }> = [];
      for (const item of list.items ?? []) {
        const name = item.metadata?.name;
        if (!name || !name.startsWith("conv-")) continue;
        out.push({ ref: { name, namespace: ns }, running: (item.spec?.operatingMode ?? "Running") !== "Suspended" });
      }
      return out;
    },

    async pendingRestart(ref: SandboxRef): Promise<PendingRestart | undefined> {
      let sb: SandboxCr;
      try {
        sb = await readCr(ref);
      } catch (e) {
        if ((e as { code?: number })?.code === 404) return undefined;
        throw e;
      }
      const containers = sb.spec?.podTemplate?.spec?.containers ?? [];
      const out: PendingRestart = {};
      const stale = staleImage(containers);
      if (stale) out.image = { from: stale, to: opts.sandboxImage };
      if (staleEnv(containers[0])) out.env = true;
      const want = await desiredTemplate(ref.name, sb).catch(() => undefined);
      if (want && sb.metadata?.annotations?.[TEMPLATE_HASH_ANNOTATION] !== templateHash(want)) {
        const changed = templateDiff(sb.spec?.podTemplate, want);
        if (changed.length) out.template = changed;
      }
      // Suspended: no pod to compare; revive applies the size.
      if (isRunning(sb) && (await sizePending(ref, containers[0]?.resources))) out.size = true;
      return Object.keys(out).length ? out : undefined;
    },

    async restart(ref: SandboxRef, hooks: { onRunning?: () => void } = {}): Promise<SandboxRestartResult> {
      const before = await readCr(ref);
      const beforeContainer = before.spec?.podTemplate?.spec?.containers?.[0];
      const wasRunning = isRunning(before);
      const sizeApplied = wasRunning && (await sizePending(ref, beforeContainer?.resources).catch(() => false));
      log.info("restarting sandbox", { sandbox: ref.name, from_image: beforeContainer?.image, size_pending: sizeApplied });
      // Never suspend: the controller would drop the placement.
      await runOnCurrentTemplate(ref, { forceCycle: true });
      hooks.onRunning?.();
      const wait = await waitPodReady(ref);
      const toImage = (await readCr(ref).catch(() => before)).spec?.podTemplate?.spec?.containers?.[0]?.image;
      const imageCurrent = !opts.sandboxImage || toImage === opts.sandboxImage;
      log.info("sandbox restarted", { sandbox: ref.name, from_image: beforeContainer?.image, to_image: toImage, image_current: imageCurrent, ...wait });
      const result: SandboxRestartResult = { fromImage: beforeContainer?.image, toImage, imageCurrent, sizeApplied, ready: wait.ready };
      if (!wait.ready) result.notReadyReason = wait.reason;
      return result;
    },

    async destroy(ref: SandboxRef): Promise<void> {
      const id = ref.name.replace(/^conv-/, "");
      // A 404 means the object is already gone; any other failure is rethrown so end() does not
      // report a clean teardown that leaked resources.
      // A placeholder ref would send these deletes to the cluster scope (403), so normalize to the
      // provisioner namespace.
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

    // --- size: the Sandbox CR is the store -----------------------------------
    // A conversation's size lives in the CR's container `resources` block, which outlives the pod;
    // patching it does not roll a running pod, so a size change takes effect on the next restart.

    async getSize(id: string): Promise<SandboxResources | undefined> {
      const block = await readSize(id);
      if (!block) return undefined;
      const friendly = unrenderResources(block);
      return Object.keys(friendly).length ? friendly : undefined;
    },

    async setSize(id: string, spec: SandboxResources | { size: string }, threadId?: string): Promise<void> {
      // A preset name resolves against the deployment catalog; raw resources are validated as
      // given.
      let friendly: SandboxResources;
      if ("size" in spec) {
        const preset = presets[spec.size];
        if (!preset) {
          const available = Object.keys(presets).join(", ") || "(no presets configured)";
          throw new InvalidResourceError("size", spec.size, `Unknown size preset "${spec.size}". Available: ${available}`);
        }
        friendly = presetToResources(preset);
      } else {
        friendly = validateResources(spec);
      }
      const resources = renderResources(friendly);

      const patchContainerResources = async (containers: Array<Record<string, unknown>>) =>
        custom.patchNamespacedCustomObject(
          {
            group: GROUP, version: VERSION, namespace: ns, plural: PLURAL, name: sandboxName(id),
            body: { spec: { podTemplate: { spec: { containers: [{ ...containers[0], resources }, ...containers.slice(1)] } } } },
          },
          // Required: the client defaults to application/json-patch+json, which expects an array of
          // ops.
          setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
        );

      let sb: { spec?: { podTemplate?: { spec?: { containers?: Array<Record<string, unknown>> } } } };
      try {
        sb = await custom.getNamespacedCustomObject({
          group: GROUP, version: VERSION, namespace: ns, plural: PLURAL, name: sandboxName(id),
        });
      } catch (e) {
        if ((e as { code?: number })?.code !== 404) throw e;
        // No Sandbox yet (a size picked before the first turn, or after the pod was destroyed):
        // create it cold so the size has somewhere durable to live.
        log.info("sizing a conversation with no Sandbox; creating it cold", { sandbox: sandboxName(id) });
        await core
          .createNamespacedServiceAccount({ namespace: ns, body: { metadata: { name: saName(id), namespace: ns } } })
          .catch((err: { code?: number }) => {
            if (err?.code !== 409) throw err;
          });
        await custom.createNamespacedCustomObject({
          group: GROUP, version: VERSION, namespace: ns, plural: PLURAL,
          body: await manifestFor(id, threadId ?? id, resources, "Suspended"),
        });
        return;
      }

      const containers = sb.spec?.podTemplate?.spec?.containers ?? [];
      if (!containers.length) throw new Error(`Sandbox ${sandboxName(id)} has no container to resize`);
      await patchContainerResources(containers);
    },

    getSizes(): { sizes: Record<string, SandboxSizePreset>; default: string | null } {
      return { sizes: presets, default: opts.defaultSizeName || null };
    },
  };
}

/** One sandbox PVC template, as scooter.sandbox.volumes renders it. */
export interface VolumeClaim {
  metadata?: Record<string, unknown>;
  spec: Record<string, unknown>;
}
export type VolumeClaims = Record<string, VolumeClaim>;

/** Parse SANDBOX_VOLUME_CLAIMS; unset is no override, and a malformed value throws so a
 *  bad deploy fails at startup rather than creating wrong claims. */
export function parseVolumeClaims(raw: string | undefined): VolumeClaims | undefined {
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(parsed)) throw new Error("SANDBOX_VOLUME_CLAIMS must be a JSON object keyed by claim name");
  for (const [name, c] of Object.entries(parsed)) {
    if (!isObj(c) || !isObj(c.spec) || (c.metadata !== undefined && !isObj(c.metadata))) {
      throw new Error(`SANDBOX_VOLUME_CLAIMS.${name} must be { metadata?, spec } objects`);
    }
  }
  return parsed as VolumeClaims;
}

/** The Sandbox CR body, a mirror of modules/conversation.nix. */
export function sandboxManifest(
  id: string,
  name: string,
  sa: string,
  image: string,
  namespace: string,
  audience: string,
  storage: string,
  systemdImage = false,
  deploy: {
    scooterConfigMap?: string;
    configFilesConfigMap?: string;
    extraTokenAudiences?: string[];
    extraEnv?: Array<{ name: string; value: string }>;
    overlayStore?: boolean;
    overlayStorage?: string;
    /** Overlay PVC StorageClass; unset means the cluster default. */
    overlayStorageClass?: string;
    /** Claims keyed by name, each replacing the built-in `workspace` / `scooter-rw` claim. */
    volumeClaims?: VolumeClaims;
    /** imagePullPolicy for the sandbox container; default "Always", with "IfNotPresent"/"Never" for
     *  a side-loaded local cluster that has no registry to pull from. */
    pullPolicy?: "Always" | "IfNotPresent" | "Never";
    /** RuntimeClass for the systemd sandbox pod (e.g. "crun"), a cgroup-delegating runtime so
     *  systemd PID 1 gets a writable cgroup subtree without `privileged`. */
    sandboxRuntimeClass?: string;
    /** hostUsers: false + procMount: Unmasked on the systemd sandbox; ignored for the generic image. */
    userNamespace?: boolean;
    /** The already-rendered k8s resources block, with arbitrary keys per side because a GPU renders
     *  under its extended-resource name. */
    resources?: {
      requests?: Record<string, string>;
      limits?: Record<string, string>;
    };
    /** A parsed consumer manifest overlay, deep-merged onto the generated Sandbox with Scooter's
     *  protected fields re-asserted (sandboxOverlay.ts). */
    overlay?: Record<string, unknown>;
  } = {},
): object {
  const scooter = deploy.scooterConfigMap;
  // Deployment config files mounted as a flat dir, byte-for-byte via the kubelet.
  const configFilesCm = deploy.configFilesConfigMap;
  const configFilesMountPath = "/etc/agent-sandbox/config";
  const extraAudiences = deploy.extraTokenAudiences ?? [];
  const extraEnv = deploy.extraEnv ?? [];
  // The overlay store's writable upper: a disk-backed PVC at /nix/.scooter-rw.
  const overlayStore = deploy.overlayStore ?? false;
  const overlayStorage = deploy.overlayStorage ?? "20Gi";
  const claim = (name: string, fallback: VolumeClaim): VolumeClaim => {
    const given = deploy.volumeClaims?.[name];
    return given ? { metadata: { ...given.metadata, name }, spec: given.spec } : fallback;
  };
  const userNamespace = systemdImage && (deploy.userNamespace ?? false);
  const base = {
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
          // Lets the shutdown GC trim the upper before it's returned.
          ...(overlayStore ? { terminationGracePeriodSeconds: OVERLAY_GRACE_SECONDS } : {}),
          // A cgroup-delegating runtime gives systemd PID 1 a writable cgroup subtree in the pod's
          // own cgroup namespace, so the pod does not need `privileged`.
          ...(systemdImage && deploy.sandboxRuntimeClass
            ? { runtimeClassName: deploy.sandboxRuntimeClass }
            : {}),
          // Pod root and its SYS_ADMIN apply only inside the pod's user namespace, never on the host.
          ...(userNamespace ? { hostUsers: false } : {}),
          containers: [
            {
              name: "sandbox",
              image,
              // Default "Always" so a re-pushed :latest is picked up; overridable for side-loaded
              // local clusters.
              imagePullPolicy: deploy.pullPolicy ?? "Always",
              // Requests spread sandboxes across nodes and the memory limit stops a runaway build
              // from OOM-ing the node.
              ...(deploy.resources ? { resources: deploy.resources } : {}),
              // The systemd sandbox runs non-privileged but needs CAP_SYS_ADMIN for the mount(2)
              // calls in NixOS stage-2 activation; under crun the cap does not re-introduce the
              // host cgroup namespace.
              ...(systemdImage
                ? {
                  securityContext: {
                    capabilities: { add: ["SYS_ADMIN"] },
                    // Unmasked only under a user namespace (the apiserver rejects it otherwise); a
                    // masked /proc is what stops a nested build sandbox mounting its own.
                    ...(userNamespace ? { procMount: "Unmasked" } : {}),
                  },
                  // Ready only once activation has linked the system profile.
                  startupProbe: {
                    exec: { command: [ACTIVATED_PROBE] },
                    periodSeconds: 1,
                    timeoutSeconds: 5,
                    failureThreshold: 300,
                  },
                }
                : {}),
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "broker-token", mountPath: "/var/run/secrets/broker", readOnly: true },
                // systemd writes to /run + /tmp; back them with tmpfs.
                ...(systemdImage
                  ? [
                      { name: "run", mountPath: "/run" },
                      { name: "tmp", mountPath: "/tmp" },
                    ]
                  : []),
                // A deployment's injected .scooter tools.
                ...(scooter
                  ? [{ name: "scooter-tools", mountPath: "/etc/agent-sandbox/scooter", readOnly: true }]
                  : []),
                // Deployment-named extra SA tokens.
                ...extraAudiences.map((aud) => ({
                  name: `tok-${aud}`,
                  mountPath: `/var/run/secrets/${aud}`,
                  readOnly: true,
                })),
                // The overlay store's writable upper, which the image mounts as the upperdir of
                // /nix/store so runtime builds persist across suspend/resume.
                ...(overlayStore ? [{ name: "scooter-rw", mountPath: "/nix/.scooter-rw" }] : []),
                // Deployment config files as a flat read-only dir.
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
                // The image has no /etc/passwd, so pin HOME to the writable workspace so git config
                // and the agent's git commands agree.
                { name: "HOME", value: "/workspace" },
                // Deployment-supplied env, including the CONVERSATION_ID the caller injects.
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
            ...(systemdImage
              ? [
                  { name: "run", emptyDir: { medium: "Memory" } },
                  { name: "tmp", emptyDir: { medium: "Memory" } },
                ]
              : []),
            ...(scooter
              ? [{ name: "scooter-tools", configMap: { name: scooter } }]
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
        claim("workspace", {
          metadata: { name: "workspace" },
          spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage } } },
        }),
        // The overlay-store upper PVC, persisting runtime builds across suspend/resume.
        ...(overlayStore
          ? [
              claim("scooter-rw", {
                metadata: { name: "scooter-rw" },
                spec: {
                  accessModes: ["ReadWriteOnce"],
                  resources: { requests: { storage: overlayStorage } },
                  ...(deploy.overlayStorageClass ? { storageClassName: deploy.overlayStorageClass } : {}),
                },
              }),
            ]
          : []),
      ],
    },
  };
  // The consumer overlay is applied last: deep-merge, then Scooter's protected fields re-asserted
  // (sandboxOverlay.ts).
  return deploy.overlay ? applyOverlay(base as Record<string, unknown>, deploy.overlay) : base;
}

function defaultKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  // In-cluster only when the projected SA token is present, since loadFromCluster() otherwise
  // yields a broken config instead of throwing.
  if (existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token")) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc;
}
