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
import type { ConversationLink } from "../session/manager.js";
import { registerAgentTools, type BrokerClient, type ResourceMapping } from "./agentTools.js";

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
    return {
      content: [
        { type: "text", text: "Environment applied — the module built and switched live (registered as a new generation)." },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          "The environment change FAILED and was not applied (a bad build never switches; a bad switch auto-rolls-back). " +
          "Fix the module and try again. Error:\n" +
          (res.error ?? "unknown error"),
      },
    ],
  };
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
function buildServer(manager: ModuleManager | undefined, conversationId: string, agentTools?: AgentToolsWiring): McpServer {
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
      const server = buildServer(deps.manager, conv, deps.agentTools);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    },
  };
}
