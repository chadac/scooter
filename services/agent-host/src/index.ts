/**
 * agent-host entry point — composes the whole service.
 *
 *   AguiServer (SSE) <-- browser
 *      | onPrompt    -> SessionManager.prompt
 *      | onPermission-> bridge permission answer
 *      | onAttach    -> replay ConversationStore events
 *   SessionManager
 *      |-- SandboxProvisioner (kube: cold Sandbox per conversation)
 *      |-- ConversationStore  (conversation-state PVC)
 *      `-- per conversation: SessionBridge( AcpClient(goose) <-> AG-UI, ExecBackend )
 *                               ExecBackend = K8s exec API into the sandbox pod
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAguiServer } from "./agui/server.js";
import { createManagementApi, raiseAwsApprovalInterrupt, type AwsRequestSummary } from "./api/management.js";
import { createSessionManager, shortId } from "./session/manager.js";
import { historyAfterCompaction, compactConversation } from "./session/compaction.js";
import { createK8sProvisioner } from "./session/k8sProvisioner.js";
import { createBrokerProvisioner, type BrokerProvisioner } from "./session/brokerProvisioner.js";
import type { SandboxResources } from "./session/resources.js";
import { brokerAuthHeaders as sharedBrokerAuthHeaders } from "./session/brokerAuth.js";
import type { SandboxProvisioner } from "./session/manager.js";
import { createFileConversationStore } from "./session/fileStore.js";
import { mirroredConversationStore } from "./session/mirroredStore.js";
import { createK8sOwnershipGuard } from "./session/k8sOwnershipGuard.js";
import { createK8sConversationRegistry } from "./session/k8sConversationRegistry.js";
import type { ConversationStore } from "./session/manager.js";
import { createPvcAssetStore } from "./session/assetStore.js";
import { createSessionBridge, PRIORITY_INTERRUPT, type AguiEvent, type ApproverIdentity } from "./bridge.js";
import { createAcpClient } from "./acp/client.js";
import { createRecorder } from "./transcript/recorder.js";
import { createSandboxExecBackend, connectSandbox } from "./exec/sandboxExec.js";
import { createDeferredConnector } from "./exec/deferredConnect.js";
import { createLocalSandboxApiClient } from "./exec/localExec.js";
import { resolvePodTarget } from "./exec/k8sExec.js";
import { createWebServiceProxy } from "./proxy/webServiceProxy.js";
import { createWebServiceRegistry } from "./proxy/webServiceRegistry.js";
import { createModuleRegistry } from "./proxy/moduleRegistry.js";
import { writeHints, loadSkills, assembleHints } from "./agent/skills.js";
import { createSdkAcpClient } from "@scooter/claude-sdk-provider";
import { ensureGooseConfig } from "./agent/gooseConfig.js";
import { catalogFromEnv, availableIds, type ModelCatalog } from "./agent/models.js";
import { createJobManager, type JobStatus } from "./session/jobManager.js";
import { createMcpEndpoint, type MarimoToolsWiring } from "./agent/mcpServer.js";
import { createMarimoClient } from "@scooter/marimo-mcp";
import {
  lastAssistantText,
  subagentDoneNotice,
  type SubagentManager,
  type SubagentStatus,
} from "./agent/subagentTools.js";
import { createSubagentManager } from "./session/subagentManager.js";
import { lastRunCompleted } from "./session/danglingRun.js";
import { randomUUID } from "node:crypto";
import { createHttpSchedulerClient } from "./agent/schedulerClient.js";
import type { SchedulerToolsWiring } from "./agent/schedulerTools.js";
import { createBrokerClient } from "./agent/brokerClient.js";
import { createResourceLookup } from "./agent/resourceMapping.js";
import { parseScooterEnv } from "./config/scooterEnv.js";
import { resolverFromEnv, type AsyncIdentityResolver } from "./auth/identity.js";
import { createWebhooksCallerVerifier } from "./auth/webhooksCaller.js";
import { withIdentityStore, createPgIdentityStore } from "./auth/identityStore.js";
import { withAlbVerification } from "./auth/albVerify.js";
import type { IncomingMessage } from "node:http";
import { createMetrics, type MetricsSink } from "./metrics/metrics.js";
import { parsePriceTable } from "./metrics/pricing.js";
import { createGooseUsageReader } from "./metrics/gooseUsage.js";
import type { SandboxRef, SessionId } from "./types.js";

/** TRANSCRIPT RECORDER (test-harness): one shared instance, OFF unless
 *  TRANSCRIPT_RECORD_DIR is set. It writes one NDJSON per run capturing the RAW
 *  agent input + emitted AG-UI, so tests can REPLAY real behavior instead of
 *  hand-authored fakes. See todo/docs/AGENT_TRANSCRIPT_HARNESS.md. */
const transcriptRecorder = createRecorder(process.env.TRANSCRIPT_RECORD_DIR);

export interface AgentHostConfig {
  port: number;
  namespace: string;
  sandboxImage: string;
  /** Durable conversation state: the AG-UI event log (history/replay). On a PVC
   *  so it survives agent-host restarts. */
  statePath: string;
  /** OPTIONAL RWX/NFS mirror root. When set, the conversation store becomes a
   *  mirroredConversationStore: LOCAL (statePath) stays the hot-path authority and a
   *  coalesced async copy of every write is shipped here so ANOTHER pod can revive the
   *  conversation from the mirror (the multi-replica story). Unset = single local store
   *  (today's behavior). See mirroredStore.ts + CONVERSATION_CRD_AND_HISTORY.md. */
  mirrorStatePath?: string;
  /** Ephemeral scratch for the agent process: goose's per-conversation cwd
   *  (sessions DB + .goosehints). The real work execs into the sandbox, so this
   *  is throwaway — an emptyDir, NOT the durable PVC. */
  scratchPath: string;
  /** ACP agent launch (goose). */
  agent: { command: string; args: string[]; env: Record<string, string> };
  /** Default model (GOOSE_MODEL) and the models offered for per-conversation
   *  selection. A conversation may override the model; unset = default only.
   *  `model` (the default) + `availableModels` (the ids) are derived from
   *  `modelCatalog` (the rich source of truth with per-model hints). */
  model?: string;
  availableModels: string[];
  /** The full model catalog (ids + deployment hints + which is default), powering
   *  the list_models / switch_model MCP tools + GET /models hints. */
  modelCatalog: ModelCatalog;
  /** Agent display name (the assistant introduces itself as this). */
  agentName: string;
  /** Directory of markdown skills injected into the agent (a ConfigMap mount in
   *  cluster). Read per conversation -> .goosehints; add a .md, no image rebuild. */
  skillsDir: string;
  /** Idle-suspend: suspend conversations idle longer than this (ms). 0 = off. */
  idleSuspendMs: number;
  /** How often the idle sweep runs (ms). */
  idleSweepIntervalMs: number;
  /** Retention reap: DESTROY (end) unstarred conversations inactive longer than this
   *  (ms). 0 = off (default — opt-in). Starred conversations are exempt. */
  retentionMaxAgeMs: number;
  /** How often the retention reap runs (ms). Default 6h. */
  retentionSweepIntervalMs: number;
  /** Hard per-command exec timeout (ms). A runaway shell command is aborted after
   *  this so it can't deadlock the conversation. 0 = off. Default 5 min. */
  commandTimeoutMs: number;
  /** Dead-on-arrival run watchdog (ms): if a run emits no ACP activity within this
   *  window, surface a RUN_ERROR so the conversation unfreezes (the goose-Bedrock-
   *  credential hang produced zero events and never returned). 0 = off. Default 60s. */
  firstActivityTimeoutMs: number;
  /** Mid-stream liveness watchdog (ms): the cadence at which an active run probes
   *  acpClient.isAlive(). If the agent PROCESS has died without a terminal event the
   *  run is force-terminated (RUN_ERROR) so a dead agent can't block the queue. It
   *  does NOT kill on silence — a long tool call is healthy. 0 = off. Default 30s. */
  livenessProbeMs: number;
  /** OpenTelemetry metrics (cost + usage + operational), exported over OTLP.
   *  OFF by default. Endpoint/headers come from the standard OTEL_* env. */
  observability: {
    enabled: boolean;
    /** deployment.environment resource attribute (e.g. "dev", "prod"). */
    environment?: string;
    /** Raw JSON of the per-model price table (USD per 1M tokens). Usually a
     *  ConfigMap-mounted file's contents, passed via AGENT_PRICING_JSON or read
     *  from AGENT_PRICING_FILE. Empty -> tokens counted, cost omitted. */
    pricingJson: string;
  };
}

export interface AgentHostConfigExtra {
  /** Skip real Sandbox provisioning (local UI testing with the dummy agent). */
  fakeSandbox: boolean;
}

