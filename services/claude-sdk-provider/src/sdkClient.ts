/**
 * AcpClient backed by the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`),
 * for the `claude-code` provider. Drop-in for the goose-backed createAcpClient:
 * it satisfies the SAME AcpClient interface, so the bridge / SessionManager /
 * AG-UI mapping / permission flow are unchanged.
 *
 * Why: under the goose claude-code path, claude's built-in Bash/Read/Edit/Write
 * run in the agent-host pod (proven live) — so scooter-rebuild (in the sandbox)
 * was unreachable. Here we DISABLE those built-ins and redirect them (toolAliases
 * + disallowedTools) to an in-process MCP server whose tools exec via ExecBackend
 * → the SANDBOX pod. Subscription auth is preserved: the SDK spawns the same
 * `claude` CLI, authenticated with CLAUDE_CODE_OAUTH_TOKEN via options.env.
 *
 * See todo/CLAUDE_AGENT_SDK_PROVIDER.md for the full design.
 */

import type {
  AcpClient,
  InitializeParams,
  NewSessionParams,
  PromptParams,
  PermissionRequest,
  PermissionAnswer,
  SessionUpdate,
  ContentBlock,
} from "./types.js";
import type { ExecBackend } from "./types.js";
import { sdkMessageToUpdates, type SdkMessage } from "./sdkAdapter.js";
import { createSandboxMcpServer } from "./sandboxMcp.js";
import { debug, debugError } from "./debug.js";

export interface SdkAcpClientDeps {
  /** Subscription OAuth token (`claude setup-token`). Passed to the SDK as
   *  env.CLAUDE_CODE_OAUTH_TOKEN so its `claude` subprocess authenticates. */
  oauthToken: string;
  /** Model for query() (was GOOSE_MODEL). */
  model: string;
  /** Services the sandbox-routed MCP tools — the SAME ExecBackend the goose ACP
   *  handlers use, so tool calls exec in this conversation's sandbox pod. */
  exec: ExecBackend;
  /** Agent identity + skills, as the SDK systemPrompt (was goose .goosehints). */
  systemPrompt: string;
  /** Extra env for the claude subprocess (e.g. IS_SANDBOX if ever needed). */
  extraEnv?: Record<string, string>;
}

/** The minimal shape of the SDK's query() we depend on — declared locally so this
 *  module type-checks without the SDK installed (it's imported lazily at runtime). */
interface SdkQuery extends AsyncIterable<SdkMessage> {
  /** Interrupt the running turn (cancel). */
  interrupt?(): Promise<void>;
}
type SdkQueryFn = (params: { prompt: string; options: Record<string, unknown> }) => SdkQuery;

/** Flatten a ContentBlock[] prompt to the text the SDK query() takes. Images are
 *  noted inline (the SDK prompt is a string in this first cut; multimodal via the
 *  streaming-input form is a follow-up). */
function promptToText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : b.type === "resource_link" ? b.uri : ""))
    .filter(Boolean)
    .join("\n");
}

/** Map an SDK result message's terminal reason to the bridge's stopReason string
 *  (the bridge only distinguishes end_turn vs an error-ish stop). */
function resultStopReason(msg: { subtype?: string; is_error?: boolean }): string {
  if (msg.subtype === "success") return "end_turn";
  return msg.subtype ?? (msg.is_error ? "error" : "end_turn");
}

/** Spawn an SDK-backed AcpClient. */
export async function createSdkAcpClient(deps: SdkAcpClientDeps): Promise<AcpClient> {
  // Build the sandbox MCP server + the alias/disable lists ONCE per client.
  const { server, toolAliases, disallowedTools } = await createSandboxMcpServer(deps.exec);

  // Lazy import so the module graph (and unit tests) load without the SDK.
  const { query } = (await import("@anthropic-ai/claude-agent-sdk")) as { query: SdkQueryFn };

  const updateCbs = new Set<(sessionId: string, u: SessionUpdate) => void>();
  const terminalCreatedCbs = new Set<(id: string, command: string, args: string[]) => void>();
  let permissionHandler: ((req: PermissionRequest) => Promise<PermissionAnswer>) | undefined;

  let sessionId = "";
  let active: SdkQuery | undefined; // the in-flight query() for cancel()

  const baseOptions: Record<string, unknown> = {
    model: deps.model,
    systemPrompt: deps.systemPrompt,
    mcpServers: { sandbox: server },
    toolAliases,
    disallowedTools,
    // Keep the sandbox tools auto-approved at the SDK layer; the bridge's own
    // permission flow (onPermissionRequest) is the UI gate. permissionMode
    // "acceptEdits"/"default" — allow our aliased tools without a CLI prompt.
    allowedTools: Object.values(toolAliases),
    includePartialMessages: true, // stream text deltas for responsive AG-UI
    env: { CLAUDE_CODE_OAUTH_TOKEN: deps.oauthToken, ...(deps.extraEnv ?? {}) },
    // canUseTool bridges the SDK permission gate to our handler (best-effort;
    // our tools are aliased+allowed, so this mainly fires for anything unexpected).
    canUseTool: async (toolName: string, input: unknown) => {
      if (!permissionHandler) return { behavior: "allow", updatedInput: input };
      const ans = await permissionHandler({
        sessionId,
        toolCallId: toolName,
        title: toolName,
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      if ("cancelled" in ans || ans.optionId === "deny") return { behavior: "deny", message: "denied by user" };
      return { behavior: "allow", updatedInput: input };
    },
  };

  return {
    async initialize(_p: InitializeParams) {
      return { protocolVersion: 1 };
    },

    async newSession(_p: NewSessionParams) {
      // The SDK mints its own session id on first query; we return a stable handle.
      sessionId = `sdk_${Date.now()}`;
      return { sessionId };
    },

    async prompt(params: PromptParams): Promise<{ stopReason: string }> {
      const text = promptToText(params.prompt);
      debug("[sdk] prompt: query start, model=%s", deps.model);
      const q = query({ prompt: text, options: baseOptions });
      active = q;
      let stopReason = "end_turn";
      try {
        for await (const msg of q) {
          if (msg.type === "result") {
            stopReason = resultStopReason(msg as { subtype?: string; is_error?: boolean });
            continue;
          }
          for (const u of sdkMessageToUpdates(msg as SdkMessage)) {
            for (const cb of updateCbs) cb(sessionId, u);
          }
        }
      } catch (e) {
        debugError("[sdk] prompt: query stream error:", e);
        throw e;
      } finally {
        active = undefined;
      }
      debug("[sdk] prompt: stopReason=%s", stopReason);
      return { stopReason };
    },

    async cancel(_sessionId: string) {
      await active?.interrupt?.().catch(() => {});
    },

    async killActiveTerminals() {
      // The SDK owns tool execution; interrupting the query stops the running
      // tool. Sandbox terminals are ExecBackend handles released per-call.
      await active?.interrupt?.().catch(() => {});
    },

    onSessionUpdate(cb) {
      updateCbs.add(cb);
      return () => updateCbs.delete(cb);
    },

    onTerminalCreated(cb) {
      terminalCreatedCbs.add(cb);
      return () => terminalCreatedCbs.delete(cb);
    },

    onPermissionRequest(handler) {
      permissionHandler = handler;
    },

    async close() {
      await active?.interrupt?.().catch(() => {});
    },
  };
}
