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
import { createManagementApi } from "./api/management.js";
import { createSessionManager } from "./session/manager.js";
import { createK8sProvisioner } from "./session/k8sProvisioner.js";
import type { SandboxProvisioner } from "./session/manager.js";
import { createFileConversationStore } from "./session/fileStore.js";
import { createSessionBridge, type AguiEvent } from "./bridge.js";
import { createAcpClient } from "./acp/client.js";
import { createSandboxExecBackend, connectSandbox } from "./exec/sandboxExec.js";
import { createDeferredConnector } from "./exec/deferredConnect.js";
import { createLocalSandboxApiClient } from "./exec/localExec.js";
import { writeHints } from "./agent/skills.js";
import { ensureGooseConfig } from "./agent/gooseConfig.js";
import { createModuleManager } from "./session/moduleManager.js";
import { createMcpEndpoint } from "./agent/mcpServer.js";
import { createBrokerClient } from "./agent/brokerClient.js";
import { createResourceLookup } from "./agent/resourceMapping.js";
import { parseScooterEnv } from "./config/scooterEnv.js";
import { resolverFromEnv, type AsyncIdentityResolver } from "./auth/identity.js";
import { withIdentityStore, createPgIdentityStore } from "./auth/identityStore.js";
import { withAlbVerification } from "./auth/albVerify.js";
import type { IncomingMessage } from "node:http";
import { createMetrics, type MetricsSink } from "./metrics/metrics.js";
import { parsePriceTable } from "./metrics/pricing.js";
import { createGooseUsageReader } from "./metrics/gooseUsage.js";
import type { SandboxRef, SessionId } from "./types.js";

export interface AgentHostConfig {
  port: number;
  namespace: string;
  sandboxImage: string;
  /** Durable conversation state: the AG-UI event log (history/replay). On a PVC
   *  so it survives agent-host restarts. */
  statePath: string;
  /** Ephemeral scratch for the agent process: goose's per-conversation cwd
   *  (sessions DB + .goosehints). The real work execs into the sandbox, so this
   *  is throwaway — an emptyDir, NOT the durable PVC. */
  scratchPath: string;
  /** ACP agent launch (goose). */
  agent: { command: string; args: string[]; env: Record<string, string> };
  /** Default model (GOOSE_MODEL) and the models offered for per-conversation
   *  selection. A conversation may override the model; unset = default only. */
  model?: string;
  availableModels: string[];
  /** Agent display name (the assistant introduces itself as this). */
  agentName: string;
  /** Directory of markdown skills injected into the agent (a ConfigMap mount in
   *  cluster). Read per conversation -> .goosehints; add a .md, no image rebuild. */
  skillsDir: string;
  /** Idle-suspend: suspend conversations idle longer than this (ms). 0 = off. */
  idleSuspendMs: number;
  /** How often the idle sweep runs (ms). */
  idleSweepIntervalMs: number;
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
    scratchPath: process.env.SCRATCH_PATH ?? defaultScratchPath,
    // Default: suspend after 30 min idle, sweep every minute. 0 disables.
    idleSuspendMs: Number(process.env.IDLE_SUSPEND_MS ?? 30 * 60 * 1000),
    idleSweepIntervalMs: Number(process.env.IDLE_SWEEP_INTERVAL_MS ?? 60 * 1000),
    fakeSandbox,
    model: process.env.GOOSE_MODEL,
    availableModels: (process.env.AGENT_AVAILABLE_MODELS ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
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

function bedrockEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    "GOOSE_PROVIDER", "GOOSE_MODEL",
    "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    // IRSA (EKS pod identity) — the credential source in-cluster.
    "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_STS_REGIONAL_ENDPOINTS",
    "AWS_ROLE_SESSION_NAME",
  ]) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out;
}

