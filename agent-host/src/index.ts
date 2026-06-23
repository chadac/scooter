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
import { createSessionManager } from "./session/manager.js";
import { createK8sProvisioner } from "./session/k8sProvisioner.js";
import type { SandboxProvisioner } from "./session/manager.js";
import { createFileConversationStore } from "./session/fileStore.js";
import { createSessionBridge } from "./bridge.js";
import { createAcpClient } from "./acp/client.js";
import { createSandboxExecBackend, connectSandbox } from "./exec/sandboxExec.js";
import type { SandboxRef } from "./types.js";

export interface AgentHostConfig {
  port: number;
  namespace: string;
  sandboxImage: string;
  /** Path on the conversation-state PVC where event logs / goose state live. */
  statePath: string;
  /** ACP agent launch (goose). */
  agent: { command: string; args: string[]; env: Record<string, string> };
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
    fakeSandbox: process.env.FAKE_SANDBOX === "1" || useFakeAgent,
    agent: useFakeAgent
      ? { command: process.execPath, args: [fakeAgentPath], env: {} }
      : { command: process.env.GOOSE_BIN ?? "goose", args: ["acp"], env: bedrockEnv() },
  };
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

/** Pass AWS/Bedrock config through to goose if present. */
function bedrockEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    "GOOSE_PROVIDER", "GOOSE_MODEL",
    "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
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
    bridgeFactory: ({ conversationId, sandbox }) => {
      // Exec + ACP client are connected lazily/asynchronously; the bridge is
      // created synchronously and starts the connection in start().
      return makeBridge(conversationId, sandbox, config);
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

  await server.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`[agent-host] listening on :${config.port}`);

  return async () => {
    await server.close();
  };

  // --- helpers ---

  function makeBridge(conversationId: string, sandbox: SandboxRef, cfg: AgentHostConfig) {
    // Exec resolves the pod-exec client on first use; the ACP client (goose) is
    // created by the factory the bridge calls on first start(). Both are async,
    // handled cleanly by the bridge's async start() — no facade shims.
    const exec = createSandboxExecBackend(deferredSandboxApi(sandbox));
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/etc/agent-sandbox/skills", agent: cfg.agent, sandbox },
      exec,
      acpClient: () =>
        createAcpClient({ command: cfg.agent.command, args: cfg.agent.args, env: cfg.agent.env, exec }),
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
