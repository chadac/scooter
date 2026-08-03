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
import {
  handleSpawnSubagent,
  handleListSubagents,
  handleCheckSubagent,
  handleCancelSubagent,
  handleSendToSubagent,
  handleMonitorSubagent,
  handleSearchSubagent,
  type SubagentManager,
} from "./subagentTools.js";
import type { ConversationLink } from "../session/manager.js";
import { registerAgentTools, type BrokerClient, type ResourceMapping } from "./agentTools.js";
import { registerSchedulerTools, type SchedulerToolsWiring } from "./schedulerTools.js";
import { handleListModels, handleSwitchModel, type ModelToolsWiring } from "./modelTools.js";
import {
  handleShowSandboxResources,
  handleSetSandboxResources,
  type SandboxResourceToolsWiring,
} from "./resourceTools.js";
import { registerMarimoTools, type MarimoClient } from "@scooter/marimo-mcp";

/** How buildServer gets a marimo client for a conversation: the agent-host resolves
 *  the conversation's pod IP fresh (it changes across suspend/resume) and returns a
 *  client targeting podIP:2718. Omitted when no real sandbox (fake/local). */
export interface MarimoToolsWiring {
  clientFor(conversationId: string): MarimoClient | Promise<MarimoClient>;
  /** The URL to tell the user to open to start a notebook session (a marimo session
   *  only exists once a browser has the notebook open). Surfaced in the no-session
   *  message. Undefined when the public URL isn't known. */
  notebookUrlFor?(conversationId: string): string | undefined;
}

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
export async function buildServer(
  conversationId: string,
  agentTools?: AgentToolsWiring,
  jobs?: JobManager,
  models?: ModelToolsWiring,
  resources?: SandboxResourceToolsWiring,
  scheduler?: SchedulerToolsWiring,
  subagents?: SubagentManager,
  marimo?: MarimoToolsWiring,
): Promise<McpServer> {
  const server = new McpServer({ name: "scooter-env", version: "1.0.0" });
  if (marimo) {
    // Notebook tools (marimo_execute / list / cell ops) — target THIS conversation's
    // in-pod marimo. clientFor resolves the pod IP fresh each call; notebookUrlFor
    // supplies the link the no-session message tells the user to open.
    registerMarimoTools(
      server,
      () => marimo.clientFor(conversationId),
      () => ({ notebookUrl: marimo.notebookUrlFor?.(conversationId) }),
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
  if (subagents) {
    type TR = Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
    server.registerTool(
      "spawn_subagent",
      {
        title: "Spawn a subagent",
        description:
          "Delegate a task to a SUBAGENT — a second agent that shares THIS conversation's sandbox (same " +
          "/workspace files + credentials) and works in the BACKGROUND without blocking your turn. Returns a " +
          "subagent id. IMPORTANT: after spawning, END YOUR TURN (or do other work) — you'll be nudged " +
          "AUTOMATICALLY with the subagent's result the moment it finishes. Do NOT sit in a check_subagent " +
          "poll loop (that keeps you busy and delays the result). Use it to fan out independent work (research " +
          "a question, investigate a subsystem) in parallel. Note: subagents share your /workspace — avoid " +
          "having two edit the same files at once.",
        inputSchema: {
          prompt: z.string().describe("The task for the subagent (be specific; it starts fresh with no context)."),
          title: z.string().optional().describe("A short label for the subagent (shown in the UI)."),
          model: z.string().optional().describe("Override the subagent's model (defaults to yours). Call list_models to see valid ids — e.g. delegate a big/cheap task to a smaller model."),
        },
      },
      async (args) => handleSpawnSubagent(subagents, conversationId, args) as TR,
    );
    server.registerTool(
      "list_subagents",
      {
        title: "List subagents",
        description: "List the subagents you've spawned in this conversation, with their status + latest activity.",
        inputSchema: {},
      },
      async () => handleListSubagents(subagents, conversationId) as TR,
    );
    server.registerTool(
      "check_subagent",
      {
        title: "Check a subagent",
        description:
          "Report a subagent's status (running / idle / ended) + its latest activity, or its final result once " +
          "done. Only for a subagent YOU spawned here. Use it ONCE to check in — if it's still running, end " +
          "your turn (you'll be nudged with the result automatically); don't call this in a loop.",
        inputSchema: { subagent_id: z.string().describe("The id returned by spawn_subagent.") },
      },
      async (args) => handleCheckSubagent(subagents, conversationId, args) as TR,
    );
    server.registerTool(
      "cancel_subagent",
      {
        title: "Cancel a subagent",
        description:
          "Stop a subagent's current run (a task you delegated that's no longer needed or is stuck). Only " +
          "works for a subagent you spawned in this conversation.",
        inputSchema: { subagent_id: z.string().describe("The id returned by spawn_subagent.") },
      },
      async (args) => handleCancelSubagent(subagents, conversationId, args) as TR,
    );
    server.registerTool(
      "send_to_subagent",
      {
        title: "Clarify a running subagent",
        description:
          "Course-correct a subagent you see diverging: send a CLARIFICATION that interrupts its current turn " +
          "(e.g. 'focus on the login path, not signup'). It factors your note in and keeps working; its result " +
          "still returns to you automatically. Only works while the subagent is RUNNING — if it's already " +
          "finished or idle, this fails (its result already came back; use spawn_subagent for new work). Use " +
          "monitor_subagent first if you're unsure what it's doing.",
        inputSchema: {
          subagent_id: z.string().describe("The id returned by spawn_subagent."),
          message: z.string().describe("The clarification / course-correction to inject into its current turn."),
        },
      },
      async (args) => handleSendToSubagent(subagents, conversationId, args) as TR,
    );
    server.registerTool(
      "monitor_subagent",
      {
        title: "Monitor a subagent's recent activity",
        description:
          "Read a subagent's RECENT turns — its messages AND a compact summary of the tools it ran — so you can " +
          "see what it's actually doing and whether it's on track. Only for a subagent you spawned here. Use " +
          "this to decide if you need to send_to_subagent a clarification. (This is a one-shot read; don't poll " +
          "it in a loop — you'll be nudged with the result when it finishes.)",
        inputSchema: {
          subagent_id: z.string().describe("The id returned by spawn_subagent."),
          turns: z.number().optional().describe("How many recent turns to show (default 6, max 30)."),
        },
      },
      async (args) => handleMonitorSubagent(subagents, conversationId, args) as TR,
    );
    server.registerTool(
      "search_subagent",
      {
        title: "Search a subagent's history",
        description:
          "Search a subagent's FULL message history (its text + the tools it ran) for a query string — e.g. find " +
          "where it touched a file or mentioned an error. Only for a subagent you spawned here.",
        inputSchema: {
          subagent_id: z.string().describe("The id returned by spawn_subagent."),
          query: z.string().describe("Text to search for (case-insensitive)."),
        },
      },
      async (args) => handleSearchSubagent(subagents, conversationId, args) as TR,
    );
  }
  if (agentTools) {
    await registerAgentTools(
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
  if (scheduler) {
    // The agent manages its OWN scheduled tasks (scoped to this conversation's owner).
    registerSchedulerTools(server, scheduler, conversationId);
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
  /** When provided, exposes the scheduled-task tools (list/search/view/create/edit/
   *  delete) — the agent manages its OWN scheduled tasks via the scheduler service.
   *  Omit to leave them off (e.g. no scheduler deployed). */
  scheduler?: SchedulerToolsWiring;
  /** When provided, exposes the subagent tools (spawn/list/check/cancel) — the
   *  agent delegates work to child agents sharing this conversation's sandbox.
   *  Omit to leave them off. */
  subagents?: SubagentManager;
  /** When provided, exposes the marimo notebook tools (execute + cell ops), targeting
   *  the conversation's in-pod marimo. Omit for a fake/local sandbox. */
  marimo?: MarimoToolsWiring;
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
      const server = await buildServer(conv, deps.agentTools, deps.jobs, deps.models, deps.resources, deps.scheduler, deps.subagents, deps.marimo);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    },
  };
}