export function configFromEnv(): AgentHostConfig & AgentHostConfigExtra {
  const catalog = catalogFromEnv();
  // GOOSE_BIN=fake runs the bundled dummy ACP agent (no model, no AWS).
  const useFakeAgent = process.env.GOOSE_BIN === "fake";
  const fakeAgentPath = new URL("./fakeAgent.js", import.meta.url).pathname;
  const fakeSandbox = process.env.FAKE_SANDBOX === "1" || useFakeAgent;
  // In prod the k8s manifest mounts /var/lib/... (a writable emptyDir/PVC). In
  // fake/local mode those paths aren't writable, so default to an OS temp dir so
  // the local e2e stack is self-contained (env still overrides either way).
  const defaultStatePath = fakeSandbox
    ? join(tmpdir(), "agent-host", "conversations")
    : "/var/lib/agent-host/conversations";
  const defaultScratchPath = fakeSandbox ? join(tmpdir(), "agent-scratch") : "/var/lib/agent-scratch";
  return {
    port: Number(process.env.PORT ?? 8080),
    namespace: process.env.NAMESPACE ?? "agent-sandbox",
    sandboxImage: process.env.SANDBOX_IMAGE ?? "agent-sandbox-os:latest",
    statePath: process.env.STATE_PATH ?? defaultStatePath,
    mirrorStatePath: process.env.MIRROR_STATE_PATH || undefined,
    scratchPath: process.env.SCRATCH_PATH ?? defaultScratchPath,
    // Default: suspend after 30 min idle, sweep every minute. 0 disables.
    idleSuspendMs: Number(process.env.IDLE_SUSPEND_MS ?? 30 * 60 * 1000),
    idleSweepIntervalMs: Number(process.env.IDLE_SWEEP_INTERVAL_MS ?? 60 * 1000),
    // Retention reap: DESTROY unstarred conversations inactive this long. OFF by
    // default (0) — opt-in via RETENTION_MAX_AGE_MS (e.g. 30d = 2592000000). Sweep
    // every 6h. Starred conversations are exempt.
    retentionMaxAgeMs: Number(process.env.RETENTION_MAX_AGE_MS ?? 0),
    retentionSweepIntervalMs: Number(process.env.RETENTION_SWEEP_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
    // Hard per-command exec timeout. Default 5 min; COMMAND_TIMEOUT_MS=0 disables.
    commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_MS ?? 5 * 60 * 1000),
    // Dead-on-arrival run watchdog: if a run emits no ACP activity within this many
    // ms, surface a RUN_ERROR so the conversation unfreezes (the goose-Bedrock-
    // credential hang). Default 60s; FIRST_ACTIVITY_TIMEOUT_MS=0 disables.
    firstActivityTimeoutMs: Number(process.env.FIRST_ACTIVITY_TIMEOUT_MS ?? 60 * 1000),
    livenessProbeMs: Number(process.env.AGENT_LIVENESS_PROBE_MS ?? 30 * 1000),
    fakeSandbox,
    // The model catalog (rich: ids + hints + default) is the source of truth;
    // `model` (the default) + `availableModels` (the ids) are derived so
    // resolveModel / GET /models / metrics keep working unchanged.
    modelCatalog: catalog,
    model: catalog.defaultId,
    availableModels: availableIds(catalog),
    agentName: process.env.AGENT_NAME ?? "Scooter",
    skillsDir: process.env.SKILLS_DIR ?? "/etc/agent-sandbox/skills",
    observability: {
      // OFF unless OTEL_METRICS_ENABLED=1. (The OTLP endpoint/headers still come
      // from the standard OTEL_EXPORTER_OTLP_* env, which the SDK reads.)
      enabled: process.env.OTEL_METRICS_ENABLED === "1",
      environment: process.env.OTEL_DEPLOYMENT_ENVIRONMENT || undefined,
      pricingJson: readPricing(),
    },
    agent: useFakeAgent
      ? { command: process.execPath, args: [fakeAgentPath], env: {} }
      : { command: process.env.GOOSE_BIN ?? "goose", args: ["acp"], env: bedrockEnv() },
  };
}

/** The per-model price table JSON: inline (AGENT_PRICING_JSON) or from a mounted
 *  file (AGENT_PRICING_FILE — a ConfigMap). Empty string if neither is set or the
 *  file can't be read (cost is then omitted; tokens still counted). */
function readPricing(): string {
  if (process.env.AGENT_PRICING_JSON) return process.env.AGENT_PRICING_JSON;
  const file = process.env.AGENT_PRICING_FILE;
  if (file) {
    try {
      return readFileSync(file, "utf8");
    } catch (e) {
      // Findings #22/#23: cost metrics are best-effort, so we DON'T crash — but
      // the operator EXPLICITLY set AGENT_PRICING_FILE, so a failure to honor it
      // is a misconfiguration, not a default-off. Log it as an error (with cause)
      // so it's not mistaken for "cost simply isn't configured".
      // eslint-disable-next-line no-console
      console.error(`[agent-host] AGENT_PRICING_FILE ${file} unreadable — cost metrics DISABLED (misconfig?):`, e);
    }
  }
  return "";
}

/** Parse the price table, tolerating an empty/invalid value (cost just omitted). */
function safeParsePrices(json: string) {
  if (!json.trim()) return {};
  try {
    return parsePriceTable(json);
  } catch (e) {
    // Finding #22: pricing JSON was provided but is malformed -> cost metrics
    // disabled. Best-effort (no crash), but an explicit-config failure, so log
    // it as an error rather than a quiet warn.
    // eslint-disable-next-line no-console
    console.error("[agent-host] invalid pricing JSON — cost metrics DISABLED (misconfig?):", e);
    return {};
  }
}

/** Resolve the model for a conversation: an explicit pick (if it's an offered
 *  model) else the configured default. Guards against arbitrary model strings. */
export function resolveModel(
  requested: string | undefined,
  config: Pick<AgentHostConfig, "model" | "availableModels">,
): string | undefined {
  if (requested && (config.availableModels.includes(requested) || requested === config.model)) {
    return requested;
  }
  return config.model;
}

/** No-op provisioner for local UI testing (no cluster). */
function createNoopProvisioner(): SandboxProvisioner {
  return {
    async create(id) {
      return { name: `fake-${id}`, namespace: "local" };
    },
    async suspend() {},
    async resume(ref) {
      return ref;
    },
    async destroy() {},
  };
}

/** Pass AWS/Bedrock config through to goose if present. Includes the IRSA
 *  web-identity vars (AWS_ROLE_ARN / AWS_WEB_IDENTITY_TOKEN_FILE) that the EKS
 *  pod-identity webhook injects — goose's AWS SDK chain uses them to assume the
 *  pod's role for Bedrock, so no static keys are needed in-cluster. */
/** DSN for the shared Postgres holding the webhooks conversation_map (the agent-
 *  tools' target-discovery fallback). Prefer an explicit WEBHOOKS_DB_DSN; else
 *  assemble it from WEBHOOKS_DB_* components (host/name/user/password/port) the
 *  same way the webhooks service does. Empty when no DB is configured (then the
 *  tools rely on the link `ref` alone). Read-only use. */
function webhooksResourceDsn(): string {
  const explicit = process.env.WEBHOOKS_DB_DSN;
  if (explicit) return explicit;
  const pw = process.env.WEBHOOKS_DB_PASSWORD;
  if (!pw) return "";
  const host = process.env.WEBHOOKS_DB_HOST ?? "agent-shared-db";
  const port = process.env.WEBHOOKS_DB_PORT ?? "5432";
  const name = process.env.WEBHOOKS_DB_NAME ?? "webhooks";
  const user = process.env.WEBHOOKS_DB_USER ?? "webhooks";
  return `postgresql://${user}:${encodeURIComponent(pw)}@${host}:${port}/${name}`;
}

/** Parse an optional static id->email map from AUTH_SUB_EMAIL_MAP ("sub=email"
 *  pairs, comma or semicolon separated). Undefined when unset/empty. Used to seed
 *  identity email resolution for a known set of users (e.g. before the learned
 *  store has seen them). */
function parseIdentityMap(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(/[;,]/)) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Drain a conversation's event stream into an array, tolerating a read error
 *  (returns what was read; the subagent watcher must never throw). */
async function collectEventsSafe(it: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  try {
    for await (const e of it) out.push(e);
  } catch {
    /* partial read is fine — the last message is near the end anyway */
  }
  return out;
}

function bedrockEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    "GOOSE_PROVIDER", "GOOSE_MODEL",
    "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    // IRSA (EKS pod identity) — the credential source in-cluster.
    "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_STS_REGIONAL_ENDPOINTS",
    "AWS_ROLE_SESSION_NAME",
    // Ollama (local/cheap provider — used for recording goose transcripts, and any
    // ollama-backed deploy). GOOSE_PROVIDER=ollama + OLLAMA_HOST points goose at it.
    "OLLAMA_HOST",
  ]) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  // Auto-compaction: goose summarizes the conversation when the context reaches this
  // FRACTION of the window (GOOSE_AUTO_COMPACT_THRESHOLD, 0.0-1.0; 0.0 disables).
  // goose's own default is 0.8, but we set it EXPLICITLY so it's visible/tunable per
  // deploy and can't drift with goose versions (goose can also misdetect the window
  // for some models — block/goose#7839). Deployer override, else 0.8.
  out.GOOSE_AUTO_COMPACT_THRESHOLD = process.env.GOOSE_AUTO_COMPACT_THRESHOLD ?? "0.8";
  return out;
}

