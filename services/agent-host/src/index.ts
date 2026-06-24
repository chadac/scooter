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

import { createAguiServer } from "./agui/server.js";
import { createManagementApi } from "./api/management.js";
import { createSessionManager } from "./session/manager.js";
import { createK8sProvisioner } from "./session/k8sProvisioner.js";
import type { SandboxProvisioner } from "./session/manager.js";
import { createFileConversationStore } from "./session/fileStore.js";
import { createSessionBridge } from "./bridge.js";
import { createAcpClient } from "./acp/client.js";
import { createSandboxExecBackend, connectSandbox } from "./exec/sandboxExec.js";
import { createLocalSandboxApiClient } from "./exec/localExec.js";
import type { SandboxRef } from "./types.js";

export interface AgentHostConfig {
  port: number;
  namespace: string;
  sandboxImage: string;
  /** Path on the conversation-state PVC where event logs / goose state live. */
  statePath: string;
  /** ACP agent launch (goose). */
  agent: { command: string; args: string[]; env: Record<string, string> };
  /** Default model (GOOSE_MODEL) and the models offered for per-conversation
   *  selection. A conversation may override the model; unset = default only. */
  model?: string;
  availableModels: string[];
  /** Idle-suspend: suspend conversations idle longer than this (ms). 0 = off. */
  idleSuspendMs: number;
  /** How often the idle sweep runs (ms). */
  idleSweepIntervalMs: number;
}

export interface AgentHostConfigExtra {
  /** Skip real Sandbox provisioning (local UI testing with the dummy agent). */
  fakeSandbox: boolean;
}

export function configFromEnv(): AgentHostConfig & AgentHostConfigExtra {
  // GOOSE_BIN=fake runs the bundled dummy ACP agent (no model, no AWS).
  const useFakeAgent = process.env.GOOSE_BIN === "fake";
  const fakeAgentPath = new URL("./fakeAgent.js", import.meta.url).pathname;
  return {
    port: Number(process.env.PORT ?? 8080),
    namespace: process.env.NAMESPACE ?? "agent-sandbox",
    sandboxImage: process.env.SANDBOX_IMAGE ?? "agent-sandbox-nix:latest",
    statePath: process.env.STATE_PATH ?? "/var/lib/agent-host/conversations",
    // Default: suspend after 30 min idle, sweep every minute. 0 disables.
    idleSuspendMs: Number(process.env.IDLE_SUSPEND_MS ?? 30 * 60 * 1000),
    idleSweepIntervalMs: Number(process.env.IDLE_SWEEP_INTERVAL_MS ?? 60 * 1000),
    fakeSandbox: process.env.FAKE_SANDBOX === "1" || useFakeAgent,
    model: process.env.GOOSE_MODEL,
    availableModels: (process.env.AGENT_AVAILABLE_MODELS ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    agent: useFakeAgent
      ? { command: process.execPath, args: [fakeAgentPath], env: {} }
      : { command: process.env.GOOSE_BIN ?? "goose", args: ["acp"], env: bedrockEnv() },
  };
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
    : createK8sProvisioner({ namespace: config.namespace, sandboxImage: config.sandboxImage });
  const store = createFileConversationStore(config.statePath);
  const server = createAguiServer();

  // Build a bridge per conversation: connect exec to the sandbox pod, spawn
  // goose, and wire its AG-UI events out through the server.
  const sessions = createSessionManager({
    provisioner,
    store,
    bridgeFactory: ({ conversationId, sandbox, model }) => {
      // Exec + ACP client are connected lazily/asynchronously; the bridge is
      // created synchronously and starts the connection in start().
      return makeBridge(conversationId, sandbox, config, model);
    },
  });

  // Forward every conversation's AG-UI events to subscribed UI connections.
  // (SessionManager already persists them to the store via its own wiring.)

  server.onPrompt(async (sessionId, input) => {
    // sessionId here is the AG-UI threadId; find-or-start the conversation.
    await sessions.promptByThread(sessionId, input.text);
  });

  server.onAttach(async (sessionId, conn) => {
    for await (const event of store.readEvents(sessionId)) conn.send(event);
  });

  // Management REST API (conversation CRUD + lifecycle + history), mounted on
  // the same server. /agui stays the AG-UI streaming transport.
  server.use(
    createManagementApi({
      sessions,
      store,
      server,
      models: { default: config.model, available: config.availableModels },
      answerPermission: async (sessionId, toolCallId, optionId) => {
        // Permission answering is wired through the bridge in a later pass;
        // the route exists so the API surface is complete.
        console.warn("[agent-host] permission answer not yet wired", { sessionId, toolCallId, optionId });
      },
    }),
  );

  await server.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`[agent-host] listening on :${config.port}`);

  // Idle-suspend sweep — kube-native-friendly: the agent-host owns the activity
  // signal, so it suspends idle conversations itself (drops the pod, keeps the
  // PVCs). Activity metadata is exposed via the API + persisted so an external
  // lifecycle controller could take over. 0 disables.
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  if (config.idleSuspendMs > 0) {
    sweepTimer = setInterval(() => {
      void sessions.sweepIdle(config.idleSuspendMs).then((ids) => {
        if (ids.length) console.log(`[agent-host] idle-suspended ${ids.length}:`, ids);
      });
    }, config.idleSweepIntervalMs);
    sweepTimer.unref?.();
  }

  return async () => {
    if (sweepTimer) clearInterval(sweepTimer);
    await server.close();
  };

  // --- helpers ---

  function makeBridge(conversationId: string, sandbox: SandboxRef, cfg: AgentHostConfig, model?: string) {
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
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/etc/agent-sandbox/skills", agent: cfg.agent, sandbox },
      exec,
      acpClient: () =>
        createAcpClient({ command: cfg.agent.command, args: cfg.agent.args, env: agentEnv, exec }),
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
  let real: Awaited<ReturnType<typeof connectSandbox>> | undefined;
  const ensure = async () => (real ??= await connectSandbox(sandbox));
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
