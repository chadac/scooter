/**
 * The agent-facing MCP server — exposes the agent-host's in-process tools to goose
 * (background jobs, model self-selection, and the typed agent-tools).
 *
 * Transport: a stateless Streamable-HTTP MCP endpoint served in-process by the
 * agent-host. Each conversation's `newSession` is given an MCP server URL that
 * encodes its conversationId (?conv=<id>), so a tool call resolves to the right
 * sandbox.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

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

/** The extra deps buildServer needs to register the agent-tools (slack/gitlab/
 *  github/web). Optional — when absent, the agent-tools simply aren't registered. */
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
 *  capabilities are present: the background-job tools when `jobs` is given, the
 *  typed agent-tools when `agentTools` is given (broker wired), and the model
 *  self-selection tools when `models` offers more than one model. */
function buildServer(
  conversationId: string,
  agentTools?: AgentToolsWiring,
  jobs?: JobManager,
  models?: ModelToolsWiring,
  resources?: SandboxResourceToolsWiring,
): McpServer {
  const server = new McpServer({ name: "scooter-env", version: "1.0.0" });
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
  // Sandbox right-sizing: show the current cpu/memory/gpu and record a new size on
  // the broker (applied on the NEXT sandbox restart — the broker owns sizing now).
  // Registered only when the resources wiring is present (the broker path is usable).
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
      async () => handleShowSandboxResources(resources, conversationId) as Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
    );
    server.registerTool(
      "set_sandbox_resources",
      {
        title: "Resize your sandbox",
        description:
          "Change the cpu / memory / gpu (requests and/or limits) YOUR sandbox runs with. The new size is " +
          "RECORDED and takes effect on the NEXT sandbox restart — it does NOT restart the running pod, so " +
          "nothing in flight is interrupted. Scale up for a heavy build/large model; scale down when idle. " +
          "Omit a field to keep it. Quantities are k8s-style (cpu \"500m\"/\"2\", memory \"1Gi\"/\"512Mi\", " +
          "gpu a whole number).",
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
  baseUrl: string;
  path?: string;
  /** When provided, the per-conversation server exposes the five typed agent-tools
   *  (slack/gitlab/github/web). Omit to leave them off (e.g. no broker configured). */
  agentTools?: AgentToolsWiring;
  /** When provided, exposes the background-job tools (run_background /
   *  check_background / list_background). Omit to leave them off. */
  jobs?: JobManager;
  /** When provided (and >1 model is offered), exposes list_models / switch_model
   *  so the agent can pick + switch its own model. */
  models?: ModelToolsWiring;
  /** When provided, exposes show_sandbox_resources / set_sandbox_resources so the
   *  agent can right-size its own sandbox (the broker owns + applies the size). Omit
   *  to leave them off (e.g. a fake/local sandbox can't resize). */
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
      const server = buildServer(conv, deps.agentTools, deps.jobs, deps.models, deps.resources);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    },
  };
}