export async function main(
  config: AgentHostConfig & Partial<AgentHostConfigExtra> = configFromEnv(),
): Promise<() => Promise<void>> {
  // Provisioner selection: fake (local UI) -> noop; the broker control plane when
  // SANDBOX_VIA_BROKER=1 + BROKER_URL set (the agent-host calls the broker's lifecycle
  // API instead of touching k8s — see todo/CONTROL_PLANE_REDESIGN.md); else the legacy
  // in-agent-host k8s provisioner (kept until PR1 St6 as a safe rollback).
  const brokerLifecycleUrl = (process.env.BROKER_URL ?? "").replace(/\/$/, "");
  const useBrokerProvisioner = process.env.SANDBOX_VIA_BROKER === "1" && brokerLifecycleUrl !== "";
  // Keep a typed handle to the broker provisioner (it ALSO exposes the size-spec
  // ops getSize/setSize used by the sandbox-resize tools). null unless the broker
  // lifecycle path is on — a fake/local or legacy-k8s sandbox has no broker size spec.
  const brokerProvisioner: BrokerProvisioner | null =
    !config.fakeSandbox && useBrokerProvisioner
      ? createBrokerProvisioner({ brokerUrl: brokerLifecycleUrl })
      : null;
  const provisioner = config.fakeSandbox
    ? createNoopProvisioner()
    : brokerProvisioner
    ? brokerProvisioner
    : createK8sProvisioner({
        namespace: config.namespace,
        sandboxImage: config.sandboxImage,
        // imagePullPolicy for the per-conversation sandbox pod. Default "Always"
        // (registry-backed); set SANDBOX_PULL_POLICY=IfNotPresent on a side-loaded
        // local cluster (kind/k3s) where "Always" fails with ImagePullBackOff.
        sandboxPullPolicy:
          (process.env.SANDBOX_PULL_POLICY as "Always" | "IfNotPresent" | "Never") || undefined,
        // When the AWS permissions broker is on, mount its account-registry
        // ConfigMap into each sandbox so the entrypoint renders ~/.aws/config.
        awsAccountsConfigMap: process.env.AWS_ACCOUNTS_CONFIGMAP || undefined,
        // The sandbox is ALWAYS the NixOS systemd-PID-1 image now (the legacy
        // generic image was retired): always provision privileged + tmpfs /run,/tmp
        // so systemd PID 1 boots.
        systemdImage: true,
        // RuntimeClass for the sandbox pod (SANDBOX_RUNTIME_CLASS, e.g. "crun"). A
        // cgroup-delegating runtime gives systemd PID 1 a writable cgroup subtree in
        // the pod's OWN private cgroup namespace, so the sandbox runs NON-privileged
        // (privileged forces the host cgroup ns → the sandbox churns the host
        // /kubepods.slice tree → node instability / host session logout). Unset = the
        // cluster default runtime.
        sandboxRuntimeClass: process.env.SANDBOX_RUNTIME_CLASS || undefined,
        // The sandbox image ALWAYS has the local-overlay Nix store on, so ALWAYS mount a
        // disk-backed PVC upper at /nix/.scooter-rw — the overlay's writable layer, holding
        // runtime nix builds (tool installs, re-converge) + persisting them across
        // suspend/resume. Default ON; SANDBOX_OVERLAY_STORE=0 opts out (ephemeral emptyDir
        // upper — the overlay still works, writes just don't persist).
        overlayStore: (process.env.SANDBOX_OVERLAY_STORE || "1") !== "0",
        overlayStorage: process.env.SANDBOX_OVERLAY_STORAGE || undefined,
        // Warm PVC pool: when on, claim a pre-warmed overlay upper (matching the sandbox
        // image tag) from the warm-store-controller's pool instead of a fresh empty one —
        // so a new conversation finds common tools already built. Off by default;
        // WARM_STORE_POOL=1 enables it (set by kubenix when agentSandbox.warmStore.enable).
        // A cold/contended pool falls back to a fresh upper (never blocks).
        warmStorePool: (process.env.WARM_STORE_POOL || "0") === "1",
        // Deployment-supplied tool injection (generic — the platform doesn't know
        // what's in these; a deployment sets them to its .scooter
        // ConfigMap, the token audiences its tools need, and their env vars).
        // SCOOTER_CONFIGMAP, SCOOTER_TOKEN_AUDIENCES (CSV), SCOOTER_ENV (JSON —
        // lossless for multi-line values like NIX_CONFIG; legacy k=v;k=v accepted).
        scooterConfigMap: process.env.SCOOTER_CONFIGMAP || undefined,
        // A ConfigMap of deployment config FILES (filename -> contents) mounted as a
        // flat dir at /etc/agent-sandbox/config. File-based (not SCOOTER_ENV) so
        // multi-line config survives the sandbox CRD controller's newline mangling.
        configFilesConfigMap: process.env.SCOOTER_CONFIG_FILES_CONFIGMAP || undefined,
        extraTokenAudiences: (process.env.SCOOTER_TOKEN_AUDIENCES || "")
          .split(",").map((s) => s.trim()).filter(Boolean),
        extraEnv: parseScooterEnv(process.env.SCOOTER_ENV),
        // Public chat UI base URL → each sandbox gets CONVERSATION_URL for its own
        // conversation (so the agent can share a link, e.g. to approve an AWS req).
        publicUrl: process.env.PUBLIC_URL || undefined,
      });
  // Ensure goose's developer extension is enabled in its config, so goose
  // redirects shell/file tool calls to the ACP client (-> the sandbox) instead
  // of running them locally in this pod. On a REAL deployment a failure here is
  // FATAL (else goose silently runs tools in the agent-host pod — finding #1);
  // on a fake/dev sandbox there's no real goose, so it's best-effort.
  ensureGooseConfig(process.env.HOME, { fatal: !config.fakeSandbox });
  // Conversation store: LOCAL fileStore (hot-path authority). When MIRROR_STATE_PATH is
  // set, wrap it so every write is also mirrored (async, coalesced, non-blocking) to a
  // second fileStore on the RWX/NFS volume — so another pod can revive from the mirror
  // (multi-replica). drainMirror is awaited by main()'s returned shutdown fn, so a
  // graceful stop ships the mirror's tail (near-RPO-0 on a planned rollout — pairs with
  // the SIGTERM drain #248). See mirroredStore.ts + CONVERSATION_CRD_AND_HISTORY.md.
  const localStore = createFileConversationStore(config.statePath);
  const mirroredStore = config.mirrorStatePath
    ? mirroredConversationStore(localStore, createFileConversationStore(config.mirrorStatePath), {
        // A mirror-write failure is NON-fatal (local is intact) but must not vanish:
        // it means the backup is diverging from the authority, so surface it debuggably
        // (full error + stack) AND on the persistence-error metric — same treatment as a
        // local durable-append failure (store.onAppendError below).
        onMirrorError: (conversationId, err) => {
          console.error(
            `[mirror] backup write FAILED for ${conversationId} (local intact; mirror diverging):`,
            err, // Node prints the stack/traceback for an Error
          );
          metrics.persistenceError?.({ conversationId });
        },
      })
    : undefined;
  const store: ConversationStore = mirroredStore ?? localStore;
  // Image/media assets (uploaded images) live alongside the event log on the
  // conversation-state volume. Configurable cap via ASSET_MAX_BYTES.
  const assets = createPvcAssetStore({
    root: config.statePath,
    maxBytes: Number(process.env.ASSET_MAX_BYTES) || undefined,
  });
  const server = createAguiServer();
  // The privileged /agui `owner` field (a webhook-resolved Scooter user) is honored
  // ONLY for the TRUSTED webhooks caller — its SA token verified via k8s TokenReview.
  // WEBHOOKS_SERVICE_ACCOUNT unset => owner is never honored (safe default).
  server.useOwnerVerifier(
    createWebhooksCallerVerifier({
      expectedServiceAccount: process.env.WEBHOOKS_SERVICE_ACCOUNT,
      audience: process.env.WEBHOOKS_TOKEN_AUDIENCE || "agent-host",
    }),
  );

  // Metrics (OFF unless OTEL_METRICS_ENABLED=1). Cost needs goose's per-session
  // token usage, which it persists under its $HOME; the reader degrades to "no
  // cost" if that DB isn't present. Tokens/cost are attributed to the resolved
  // model per run.
  const metrics: MetricsSink = createMetrics({
    enabled: config.observability.enabled,
    serviceName: "agent-host",
    environment: config.observability.environment,
    prices: safeParsePrices(config.observability.pricingJson),
    usageReader:
      config.observability.enabled && !config.fakeSandbox && process.env.HOME
        ? createGooseUsageReader({ gooseHome: process.env.HOME })
        : undefined,
  });

  // Finding #4: a failed durable append (the conversation's only persistence)
  // must leave a trace. The store now surfaces append failures; record them as a
  // metric so an operator can alert (the store already logs each one loudly).
  store.onAppendError?.((conversationId) => {
    metrics.persistenceError?.({ conversationId });
  });

  // Build a bridge per conversation: connect exec to the sandbox pod, spawn
  // goose, and wire its AG-UI events out through the server.
  // Multi-replica FENCING: when POD_NAME is set (the StatefulSet gives each pod its
  // ordinal name), watch the Conversation CRD so this pod stops appending to a
  // conversation reassigned away from it. Unset (single-replica) => allowAllGuard (no-op,
  // today's behavior); no watch, no k8s dependency. See ownershipGuard.ts.
  const podName = process.env.POD_NAME;
  const ownership = podName
    ? createK8sOwnershipGuard(podName, config.namespace)
    : undefined;
  // The WRITE side of the same CRD: when multi-replica (POD_NAME set), register each new
  // conversation as a Conversation CR so the controller assigns it a hostPod and the
  // router forwards to it. Unset => noopRegistry (no CR). See conversationRegistry.ts.
  const conversationRegistry = podName
    ? createK8sConversationRegistry(config.namespace)
    : undefined;

  const sessions = createSessionManager({
    provisioner,
    store,
    ownershipGuard: ownership?.guard,
    // Revive-on-assign (multi-replica rollout): pull a reassigned conversation's state
    // from the mirror. Only when a mirror is configured. See ROLLOUT_DRAIN_AND_POD_IP.md.
    hydrateFromMirror: mirroredStore ? (id) => mirroredStore.hydrateFromMirror(id) : undefined,
    conversationRegistry,
    bridgeFactory: ({ conversationId, sandbox, model }) => {
      // Exec + ACP client are connected lazily/asynchronously; the bridge is
      // created synchronously and starts the connection in start().
      const bridge = makeBridge(conversationId, sandbox, config, model, metrics);
      // The agent titles the conversation by emitting <title>…</title> as its
      // first action; the bridge extracts it -> set it on the conversation.
      bridge.onTitle((title) => sessions.setTitle(conversationId, title));
      return bridge;
    },
    // After a revive rebuilds the bridge, re-raise any AWS approval interrupts a pod
    // rollout dropped. The interrupt's in-memory answer-routing dies with the old
    // pod, but the request still sits PENDING in the broker (source of truth) — so
    // we re-query it and re-raise, restoring the Approve/Deny button + routing.
    // Without this the agent deadlocks: it polls the pending request forever and the
    // UI shows no button (the reported approval-interrupt-lost-on-rollout bug).
    onRevived: (id) => {
      void reRaisePendingAwsInterrupts(id).catch((err) =>
        console.error(`[agent-host] re-raise pending AWS interrupts failed for ${id}:`, err),
      );
    },
    // Keep the pod up while a background job is still running — else the idle sweep would
    // SIGTERM a long-running run_background job (see sweepIdle). Consults the jobManager
    // (defined below; this closure runs only at sweep time). Only probes jobs NOT yet
    // announced as complete (notifiedAt unset) — an announced job already exited. Returns
    // true on the FIRST job still "running"; a null jobManager (jobs disabled) → false.
    hasRunningBackgroundJob: async (id) => {
      if (!jobManager) return false;
      const jobs = await jobManager.list(id as SessionId);
      for (const job of jobs) {
        if (job.notifiedAt) continue; // already announced complete
        const st = await jobManager.check(id as SessionId, job.jobId);
        if (st.state === "running") return true;
      }
      return false;
    },
  });

  /** Broker auth headers (the agent-host SA token), shared by the AWS calls. Mirrors
   *  resolveAwsRequest's token read: a MISSING token (ENOENT) is the dev case; any
   *  OTHER read error is surfaced (don't send an unauthenticated request). */
  const brokerAuthHeaders = sharedBrokerAuthHeaders;

  /** On revive, ask the broker for this conversation's PENDING AWS requests and
   *  re-raise an Approve/Deny interrupt for each — reconstructing the exact interrupt
   *  the rollout lost (same builder as the live /aws-request route). raiseInterrupt
   *  keys on the request id, so a re-raise of a still-open interrupt is idempotent. */
  const reRaisePendingAwsInterrupts = async (id: string): Promise<void> => {
    const brokerUrl = (process.env.BROKER_URL ?? "").replace(/\/$/, "");
    if (!brokerUrl) return; // no broker (local/dev) — nothing to re-raise
    const bridge = sessions.get(id as SessionId)?.bridge;
    if (!bridge) return;
    const res = await fetch(`${brokerUrl}/aws/aws/pending?conversation_id=${encodeURIComponent(id)}`, {
      method: "GET",
      headers: await brokerAuthHeaders(),
    });
    if (!res.ok) {
      // 404/501 = no AWS broker configured; anything else is worth a log but not fatal.
      if (res.status !== 404 && res.status !== 501) {
        console.warn(`[agent-host] broker /aws/pending for ${id}: HTTP ${res.status}`);
      }
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { requests?: AwsRequestSummary[] };
    for (const req of body.requests ?? []) {
      if (!req.request_id) continue;
      raiseAwsApprovalInterrupt(bridge, id, req, resolveAwsRequestForBroker);
    }
  };

  /** Approve/deny a broker AWS request (POST /aws/{id}/approve|deny) after the user
   *  answers the interrupt. Shared by the /aws-request route's onAnswer AND the
   *  revive re-raise. Sends the answering user's identity; the broker authorizes the
   *  configured claim. Throws on a dropped/failed approval (never silently lost); an
   *  APPROVE provisioning failure is fed back into the conversation. */
  const resolveAwsRequestForBroker = async (
    sessionId: string,
    requestId: string,
    approved: boolean,
    approver: ApproverIdentity,
  ): Promise<void> => {
    const brokerUrl = (process.env.BROKER_URL ?? "").replace(/\/$/, "");
    if (!brokerUrl) {
      console.warn("[agent-host] BROKER_URL unset; cannot resolve AWS request", { requestId });
      return;
    }
    const action = approved ? "approve" : "deny";
    const res = await fetch(`${brokerUrl}/aws/aws/${encodeURIComponent(requestId)}/${action}`, {
      method: "POST",
      headers: await brokerAuthHeaders(),
      body: JSON.stringify({ approver }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (approved) {
        // Extract the broker's error reasons for a readable, actionable message.
        let detail = body.slice(0, 1500);
        try {
          const j = JSON.parse(body);
          const errs = j?.detail?.errors ?? j?.errors;
          if (Array.isArray(errs) && errs.length) detail = errs.join("\n");
        } catch {
          /* not JSON — use the raw body */
        }
        void sessions
          .prompt(
            sessionId as SessionId,
            "The AWS access you requested was approved, but the broker could NOT " +
              "provision it. Do NOT retry the request; instead, help the user fix the broker " +
              "setup, then they can re-approve. Broker error:\n\n" + detail,
            undefined, undefined, undefined, undefined, undefined, "broker",
          )
          .catch((e) => console.error("[agent-host] failed to feed AWS provisioning error to the agent:", e));
      }
      throw new Error(`broker rejected AWS ${action} for ${requestId}: ${res.status} ${body.slice(0, 500)}`);
    }
  };

  // Background jobs (run_background): the agent starts a long command detached in
  // its sandbox and keeps working. Gated to a real sandbox with a durable registry.
  // The registry is the state PVC (store).
  const jobsEnabled = process.env.AGENT_BACKGROUND_JOBS !== "0" && !config.fakeSandbox && !!store.saveJob;
  const jobManager = jobsEnabled
    ? createJobManager({
        client: (id) => {
          const sb = sessions.get(id as SessionId)!.sandbox;
          return deferredSandboxApi(sb, () => provisioner.resume(sb).then(() => {}));
        },
        registry: {
          saveJob: (id, job) => store.saveJob!(id as SessionId, job),
          listJobs: (id) => store.listJobs!(id as SessionId),
          updateJob: store.updateJob ? (id, job) => store.updateJob!(id as SessionId, job) : undefined,
        },
        cleanupTtlMs: Number(process.env.BACKGROUND_JOB_TTL_MS ?? 10 * 60 * 1000),
      })
    : undefined;

  // The typed agent-tools (slack/gitlab/github/web) call the broker server-side
  // under the agent-host's OWN identity (BROKER_URL + SA token, same anchor as
  // resolveAwsRequest below). When BROKER_URL is unset (local/fake) the tools
  // still register, but calls fail with a clear error the handlers echo verbatim.
  const brokerUrl = (process.env.BROKER_URL ?? "").replace(/\/$/, "");
  // Optional FALLBACK target discovery: read the webhooks conversation_map from
  // the shared Postgres when a conversation's link has no structured `ref` (e.g.
  // a conversation created before ref existed). Wired iff a DSN is available
  // (WEBHOOKS_DB_DSN, or assembled from WEBHOOKS_DB_* like the webhooks service).
  // Absent -> the tools rely on `ref` alone (unchanged behavior).
  const webhooksDsn = webhooksResourceDsn();
  const resourceLookup = webhooksDsn ? createResourceLookup({ dsn: webhooksDsn }) : undefined;

  // Identity resolution (provider-agnostic), composed as layers over the base
  // resolver (header by default; alb-oidc when AUTH_MODE=alb-oidc):
  //   base -> [ALB signature verify] -> [sub->email store + static map]
  // Verification runs BEFORE the store so an UNVERIFIED email is never learned.
  // All layers optional — with none configured this is the plain header behavior.
  const identityStore = webhooksDsn ? createPgIdentityStore({ dsn: webhooksDsn }) : undefined;
  const staticIdentityMap = parseIdentityMap(process.env.AUTH_SUB_EMAIL_MAP);

  /** Resolve an owner id → email for per-user cost metrics: the static map first
   *  (cheap, offline), then the identity store (learned at ingress login). Returns
   *  null when unknown — the metric then labels user_email "". Best-effort: a store
   *  error must never break metric emission. Used by the run-complete metrics hook. */
  const resolveOwnerEmail = async (id: string | undefined): Promise<string | null> => {
    if (!id) return null;
    const mapped = staticIdentityMap?.[id];
    if (mapped) return mapped;
    try {
      return (await identityStore?.get(id))?.email ?? null;
    } catch {
      return null;
    }
  };
  let identityResolver: AsyncIdentityResolver = resolverFromEnv();
  if (process.env.AUTH_ALB_VERIFY === "1") {
    identityResolver = withAlbVerification(identityResolver, {
      region: process.env.AUTH_ALB_REGION || process.env.AWS_REGION || "us-east-1",
      dataHeader: process.env.AUTH_ALB_DATA_HEADER || "x-amzn-oidc-data",
    });
  }
  const resolveUser =
    identityStore || staticIdentityMap
      ? withIdentityStore(identityResolver, { store: identityStore, staticMap: staticIdentityMap }).resolve
      : (req: IncomingMessage) => identityResolver.resolve(req);
  // Own a UI-created conversation (POST /agui) to its ingress-authenticated creator,
  // the same resolver /whoami + POST /conversations use — otherwise a browser-made
  // conversation had no owner and never showed under the Mine filter.
  server.useIdentityResolver(resolveUser);
  const agentToolsWiring = brokerUrl
    ? {
        broker: createBrokerClient({
          baseUrl: brokerUrl,
          tokenPath: process.env.BROKER_TOKEN_PATH ?? "/var/run/secrets/broker/token",
        }),
        links: (id: string) => store.listLinks?.(id as SessionId) ?? Promise.resolve([]),
        resourceLookup: resourceLookup
          ? (id: string, source: string) => resourceLookup.lookup(id, source)
          : undefined,
      }
    : undefined;
  // Serve the MCP endpoint if ANY capability is available: the agent-tools (broker
  // wired), the background-job tools, or the model self-selection tools. buildServer
  // registers whichever deps are present.
  // Model self-selection tools (list_models / switch_model) — offered when the
  // deployment has >1 model to choose from. Sourced from the catalog + the manager's
  // immediate-switch primitive.
  const modelToolsWiring =
    config.modelCatalog.models.length > 1
      ? {
          catalog: config.modelCatalog,
          currentModel: (id: string) => sessions.get(id)?.model,
          switchModel: (id: string, model: string) => sessions.switchModelNow(id, model),
        }
      : undefined;

  // Sandbox right-sizing tools (show_sandbox_resources / set_sandbox_resources) —
  // wired ONLY on the broker path (the broker owns + applies the size). The MCP
  // `conv` param is the FULL conversationId (= threadId); the broker keys the size
  // spec by the SHORT id (the same id ensure/resume/create use), so map through
  // shortId() before every broker size call — otherwise the tool would write a spec
  // the broker never reads at (re)provision time.
  const resourceToolsWiring = brokerProvisioner
    ? {
        currentResources: async (id: string): Promise<SandboxResources> =>
          (await brokerProvisioner.getSize(shortId(id))) ?? {},
        setResources: async (id: string, r: SandboxResources): Promise<boolean> => {
          await brokerProvisioner.setSize(shortId(id), r);
          return true; // recorded — the broker applies it on the next sandbox restart
        },
      }
    : undefined;

  // Scheduled-task tools (list/search/view/create/edit/delete) — wired when a
  // scheduler service URL is configured. Every call is scoped to the conversation's
  // OWNER (sessions.get(id).owner), which the HTTP client forwards as x-auth-user so
  // the scheduler attributes/scopes tasks to that user. No owner → the tools refuse.
  // One HTTP client to the scheduler service, shared by the agent MCP tools AND the
  // UI settings-page proxy (createManagementApi). Both scope every call to an owner
  // (the conversation owner for MCP; the caller for the UI).
  const schedulerClient = process.env.SCHEDULER_URL
    ? createHttpSchedulerClient({
        baseUrl: process.env.SCHEDULER_URL,
        relayKey: process.env.SCHEDULER_RELAY_KEY || undefined,
      })
    : undefined;
  const schedulerToolsWiring: SchedulerToolsWiring | undefined = schedulerClient
    ? {
        client: schedulerClient,
        owner: async (id: string) => sessions.get(id as SessionId)?.owner ?? null,
      }
    : undefined;

  // Subagent tools: delegate work to a child conversation that SHARES this
  // conversation's sandbox (see todo/docs/SUBAGENTS.md +
  // todo/docs/SUBAGENT_INTERACTION.md). Extracted to session/subagentManager.ts so
  // the spawn/list/check/cancel/send/monitor/search logic is unit-testable.
  const subagentManager: SubagentManager = createSubagentManager(sessions, store);

  // marimo notebook tools: target THIS conversation's in-pod marimo at podIP:2718.
  // Real sandboxes only (a fake/local sandbox has no pod IP). The pod IP is resolved
  // FRESH per call — it changes across suspend/resume, so we must not cache it.
  //
  // marimo runs with `--base-url /c/<CONVERSATION_ID>/marimo` (so it serves correctly
  // behind the web-service proxy), which prefixes ALL its routes — INCLUDING the
  // /api/* endpoints the client hits. So the client baseUrl must carry that same
  // prefix, else GET /api/sessions 404s (the live bug the fake-server tests missed).
  // CONVERSATION_ID is the full threadId the provisioner injects (see web-services/
  // marimo.nix). Overridable via MARIMO_BASE_PATH ("" to disable) for a bare server.
  const MARIMO_PORT = Number(process.env.MARIMO_PORT ?? 2718);
  const marimoBasePath = (threadId: string) =>
    process.env.MARIMO_BASE_PATH ?? `/c/${threadId}/marimo`;
  const publicBase = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  const marimoToolsWiring: MarimoToolsWiring | undefined = config.fakeSandbox
    ? undefined
    : {
        clientFor: async (conversationId: string) => {
          const conv = sessions.get(conversationId as SessionId);
          if (!conv) throw new Error(`no conversation ${conversationId} for marimo`);
          const target = await resolvePodTarget(conv.sandbox);
          const base = marimoBasePath(conv.threadId).replace(/\/$/, "");
          return createMarimoClient({ baseUrl: `http://${target.podIP}:${MARIMO_PORT}${base}` });
        },
        // The user-facing notebook URL: <PUBLIC_URL>/c/<threadId>/marimo/ (the same
        // path the web-service proxy serves). Undefined when PUBLIC_URL isn't set.
        notebookUrlFor: (conversationId: string) => {
          const conv = sessions.get(conversationId as SessionId);
          if (!conv || !publicBase) return undefined;
          return `${publicBase}${marimoBasePath(conv.threadId).replace(/\/$/, "")}/`;
        },
      };

  const mcpEndpoint =
    agentToolsWiring !== undefined ||
    jobManager !== undefined ||
    modelToolsWiring !== undefined ||
    resourceToolsWiring !== undefined ||
    schedulerToolsWiring !== undefined ||
    subagentManager !== undefined ||
    marimoToolsWiring !== undefined
      ? createMcpEndpoint({
          // The URL goose connects to. The agent-host serves it on its own port;
          // goose runs in THIS pod, so localhost reaches it.
          baseUrl: process.env.AGENT_SELF_MODIFY_MCP_URL ?? `http://127.0.0.1:${config.port}`,
          agentTools: agentToolsWiring,
          jobs: jobManager,
          models: modelToolsWiring,
          resources: resourceToolsWiring,
          scheduler: schedulerToolsWiring,
          subagents: subagentManager,
          marimo: marimoToolsWiring,
        })
      : undefined;

  // Restore persisted conversations so the session list survives a restart
  // (GET /conversations returns them; the UI sidebar repopulates on refresh).
  await sessions.hydrate();

  // Forward every conversation's AG-UI events to subscribed UI connections.
  // (SessionManager already persists them to the store via its own wiring.)

  server.onPrompt(async (sessionId, input) => {
    // sessionId here is the AG-UI threadId; find-or-start the conversation.
    // A requested model is honored only if it's the default or an offered model
    // (an unknown one is ignored -> the conversation keeps its current model).
    const requested = input.model;
    const model =
      requested && (requested === config.model || config.availableModels.includes(requested))
        ? requested
        : undefined;
    // Store any attached images in the AssetStore -> pass small refs to the bridge
    // (which resolves them to base64 ACP image blocks). Oversize/unsupported images
    // are dropped best-effort (a bad image must not fail the whole turn); the
    // AssetStore enforces the cap + MIME allow-list.
    const promptImages: Array<{ assetId: string; mimeType: string }> = [];
    for (const img of input.images ?? []) {
      try {
        const stored = await assets.put(sessionId, { data: Buffer.from(img.data, "base64"), mimeType: img.mimeType });
        promptImages.push({ assetId: stored.assetId, mimeType: stored.mimeType });
      } catch (e) {
        console.warn(`[agent-host] dropped an attached image for ${sessionId}:`, (e as Error).message);
      }
    }
    // Binary file attachments (Slack pdf/zip/…) ride straight through to the bridge,
    // which materializes each into the sandbox at /workspace/.slack/<name> via the
    // exec client (best-effort — a failed write must not kill the turn). The agent
    // SEES the saved paths because the message text (woven webhooks-side) references
    // them.
    const promptFiles = (input.files ?? []).map((f) => ({
      name: f.name,
      data: f.data,
      mimeType: f.mimeType,
    }));
    try {
      await sessions.promptByThread(sessionId, input.text, model, input.priority, input.owner, promptImages, promptFiles, input.source);
    } catch (err) {
      // The run couldn't even START (provision/revive failed — e.g. 409 on a wrong
      // hydrate map, goose/ACP error). PERSIST a RUN_ERROR to the durable log so a
      // reattaching/refreshing UI sees the failure (not just the live client — the
      // server also emits a live RUN_ERROR when we rethrow). Without this, the run
      // left no trace and the conversation looked silently dead.
      const message = err instanceof Error ? err.message : String(err);
      const runId = `err-${Date.now()}`;
      try {
        await store.appendEvent(sessionId as SessionId, { type: "RUN_STARTED", threadId: sessionId, runId });
        await store.appendEvent(sessionId as SessionId, {
          type: "RUN_ERROR",
          message: `The agent could not start this run: ${message}`,
        });
      } catch (persistErr) {
        console.error(`[agent-host] failed to persist RUN_ERROR for ${sessionId}:`, persistErr);
      }
      throw err; // rethrow so the /agui handler also emits a LIVE RUN_ERROR + closes
    }
  });

  // A user's answer to a permission/option request -> resolve the blocked run.
  server.onPermission(async (sessionId, toolCallId, optionId) => {
    sessions.get(sessionId)?.bridge?.answerPermission(toolCallId, optionId);
  });

  // assistant-ui resumes a paused run by POSTing /agui with resume[] — route the
  // answer to the conversation's bridge (interruptId == the request's toolCallId).
  //
  // REVIVE-BEFORE-ANSWER: after a rollout or idle-suspend the paused run is gone from
  // memory — no live bridge, or a bridge that no longer has this interrupt registered
  // (answerPermission returns false). Answering only the already-live bridge silently
  // no-ops there, the SSE is left open with no data, and the approval hangs → 502
  // forever (docs/scooter-bug-resume-hangs-when-run-not-live.md). So if the direct
  // answer doesn't land, REVIVE the conversation (rebuilds the bridge; onRevived →
  // reRaisePendingAwsInterrupts re-raises the still-pending broker request, restoring
  // answer-routing) and also re-raise directly (covers a live bridge that merely lost
  // the interrupt), then retry. Returns whether it was ultimately answered so the /agui
  // resume branch can close with RUN_ERROR instead of hanging when it genuinely can't.
  server.onResume(async (sessionId, entry) => {
    // cancelled -> empty optionId (the bridge treats an unknown/empty id as a
    // cancel); resolved -> the chosen optionId from the payload.
    const optionId =
      entry.status === "cancelled"
        ? ""
        : ((entry.payload as { optionId?: string } | undefined)?.optionId ?? "");

    const answer = () => sessions.get(sessionId)?.bridge?.answerPermission(entry.interruptId, optionId) ?? false;

    // 1) Fast path — the run is still live and holding this interrupt.
    if (answer()) return { ok: true };

    // 2) Dormant / lost-interrupt path — revive + re-raise, then retry. Both are
    //    best-effort and idempotent (revive is a no-op if already live; re-raise keys
    //    on the request id). A revive failure (e.g. conversation genuinely gone) is not
    //    fatal — we still attempt the answer and, failing that, report ok:false.
    await sessions.revive(sessionId as SessionId).catch((err) => {
      console.warn(`[agent-host] resume: revive of ${sessionId} failed (answering best-effort):`, err);
    });
    await reRaisePendingAwsInterrupts(sessionId).catch((err) => {
      console.warn(`[agent-host] resume: re-raise pending interrupts for ${sessionId} failed:`, err);
    });
    if (answer()) return { ok: true };

    // 3) Genuinely unanswerable (interrupt expired / already answered / unknown). The
    //    caller turns this into a RUN_ERROR on the stream rather than a silent hang.
    return { ok: false, reason: "this approval is no longer awaiting an answer (it may have expired or already been answered)" };
  });

  server.onAttach(async (sessionId, conn) => {
    for await (const event of store.readEvents(sessionId)) conn.send(event);
  });

  // Shared broker call setup: base URL + the agent-host SA token (the trust
  // anchor that vouches for the real user). Returns null when BROKER_URL is unset
  // (local/fake) so callers can no-op cleanly. Mirrors the token-read rules used
  // by resolveAwsRequest (ENOENT => dev/no-token; any other read error throws).
  const brokerAuth = async (): Promise<{ url: string; headers: Record<string, string> } | null> => {
    const url = (process.env.BROKER_URL ?? "").replace(/\/$/, "");
    if (!url) return null;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const tokenPath = process.env.BROKER_TOKEN_PATH ?? "/var/run/secrets/broker/token";
    try {
      const { readFileSync } = await import("node:fs");
      headers["Authorization"] = `Bearer ${readFileSync(tokenPath, "utf8").trim()}`;
    } catch (e) {
      if ((e as { code?: string })?.code !== "ENOENT") {
        throw new Error(
          `failed to read broker token at ${tokenPath}: ${(e as Error)?.message ?? e}`,
          { cause: e },
        );
      }
      /* ENOENT -> no token (local/dev) */
    }
    return { url, headers };
  };

  // In-pod web-service registry (list/start via exec) — shared by the management
  // API (UI Services panel) and the reverse proxy. Real k8s only; fake/local
  // sandboxes have no pod, so it's left undefined and the routes report none.
  const webServices = config.fakeSandbox
    ? undefined
    : createWebServiceRegistry({
        sandboxFor: (id) => sessions.get(id)?.sandbox,
        connect: (ref) => connectSandbox(ref),
      });

  // Module registry: search the broker catalog + install (attach) modules into a
  // conversation's sandbox, via the in-pod agent-broker / scooter-rebuild CLIs.
  const moduleRegistry = config.fakeSandbox
    ? undefined
    : createModuleRegistry({
        sandboxFor: (id) => sessions.get(id)?.sandbox,
        connect: (ref) => connectSandbox(ref),
      });

  // Management REST API (conversation CRUD + lifecycle + history), mounted on
  // the same server. /agui stays the AG-UI streaming transport.
  server.use(
    createManagementApi({
      sessions,
      store,
      server,
      webServices,
      moduleRegistry,
      identityStore,
      assets,
      scheduler: schedulerClient,
      // The current sandbox size (cpu/memory/gpu) for the Sandbox tab. Broker path
      // only (it owns sizing); keyed by shortId like the show/set resource tools.
      sandboxResources: brokerProvisioner
        ? (id: string) => brokerProvisioner.getSize(shortId(id))
        : undefined,
      // Manual compaction — summarize older turns via a one-off SDK query with the
      // SAME token/model the conversation runs on. Off (undefined) without a token.
      compact: process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? (id: string) =>
            compactConversation(store, id, {
              model: sessions.get(id as SessionId)?.model ?? config.model ?? "claude-sonnet-4-5",
              oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN!,
              claudeCodePath: process.env.CLAUDE_CODE_COMMAND,
            })
        : undefined,
      models: {
        default: config.model,
        available: config.availableModels,
        hints: Object.fromEntries(
          config.modelCatalog.models.filter((m) => m.hint).map((m) => [m.id, m.hint]),
        ),
      },
      resolveUser,
      mcpHandler: mcpEndpoint ? (req, res, body) => mcpEndpoint.handle(req, res, body) : undefined,
      answerPermission: async (sessionId, toolCallId, optionId) => {
        // Route the user's choice to the conversation's bridge, which resolves
        // the blocked agent run (ACP request_permission).
        const answered = sessions.get(sessionId)?.bridge?.answerPermission(toolCallId, optionId);
        if (!answered) {
          console.warn("[agent-host] no pending permission", { sessionId, toolCallId });
        }
      },
      // Approve/deny the broker AWS request the user answered. Shared with the
      // revive re-raise (onRevived) so both paths route answers identically.
      resolveAwsRequest: resolveAwsRequestForBroker,
      canApproveAwsRequest: async (_sessionId, requestId, approver) => {
        // Read-only: may THIS viewer approve THIS request? Per-viewer (the interrupt
        // is raised once but seen by many users), so the UI asks with the current
        // user's identity. Fail CLOSED (false) on any hiccup — a greyed button that
        // should be live is safe; a live button that should be greyed is not. When
        // BROKER_URL is unset (local/fake), default to true so dev UIs stay usable.
        const auth = await brokerAuth().catch(() => null);
        if (!auth) return true;
        try {
          const res = await fetch(
            `${auth.url}/aws/aws/${encodeURIComponent(requestId)}/can-approve`,
            { method: "POST", headers: auth.headers, body: JSON.stringify({ approver }) },
          );
          if (!res.ok) return false;
          const j = (await res.json().catch(() => ({}))) as { can_approve?: boolean };
          return j.can_approve === true;
        } catch {
          return false;
        }
      },
    }),
  );

  // Web-service reverse proxy (/c/<id>/<service>/... -> the conversation's pod).
  // Real k8s only — needs pod IPs + in-pod systemd. Fake/local sandboxes have no
  // pod to proxy to, so it's left unmounted there (the routes just 404).
  if (webServices) {
    server.useProxy(
      createWebServiceProxy({
        sessions,
        resolvePodTarget: (ref) => resolvePodTarget(ref),
        registry: webServices,
        publicHost: (() => {
          try {
            return process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).host : "";
          } catch {
            return "";
          }
        })(),
      }),
    );
  }

  await server.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`[agent-host] listening on :${config.port}`);

  // Resume conversations interrupted by THIS restart (a run that started but never
  // finished): revive + nudge them to continue. Fire-and-forget AFTER listen(), so
  // the server is up to serve the resumed runs' events and boot isn't blocked. Not
  // in fake mode (no real sandboxes/goose to revive).
  if (!config.fakeSandbox) {
    void sessions
      .resumeInterrupted()
      .then((ids) => {
        if (ids.length) console.log(`[agent-host] resumed ${ids.length} interrupted conversation(s)`);
      })
      .catch((err) => console.error("[agent-host] resumeInterrupted failed:", err));
  }

  // Idle-suspend sweep — kube-native-friendly: the agent-host owns the activity
  // signal, so it suspends idle conversations itself (drops the pod, keeps the
  // PVCs). Activity metadata is exposed via the API + persisted so an external
  // lifecycle controller could take over. 0 disables.
  // Report sandbox population to metrics (also each sweep tick below).
  const reportSandboxCounts = () => {
    let running = 0;
    let suspended = 0;
    for (const c of sessions.list()) {
      if (c.status === "running") running++;
      else if (c.status === "suspended") suspended++;
    }
    metrics.setSandboxCounts({ running, suspended });
  };
  reportSandboxCounts();

  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  if (config.idleSuspendMs > 0) {
    sweepTimer = setInterval(() => {
      void sessions.sweepIdle(config.idleSuspendMs).then((ids) => {
        if (ids.length) console.log(`[agent-host] idle-suspended ${ids.length}:`, ids);
        reportSandboxCounts();
      });
    }, config.idleSweepIntervalMs);
    sweepTimer.unref?.();
  }

  // Retention reap — DESTROY (end) unstarred conversations inactive past the
  // retention window. Opt-in (0 = off); starred conversations are exempt. Runs on its
  // own slow cadence (default 6h) since deletion is coarse-grained.
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  if (config.retentionMaxAgeMs > 0) {
    const reap = () =>
      void sessions.sweepRetention(config.retentionMaxAgeMs).then((ids) => {
        if (ids.length) console.log(`[agent-host] retention-reaped ${ids.length} (inactive > ${config.retentionMaxAgeMs}ms, unstarred):`, ids);
        reportSandboxCounts();
      }).catch((err) => console.error("[agent-host] retention sweep failed:", err));
    retentionTimer = setInterval(reap, config.retentionSweepIntervalMs);
    retentionTimer.unref?.();
  }

  // Background-job cleanup: periodically remove EXITED jobs' on-disk files past the
  // TTL, per RUNNING conversation (a suspended pod has no fs to sweep). Best-effort.
  let jobCleanupTimer: ReturnType<typeof setInterval> | undefined;
  if (jobManager) {
    jobCleanupTimer = setInterval(() => {
      for (const c of sessions.list()) {
        if (c.status !== "running") continue;
        void jobManager.cleanup(c.id).catch(() => {});
      }
    }, config.idleSweepIntervalMs);
    jobCleanupTimer.unref?.();
  }

  // Background-job completion WATCHER: poll running conversations for jobs that
  // finished since last tick and inject a "job finished" turn so the agent reacts
  // WITHOUT the user having to ask it to check. The injection uses interrupt:
  // "thinking" — it preempts idle text generation but NEVER kills an in-flight tool
  // call (don't cancel a build to announce another job). prompt() revives the
  // conversation if its bridge went idle, so a completion still lands. Best-effort.
  const jobWatchEnabled = jobManager && process.env.BACKGROUND_JOB_WATCH !== "0";
  let jobWatchTimer: ReturnType<typeof setInterval> | undefined;
  if (jobWatchEnabled) {
    jobWatchTimer = setInterval(() => {
      for (const c of sessions.list()) {
        // Poll conversations whose pod is up (running) — a suspended conversation's
        // completions are announced on its next revive (the watcher sees them then).
        if (c.status !== "running") continue;
        void (async () => {
          const done = await jobManager!.pollCompletions(c.id).catch(() => [] as JobStatus[]);
          for (const st of done) {
            const tail = st.output.trim();
            const more = st.truncated ? `\n(output truncated — full log: check_background("${st.jobId}"))` : "";
            // A SYSTEM message (source "background job") — the standard decoration is
            // added by the bridge, so no manual [System] prefix here.
            const text =
              `Background job \`${st.jobId}\` (${st.command}) finished with exit code ${st.exitCode}.\n` +
              (tail ? `Recent output:\n${tail}${more}\n\n` : "") +
              `React to this result if it's relevant to your task; otherwise acknowledge briefly.`;
            await sessions
              .prompt(c.id as SessionId, text, undefined, PRIORITY_INTERRUPT, "thinking", undefined, undefined, "background job")
              .catch((e) => console.error(`[agent-host] job-completion inject failed for ${c.id}:`, e));
          }
        })();
      }
    }, config.idleSweepIntervalMs);
    jobWatchTimer.unref?.();
  }

  // Subagent completion: when a subagent finishes, inject its RESULT (last
  // assistant message) into the PARENT — priority-interrupt so it preempts the
  // parent's idle turn — then CLEAN UP the subagent (end it). The result
  // convention matches the Claude CLI (final message returns to the parent).
  //
  // Two triggers, notify-ONCE across both:
  //   - EVENT-DRIVEN (primary): onSubagentComplete fires the instant the child's
  //     run terminates → the parent gets the result immediately (no poll latency).
  //   - POLL BACKSTOP: a periodic sweep catches a completion whose event was missed
  //     (e.g. a subagent finished across an agent-host restart, so no live bridge
  //     fired the event). SUBAGENT_WATCH=0 disables both.
  let subagentWatchTimer: ReturnType<typeof setInterval> | undefined;
  if (process.env.SUBAGENT_WATCH !== "0") {
    const notified = new Set<SessionId>(); // subagents already reported + cleaned up
    const reportCompletion = async (subagentId: SessionId, parentId: SessionId): Promise<void> => {
      if (notified.has(subagentId)) return;
      notified.add(subagentId); // notify-once (mark before the async work)
      // Flush the subagent's pending appends FIRST. The event-driven path fires from
      // the bridge's RUN_FINISHED onEvent, but the store write is fire-and-forget
      // (wireEventLog `void store.appendEvent`), so without this the read below can
      // miss the just-emitted RUN_FINISHED → lastRunCompleted=false → the completion
      // is silently dropped (the goose subagent "no result" bug; claude's timing
      // usually won the race, goose's lost it). Flushing closes that window.
      await store.flush?.(subagentId).catch(() => {});
      const events = await collectEventsSafe(store.readEvents(subagentId));
      if (!lastRunCompleted(events)) {
        notified.delete(subagentId); // hasn't actually run yet — re-check later
        return;
      }
      const child = sessions.get(subagentId);
      if (sessions.get(parentId)) {
        const text = subagentDoneNotice(subagentId, child?.title, lastAssistantText(events));
        await sessions
          .prompt(parentId, text, undefined, PRIORITY_INTERRUPT, "thinking", undefined, undefined, "subagent")
          .catch((e) => console.error(`[agent-host] subagent-completion inject failed for parent ${parentId}:`, e));
      }
      // Clean up the finished subagent (cascade-safe: a child shares the parent's
      // pod, so end() won't tear the pod down for it).
      await sessions
        .end(subagentId)
        .catch((e) => console.error(`[agent-host] subagent cleanup (end) failed for ${subagentId}:`, e));
    };

    // Primary: fire the moment a subagent's run terminates.
    sessions.onSubagentComplete((subagentId, parentId) => void reportCompletion(subagentId, parentId));

    // Backstop: sweep for an idle, completed subagent whose event was missed.
    subagentWatchTimer = setInterval(() => {
      for (const c of sessions.list()) {
        if (c.parentId === undefined) continue; // top-level, not a subagent
        if (notified.has(c.id as SessionId)) continue;
        if (c.bridge?.queueState().running) continue; // still working
        void reportCompletion(c.id as SessionId, c.parentId as SessionId);
      }
    }, config.idleSweepIntervalMs);
    subagentWatchTimer.unref?.();
  }

  return async () => {
    if (sweepTimer) clearInterval(sweepTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    if (jobCleanupTimer) clearInterval(jobCleanupTimer);
    if (jobWatchTimer) clearInterval(jobWatchTimer);
    if (subagentWatchTimer) clearInterval(subagentWatchTimer);
    await metrics.shutdown();
    await server.close();
    ownership?.stop(); // end the Conversation-CRD watch (multi-replica only)
    // Flush the NFS mirror's buffered tail before exit so a PLANNED rollout ships every
    // event to the backup (near-RPO-0); an unclean crash loses at most the in-flight
    // batch. No-op when the mirror is off. Best-effort — never BLOCK the exit on it, but
    // a drain failure means the backup just lost its buffered tail (exactly the data a
    // planned rollout was trying to preserve), so LOG it loudly + debuggably (full error
    // + stack) instead of swallowing — a silent failure here is undiagnosable after the
    // pod is gone.
    if (mirroredStore) {
      try {
        await mirroredStore.drainMirror();
      } catch (err) {
        console.error(
          "[agent-host] MIRROR DRAIN FAILED on shutdown — the NFS backup may be missing " +
            "its buffered tail (data loss on this rollout). Error:",
          err, // Node prints the stack/traceback for an Error
        );
      }
    }
  };

  // --- helpers ---

  function makeBridge(
    conversationId: string,
    sandbox: SandboxRef,
    cfg: AgentHostConfig,
    model: string | undefined,
    metrics: MetricsSink,
  ) {
    // In fake mode there is no pod, so the agent's tool calls run as local
    // subprocesses; in cluster mode they exec into the sandbox pod via the K8s
    // exec API (resolved on first use). The ACP client (goose) is created by the
    // factory the bridge calls on first start().
    const exec = createSandboxExecBackend(
      config.fakeSandbox
        ? createLocalSandboxApiClient()
        : deferredSandboxApi(sandbox, () => provisioner.resume(sandbox).then(() => {})),
      { commandTimeoutMs: config.commandTimeoutMs },
    );
    // Per-conversation model override: GOOSE_MODEL in the agent's launch env.
    const resolved = resolveModel(model, cfg);
    // GOOSE_MODE=approve enables the per-tool permission gate the acp client
    // auto-answers for back-pressure (allow normally; reject when a priority item
    // is queued). Off (auto) when SUBAGENT_BACKPRESSURE=0. See the shouldYield dep
    // on createAcpClient below + todo/docs/SUBAGENT_BACKPRESSURE.md.
    const backpressureOn = process.env.SUBAGENT_BACKPRESSURE !== "0";
    const agentEnv = {
      ...cfg.agent.env,
      ...(resolved ? { GOOSE_MODEL: resolved } : {}),
      ...(backpressureOn ? { GOOSE_MODE: "approve" } : {}),
    };
    // goose runs IN the agent-host pod (not the sandbox), so its cwd must be a
    // real, writable dir HERE — not the sandbox's "/workspace" (which doesn't
    // exist in this pod; goose's session/new panics on a missing cwd and the
    // ACP newSession hangs). The agent's *tool calls* still exec into the
    // sandbox via the ExecBackend. Give goose a per-conversation scratch dir on
    // the state volume.
    // goose's per-conversation cwd is EPHEMERAL scratch (sessions DB +
    // .goosehints) — the agent's real file/terminal work execs into the sandbox
    // via the ExecBackend, not here. So it lives under scratchPath (an emptyDir),
    // NOT the durable state PVC. (The durable event log stays on statePath.)
    const cwd = join(config.scratchPath, conversationId, "agent-cwd");
    mkdirSync(cwd, { recursive: true });
    // Inject the agent identity (Scooter) + skills as goose's .goosehints in its
    // cwd. Re-read on every conversation start, so editing the skills ConfigMap
    // takes effect for new conversations with no image rebuild.
    const skillCount = writeHints(cwd, config.skillsDir, { name: config.agentName });
    if (skillCount) console.log(`[agent-host] ${conversationId}: ${skillCount} skill(s) -> .goosehints`);
    const metricModel = resolved ?? cfg.model ?? "unknown";
    // Offer the agent the in-process MCP tools (background jobs / model selection /
    // agent-tools), scoped to THIS conversation via the URL's ?conv=<id>.
    const mcpServers = mcpEndpoint
      ? [{ type: "http", name: "scooter-env", url: mcpEndpoint.urlFor(conversationId), headers: [] }]
      : undefined;
    const usingClaude = process.env.GOOSE_PROVIDER === "claude-code" && !config.fakeSandbox;
    const bridge = createSessionBridge({
      config: { cwd, skillsDir: config.skillsDir, agent: cfg.agent, sandbox, mcpServers },
      exec,
      firstActivityTimeoutMs: config.firstActivityTimeoutMs,
      livenessProbeMs: config.livenessProbeMs,
      // TRANSCRIPT RECORDER (test-harness, off unless TRANSCRIPT_RECORD_DIR is set):
      // record the RAW agent input + emitted AG-UI so tests replay real behavior.
      recorder: transcriptRecorder,
      provider: usingClaude ? "claude" : "goose",
      acpClient: () =>
        // claude-code: drive the agent via the Claude Agent SDK (isolated package)
        // so its tools run IN THE SANDBOX (via ExecBackend) instead of the
        // agent-host pod — the fix for the unreachable-scooter-rebuild bug — while
        // keeping subscription auth (CLAUDE_CODE_OAUTH_TOKEN). Other providers keep
        // the goose acp path unchanged.
        usingClaude
          ? createSdkAcpClient({
              oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
              model: resolved ?? cfg.model ?? "claude-sonnet-4-5",
              exec,
              systemPrompt: assembleHints(loadSkills(config.skillsDir), { name: config.agentName }),
              // TRANSCRIPT: record the RAW SDK messages under this run (no-op off).
              recordRaw: (m) => bridge.recordRawInput(m),
              // Give the SDK agent the SAME platform MCP tools the goose path gets
              // (scheduler / slack / github / background jobs / model switch / resize),
              // scoped to this conversation via ?conv=<id>. Without this the agent has
              // only the sandbox tools and can't actually use those capabilities.
              mcpEndpointUrl: mcpEndpoint?.urlFor(conversationId),
              // BACK-PRESSURE: yield the next tool call when a priority item (e.g. a
              // finished subagent's result) is waiting, so it injects promptly
              // instead of the parent spinning in a check_subagent poll loop.
              // Late-bound: `bridge` is assigned below and set by the time the SDK
              // calls this (on the first tool). Gated by SUBAGENT_BACKPRESSURE.
              shouldYield:
                process.env.SUBAGENT_BACKPRESSURE === "0"
                  ? undefined
                  : () => bridge.shouldYieldToQueue(),
            })
          : createAcpClient({
              command: cfg.agent.command,
              args: cfg.agent.args,
              env: agentEnv,
              exec,
              // Back-pressure: auto-answer goose's approve-mode permission gate —
              // allow normally, reject the next tool when a priority item waits.
              // Late-bound (bridge assigned below). Gated with GOOSE_MODE above.
              shouldYield: backpressureOn ? () => bridge.shouldYieldToQueue() : undefined,
              // TRANSCRIPT: record the RAW ACP updates under this run (no-op off).
              recordRaw: (u) => bridge.recordRawInput(u),
            }),
      onRunComplete: ({ acpSessionId, durationMs, outcome }) => {
        // Attribute cost to the conversation OWNER (id + email). Resolve async
        // (email may need the identity store) but don't block the run — the metric
        // read is itself async/best-effort. Unowned → runFinished buckets it as
        // user_id "anonymous".
        const ownerId = sessions.get(conversationId as SessionId)?.owner;
        void resolveOwnerEmail(ownerId).then((ownerEmail) => {
          metrics.runFinished({
            conversationId,
            model: metricModel,
            acpSessionId: acpSessionId ?? conversationId,
            durationMs,
            outcome,
            ownerId,
            ownerEmail,
          });
        });
      },
      // Revive history reinjection: a revived conversation spawns a fresh goose
      // session with no memory, so on this bridge's first prompt the persisted
      // event log is folded into a transcript and prepended. Read the FULL log
      // for this conversation (the bridge snapshots it before the current turn).
      loadHistory: async () => {
        const events: AguiEvent[] = [];
        for await (const e of store.readEvents(conversationId as SessionId)) events.push(e);
        // If the conversation was COMPACTED, resume from [summary recap + events after
        // the latest marker] so the revived session's context is the compacted one
        // (real token reduction). No marker → full log, unchanged.
        return historyAfterCompaction(events);
      },
      // Resolve an attached image's bytes so the run builds the ACP image block.
      readAsset: (assetId) => assets.read(conversationId as SessionId, assetId),
    });

    // Mirror bridge events to UI subscribers.
    bridge.onEvent((event) => server.broadcast(conversationId, event));
    return bridge;
  }
}

/**
 * A SandboxApiClient that resolves the real pod-exec client on first use.
 * (connectSandbox is async; the ExecBackend interface is sync-constructed.)
 */
function deferredSandboxApi(sandbox: SandboxRef, ensureRunning?: () => Promise<void>) {
  // In-flight dedupe: a burst of concurrent first tool calls shares ONE connect
  // (one pod-readiness wait), not N. (`real ??= await connect()` would not dedupe
  // — it caches only the resolved value, so concurrent awaits each connect.)
  // ensureRunning self-heals a sandbox idle-suspended out from under a live bridge:
  // if connect finds no pod, it resumes the sandbox (idempotent) + re-polls.
  const ensure = createDeferredConnector(() => connectSandbox(sandbox, { ensureRunning }));
  return {
    mode: "k8s-exec" as const,
    async execute(req: Parameters<Awaited<ReturnType<typeof connectSandbox>>["execute"]>[0]) {
      return (await ensure()).execute(req);
    },
    async download(path: string) {
      return (await ensure()).download(path);
    },
    async upload(path: string, content: string) {
      return (await ensure()).upload(path, content);
    },
  };
}


/** Wire SIGTERM (the k8s preStop/rollout signal) + SIGINT to a graceful drain.
 *  `shutdown` (main()'s return) stops the timers, flushes metrics, and closes the
 *  server — which flushes in-flight event-log writes + ends SSE connections cleanly
 *  so clients get a proper close and reconnect, rather than a raw 502 from a hard
 *  kill. The drain is bounded by SHUTDOWN_TIMEOUT_MS so a stuck close can never hold
 *  the pod past its terminationGracePeriod. Repeat signals mid-drain are ignored.
 *  Exported (with injectable proc/timers) so it's unit-testable without the process. */
export function installShutdownHandlers(
  shutdown: () => Promise<void>,
  opts: {
    proc?: Pick<NodeJS.Process, "on" | "exit">;
    timeoutMs?: number;
    setTimeoutFn?: typeof setTimeout;
    log?: (msg: string) => void;
  } = {},
): void {
  const proc = opts.proc ?? process;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 8000);
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  const log = opts.log ?? ((m) => console.log(m));
  let shuttingDown = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (shuttingDown) return; // ignore repeat signals mid-drain
    shuttingDown = true;
    log(`[agent-host] ${sig} — draining…`);
    const timer = setTimeoutFn(() => {
      log(`[agent-host] drain exceeded ${timeoutMs}ms — exiting`);
      proc.exit(0);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    shutdown()
      .then(() => { log("[agent-host] drained cleanly"); proc.exit(0); })
      .catch((e) => { console.error("[agent-host] drain error:", e); proc.exit(0); });
  };
  proc.on("SIGTERM", onSignal);
  proc.on("SIGINT", onSignal);
}

// Entry point: when run directly (node dist/index.js), start the service.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((shutdown) => installShutdownHandlers(shutdown))
    .catch((err) => {
      console.error("[agent-host] fatal:", err);
      process.exit(1);
    });
}