export async function main(
  config: AgentHostConfig & Partial<AgentHostConfigExtra> = configFromEnv(),
): Promise<() => Promise<void>> {
  const provisioner = config.fakeSandbox
    ? createNoopProvisioner()
    : createK8sProvisioner({
        namespace: config.namespace,
        sandboxImage: config.sandboxImage,
        // When the AWS permissions broker is on, mount its account-registry
        // ConfigMap into each sandbox so the entrypoint renders ~/.aws/config.
        awsAccountsConfigMap: process.env.AWS_ACCOUNTS_CONFIGMAP || undefined,
        // The sandbox is ALWAYS the NixOS systemd-PID-1 image now (the legacy
        // generic image was retired): always provision privileged + tmpfs /run,/tmp
        // so systemd PID 1 boots.
        systemdImage: true,
        // When the sandbox image has the local-overlay Nix store enabled
        // (agent-sandbox-os-overlay), mount a disk-backed PVC upper at
        // /nix/.scooter-rw so runtime nix builds (re-converge) can write + persist.
        overlayStore: (process.env.SANDBOX_OVERLAY_STORE || "") === "1",
        overlayStorage: process.env.SANDBOX_OVERLAY_STORAGE || undefined,
        // Deployment-supplied tool injection (generic — the platform doesn't know
        // what's in these; a deployment sets them to its .scooter
        // ConfigMap, the token audiences its tools need, and their env vars).
        // SCOOTER_CONFIGMAP, SCOOTER_TOKEN_AUDIENCES (CSV), SCOOTER_ENV (JSON —
        // lossless for multi-line values like NIX_CONFIG; legacy k=v;k=v accepted).
        scooterConfigMap: process.env.SCOOTER_CONFIGMAP || undefined,
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
  const store = createFileConversationStore(config.statePath);
  const server = createAguiServer();

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
  const sessions = createSessionManager({
    provisioner,
    store,
    bridgeFactory: ({ conversationId, sandbox, model }) => {
      // Exec + ACP client are connected lazily/asynchronously; the bridge is
      // created synchronously and starts the connection in start().
      const bridge = makeBridge(conversationId, sandbox, config, model, metrics);
      // The agent titles the conversation by emitting <title>…</title> as its
      // first action; the bridge extracts it -> set it on the conversation.
      bridge.onTitle((title) => sessions.setTitle(conversationId, title));
      return bridge;
    },
  });

  // Agent self-modify: the moduleManager applies the agent's self-authored module
  // live (upload -> scooter-apply-module -> persist-on-success) and the MCP server
  // exposes it to goose as the `modify_environment` tool. ON by default; it still
  // self-gates to a real sandbox with the in-pod build support (overlay-store
  // image + a real sandbox), so fake/local runs skip it. Set AGENT_SELF_MODIFY=0
  // to force it off.
  const selfModifyEnabled =
    process.env.AGENT_SELF_MODIFY !== "0" && !config.fakeSandbox && !!provisioner.writeModule;
  const moduleManager = selfModifyEnabled
    ? createModuleManager({
        // Resolve each conversation's sandbox to an exec client (same path the
        // bridge uses) so the apply runs in the right pod.
        client: (id) => deferredSandboxApi(sessions.get(id as SessionId)!.sandbox),
        configMap: { writeModule: (id, m) => provisioner.writeModule!(id, m) },
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
  // Serve the MCP endpoint if EITHER capability is available: self-modify
  // (modify_environment) OR the agent-tools (broker wired). They're independent —
  // the agent-tools (slack/gitlab/github/web) must reach goose even when
  // self-modify is off, and vice-versa. buildServer registers whichever deps are
  // present.
  const mcpEndpoint =
    moduleManager !== undefined || agentToolsWiring !== undefined
      ? createMcpEndpoint({
          manager: moduleManager,
          // The URL goose connects to. The agent-host serves it on its own port;
          // goose runs in THIS pod, so localhost reaches it.
          baseUrl: process.env.AGENT_SELF_MODIFY_MCP_URL ?? `http://127.0.0.1:${config.port}`,
          agentTools: agentToolsWiring,
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
    await sessions.promptByThread(sessionId, input.text, model);
  });

  // A user's answer to a permission/option request -> resolve the blocked run.
  server.onPermission(async (sessionId, toolCallId, optionId) => {
    sessions.get(sessionId)?.bridge?.answerPermission(toolCallId, optionId);
  });

  // assistant-ui resumes a paused run by POSTing /agui with resume[] — route the
  // answer to the conversation's bridge (interruptId == the request's toolCallId).
  server.onResume(async (sessionId, entry) => {
    const bridge = sessions.get(sessionId)?.bridge;
    if (!bridge) return;
    // cancelled -> empty optionId (the bridge treats an unknown/empty id as a
    // cancel); resolved -> the chosen optionId from the payload.
    const optionId =
      entry.status === "cancelled"
        ? ""
        : ((entry.payload as { optionId?: string } | undefined)?.optionId ?? "");
    bridge.answerPermission(entry.interruptId, optionId);
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

  // Management REST API (conversation CRUD + lifecycle + history), mounted on
  // the same server. /agui stays the AG-UI streaming transport.
  server.use(
    createManagementApi({
      sessions,
      store,
      server,
      models: { default: config.model, available: config.availableModels },
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
      resolveAwsRequest: async (sessionId, requestId, approved, approver) => {
        // The user answered a broker AWS approval interrupt -> approve/deny the
        // request on the broker. The broker URL + auth come from env (BROKER_URL
        // + the agent-host's SA token, same as the sandbox helpers).
        const brokerUrl = (process.env.BROKER_URL ?? "").replace(/\/$/, "");
        if (!brokerUrl) {
          console.warn("[agent-host] BROKER_URL unset; cannot resolve AWS request", { requestId });
          return;
        }
        const action = approved ? "approve" : "deny";
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const tokenPath = process.env.BROKER_TOKEN_PATH ?? "/var/run/secrets/broker/token";
        try {
          const { readFileSync } = await import("node:fs");
          headers["Authorization"] = `Bearer ${readFileSync(tokenPath, "utf8").trim()}`;
        } catch (e) {
          // Finding #9: a MISSING token (ENOENT) is the genuine local/dev case.
          // But an unreadable token (EACCES, etc.) that SHOULD be there would
          // otherwise masquerade as dev mode -> we'd send an unauthenticated
          // request -> broker 401 -> the user's approval silently lost. Only treat
          // not-found as dev; surface any other read error.
          if ((e as { code?: string })?.code !== "ENOENT") {
            throw new Error(
              `failed to read broker token at ${tokenPath} (would send an ` +
                `unauthenticated approval): ${(e as Error)?.message ?? e}`,
              { cause: e },
            );
          }
          /* ENOENT -> no token (local/dev) */
        }
        // Send the answering user's FULL identity (id + email + name); the broker
        // authorizes the CLAIM it's configured for (email/id/name). The agent-host
        // SA token is the trust anchor (it vouches for this real user).
        // Finding #5: approve/deny is security-relevant — a broker 4xx/5xx (approver
        // lacks rights, request expired, provisioning failed) must NOT be treated as
        // success. On failure, throw (observable) AND, for an APPROVE, feed the
        // broker's detail back into the conversation so the agent can help the user
        // fix the setup (e.g. the account's IAM isn't provisioned).
        const res = await fetch(`${brokerUrl}/aws/aws/${encodeURIComponent(requestId)}/${action}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ approver }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if (approved) {
            // Extract the broker's error reasons (JSON {detail:{errors:[...]}}) for
            // a readable, actionable message; fall back to the raw body.
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
                "[System: the AWS access you requested was approved, but the broker could NOT " +
                  "provision it. Do NOT retry the request; instead, help the user fix the broker " +
                  "setup, then they can re-approve. Broker error:\n\n" + detail,
              )
              .catch((e) => console.error("[agent-host] failed to feed AWS provisioning error to the agent:", e));
          }
          throw new Error(
            `broker rejected AWS ${action} for ${requestId}: ${res.status} ${body.slice(0, 500)}`,
          );
        }
      },
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

  return async () => {
    if (sweepTimer) clearInterval(sweepTimer);
    await metrics.shutdown();
    await server.close();
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
      config.fakeSandbox ? createLocalSandboxApiClient() : deferredSandboxApi(sandbox),
    );
    // Per-conversation model override: GOOSE_MODEL in the agent's launch env.
    const resolved = resolveModel(model, cfg);
    const agentEnv = resolved ? { ...cfg.agent.env, GOOSE_MODEL: resolved } : cfg.agent.env;
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
    // Offer the agent the modify_environment MCP tool (when self-modify is on),
    // scoped to THIS conversation via the URL's ?conv=<id>.
    const mcpServers = mcpEndpoint
      ? [{ type: "http", name: "scooter-env", url: mcpEndpoint.urlFor(conversationId), headers: [] }]
      : undefined;
    const bridge = createSessionBridge({
      config: { cwd, skillsDir: config.skillsDir, agent: cfg.agent, sandbox, mcpServers },
      exec,
      acpClient: () =>
        createAcpClient({ command: cfg.agent.command, args: cfg.agent.args, env: agentEnv, exec }),
      onRunComplete: ({ acpSessionId, durationMs, outcome }) => {
        metrics.runFinished({
          conversationId,
          model: metricModel,
          acpSessionId: acpSessionId ?? conversationId,
          durationMs,
          outcome,
        });
      },
      // Revive history reinjection: a revived conversation spawns a fresh goose
      // session with no memory, so on this bridge's first prompt the persisted
      // event log is folded into a transcript and prepended. Read the FULL log
      // for this conversation (the bridge snapshots it before the current turn).
      loadHistory: async () => {
        const events: AguiEvent[] = [];
        for await (const e of store.readEvents(conversationId as SessionId)) events.push(e);
        return events;
      },
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
function deferredSandboxApi(sandbox: SandboxRef) {
  // In-flight dedupe: a burst of concurrent first tool calls shares ONE connect
  // (one pod-readiness wait), not N. (`real ??= await connect()` would not dedupe
  // — it caches only the resolved value, so concurrent awaits each connect.)
  const ensure = createDeferredConnector(() => connectSandbox(sandbox));
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


// Entry point: when run directly (node dist/index.js), start the service.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[agent-host] fatal:", err);
    process.exit(1);
  });
}
