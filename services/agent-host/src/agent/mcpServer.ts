/**
 * The agent-facing MCP server — gives goose one tool, `modify_environment`, that
 * routes DIRECTLY to the agent-host (the brain), NOT through the sandbox. So the
 * agent changes its own NixOS environment without depending on the very compute
 * environment it's changing.
 *
 * Transport: a stateless Streamable-HTTP MCP endpoint served in-process by the
 * agent-host. Each conversation's `newSession` is given an MCP server URL that
 * encodes its conversationId (?conv=<id>), so a tool call resolves to the right
 * sandbox. The tool handler calls moduleManager.apply (upload -> build/switch ->
 * persist-on-success), returning success or the build error to the agent.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import type { ModuleManager } from "../session/moduleManager.js";
import type { JobManager } from "../session/jobManager.js";
import type { ConversationLink } from "../session/manager.js";
import { registerAgentTools, type BrokerClient, type ResourceMapping } from "./agentTools.js";
import { handleListModels, handleSwitchModel, type ModelToolsWiring } from "./modelTools.js";
import {
  handleShowSandboxResources,
  handleSetSandboxResources,
  type SandboxResourceToolsWiring,
} from "./resourceTools.js";

/** An MCP tool result (the shape the SDK callback returns). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * The pure handler for modify_environment — testable without the HTTP/MCP
 * plumbing. Applies the agent's module to `conversationId`'s sandbox and maps the
 * result to an MCP tool response: success text, or the build/switch error as an
 * error result so the agent can fix its module and retry.
 */
export async function handleModifyEnvironment(
  manager: ModuleManager,
  conversationId: string,
  args: { module_nix: string },
): Promise<ToolResult> {
  const module = args.module_nix ?? "";
  if (!module.trim()) {
    return { isError: true, content: [{ type: "text", text: "module_nix is empty — provide a NixOS module." }] };
  }
  const res = await manager.apply(conversationId, module);
  if (res.ok) {
    // The build+switch runs in the BACKGROUND now — the agent gets its turn back and
    // keeps working. Tell it how to check on the switch (and where the error goes if
    // it fails) so it doesn't assume the environment is ready yet.
    return {
      content: [
        {
          type: "text",
          text:
            "Environment change LAUNCHED — it's building + switching in the background, so you can keep working. " +
            "It usually takes ~1-3 min. Run `scooter-env-status` in the shell to see progress; on failure it prints " +
            "the full build/switch log so you can fix the module. Don't rely on a newly-added tool until the switch " +
            "reports `done` (ready).",
        },
      ],
    };
  }
  // A LAUNCH failure (couldn't upload / a switch already in flight) — distinct from a
  // build/switch failure, which now surfaces via scooter-env-status.
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          "The environment change could not be LAUNCHED (it was not applied). This is not a build error — " +
          "check `scooter-env-status` (a switch may already be in progress) and try again. Error:\n" +
          (res.error ?? "unknown error"),
      },
    ],
  };
}

/** Pure handlers for the background-job tools (run_background / check_background /
 *  list_background), testable without the MCP plumbing. */
export async function handleRunBackground(
  jobs: JobManager,
  conversationId: string,
  args: { command: string },
): Promise<ToolResult> {
  const command = (args.command ?? "").trim();
  if (!command) {
    return { isError: true, content: [{ type: "text", text: "command is empty — provide a shell command to run in the background." }] };
  }
  const { jobId } = await jobs.start(conversationId, command);
  return {
    content: [
      {
        type: "text",
        text:
          `Started background job \`${jobId}\`: ${command}\n` +
          `Check it with check_background("${jobId}"). It keeps running while you work.`,
      },
    ],
  };
}

export async function handleCheckBackground(
  jobs: JobManager,
  conversationId: string,
  args: { job_id: string },
): Promise<ToolResult> {
  const jobId = (args.job_id ?? "").trim();
  if (!jobId) return { isError: true, content: [{ type: "text", text: "job_id is required." }] };
  const st = await jobs.check(conversationId, jobId);
  if (st.state === "unknown") {
    return { isError: true, content: [{ type: "text", text: `Job \`${jobId}\` is unknown (its files were cleaned up or the pod was recreated).` }] };
  }
  const header =
    st.state === "running"
      ? `Job \`${jobId}\` is still RUNNING: ${st.command}`
      : `Job \`${jobId}\` EXITED with code ${st.exitCode}: ${st.command}`;
  const more = st.truncated ? `\n(output truncated to the tail — full log in the pod at ${st.logPath})` : "";
  return { content: [{ type: "text", text: `${header}\n\n${st.output}${more}` }] };
}

export async function handleListBackground(
  jobs: JobManager,
  conversationId: string,
): Promise<ToolResult> {
  const list = await jobs.list(conversationId);
  if (list.length === 0) return { content: [{ type: "text", text: "No background jobs for this conversation." }] };
  const lines = list.map((j) => `- ${j.jobId}: ${j.command}`).join("\n");
  return { content: [{ type: "text", text: `Background jobs (newest first):\n${lines}` }] };
}

