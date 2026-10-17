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
import {
  createManagementApi,
  raiseApprovalInterrupt,
  fetchPendingApprovals,
  type ApprovalContrib,
  fetchConversationShares,
} from "./api/management.js";
import { createSessionManager, shortId } from "./session/manager.js";
import { createRemoteAgentRegistry, createRemotePersonalizedProvider } from "./acp/remoteAgentRegistry.js";
import { createRemoteAgentUi } from "./acp/remoteAgentOneliner.js";
import { createPgRemoteAgentStore } from "./acp/remoteAgentStore.js";
import type { AcpProvider } from "./acp/provider.js";
import { historyAfterCompaction, compactConversation } from "./session/compaction.js";
import { createK8sProvisioner, type K8sProvisioner } from "./session/k8sProvisioner.js";
import type { SandboxResources } from "./session/resources.js";
import { brokerAuthHeaders as sharedBrokerAuthHeaders } from "./session/brokerAuth.js";
import type { SandboxProvisioner } from "./session/manager.js";
import { createFileConversationStore } from "./session/fileStore.js";
import { createPgEventStore, withPgEvents } from "./session/eventStore.js";
import { agentHostDsnFromEnv } from "./db/agentHostDsn.js";
import { createK8sOwnershipGuard } from "./session/k8sOwnershipGuard.js";
import { createK8sConversationRegistry } from "./session/k8sConversationRegistry.js";
import { withConversationRows } from "./session/pgConversationRegistry.js";
import type { ConversationStore, ConversationLink } from "./session/manager.js";
import { createPgLinkStore } from "./session/linkStore.js";
import { createPgMetaStore } from "./session/metaStore.js";
import { createPvcAssetStore } from "./session/assetStore.js";
import { createHybridAssetStore } from "./session/hybridAssetStore.js";
import { createSessionBridge, PRIORITY_INTERRUPT, type AguiEvent, type ApproverIdentity } from "./bridge.js";
import { createAcpClient } from "./acp/client.js";
import { createRecorder } from "./transcript/recorder.js";
import { createSandboxExecBackend, connectSandbox } from "./exec/sandboxExec.js";
import { createDeferredConnector } from "./exec/deferredConnect.js";
import { createLocalSandboxApiClient } from "./exec/localExec.js";
import { resolvePodTarget } from "./exec/k8sExec.js";
import { createWake, createWebServiceProxy } from "./proxy/webServiceProxy.js";
import { createWebServiceRegistry } from "./proxy/webServiceRegistry.js";
import { createModuleRegistry } from "./proxy/moduleRegistry.js";
import {
  writeHints,
  writeSkillDir,
  sdkPrompt,
  loadSkills,
  personalSkill,
  shadowedNames,
  type Skill,
} from "./agent/skills.js";
import { createSdkAcpClient } from "@scooter/claude-sdk-provider";
import { ensureGooseConfig } from "./agent/gooseConfig.js";
import { catalogFromEnv, availableIds, type ModelCatalog } from "./agent/models.js";
import { createJobManager, type JobStatus, type JobRegistry } from "./session/jobManager.js";
import { createPgJobStore } from "./session/jobStore.js";
import { createPgUserSkillStore } from "./session/userSkillStore.js";
import { mintConvToken } from "./auth/convToken.js";
import { createMcpEndpoint, resolveConversation } from "./agent/mcpServer.js";
import { createBrokerMcpProxy } from "./agent/brokerMcpProxy.js";
import {
  lastAssistantText,
  subagentDoneNotice,
  type SubagentManager,
  type SubagentStatus,
} from "./agent/subagentTools.js";
import { createSubagentManager } from "./session/subagentManager.js";
import { createRouterSubagentCreator } from "./session/routerSubagents.js";
import { lastRunCompleted } from "./session/danglingRun.js";
import { randomUUID } from "node:crypto";
import { createHttpSchedulerClient } from "./agent/schedulerClient.js";
import type { SchedulerToolsWiring } from "./agent/schedulerTools.js";
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
import { formatError, logger, type Logger } from "./log.js";

const hostLog = logger("agent-host");

/** Default per-file cap (~25MB) for materialized (non-image) uploads, overridable with FILE_MAX_BYTES. */
const DEFAULT_FILE_MAX_BYTES = 25 * 1024 * 1024;

/** Decoded byte length of a base64 string, computed without allocating a Buffer so an
 *  oversize upload is rejected before decoding. */
function base64ByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

/** The shared transcript recorder for the test harness, off unless TRANSCRIPT_RECORD_DIR is set. */
const transcriptRecorder = createRecorder(process.env.TRANSCRIPT_RECORD_DIR);