export async function handleKillBackground(
  jobs: JobManager,
  conversationId: string,
  args: { job_id: string },
): Promise<ToolResult> {
  const jobId = (args.job_id ?? "").trim();
  if (!jobId) return { isError: true, content: [{ type: "text", text: "job_id is required." }] };
  const res = await jobs.kill(conversationId, jobId);
  const text =
    res.outcome === "killed"
      ? `Killed background job \`${jobId}\` (SIGTERM then SIGKILL to its process group).`
      : res.outcome === "already-exited"
        ? `Job \`${jobId}\` had already finished — nothing to kill (check_background for its result).`
        : `Job \`${jobId}\` is unknown (no such job, or its files were cleaned up).`;
  return { content: [{ type: "text", text }], isError: res.outcome === "unknown" };
}

/** The extra deps buildServer needs to ALSO register the agent-tools (slack/
 *  gitlab/github/web). Optional — when absent, only modify_environment registers
 *  (a modify_environment-only endpoint never crashes for lack of a broker). */
export interface AgentToolsWiring {
  /** The broker client the agent-tools call under the agent-host's identity. */
  broker: BrokerClient;
  /** The conversation's links (for inferred defaults), from store.listLinks. */
  links(conversationId: string): Promise<ConversationLink[]>;
  /** FALLBACK target lookup: the webhooks conversation_map (Postgres), used when a
   *  link has no structured `ref`. Optional — omitted when no DB is wired. */
  resourceLookup?(conversationId: string, source: string): Promise<ResourceMapping | undefined>;
  /** Injectable fetch for web_search / web_fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

/** Build an McpServer instance bound to one conversation. Registers whichever
 *  capabilities are present: modify_environment when `manager` is given (self-
 *  modify enabled), and the five typed agent-tools when `agentTools` is given
 *  (broker wired). The two are independent — the endpoint serves either or both. */
function buildServer(
  manager: ModuleManager | undefined,
  conversationId: string,
  agentTools?: AgentToolsWiring,
  jobs?: JobManager,
  models?: ModelToolsWiring,
  resources?: SandboxResourceToolsWiring,
): McpServer {
  const server = new McpServer({ name: "scooter-env", version: "1.0.0" });
  if (manager) {
    server.registerTool(
      "modify_environment",
      {
        title: "Modify the dev environment",
        description:
          "Apply a NixOS module to THIS sandbox, live (no restart). Use it to add tools, packages, " +
          "systemd services, or config — anything a NixOS module can declare. Pass the full module as " +
          "`module_nix` (e.g. `{ pkgs, ... }: { environment.systemPackages = [ pkgs.ripgrep ]; }`). " +
          "The module is built (the build is the validation gate) and switched into the running system; " +
          "a build error or a failed switch is returned to you and the old environment is kept.",
        inputSchema: { module_nix: z.string().describe("The full NixOS module.nix text to apply.") },
      },
      async (args) => handleModifyEnvironment(manager, conversationId, args) as Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
    );
  }
  if (jobs) {
    server.registerTool(
      "run_background",
      {
        title: "Run a command in the background",
        description:
          "Start a long-running shell command (a build, a test suite) DETACHED in your sandbox and keep " +
          "working — it does NOT block this turn. Returns a job id; poll it with check_background (you'll also " +
          "be told automatically when it finishes), or stop it with kill_background. Output is captured to a log " +
          "in the pod. Use this instead of a normal shell tool call for anything that takes more than a few seconds.",
        inputSchema: { command: z.string().describe("The shell command to run in the background.") },
      },
      async (args) => handleRunBackground(jobs, conversationId, args) as Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
    );
    server.registerTool(
      "check_background",
      {
        title: "Check a background job",
        description: "Report a background job's state (running / exited + exit code) and its recent output tail.",
        inputSchema: { job_id: z.string().describe("The job id returned by run_background.") },
      },
      async (args) => handleCheckBackground(jobs, conversationId, args) as Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
    );
    server.registerTool(
      "list_background",
      {
        title: "List background jobs",
        description: "List this conversation's background jobs (newest first) with their commands.",
        inputSchema: {},
      },
      async () => handleListBackground(jobs, conversationId) as Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
    );
    server.registerTool(
      "kill_background",
      {
        title: "Kill a background job",
        description:
          "Stop a running background job — SIGTERM then SIGKILL to its whole process group (so a build's " +
          "child processes are reaped too). Use it to abort a job you started that's no longer needed or is stuck.",
        inputSchema: { job_id: z.string().describe("The job id returned by run_background.") },
      },
      async (args) => handleKillBackground(jobs, conversationId, args) as Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
    );
  }
  if (agentTools) {
    registerAgentTools(
      server,
      { broker: agentTools.broker, fetchImpl: agentTools.fetchImpl },
      {
        conversationId,
        links: () => agentTools.links(conversationId),
        resourceLookup: agentTools.resourceLookup
          ? (source) => agentTools.resourceLookup!(conversationId, source)
          : undefined,
      },
    );
  }
  // Model self-selection: list the offered models (+ deployment hints) and switch
  // this conversation's model mid-run. Registered only when more than one model is
  // offered (a single-model deployment has nothing to switch to).
  if (models && models.catalog.models.length > 1) {
    server.registerTool(
      "list_models",
      {
        title: "List available models",
        description:
          "List the models you can run on, with a deployment hint for each (fast/cheap vs slow/powerful) " +
          "and which is current/default. Use this before switch_model to pick the right model for the task.",
        inputSchema: {},
      },
      async () => handleListModels(models, conversationId) as { content: Array<{ type: "text"; text: string }>; isError?: boolean },
    );
    server.registerTool(
      "switch_model",
      {
        title: "Switch your model",
        description:
          "Switch the model YOU run on for the rest of this conversation. Escalate to a more powerful model " +
          "for complex planning / research / hard debugging; drop to a faster/cheaper one for simple work. " +
          "Applies immediately: your current turn ends and you continue on the new model — no need to repeat " +
          "anything. Pass an exact model id from list_models.",
        inputSchema: { model: z.string().describe("The exact model id to switch to (from list_models).") },
      },
      async (args) => handleSwitchModel(models, conversationId, args) as Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
    );
  }
  // Sandbox right-sizing: show the current cpu/memory/gpu and restart the sandbox
  // at new resources. Registered only when the resources wiring is present (a
  // provisioner that can restart-with-override is configured).
  if (resources) {
    server.registerTool(
      "show_sandbox_resources",
      {
        title: "Show your sandbox resources",
        description:
          "Show your sandbox's current cpu / memory / gpu (requests and limits). Use this before " +
          "set_sandbox_resources to see what you have.",
        inputSchema: {},
      },
      () => handleShowSandboxResources(resources, conversationId) as { content: Array<{ type: "text"; text: string }>; isError?: boolean },
    );
    server.registerTool(
      "set_sandbox_resources",
      {
        title: "Resize your sandbox",
        description:
          "Change the cpu / memory / gpu (requests and/or limits) YOUR sandbox runs with, then RESTART it " +
          "so the change takes effect. Scale up for a heavy build/large model; scale down when idle. Omit a " +
          "field to keep it. NOTE: this restarts your sandbox — in-flight foreground work is interrupted. " +
          "Quantities are k8s-style (cpu \"500m\"/\"2\", memory \"1Gi\"/\"512Mi\", gpu a whole number).",
        inputSchema: {
          requestCpu: z.string().optional().describe('cpu request, e.g. "500m" or "2".'),
          requestMemory: z.string().optional().describe('memory request, e.g. "1Gi".'),
          requestGpu: z.number().int().nonnegative().optional().describe("whole GPUs to request (nvidia.com/gpu)."),
          limitCpu: z.string().optional().describe('cpu limit, e.g. "2".'),
          limitMemory: z.string().optional().describe('memory limit, e.g. "8Gi".'),
          limitGpu: z.number().int().nonnegative().optional().describe("whole GPUs to limit (nvidia.com/gpu)."),
        },
      },
      async (args) => handleSetSandboxResources(resources, conversationId, args) as Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
    );
  }
  return server;
}

export interface McpEndpoint {
  /** Handle an HTTP request to the MCP endpoint. The conversationId is read from
   *  the `conv` query param (each conversation's newSession URL encodes it). */
  handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void>;
  /** The MCP URL a conversation's newSession should advertise to goose. */
  urlFor(conversationId: string): string;
}

/**
 * Create the in-process MCP endpoint. Stateless: a fresh McpServer +
 * StreamableHTTP transport per request (no session state to keep — the
 * conversationId comes from the URL), so it composes with the agent-host's
 * existing node:http server.
 */
export function createMcpEndpoint(deps: {
  /** Self-modify (modify_environment). Omit when self-modify is off — the
   *  endpoint then serves only the agent-tools. */
  manager?: ModuleManager;
  baseUrl: string;
  path?: string;
  /** When provided, the same per-conversation server ALSO exposes the five typed
   *  agent-tools (slack/gitlab/github/web). Omit to expose only
   *  modify_environment (e.g. when no broker is configured). */
  agentTools?: AgentToolsWiring;
  /** When provided, exposes the background-job tools (run_background /
   *  check_background / list_background). Omit to leave them off. */
  jobs?: JobManager;
  /** When provided (and >1 model is offered), exposes list_models / switch_model
   *  so the agent can pick + switch its own model. */
  models?: ModelToolsWiring;
  /** When provided, exposes show_sandbox_resources / set_sandbox_resources so the
   *  agent can right-size + restart its own sandbox. Omit to leave them off. */
  resources?: SandboxResourceToolsWiring;
}): McpEndpoint {
  const path = deps.path ?? "/mcp";
  return {
    urlFor(conversationId) {
      return `${deps.baseUrl.replace(/\/$/, "")}${path}?conv=${encodeURIComponent(conversationId)}`;
    },
    async handle(req, res, body) {
      const url = new URL(req.url ?? "", "http://localhost");
      const conv = url.searchParams.get("conv");
      if (!conv) {
        res.statusCode = 400;
        res.end("missing conv");
        return;
      }
      // Stateless transport: no session id (sessionIdGenerator undefined).
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildServer(deps.manager, conv, deps.agentTools, deps.jobs, deps.models, deps.resources);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    },
  };
}