export interface AgentHostConfig {
  port: number;
  namespace: string;
  sandboxImage: string;
  /** Ephemeral per-pod volume (an emptyDir) for uploaded assets and goose state; nothing
   *  answering "which conversations exist?" may depend on it. */
  localStatePath: string;
  /** Ephemeral scratch for the agent process (goose's per-conversation cwd), an emptyDir
   *  rather than the durable PVC. */
  scratchPath: string;
  /** ACP agent launch (goose). */
  agent: { command: string; args: string[]; env: Record<string, string> };
  /** The default model and the ids offered for per-conversation selection, both derived
   *  from `modelCatalog`. */
  model?: string;
  availableModels: string[];
  /** The full model catalog (ids, hints, default), powering the model MCP tools and GET /models. */
  modelCatalog: ModelCatalog;
  /** Agent display name (the assistant introduces itself as this). */
  agentName: string;
  /** Directory of markdown skills injected into the agent, read per conversation into .goosehints. */
  skillsDir: string;
  /** Suspend conversations idle longer than this many ms, 0 for off. */
  idleSuspendMs: number;
  /** How often the idle sweep runs (ms). */
  idleSweepIntervalMs: number;
  /** Retention reap: destroy unstarred conversations inactive longer than this (ms); 0 = off. */
  retentionMaxAgeMs: number;
  /** How often the retention reap runs (ms), defaulting to 6h. */
  retentionSweepIntervalMs: number;
  /** Hard per-command exec timeout (ms) after which a runaway shell command is aborted; 0 = off. */
  commandTimeoutMs: number;
  /** Dead-on-arrival run watchdog (ms): a run with no ACP activity within this window ends
   *  with a RUN_ERROR; 0 = off. */
  firstActivityTimeoutMs: number;
  /** Liveness probe cadence (ms) at which an active run checks the agent process is alive,
   *  force-terminating only when it has died; 0 = off. */
  livenessProbeMs: number;
  /** OpenTelemetry metrics exported over OTLP, off by default. */
  observability: {
    enabled: boolean;
    /** deployment.environment resource attribute (e.g. "dev", "prod"). */
    environment?: string;
    /** Raw JSON of the per-model price table (USD per 1M tokens); empty means tokens are
     *  counted and cost omitted. */
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
    // The agent and the sandbox are separate choices: GOOSE_BIN=fake picks a deterministic
    // agent, while the sandbox is faked only out of a cluster (or with FAKE_SANDBOX=1).
    const inCluster = process.env.KUBERNETES_SERVICE_HOST !== undefined;
    const fakeSandbox =
      process.env.FAKE_SANDBOX === "1" || (useFakeAgent && !inCluster);
  // Outside a cluster the /var/lib paths are not writable, so default to an OS temp dir.
  const defaultStatePath = fakeSandbox
    ? join(tmpdir(), "agent-host", "conversations")
    : "/var/lib/agent-host/conversations";
  const defaultScratchPath = fakeSandbox ? join(tmpdir(), "agent-scratch") : "/var/lib/agent-scratch";
  return {
    port: Number(process.env.PORT ?? 8080),
    namespace: process.env.NAMESPACE ?? "agent-sandbox",
    sandboxImage: process.env.SANDBOX_IMAGE ?? "agent-sandbox-os:latest",
    // An ephemeral per-pod cache of the conversations this pod serves, never the durable
    // record; STATE_PATH is the older name, still honored.
    localStatePath: process.env.LOCAL_STATE_PATH ?? process.env.STATE_PATH ?? defaultStatePath,
    scratchPath: process.env.SCRATCH_PATH ?? defaultScratchPath,
    // Defaults to suspending after 30 min idle with a sweep every minute, and 0 disables.
    idleSuspendMs: Number(process.env.IDLE_SUSPEND_MS ?? 30 * 60 * 1000),
    idleSweepIntervalMs: Number(process.env.IDLE_SWEEP_INTERVAL_MS ?? 60 * 1000),
    // Retention reap: destroy unstarred conversations inactive this long; off by default.
    retentionMaxAgeMs: Number(process.env.RETENTION_MAX_AGE_MS ?? 0),
    retentionSweepIntervalMs: Number(process.env.RETENTION_SWEEP_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
    // Hard per-command exec timeout, defaulting to 5 min, with COMMAND_TIMEOUT_MS=0 disabling it.
    commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_MS ?? 5 * 60 * 1000),
    // Dead-on-arrival run watchdog; FIRST_ACTIVITY_TIMEOUT_MS=0 disables.
    firstActivityTimeoutMs: Number(process.env.FIRST_ACTIVITY_TIMEOUT_MS ?? 60 * 1000),
    livenessProbeMs: Number(process.env.AGENT_LIVENESS_PROBE_MS ?? 30 * 1000),
    fakeSandbox,
    // The default model and the offered ids are derived from the catalog.
    modelCatalog: catalog,
    model: catalog.defaultId,
    availableModels: availableIds(catalog),
    agentName: process.env.AGENT_NAME ?? "Scooter",
    skillsDir: process.env.SKILLS_DIR ?? "/etc/agent-sandbox/skills",
    observability: {
      // Off unless OTEL_METRICS_ENABLED=1; the OTLP endpoint comes from the standard
      // OTEL_EXPORTER_OTLP_* env.
      enabled: process.env.OTEL_METRICS_ENABLED === "1",
      environment: process.env.OTEL_DEPLOYMENT_ENVIRONMENT || undefined,
      pricingJson: readPricing(),
    },
    agent: useFakeAgent
      ? { command: process.execPath, args: [fakeAgentPath], env: {} }
      : // Without --with-builtin the agent gets no shell/file tools at all.
        {
          command: process.env.GOOSE_BIN ?? "goose",
          args: ["acp", "--with-builtin", "developer"],
          env: bedrockEnv(),
        },
  };
}

/** The per-model price table JSON, inline (AGENT_PRICING_JSON) or from a mounted file
 *  (AGENT_PRICING_FILE); empty when neither is set or the file is unreadable. */
function readPricing(): string {
  if (process.env.AGENT_PRICING_JSON) return process.env.AGENT_PRICING_JSON;
  const file = process.env.AGENT_PRICING_FILE;
  if (file) {
    try {
      return readFileSync(file, "utf8");
    } catch (e) {
      // Cost metrics are best-effort, but an explicitly set AGENT_PRICING_FILE that cannot be
      // read is a misconfiguration, so log it as an error.
      // eslint-disable-next-line no-console
      hostLog.errorWith("AGENT_PRICING_FILE unreadable; cost metrics DISABLED (misconfig?)", e, { file });
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
    // Malformed pricing JSON is an explicit-config failure, so log it as an error.
    // eslint-disable-next-line no-console
    hostLog.errorWith("invalid pricing JSON; cost metrics DISABLED (misconfig?)", e);
    return {};
  }
}

/** Resolve the model for a conversation: an explicit pick if it is an offered model, else
 *  the configured default. */
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

/** DSN for the shared Postgres holding the webhooks conversation_map, from WEBHOOKS_DB_DSN
 *  or the WEBHOOKS_DB_* components; empty when no DB is configured. */
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

/** DSN for the BYOC database, where agent-host writes the byoc.remote_agents liveness badge
 *  alongside byoc-controller; not derived from the webhooks DSN. */
function byocResourceDsn(): string {
  const explicit = process.env.BYOC_DB_DSN;
  if (explicit) return explicit;
  const pw = process.env.BYOC_DB_PASSWORD;
  if (!pw) return "";
  const host = process.env.BYOC_DB_HOST ?? "agent-shared-db";
  const port = process.env.BYOC_DB_PORT ?? "5432";
  const name = process.env.BYOC_DB_NAME ?? "byoc";
  const user = process.env.BYOC_DB_USER ?? "byoc";
  return `postgresql://${user}:${encodeURIComponent(pw)}@${host}:${port}/${name}`;
}

/** DSN for the agent_host database (the tables agent-host owns), independent of the
 *  webhooks DSN so agent-host's own state does not disappear when webhooks is disabled. */
function agentHostResourceDsn(): string {
  return agentHostDsnFromEnv();
}

/** Parse an optional static id->email map from AUTH_SUB_EMAIL_MAP ("sub=email" pairs,
 *  comma or semicolon separated). */
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

/** Drain a conversation's event stream into an array, returning what was read on a read error. */
async function collectEventsSafe(it: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  try {
    for await (const e of it) out.push(e);
  } catch {
    /* a partial read is fine */
  }
  return out;
}

/** Pass AWS/Bedrock config through to goose, including the IRSA web-identity vars the EKS
 *  pod-identity webhook injects. */
function bedrockEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    "GOOSE_PROVIDER", "GOOSE_MODEL",
    "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    // IRSA (EKS pod identity) — the credential source in-cluster.
    "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_STS_REGIONAL_ENDPOINTS",
    "AWS_ROLE_SESSION_NAME",
    // Ollama: GOOSE_PROVIDER=ollama + OLLAMA_HOST points goose at it.
    "OLLAMA_HOST",
  ]) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  // Auto-compaction threshold (fraction of the context window, 0.0 disables), set
  // explicitly so it is visible per deploy and cannot drift with goose versions.
  out.GOOSE_AUTO_COMPACT_THRESHOLD = process.env.GOOSE_AUTO_COMPACT_THRESHOLD ?? "0.8";
  return out;
}

/** Wall-clock budget for the startup hydrate (see hydrateWithRetry). */
export const HYDRATE_BUDGET_MS = 60_000;

/** Hydrate at startup, retrying until a wall-clock budget expires, since a cold Postgres
 *  must not be read as a broken one. */
export async function hydrateWithRetry(
  hydrate: () => Promise<void>,
  log: Pick<Logger, "warn" | "errorWith">,
  opts: {
    budgetMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<void> {
  const budgetMs = opts.budgetMs ?? HYDRATE_BUDGET_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try {
      await hydrate();
      return;
    } catch (err) {
      const elapsed = now() - started;
      // Cap the backoff so the tail of the budget is not spent asleep.
      const delay = Math.min(250 * 2 ** (attempt - 1), 5_000);
      if (elapsed + delay >= budgetMs) {
        log.errorWith(
          "hydrate failed; cannot read the conversation source of truth, refusing to serve on a stale view",
          err,
          { attempts: attempt, waited_ms: elapsed, budget_ms: budgetMs },
        );
        throw err;
      }
      log.warn("hydrate attempt failed; retrying", {
        attempt,
        waited_ms: elapsed,
        budget_ms: budgetMs,
        retry_in_ms: delay,
        error: formatError(err),
      });
      await sleep(delay);
    }
  }
}

export async function main(
  config: AgentHostConfig & Partial<AgentHostConfigExtra> = configFromEnv(),
): Promise<() => Promise<void>> {
  // The provisioner: noop for a fake sandbox (which has no CR to size), else the k8s
  // provisioner, kept typed because it also exposes the size ops.
  const k8sProvisioner: K8sProvisioner | null = config.fakeSandbox
    ? null
    : createK8sProvisioner({
        namespace: config.namespace,
        sandboxImage: config.sandboxImage,
        // imagePullPolicy for the sandbox pod; SANDBOX_PULL_POLICY=IfNotPresent on a
        // side-loaded local cluster.
        sandboxPullPolicy:
          (process.env.SANDBOX_PULL_POLICY as "Always" | "IfNotPresent" | "Never") || undefined,
        // The sandbox is the NixOS systemd-PID-1 image, so provision privileged + tmpfs
        // /run,/tmp.
        systemdImage: true,
        // RuntimeClass for the sandbox pod (SANDBOX_RUNTIME_CLASS, e.g. "crun"); a
        // cgroup-delegating runtime lets systemd PID 1 run non-privileged in a private
        // cgroup namespace.
        sandboxRuntimeClass: process.env.SANDBOX_RUNTIME_CLASS || undefined,
        // SANDBOX_RESOURCES is a JSON {requests,limits} override of the provisioner's
        // Guaranteed 2cpu/4Gi default.
        sandboxResources: process.env.SANDBOX_RESOURCES
          ? (JSON.parse(process.env.SANDBOX_RESOURCES) as {
              requests?: { cpu?: string; memory?: string };
              limits?: { cpu?: string; memory?: string };
            })
          : undefined,
        // A disk-backed PVC upper for the overlay Nix store at /nix/.scooter-rw, persisting
        // runtime nix builds across suspend/resume; SANDBOX_OVERLAY_STORE=0 opts out.
        overlayStore: (process.env.SANDBOX_OVERLAY_STORE || "1") !== "0",
        overlayStorage: process.env.SANDBOX_OVERLAY_STORAGE || undefined,
        // Deployment-supplied tool injection: SCOOTER_CONFIGMAP, SCOOTER_TOKEN_AUDIENCES
        // (CSV) and SCOOTER_ENV (JSON, or k=v;k=v).
        scooterConfigMap: process.env.SCOOTER_CONFIGMAP || undefined,
        // A consumer patch deep-merged onto each generated Sandbox, read fresh at create time.
        manifestOverlayConfigMap: process.env.SANDBOX_MANIFEST_OVERLAY_CONFIGMAP || undefined,
        // A ConfigMap of deployment config files mounted as a flat dir at
        // /etc/agent-sandbox/config, so multi-line config survives the controller's
        // newline mangling.
        configFilesConfigMap: process.env.SCOOTER_CONFIG_FILES_CONFIGMAP || undefined,
        extraTokenAudiences: (process.env.SCOOTER_TOKEN_AUDIENCES || "")
          .split(",").map((s) => s.trim()).filter(Boolean),
        extraEnv: parseScooterEnv(process.env.SCOOTER_ENV),
        // Public chat UI base URL, from which each sandbox gets its own CONVERSATION_URL.
        publicUrl: process.env.PUBLIC_URL || undefined,
        // The deployment's named size catalog and default preset, for the resize tools and
        // the UI picker.
        sizePresetsJson: process.env.SANDBOX_SIZES_JSON || undefined,
        defaultSizeName: process.env.SANDBOX_DEFAULT_SIZE_NAME || undefined,
      });
  const provisioner = k8sProvisioner ?? createNoopProvisioner();
  // A noop provisioner creates no sandbox and every turn hangs, so say which one was
  // selected at boot.
  hostLog.info("sandbox provisioner selected", {
    provisioner: config.fakeSandbox ? "noop" : "k8s",
    fake_sandbox: config.fakeSandbox,
    in_cluster: process.env.KUBERNETES_SERVICE_HOST !== undefined,
  });
  // Ensure goose's developer extension is enabled so shell/file tool calls go to the ACP
  // client (the sandbox) rather than running locally; fatal on a real deployment.
  ensureGooseConfig(process.env.HOME, { fatal: !config.fakeSandbox });
  // The event log lives in Postgres and the file store keeps what is still on the state
  // volume (assets, goose state); without a DSN the event log is unavailable rather than
  // silently written to an emptyDir.
  const localStore = createFileConversationStore(config.localStatePath);
  // The append fence's claim source, late-bound because the ownership tracker is built
  // further down and nothing appends before boot finishes.
  let observedGeneration: ((id: SessionId) => number | undefined) | undefined;
  const podName = process.env.POD_NAME;
  const eventStore = agentHostResourceDsn()
    ? createPgEventStore({
        dsn: agentHostResourceDsn(),
        // Single-replica (no POD_NAME) has no second writer to fence against.
        fence: podName ? { pod: podName, generation: (id) => observedGeneration?.(id) } : undefined,
      })
    : undefined;
  hostLog.info("conversation event log", { backend: eventStore ? "postgres" : "none" });
  const fileStore: ConversationStore = eventStore
    ? withPgEvents(localStore, eventStore)
    : localStore;

  // Linked resources come from Postgres when a DSN is configured, with the file store as
  // the read-through source so links still only on disk keep showing.
  const sharedDsn = webhooksResourceDsn();
  const agentHostDsn = agentHostResourceDsn();
  const linkStore = sharedDsn
    ? createPgLinkStore({
        dsn: sharedDsn,
        legacy: fileStore.listLinks
          ? { listLinks: (id) => fileStore.listLinks!(id) }
          : undefined,
      })
    : undefined;
  hostLog.info("link store selected", { backend: linkStore ? "postgres" : "file" });

  // Conversation metadata (the sidebar list and what hydrate rebuilds from) lives in the
  // agent_host database, seeded from the file store when the table is empty.
  const metaStore = agentHostDsn
    ? createPgMetaStore({
        dsn: agentHostDsn,
        legacy: fileStore.listConversations
          ? { listConversations: () => fileStore.listConversations!() }
          : undefined,
      })
    : undefined;
  hostLog.info("conversation metadata store selected", { backend: metaStore ? "postgres" : "file" });

  // Decorate rather than replace the file store, delegating everything else through the
  // original since several of its methods call siblings via `this`; saveMeta writes both
  // Postgres (authoritative) and the file copy.
  const overrides: Partial<ConversationStore> = {
    ...(linkStore
      ? {
          addLink: (id: SessionId, link: ConversationLink) => linkStore.addLink(id, link),
          listLinks: (id: SessionId) => linkStore.listLinks(id),
        }
      : {}),
    ...(metaStore
      ? {
          saveMeta: async (meta) => {
            await metaStore.saveMeta(meta);
            await fileStore.saveMeta?.(meta);
          },
          touchActivity: (id: SessionId, at: number) => metaStore.touchActivity(id, at),
          readLastActivity: (id: SessionId) => metaStore.readLastActivity(id),
          listConversations: () => metaStore.listConversations(),
          removeConversation: async (id: SessionId) => {
            await metaStore.removeConversation(id);
            await fileStore.removeConversation?.(id);
            // The shared PG resource_links table needs an explicit delete, or an orphaned row
            // collides with a later re-link.
            await linkStore?.deleteByConversation(id);
          },
        }
      : {}),
  };
  const store: ConversationStore =
    Object.keys(overrides).length > 0
      ? new Proxy(fileStore, {
          get(target, prop, receiver) {
            const override = overrides[prop as keyof ConversationStore];
            if (override) return override;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : fileStore;
  // Image/media assets: metadata in Postgres and bytes on the assets PVC (ASSETS_PATH, else
  // LOCAL_STATE_PATH), or PVC-only without a DSN.
  const assetsPath = process.env.ASSETS_PATH ?? config.localStatePath;
  const assets = agentHostResourceDsn()
    ? createHybridAssetStore({
        dsn: agentHostResourceDsn(),
        bytesRoot: assetsPath,
        maxBytes: Number(process.env.ASSET_MAX_BYTES) || undefined,
      })
    : createPvcAssetStore({
        root: assetsPath,
        maxBytes: Number(process.env.ASSET_MAX_BYTES) || undefined,
      });
  hostLog.info("asset store", {
    backend: agentHostResourceDsn() ? "hybrid (pg+pvc)" : "pvc-only",
    path: assetsPath,
  });
  // Per-file cap for materialized (non-image) uploads, separate from ASSET_MAX_BYTES since
  // files go straight into the sandbox.
  const fileMaxBytes = Number(process.env.FILE_MAX_BYTES) || DEFAULT_FILE_MAX_BYTES;
  const server = createAguiServer();
  // The privileged /agui `owner` field is honored only for the trusted webhooks caller,
  // whose SA token is verified via k8s TokenReview.
  server.useOwnerVerifier(
    createWebhooksCallerVerifier({
      expectedServiceAccount: process.env.WEBHOOKS_SERVICE_ACCOUNT,
      audience: process.env.WEBHOOKS_TOKEN_AUDIENCE || "agent-host",
    }),
  );

  // Bring-your-own-Claude is gated on REMOTE_AGENT_JOIN_SECRET; absent means no route and no
  // remote provider.
  const remoteAgentJoinSecret = process.env.REMOTE_AGENT_JOIN_SECRET;
  // The BYOC controller's in-cluster base URL, through which ownership resolution, every ACP
  // frame and the one-liner's session mint go; empty means no BYO path.
  const byocControllerUrl = (process.env.BYOC_CONTROLLER_URL ?? "").trim();
  // Durable online/offline binding on the shared Postgres so the "Connected" badge is correct
  // across replicas; absent DSN means in-memory only.
  const remoteAgentDsn = byocResourceDsn();
  const remoteAgentStore =
    remoteAgentJoinSecret && remoteAgentDsn ? createPgRemoteAgentStore({ dsn: remoteAgentDsn }) : undefined;
  const remoteAgentRegistry = remoteAgentJoinSecret
    ? createRemoteAgentRegistry({
        // Fire-and-forget DB persistence on connect/disconnect (best-effort).
        onOnline: remoteAgentStore ? (owner) => void remoteAgentStore.markOnline(owner) : undefined,
        onOffline: remoteAgentStore ? (owner) => void remoteAgentStore.markOffline(owner) : undefined,
      })
    : undefined;
  // The Settings "Connect your Claude agent" backing (mint one-liner + connected badge), only
  // when BYO is enabled.
  const remoteAgentUi =
    remoteAgentRegistry && remoteAgentJoinSecret
      ? createRemoteAgentUi({
          joinSecret: remoteAgentJoinSecret,
          // The session is minted in-cluster (controllerUrl) and the container connects to the
          // public ingress (publicByocUrl).
          controllerUrl: byocControllerUrl,
          publicByocUrl: process.env.BYOC_PUBLIC_URL || undefined,
          // The badge reads the controller, the only component that knows whether a container
          // is attached.
          statusAsync: async (owner: string) => {
            const offline = { connected: false, lastAuthFailure: null };
            if (!byocControllerUrl) return offline;
            try {
              const res = await fetch(
                `${byocControllerUrl.replace(/\/$/, "")}/byoc/status?owner=${encodeURIComponent(owner)}`,
                { headers: { Accept: "application/json" } },
              );
              if (!res.ok) return offline;
              const body = (await res.json()) as {
                status?: string;
                lastAuthFailure?: { reason: string; at: string } | null;
              };
              return {
                // Only "connected" counts; "minted" means no container has dialled in yet.
                connected: body.status === "connected",
                // The controller's record of the owner's most recent rejected attempt, for the
                // Settings page.
                lastAuthFailure: body.lastAuthFailure ?? null,
              };
            } catch {
              return offline; // a controller blip degrades the badge, never a run
            }
          },
          image: process.env.REMOTE_AGENT_IMAGE || undefined,
        })
      : undefined;

  // Metrics, off unless OTEL_METRICS_ENABLED=1; cost needs goose's per-session token usage
  // under its $HOME.
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

  // A failed durable append must leave a trace, so record it as a metric an operator can
  // alert on.
  store.onAppendError?.((conversationId) => {
    metrics.persistenceError?.({ conversationId });
  });

  // Multi-replica fencing: with POD_NAME set, watch the Conversation CRD so this pod stops
  // appending to a conversation reassigned away from it.
  const ownership = podName
    ? createK8sOwnershipGuard(podName, config.namespace)
    : undefined;
  // Hand the tracker's cached epoch to the append fence; undefined narrows the fence to pod
  // identity.
  observedGeneration = (id) => ownership?.guard.observedGeneration?.(id);
  // The write side of the same CRD: register each new conversation as a Conversation CR
  // (and, with a DSN, an agent_host.conversations row) so the controller assigns it a
  // hostPod.
  const crRegistry = podName ? createK8sConversationRegistry(config.namespace) : undefined;
  const conversationRegistry =
    crRegistry && agentHostDsn ? withConversationRows(crRegistry, { dsn: agentHostDsn }) : crRegistry;

  const sessions = createSessionManager({
    provisioner,
    store,
    ownershipGuard: ownership?.guard,
    conversationRegistry,
    // With selfPod set, hydrate() adopts every Conversation the controller assigned to this
    // pod instead of replaying the local store.
    selfPod: podName,
    bridgeFactory: ({ conversationId, sandbox, model, pickedProvider, owner }) => {
      // Exec + ACP client are connected lazily/asynchronously; the bridge is
      // created synchronously and starts the connection in start().
      const bridge = makeBridge(conversationId, sandbox, config, model, metrics, owner, pickedProvider);
      // The agent titles the conversation by emitting <title>…</title> as its
      // first action; the bridge extracts it -> set it on the conversation.
      bridge.onTitle((title) => sessions.setTitle(conversationId, title));
      return bridge;
    },
    // After a revive rebuilds the bridge, re-raise any approval interrupts a rollout dropped,
    // since the request still sits pending in the broker.
    onRevived: (id) => {
      void reRaisePendingApprovals(id).catch((err) =>
        hostLog.errorWith("re-raise pending AWS interrupts failed", err, { conversation_id: id }),
      );
    },
    // Keep the pod up while a background job not yet announced as complete is still running,
    // so the idle sweep does not kill it.
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

  // Settlement on ownership gain: the CR watch always fires when a conversation moves to
  // this pod, so a stranded run gets terminated or resume-nudged there.
  if (ownership) {
    ownership.guard.onGained = (id, generation) => {
      void sessions
        .reconcileDanglingRun(id as SessionId, generation)
        .catch((err) => hostLog.errorWith("ownership-gain settlement failed", err, { conversation_id: id }));
    };
  }

  /** Broker auth headers (the agent-host SA token), shared by the approval calls. */
  const brokerAuthHeaders = sharedBrokerAuthHeaders;

  /** The contribs that raise approvals (name -> where its verbs live on the broker), rendered
   *  by modules/platform.nix; unset or malformed means no approvals are relayed. */
  const approvalContribs: Record<string, ApprovalContrib> = (() => {
    const raw = process.env.APPROVAL_CONTRIBS_JSON;
    if (!raw || !raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, ApprovalContrib>;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      hostLog.errorWith("APPROVAL_CONTRIBS_JSON is not valid JSON; no approvals will be relayed", e as Error);
      return {};
    }
  })();

  /** On revive, ask each approval contrib with a `pendingPath` for this conversation's
   *  pending requests and re-raise an interrupt for each (idempotent by request id). */
  const reRaisePendingApprovals = async (id: string): Promise<void> => {
    const brokerUrl = (process.env.BROKER_URL ?? "").replace(/\/$/, "");
    if (!brokerUrl) return; // no broker (local/dev) — nothing to re-raise
    const bridge = sessions.get(id as SessionId)?.bridge;
    if (!bridge) return;
    const headers = await brokerAuthHeaders();
    for (const [contrib, cfg] of Object.entries(approvalContribs)) {
      if (!cfg.pendingPath) continue;
      // The broker keys requests by the sandbox short id, not the full thread UUID, while the
      // interrupt is raised on the real conversation id.
      const pending = await fetchPendingApprovals(
        brokerUrl, cfg.pendingPath, shortId(id), headers,
        (status) => hostLog.warn("broker pending-approvals returned a non-2xx", { conversation_id: id, contrib, status }),
      ).catch((err) => {
        // One contrib's broker being unreachable must not stop the others' re-raises.
        hostLog.warn("pending-approvals fetch failed", { conversation_id: id, contrib, error: formatError(err) });
        return [];
      });
      for (const req of pending) {
        raiseApprovalInterrupt(bridge, id, contrib, req, resolveApprovalForBroker);
      }
    }
  };

  /** Relay the user's answer to the contrib's broker half (POST
   *  <brokerPrefix>/{requestId}/{optionId}) with the approver's identity, throwing on a
   *  failed relay and feeding the failure back into the conversation. */
  const resolveApprovalForBroker = async (
    sessionId: string,
    contrib: string,
    requestId: string,
    optionId: string,
    approver: ApproverIdentity,
  ): Promise<void> => {
    const brokerUrl = (process.env.BROKER_URL ?? "").replace(/\/$/, "");
    if (!brokerUrl) {
      hostLog.warn("BROKER_URL unset; cannot relay approval", { contrib, request_id: requestId });
      return;
    }
    const cfg = approvalContribs[contrib];
    if (!cfg) {
      // Loud, because a user's security decision just went nowhere and nothing else will say
      // so.
      throw new Error(`no approval routing configured for contrib '${contrib}' (APPROVAL_CONTRIBS_JSON)`);
    }
    // The optionId is the verb; the platform does not interpret the choice.
    const prefix = cfg.brokerPrefix.replace(/\/$/, "");
    const res = await fetch(
      `${brokerUrl}${prefix}/${encodeURIComponent(requestId)}/${encodeURIComponent(optionId)}`,
      { method: "POST", headers: await brokerAuthHeaders(), body: JSON.stringify({ approver }) },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // `errors` under `detail` is the shape scooter_broker_lib raises RequestError as.
      let detail = body.slice(0, 1500);
      try {
        const j = JSON.parse(body);
        const errs = j?.detail?.errors ?? j?.errors;
        if (Array.isArray(errs) && errs.length) detail = errs.join("\n");
      } catch {
        /* not JSON — use the raw body */
      }
      // Tell the agent, not just the log, since it is blocked on this answer.
      void sessions
        .prompt(
          sessionId as SessionId,
          `Your ${contrib} request was answered "${optionId}", but the broker could NOT ` +
            "complete it. Do NOT retry the request; instead, help the user fix the broker " +
            "setup, then they can answer again. Broker error:\n\n" + detail,
          undefined, undefined, undefined, undefined, undefined, "broker",
        )
        .catch((e) => hostLog.errorWith("failed to feed the approval failure to the agent", e));
      throw new Error(`broker rejected ${contrib} '${optionId}' for ${requestId}: ${res.status} ${body.slice(0, 500)}`);
    }
  };

  // Background jobs (run_background): the job's output stays on the workspace PVC, and the
  // registry of which jobs a conversation has lives in Postgres with the file registry as
  // the read-through source.
  const fileJobRegistry: JobRegistry | undefined = store.saveJob
    ? {
        saveJob: (id, job) => store.saveJob!(id, job),
        listJobs: (id) => store.listJobs!(id),
        updateJob: store.updateJob ? (id, job) => store.updateJob!(id, job) : undefined,
      }
    : undefined;
  const jobsDsn = agentHostDsn;
  // No database means no registry, since falling back to the emptyDir-backed file registry
  // would lose jobs on the next rollout.
  const jobRegistry = jobsDsn ? createPgJobStore({ dsn: jobsDsn, legacy: fileJobRegistry }) : undefined;
  hostLog.info("background-job registry", {
    backend: jobRegistry ? "postgres" : "none",
    ...(jobRegistry ? {} : { reason: "no agent_host DSN — background jobs are disabled" }),
  });

  // Personal skills: the per-user half of the agent's skills, authored in the settings page.
  // No database means the settings tab reports itself unconfigured and only the deployment's
  // ConfigMap skills are injected.
  const userSkillStore = agentHostDsn ? createPgUserSkillStore({ dsn: agentHostDsn }) : undefined;
  hostLog.info("personal skills", {
    backend: userSkillStore ? "postgres" : "none",
    ...(userSkillStore ? {} : { reason: "no agent_host DSN — personal skills are disabled" }),
  });

  /**
   * One owner's enabled personal skills, shaped to merge with the directory-loaded ones.
   *
   * Never throws: a database hiccup must start the conversation on the deployment's skills
   * rather than not at all.
   */
  const personalSkillsFor = async (owner?: string): Promise<Skill[]> => {
    if (!userSkillStore || !owner) return [];
    const rows = await userSkillStore.listEnabled(owner);
    return rows.map((r) => personalSkill({ name: r.name, description: r.description, body: r.body }));
  };

  const jobsEnabled = process.env.AGENT_BACKGROUND_JOBS !== "0" && !config.fakeSandbox && !!jobRegistry;
  const jobManager = jobsEnabled
    ? createJobManager({
        client: (id) => {
          const sb = sessions.get(id as SessionId)!.sandbox;
          return deferredSandboxApi(sb, () => provisioner.resume(sb).then(() => {}));
        },
        registry: jobRegistry!,
        cleanupTtlMs: Number(process.env.BACKGROUND_JOB_TTL_MS ?? 10 * 60 * 1000),
      })
    : undefined;

  // The broker base URL for the agent-tools; unset, calls fail with a clear error.
  const brokerUrl = (process.env.BROKER_URL ?? "").replace(/\/$/, "");
  // Fallback target discovery from the webhooks conversation_map when a conversation's link
  // has no structured `ref`, wired only when a DSN is available.
  const webhooksDsn = webhooksResourceDsn();
  const resourceLookup = webhooksDsn ? createResourceLookup({ dsn: webhooksDsn }) : undefined;

  // Identity resolution, composed as layers over the base resolver (base -> [ALB signature
  // verify] -> [sub->email store + static map]), with verification before the store so an
  // unverified email is never learned.
  const identityStore = webhooksDsn ? createPgIdentityStore({ dsn: webhooksDsn }) : undefined;
  const staticIdentityMap = parseIdentityMap(process.env.AUTH_SUB_EMAIL_MAP);

  /** Resolve an owner id to an email for per-user cost metrics (static map first, then the
   *  identity store), null when unknown. */
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
  // Own a UI-created conversation to its ingress-authenticated creator, the same resolver
  // /whoami uses.
  server.useIdentityResolver(resolveUser);
  // Only the web tools' injectable fetch remains here, and nothing overrides it in
  // production.
  const agentToolsWiring: { fetchImpl?: typeof fetch } | undefined = undefined;

  // Model self-selection tools (list_models / switch_model), offered when the deployment has
  // more than one model.
  const modelToolsWiring =
    config.modelCatalog.models.length > 1
      ? {
          catalog: config.modelCatalog,
          currentModel: (id: string) => sessions.get(id)?.model,
          modelSetBy: (id: string) => sessions.get(id)?.modelSetBy,
          switchModel: (id: string, model: string) => sessions.switchModelNow(id, model),
        }
      : undefined;

  // Renaming (set_conversation_title), the agent's only way past the name-once gate on the
  // <title> marker; `force` is what distinguishes a deliberate rename from that marker.
  const titleToolsWiring = {
    currentTitle: (id: string) => sessions.get(id)?.title,
    userTitled: (id: string) => sessions.get(id)?.userTitled === true,
    setTitle: (id: string, title: string) => sessions.setTitle(id, title, { force: true }),
  };

  // Sandbox right-sizing tools, absent only for a fake sandbox; the CR is named for the
  // short id, so map through shortId(), with the full id passed for the cold-create path.
  const resourceToolsWiring = k8sProvisioner
    ? {
        currentResources: async (id: string): Promise<SandboxResources> =>
          (await k8sProvisioner.getSize(shortId(id))) ?? {},
        setResources: async (id: string, r: SandboxResources | { size: string }): Promise<boolean> => {
          await k8sProvisioner.setSize(shortId(id), r, id);
          return true; // recorded — it applies on the next sandbox restart
        },
        availableSizes: async () => k8sProvisioner.getSizes(),
      }
    : undefined;

  // One HTTP client to the scheduler service, shared by the agent MCP tools and the UI
  // settings proxy, with every call scoped to an owner.
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

  // Subagent tools delegate work to a child conversation that shares this conversation's
  // sandbox, with the router creating the child conversation.
  const subagentCreator = process.env.CONVERSATION_ROUTER_URL
    ? createRouterSubagentCreator({
        url: process.env.CONVERSATION_ROUTER_URL,
        tokenPath: process.env.CONVERSATION_ROUTER_TOKEN_PATH,
      })
    : undefined;
  // No router plus an update-only saveMeta silently loses subagents.
  if (!subagentCreator && process.env.AGENT_HOST_DB_DSN) {
    hostLog.warn("CONVERSATION_ROUTER_URL unset with a Postgres store: a spawned subagent will have no conversations row and will not list");
  }
  const subagentManager: SubagentManager = createSubagentManager(sessions, store, subagentCreator);

  const convTokenSecret = process.env.CONV_TOKEN_SECRET ?? "";
  const brokerTokenPath = process.env.BROKER_TOKEN_PATH ?? "/var/run/secrets/broker/token";
  const mcpEndpoint =
    agentToolsWiring !== undefined ||
    jobManager !== undefined ||
    modelToolsWiring !== undefined ||
    resourceToolsWiring !== undefined ||
    schedulerToolsWiring !== undefined ||
    subagentManager !== undefined
      ? createMcpEndpoint({
          // The URL goose connects to; goose runs in this pod, so localhost reaches it.
          baseUrl: process.env.AGENT_SELF_MODIFY_MCP_URL ?? `http://127.0.0.1:${config.port}`,
          // The conversation scope travels as a signed bearer token; unset keeps the
          // unauthenticated `?conv=` behaviour with a loud startup warning.
          convTokenSecret,
          convTokenTtlSeconds: process.env.CONV_TOKEN_TTL_SECONDS
            ? Number(process.env.CONV_TOKEN_TTL_SECONDS)
            : undefined,
          agentTools: agentToolsWiring,
          jobs: jobManager,
          models: modelToolsWiring,
          resources: resourceToolsWiring,
          scheduler: schedulerToolsWiring,
          subagents: subagentManager,
          titles: titleToolsWiring,
        })
      : undefined;

  // The broker-MCP proxy, through which the agent reaches the contrib-contributed tools: the
  // SA token is attached fresh per request (a projected token rotates hourly, while an MCP
  // server's headers are fixed at session creation) and never reaches the agent.
  const brokerMcpUrl = (process.env.BROKER_MCP_URL ?? (brokerUrl ? `${brokerUrl.replace(/\/$/, "")}/mcp` : "")).trim();
  const brokerMcpProxy =
    brokerMcpUrl && convTokenSecret
      ? createBrokerMcpProxy({
          baseUrl: process.env.AGENT_SELF_MODIFY_MCP_URL ?? `http://127.0.0.1:${config.port}`,
          brokerMcpUrl,
          resolveConversation: (req) => resolveConversation(req, convTokenSecret),
          mintConvToken: (conversationId) => mintConvToken(conversationId, convTokenSecret),
          saToken: async () => {
            // Re-read per request, since kubelet rotates the projected token on disk.
            try {
              const { readFile } = await import("node:fs/promises");
              return (await readFile(brokerTokenPath, "utf8")).trim();
            } catch (err) {
              // ENOENT is the local/dev case; anything else must not silently downgrade to an
              // unauthenticated call.
              if ((err as { code?: string })?.code !== "ENOENT") {
                hostLog.warn("could not read the broker SA token; the broker will reject MCP calls", {
                  path: brokerTokenPath,
                  error: formatError(err),
                });
              }
              return undefined;
            }
          },
        })
      : undefined;
  if (!brokerMcpProxy) {
    hostLog.info("broker MCP tools are NOT offered", {
      reason: !brokerMcpUrl ? "no BROKER_URL/BROKER_MCP_URL" : "no CONV_TOKEN_SECRET",
    });
  }

  // Restore conversations at startup, from the Conversation CRs when multi-replica; a pod
  // that cannot read the source of truth retries with backoff and then exits rather than
  // serving a stale view.
  await hydrateWithRetry(() => sessions.hydrate(), hostLog);

  server.onPrompt(async (sessionId, input) => {
    // sessionId is the AG-UI threadId; a requested model is honored only if it is the
    // default or an offered model.
    const requested = input.model;
    const model =
      requested && (requested === config.model || config.availableModels.includes(requested))
        ? requested
        : undefined;
    // Store attached images in the AssetStore and pass refs to the bridge, dropping an
    // oversize or unsupported image rather than failing the turn.
    const promptImages: Array<{ assetId: string; mimeType: string }> = [];
    for (const img of input.images ?? []) {
      try {
        const stored = await assets.put(sessionId, { data: Buffer.from(img.data, "base64"), mimeType: img.mimeType });
        promptImages.push({ assetId: stored.assetId, mimeType: stored.mimeType });
      } catch (e) {
        hostLog.warn("dropped an attached image", { conversation_id: sessionId, error: formatError(e) });
      }
    }
    // Binary file attachments ride through to the bridge, which materializes them into the
    // sandbox; oversize files are dropped here.
    const promptFiles: Array<{ name: string; data: string; mimeType: string }> = [];
    for (const f of input.files ?? []) {
      if (base64ByteLength(f.data) > fileMaxBytes) {
        hostLog.warn("dropped an oversize file attachment", {
          conversation_id: sessionId,
          name: f.name,
          max_bytes: fileMaxBytes,
        });
        continue;
      }
      promptFiles.push({ name: f.name, data: f.data, mimeType: f.mimeType });
    }
    try {
      await sessions.promptByThread(sessionId, input.text, model, input.priority, input.owner, promptImages, promptFiles, input.source, input.provider);
    } catch (err) {
      // The run could not start, so persist a RUN_ERROR to the durable log so a reattaching
      // UI sees the failure.
      const message = err instanceof Error ? err.message : String(err);
      const runId = `err-${Date.now()}`;
      try {
        await store.appendEvent(sessionId as SessionId, { type: "RUN_STARTED", threadId: sessionId, runId });
        await store.appendEvent(sessionId as SessionId, {
          type: "RUN_ERROR",
          message: `The agent could not start this run: ${message}`,
        });
      } catch (persistErr) {
        hostLog.errorWith("failed to persist RUN_ERROR", persistErr, { conversation_id: sessionId });
      }
      throw err; // rethrow so the /agui handler also emits a live RUN_ERROR
    }
  });

  // A user's answer to a permission/option request -> resolve the blocked run.
  server.onPermission(async (sessionId, toolCallId, optionId) => {
    sessions.get(sessionId)?.bridge?.answerPermission(toolCallId, optionId);
  });

  // assistant-ui resumes a paused run by POSTing /agui with resume[]; if the direct answer
  // does not land (the run is gone after a rollout or idle-suspend), revive and re-raise
  // the pending interrupt, then retry, returning whether it was answered so the caller can
  // close with RUN_ERROR instead of hanging.
  server.onResume(async (sessionId, entry, approver) => {
    // cancelled -> empty optionId (which the bridge treats as a cancel); resolved -> the
    // chosen optionId.
    const optionId =
      entry.status === "cancelled"
        ? ""
        : ((entry.payload as { optionId?: string } | undefined)?.optionId ?? "");

    // `approver` is the human who answered, which an approval interrupt's onAnswer relays to
    // the broker for authorization.
    const answer = () =>
      sessions.get(sessionId)?.bridge?.answerPermission(entry.interruptId, optionId, approver) ?? false;

    // 1) Fast path — the run is still live and holding this interrupt.
    if (answer()) return { ok: true };

    // 2) Dormant / lost-interrupt path: revive and re-raise (both idempotent and
    //    best-effort), then retry.
    await sessions.revive(sessionId as SessionId).catch((err) => {
      hostLog.warn("resume: revive failed; answering best-effort", {
        conversation_id: sessionId,
        error: formatError(err),
      });
    });
    await reRaisePendingApprovals(sessionId).catch((err) => {
      hostLog.warn("resume: re-raise pending interrupts failed", {
        conversation_id: sessionId,
        error: formatError(err),
      });
    });
    if (answer()) return { ok: true };

    // 3) Genuinely unanswerable; the caller turns this into a RUN_ERROR on the stream.
    return { ok: false, reason: "this approval is no longer awaiting an answer (it may have expired or already been answered)" };
  });

  server.onAttach(async (sessionId, conn) => {
    for await (const event of store.readEvents(sessionId)) conn.send(event);
  });

  // Shared broker call setup (base URL + the agent-host SA token), null when BROKER_URL is
  // unset; ENOENT means no token, any other read error throws.
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

  // In-pod web-service registry shared by the management API and the reverse proxy;
  // undefined for a fake sandbox, which has no pod.
  const webServices = config.fakeSandbox
    ? undefined
    : createWebServiceRegistry({
        sandboxFor: (id) => sessions.get(id)?.sandbox,
        connect: (ref) => connectSandbox(ref),
      });

  // Module registry: search the broker catalog and install modules into a conversation's
  // sandbox via the in-pod CLIs.
  const moduleRegistry = config.fakeSandbox
    ? undefined
    : createModuleRegistry({
        sandboxFor: (id) => sessions.get(id)?.sandbox,
        connect: (ref) => connectSandbox(ref),
      });

  // Management REST API (conversation CRUD, lifecycle, history), mounted on the same server
  // as /agui.
  server.use(
    createManagementApi({
    // Live appends only reach the owner's local store, so the integrity stream reports
    // whether this pod owns the conversation.
    streamOwnership: conversationRegistry && podName
      ? async (id: string) => {
          const rec = await conversationRegistry.get(id).catch(() => undefined);
          if (!rec?.hostPod) return "unknown" as const; // not assigned yet — serve on
          return rec.hostPod === podName ? ("mine" as const) : ("elsewhere" as const);
        }
      : undefined,
      sessions,
      store,
      server,
      webServices,
      moduleRegistry,
      identityStore,
      assets,
      scheduler: schedulerClient,
      userSkills: userSkillStore,
      // Read fresh rather than cached: the ConfigMap is editable without a restart, so a
      // cached list would warn about a shadow that no longer exists.
      builtinSkillNames: () => loadSkills(config.skillsDir).map((s) => s.name),
      // The current sandbox size for the Sandbox tab, read off the CR by shortId.
      sandboxResources: k8sProvisioner
        ? (id: string) => k8sProvisioner.getSize(shortId(id))
        : undefined,
      // The conversation's published static shares, keyed by shortId since the broker owns
      // shares by the short id.
      listShares: (process.env.BROKER_URL ?? "").trim()
        ? async (id: string) =>
            fetchConversationShares(
              (process.env.BROKER_URL ?? "").replace(/\/$/, ""),
              shortId(id),
              await brokerAuthHeaders(),
              (status) => hostLog.warn("broker /shares list failed", { conversation_id: id, status }),
            )
        : undefined,
      // The named sandbox size presets and the default, for the UI dropdown and the agent's
      // size discovery.
      sandboxSizes: k8sProvisioner ? () => Promise.resolve(k8sProvisioner.getSizes()) : undefined,
      // The Sandbox tab's size dropdown, keyed by shortId with the full id passed for the
      // cold-create path.
      setSandboxSize: k8sProvisioner
        ? (id: string, size: string) => k8sProvisioner.setSize(shortId(id), { size }, id)
        : undefined,
      // BYO-Claude Settings section (mint one-liner + connected badge), undefined when BYO is off.
      remoteAgent: remoteAgentUi,
      // Manual compaction via a one-off SDK query with the same token/model the conversation
      // runs on; off without a token.
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
        providers: Object.fromEntries(
          config.modelCatalog.models.map((m) => [m.id, m.providers]),
        ),
        defaultFor: Object.fromEntries(
          config.modelCatalog.models.map((m) => [m.id, m.defaultFor]),
        ),
      },
      resolveUser,
      mcpHandler: mcpEndpoint ? (req, res, body) => mcpEndpoint.handle(req, res, body) : undefined,
      resourceLookup,
      brokerMcpHandler: brokerMcpProxy ? (req, res, body) => brokerMcpProxy.handle(req, res, body) : undefined,
      answerPermission: async (sessionId, toolCallId, optionId, approver) => {
        // Route the user's choice to the conversation's bridge, forwarding `approver` so an
        // approval interrupt relays the authorized human to the broker.
        const answered = sessions.get(sessionId)?.bridge?.answerPermission(toolCallId, optionId, approver);
        if (!answered) {
          hostLog.warn("no pending permission", { conversation_id: sessionId, tool_call_id: toolCallId });
        }
      },
      // Relay the user's answer to the contrib that asked, shared with the revive re-raise.
      resolveApproval: resolveApprovalForBroker,
      canApproveRequest: async (_sessionId, contrib, requestId, approver) => {
        // Per-viewer read-only check of whether this viewer may act on this request, failing
        // closed on any hiccup and defaulting to true when BROKER_URL is unset.
        const cfg = approvalContribs[contrib];
        if (!cfg) return false; // unknown contrib: nothing can authorize it
        const auth = await brokerAuth().catch(() => null);
        if (!auth) return true;
        try {
          const prefix = cfg.brokerPrefix.replace(/\/$/, "");
          const res = await fetch(
            `${auth.url}${prefix}/${encodeURIComponent(requestId)}/can-approve`,
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

  // Web-service reverse proxy (/c/<id>/<service>/... -> the conversation's pod), unmounted
  // for a fake sandbox.
  if (webServices) {
    server.useProxy(
      createWebServiceProxy({
        sessions,
        resolvePodTarget: (ref) => resolvePodTarget(ref),
        registry: webServices,
        wake: createWake({ sessions, provisioner, registry: webServices }),
        resolveUser,
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
  hostLog.info("listening", { port: config.port });

  // Resume conversations interrupted by this restart, fire-and-forget after listen() so the
  // server is up to serve their events.
  if (!config.fakeSandbox) {
    void sessions
      .resumeInterrupted()
      .then((ids) => {
        if (ids.length) hostLog.info("resumed interrupted conversations", { count: ids.length });
      })
      .catch((err) => hostLog.errorWith("resumeInterrupted failed", err));
  }

  // Report sandbox population to metrics, also on each sweep tick.
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

  // Idle-suspend sweep: the agent-host owns the activity signal, so it suspends idle
  // conversations itself (drops the pod, keeps the PVCs).
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  if (config.idleSuspendMs > 0) {
    sweepTimer = setInterval(() => {
      void sessions.sweepIdle(config.idleSuspendMs).then((ids) => {
        if (ids.length) hostLog.info("idle-suspended conversations", { count: ids.length, conversation_ids: ids });
        reportSandboxCounts();
      });
    }, config.idleSweepIntervalMs);
    sweepTimer.unref?.();
  }

  // Retention reap: destroy unstarred conversations inactive past the window, on its own
  // slow cadence.
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  if (config.retentionMaxAgeMs > 0) {
    const reap = () =>
      void sessions.sweepRetention(config.retentionMaxAgeMs).then((ids) => {
        if (ids.length)
          hostLog.info("retention-reaped conversations", {
            count: ids.length,
            inactive_over_ms: config.retentionMaxAgeMs,
            conversation_ids: ids,
          });
        reportSandboxCounts();
      }).catch((err) => hostLog.errorWith("retention sweep failed", err));
    retentionTimer = setInterval(reap, config.retentionSweepIntervalMs);
    retentionTimer.unref?.();
  }

  // Background-job cleanup: periodically remove exited jobs' on-disk files past the TTL for
  // each running conversation this pod owns.
  let jobCleanupTimer: ReturnType<typeof setInterval> | undefined;
  if (jobManager) {
    jobCleanupTimer = setInterval(() => {
      for (const c of sessions.list()) {
        if (c.status !== "running") continue;
        // Owner-only, like sweepIdle: a stale local entry for a conversation that moved away
        // would otherwise be exec-probed into a resume of a sandbox that may be gone.
        if (ownership && !ownership.guard.canWrite(c.id)) continue;
        void jobManager.cleanup(c.id).catch(() => {});
      }
    }, config.idleSweepIntervalMs);
    jobCleanupTimer.unref?.();
  }

  // Background-job completion watcher: poll running conversations for jobs that finished
  // since the last tick and inject a "job finished" turn with the "thinking" interrupt,
  // which never kills an in-flight tool call.
  const jobWatchEnabled = jobManager && process.env.BACKGROUND_JOB_WATCH !== "0";
  let jobWatchTimer: ReturnType<typeof setInterval> | undefined;
  if (jobWatchEnabled) {
    jobWatchTimer = setInterval(() => {
      for (const c of sessions.list()) {
        // A suspended conversation's completions are announced on its next revive.
        if (c.status !== "running") continue;
        // Owner-only, like the cleanup sweep above.
        if (ownership && !ownership.guard.canWrite(c.id)) continue;
        void (async () => {
          const done = await jobManager!.pollCompletions(c.id).catch(() => [] as JobStatus[]);
          for (const st of done) {
            const tail = st.output.trim();
            const more = st.truncated ? `\n(output truncated — full log: check_background("${st.jobId}"))` : "";
            // The bridge adds the system-message decoration; a died job never wrote an exit
            // code, so say it was killed rather than reporting the synthesized 137 as a
            // failure.
            const headline = st.died
              ? `Background job \`${st.jobId}\` (${st.command}) was KILLED before it finished ` +
                `(the sandbox restarted or the process was terminated). Its output stops wherever it died, ` +
                `and it did NOT complete — re-run it if you still need the result.`
              : `Background job \`${st.jobId}\` (${st.command}) finished with exit code ${st.exitCode}.`;
            const text =
              `${headline}\n` +
              (tail ? `Recent output:\n${tail}${more}\n\n` : "") +
              `React to this result if it's relevant to your task; otherwise acknowledge briefly.`;
            await sessions
              .prompt(c.id as SessionId, text, undefined, PRIORITY_INTERRUPT, "thinking", undefined, undefined, "background job")
              .catch((e) => hostLog.errorWith("job-completion inject failed", e, { conversation_id: c.id }));
          }
        })();
      }
    }, config.idleSweepIntervalMs);
    jobWatchTimer.unref?.();
  }

  // Subagent completion: inject the child's last assistant message into the parent as a
  // priority interrupt, then end the subagent, notifying once across the event-driven
  // trigger and the poll backstop (SUBAGENT_WATCH=0 disables both).
  let subagentWatchTimer: ReturnType<typeof setInterval> | undefined;
  if (process.env.SUBAGENT_WATCH !== "0") {
    const notified = new Set<SessionId>(); // subagents already reported + cleaned up
    const reportCompletion = async (subagentId: SessionId, parentId: SessionId): Promise<void> => {
      if (notified.has(subagentId)) return;
      notified.add(subagentId); // notify-once (mark before the async work)
      // Flush the subagent's pending appends first, since the store write is fire-and-forget
      // and the read below could otherwise miss the just-emitted RUN_FINISHED.
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
          .catch((e) => hostLog.errorWith("subagent-completion inject failed", e, { parent_id: parentId }));
      }
      // End the finished subagent (a child shares the parent's pod, so end() does not tear
      // the pod down).
      await sessions
        .end(subagentId)
        .catch((e) => hostLog.errorWith("subagent cleanup (end) failed", e, { subagent_id: subagentId }));
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
  };

  // --- helpers ---

  function makeBridge(
    conversationId: string,
    sandbox: SandboxRef,
    cfg: AgentHostConfig,
    model: string | undefined,
    metrics: MetricsSink,
    owner?: string,
    pickedProvider?: string,
  ) {
    // Tool calls run as local subprocesses in fake mode and exec into the sandbox pod via
    // the K8s exec API otherwise.
    const exec = createSandboxExecBackend(
      config.fakeSandbox
        ? createLocalSandboxApiClient()
        : deferredSandboxApi(sandbox, () => provisioner.resume(sandbox).then(() => {})),
      { commandTimeoutMs: config.commandTimeoutMs },
    );
    // Per-conversation model override: GOOSE_MODEL in the agent's launch env.
    const resolved = resolveModel(model, cfg);
    // GOOSE_MODE=approve enables the per-tool permission gate the ACP client auto-answers
    // for back-pressure, off when SUBAGENT_BACKPRESSURE=0.
    const backpressureOn = process.env.SUBAGENT_BACKPRESSURE !== "0";
    const agentEnv = {
      ...cfg.agent.env,
      ...(resolved ? { GOOSE_MODEL: resolved } : {}),
      ...(backpressureOn ? { GOOSE_MODE: "approve" } : {}),
    };
    // goose runs in this pod, so its cwd must be a real writable dir here: ephemeral
    // per-conversation scratch under scratchPath, while its tool calls exec into the
    // sandbox.
    const cwd = join(config.scratchPath, conversationId, "agent-cwd");
    mkdirSync(cwd, { recursive: true });
    // The skills are re-read on every conversation start, so editing the skills ConfigMap
    // takes effect for new conversations with no image rebuild.
    const usingClaude = process.env.GOOSE_PROVIDER === "claude-code" && !config.fakeSandbox;
    // Write the agent's skills once per conversation, answering the owner's personal ones.
    // Memoized and deferred: makeBridge is sync and these come from the database. Why: PR #767.
    let skillsOnce: Promise<readonly Skill[]> | undefined;
    const prepareSkills = (): Promise<readonly Skill[]> =>
      (skillsOnce ??= (async () => {
        const personal = await personalSkillsFor(owner);
        // Provider-specific: goose reads .goosehints with every body inlined; the
        // SDK discovers .claude/skills itself and gets no bodies in its prompt.
        const skillCount = usingClaude
          ? writeSkillDir(cwd, config.skillsDir, personal)
          : writeHints(cwd, config.skillsDir, { name: config.agentName }, personal);
        if (skillCount)
          hostLog.info("wrote skills", {
            conversation_id: conversationId,
            skills: skillCount,
            personal: personal.length,
            // Named when non-empty so a surprising prompt is traceable to the user's own copy.
            ...(personal.length
              ? { shadowed: shadowedNames(loadSkills(config.skillsDir), personal) }
              : {}),
            via: usingClaude ? ".claude/skills" : ".goosehints",
          });
        return personal;
      })());
    const metricModel = resolved ?? cfg.model ?? "unknown";
    // The agent is offered two MCP servers split by who owns the tools: scooter-env for the
    // control-plane tools and scooter-broker for the contrib provider tools, both carrying
    // the same conversation token.
    const offeredServers = [
      ...(mcpEndpoint
        ? [{
            type: "http",
            name: "scooter-env",
            url: mcpEndpoint.urlFor(conversationId),
            headers: mcpEndpoint.headersFor(conversationId, owner),
          }]
        : []),
      ...(brokerMcpProxy && mcpEndpoint
        ? [{
            type: "http",
            name: "scooter-broker",
            url: brokerMcpProxy.url(),
            // The same conversation token; the proxy verifies it and attaches the rotating SA
            // token itself.
            headers: mcpEndpoint.headersFor(conversationId, owner),
          }]
        : []),
    ];
    const mcpServers = offeredServers.length ? offeredServers : undefined;
    // The floor ACP client factory is the cloud brain (SDK-claude on Bedrock, or goose) a run
    // uses when no personalized remote agent applies.
    const floorAcpClientFactory = async () => {
      // The agent reads .goosehints / .claude/skills from `cwd` as it starts, so the write
      // has to land before the client is built.
      await prepareSkills();
      return (
        // claude-code drives the agent via the Claude Agent SDK so its tools run in the
        // sandbox via ExecBackend; other providers take the goose ACP path.
        usingClaude
          ? createSdkAcpClient({
              oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
              model: resolved ?? cfg.model ?? "claude-sonnet-4-5",
              exec,
              // No skill bodies: the SDK loads them from .claude/skills on demand.
              systemPrompt: sdkPrompt({ name: config.agentName }),
              // settingSources makes the SDK read .claude/skills from cwd, and without it no
              // skill list is ever sent.
              cwd,
              settingSources: ["project"],
              // Without `skills` the SDK leaves the Skill tool out of the explicit allowedTools,
              // so the model cannot invoke any.
              skills: "all",
              // One line naming the skills the session discovered.
              onInit: (info) =>
                hostLog.info("sdk session init", {
                  conversation_id: conversationId,
                  skills: info.skills.length,
                  skill_names: info.skills
                    .map((s) => (s as { name?: string })?.name)
                    .filter(Boolean),
                  commands: info.commands,
                }),
              // Record the raw SDK messages under this run for the transcript (no-op when off).
              recordRaw: (m) => bridge.recordRawInput(m),
              // Give the SDK agent the same platform MCP tools the goose path gets, scoped by
              // the conversation token.
              mcpEndpointUrl: mcpEndpoint?.urlFor(conversationId),
              // scooter-broker carries the contrib provider tools (github, gitlab, jira, slack).
              mcpServers:
                brokerMcpProxy && mcpEndpoint
                  ? [
                      {
                        name: "scooter-broker",
                        url: brokerMcpProxy.url(),
                        headers: Object.fromEntries(
                          mcpEndpoint
                            .headersFor(conversationId, owner)
                            .map((h) => [h.name, h.value]),
                        ),
                      },
                    ]
                  : undefined,
              // The conversation token, as the SDK's per-server `headers`.
              mcpEndpointHeaders: mcpEndpoint
                ? Object.fromEntries(
                    mcpEndpoint.headersFor(conversationId, owner).map((h) => [h.name, h.value]),
                  )
                : undefined,
              // Back-pressure: yield the next tool call when a priority item is waiting;
              // late-bound since `bridge` is assigned below.
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
              // Back-pressure: auto-answer goose's approve-mode permission gate, rejecting the
              // next tool when a priority item waits; late-bound since `bridge` is assigned
              // below.
              shouldYield: backpressureOn ? () => bridge.shouldYieldToQueue() : undefined,
              // Record the raw ACP updates under this run (no-op when off).
              recordRaw: (u) => bridge.recordRawInput(u),
            })
      );
    };

    // Per-run ACP provider registry: with BYO, the resolver prefers the owner's remote agent
    // for human triggers and falls to the floor otherwise, with the remote provider's tools
    // still exec'ing into this conversation's cloud sandbox.
    const floorProvider: AcpProvider = {
      id: usingClaude ? "sdk-claude" : "bedrock-goose",
      kind: usingClaude ? "claude" : "goose",
      priority: 0,
      // The model namespace this provider serves: goose = Bedrock ids, the in-cluster SDK =
      // API ids under "claude-code".
      modelTag: usingClaude ? "claude-code" : "goose",
      eligible: () => true,
      createClient: floorAcpClientFactory,
    };
    // BYO is a candidate only when a controller is configured, since the controller holds
    // every container socket and resolves ownership.
    const acpProviders: AcpProvider[] = byocControllerUrl
      ? [
          createRemotePersonalizedProvider({
            controllerUrl: byocControllerUrl,
            exec,
            // The BYO container reaches scooter-env over the tunnel, not this loopback URL
            // directly.
            mcpUrlFor: mcpEndpoint ? (conv: string) => mcpEndpoint.urlFor(conv) : undefined,
            // Injected by the agent-host when it proxies a tunnel frame, so the user's machine
            // never holds a conversation token.
            mcpHeadersFor: mcpEndpoint ? (conv: string) => mcpEndpoint.headersFor(conv) : undefined,
            // Offer a BYO agent the contrib provider tools too, not just scooter-env.
            brokerMcpUrlFor: brokerMcpProxy ? () => brokerMcpProxy.url() : undefined,
            // So an explicit pick of a cloud-only model declines here rather than
            // being silently overridden by BYOC's priority.
            catalog: config.modelCatalog,
          }),
          floorProvider,
        ]
      : [floorProvider];
    // Log the candidates once per bridge, with the owner, so "why did my container not serve
    // this?" is answerable from the log.
        logger("acp-providers").info("resolved provider candidates", {
          conversation_id: conversationId,
          owner: owner ?? null,
          candidates: acpProviders.map((pr) => `${pr.id}@${pr.priority}`),
          byoc_controller: byocControllerUrl || null,
        });

    const bridge = createSessionBridge({
      config: { cwd, skillsDir: config.skillsDir, agentName: config.agentName, agent: cfg.agent, sandbox, mcpServers },
      exec,
        // Stamped onto RUN_STARTED so a later reader can tell a run this pod is still
        // executing from one stranded by a dead host.
        selfPod: podName,
        // The epoch half of that stamp, without which a StatefulSet pod reusing its name
        // would read a run stranded by its previous process as its own.
        generation: () => ownership?.guard.observedGeneration?.(conversationId as SessionId),
      firstActivityTimeoutMs: config.firstActivityTimeoutMs,
      livenessProbeMs: config.livenessProbeMs,
      // Transcript recorder for the test harness, off unless TRANSCRIPT_RECORD_DIR is set.
      recorder: transcriptRecorder,
      provider: usingClaude ? "claude" : "goose",
      owner,
      // The same memoized set the in-pod write uses, so a BYO container is handed exactly
      // what a cloud run of this conversation would see.
      personalSkills: prepareSkills,
      acpProviders,
      // Per-provider model resolution: the conversation's choice when the run's provider
      // offers it, else that provider's default.
      model,
      pickedProvider,
      modelCatalog: cfg.modelCatalog,
      onRunComplete: ({ acpSessionId, durationMs, outcome }) => {
        // Attribute cost to the conversation owner, resolving the email async without
        // blocking the run.
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
      // Revive history reinjection: the full persisted log is folded into a transcript and
      // prepended on this bridge's first prompt.
      loadHistory: async () => {
        const events: AguiEvent[] = [];
        for await (const e of store.readEvents(conversationId as SessionId)) events.push(e);
        // A compacted conversation resumes from the summary plus the events after the
        // latest marker.
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

/** A SandboxApiClient that resolves the real pod-exec client on first use, since
 *  connectSandbox is async and the ExecBackend is sync-constructed. */
function deferredSandboxApi(sandbox: SandboxRef, ensureRunning?: () => Promise<void>) {
  // Concurrent first tool calls share one connect, and ensureRunning resumes a sandbox
  // idle-suspended out from under a live bridge when connect finds no pod.
  const ensure = createDeferredConnector(() => connectSandbox(sandbox, { ensureRunning }));
  return {
    mode: "k8s-exec" as const,
    // Forward the AbortSignal so kill()'s abort reaches the k8s exec layer.
    async execute(req: Parameters<Awaited<ReturnType<typeof connectSandbox>>["execute"]>[0], signal?: AbortSignal) {
      return (await ensure()).execute(req, signal);
    },
    async download(path: string) {
      return (await ensure()).download(path);
    },
    async upload(path: string, content: string) {
      return (await ensure()).upload(path, content);
    },
    async uploadBinary(path: string, base64: string) {
      return (await ensure()).uploadBinary(path, base64);
    },
  };
}


/** Wire SIGTERM and SIGINT to a graceful drain of `shutdown` (main()'s return), bounded by
 *  SHUTDOWN_TIMEOUT_MS so a stuck close cannot hold the pod past its terminationGracePeriod. */
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
  // opts.log stays a plain-string seam for tests, while the default routes through the
  // structured logger with the signal and timeout as fields.
  const injected = opts.log;
  const drainLog = (msg: string, fields?: Record<string, unknown>) => {
    if (injected) injected(msg);
    else hostLog.info(msg, fields);
  };
  let shuttingDown = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (shuttingDown) return; // ignore repeat signals mid-drain
    shuttingDown = true;
    drainLog("draining", { signal: sig });
    const timer = setTimeoutFn(() => {
      drainLog("drain exceeded the timeout — exiting", { timeout_ms: timeoutMs });
      proc.exit(0);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    shutdown()
      .then(() => { drainLog("drained cleanly"); proc.exit(0); })
      .catch((e) => { hostLog.errorWith("drain error", e); proc.exit(0); });
  };
  proc.on("SIGTERM", onSignal);
  proc.on("SIGINT", onSignal);
}

// Entry point: when run directly (node dist/index.js), start the service.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((shutdown) => installShutdownHandlers(shutdown))
    .catch((err) => {
      hostLog.errorWith("fatal", err);
      process.exit(1);
    });
}
