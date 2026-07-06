/**
 * ACP client — drives a `goose acp` subprocess over JSON-RPC 2.0 / stdio,
 * built on the official @zed-industries/agent-client-protocol SDK.
 *
 * The agent-host is the ACP *client*; Goose is the ACP *agent*. We call agent
 * methods (initialize, session/new, session/prompt, session/cancel). Goose calls
 * our client methods (fs/*, terminal/*, session/request_permission), which we
 * service via the ExecBackend / permission handler.
 *
 * This module exposes a small `AcpClient` facade over the SDK so the bridge
 * stays decoupled from SDK types (and so tests can inject an in-process fake).
 */

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type Stream,
} from "@zed-industries/agent-client-protocol";
import type * as schema from "@zed-industries/agent-client-protocol";

import type { ExecBackend } from "../types.js";
import { createSandboxClientHandlers } from "./sandboxHandlers.js";
import { debug, debugError } from "../debug.js";

// --- Facade types (kept stable for the bridge + fake) -----------------------

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: ClientCapabilities;
}

export interface ClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean };
  terminal: boolean;
}

export interface NewSessionParams {
  cwd: string;
  mcpServers?: unknown[];
}

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string };

/** Normalized session/update variants the bridge consumes. */
export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | { sessionUpdate: "tool_call"; toolCallId: string; title: string; rawInput?: unknown }
  // rawInput/rawOutput ride the UPDATE too: goose typically sends the initial
  // tool_call with no rawInput and fills it in on a subsequent tool_call_update
  // (the command a Shell runs / the text slack_respond posts). Dropping them here
  // is why the UI showed an empty tool card. rawOutput carries the structured
  // result (e.g. the shell's stdout) when the provider supplies it.
  | { sessionUpdate: "tool_call_update"; toolCallId: string; status: string; content?: unknown; rawInput?: unknown; rawOutput?: unknown }
  | { sessionUpdate: "plan"; entries: unknown[] };

export interface PermissionRequest {
  sessionId: string;
  toolCallId: string;
  /** Human-readable summary of what's being requested (from the tool call). */
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

/** A permission handler either selects an option or cancels the request. */
export type PermissionAnswer = { optionId: string } | { cancelled: true };

export interface AcpClient {
  initialize(params: InitializeParams): Promise<{ protocolVersion: number }>;
  newSession(params: NewSessionParams): Promise<{ sessionId: string }>;
  prompt(params: PromptParams): Promise<{ stopReason: string }>;
  cancel(sessionId: string): Promise<void>;
  /** Kill every live sandbox terminal for this client (a user cancel / force-
   *  interrupt) — stops a running command, not just future ones. Best-effort. */
  killActiveTerminals(): Promise<void>;

  onSessionUpdate(cb: (sessionId: string, update: SessionUpdate) => void): () => void;
  onPermissionRequest(
    handler: (req: PermissionRequest) => Promise<PermissionAnswer>,
  ): void;

  close(): Promise<void>;
}

export interface AcpClientDeps {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Services Goose's fs/* and terminal/* client-method calls. */
  exec: ExecBackend;
}

/** Spawns `goose acp` and returns a connected ACP client. */
export async function createAcpClient(deps: AcpClientDeps): Promise<AcpClient> {
  const child = spawn(deps.command, deps.args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...deps.env },
  });

  // Adapt the child's Node stdio to the Web streams ndJsonStream expects.
  const toAgent = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const fromAgent = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream: Stream = ndJsonStream(toAgent, fromAgent);

  const updateCbs = new Set<(sessionId: string, u: SessionUpdate) => void>();
  let permissionHandler:
    | ((req: PermissionRequest) => Promise<PermissionAnswer>)
    | undefined;

  // fs/* + terminal/* handlers live in a standalone, testable factory (each call
  // gets a fresh handler set with its own unique-id-keyed terminal maps).
  const sandbox = createSandboxClientHandlers(deps.exec);

  // Our Client implementation: what Goose calls back into. sessionUpdate +
  // requestPermission need the bridge's callbacks (closures below); everything
  // else is the sandbox handlers.
  const makeClient = (_agent: Agent): Client => ({
    async sessionUpdate(params: schema.SessionNotification): Promise<void> {
      const norm = normalizeUpdate(params);
      if (norm) for (const cb of updateCbs) cb(params.sessionId, norm);
    },

    async requestPermission(
      params: schema.RequestPermissionRequest,
    ): Promise<schema.RequestPermissionResponse> {
      if (!permissionHandler) {
        // Finding #25: a permission request arrived but no handler is registered —
        // that's a HOST WIRING BUG, not a user cancel. Returning "cancelled"
        // silently makes the agent (and any UI) think the user declined. We still
        // return cancelled so the agent run doesn't hang, but log loudly so the
        // missing wiring is diagnosable instead of masquerading as a user choice.
        debugError(
          "[acp] requestPermission with NO handler registered (host wiring bug) — " +
            "returning cancelled for toolCall",
          params.toolCall.toolCallId,
        );
        return { outcome: { outcome: "cancelled" } };
      }
      const answer = await permissionHandler({
        sessionId: params.sessionId,
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title ?? "The agent needs your choice",
        options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      });
      if ("cancelled" in answer) {
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId: answer.optionId } };
    },

    readTextFile: sandbox.readTextFile,
    writeTextFile: sandbox.writeTextFile,
    createTerminal: sandbox.createTerminal,
    terminalOutput: sandbox.terminalOutput,
    waitForTerminalExit: sandbox.waitForTerminalExit,
    releaseTerminal: sandbox.releaseTerminal,
    killTerminal: sandbox.killTerminal,
  });

  const conn = new ClientSideConnection(makeClient, stream);

  await conn.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });

  return {
    async initialize(_params) {
      return { protocolVersion: 1 };
    },
    async newSession(params) {
      const res = await conn.newSession({
        cwd: params.cwd,
        // MCP servers the agent (goose) may call — e.g. the agent-host's
        // modify_environment tool. Empty when none configured.
        mcpServers: (params.mcpServers ?? []) as never,
      });
      return { sessionId: res.sessionId };
    },
    async prompt(params) {
      const res = await conn.prompt({
        sessionId: params.sessionId,
        prompt: params.prompt as schema.ContentBlock[],
      });
      return { stopReason: res.stopReason };
    },
    async cancel(sessionId) {
      await conn.cancel({ sessionId });
    },
    async killActiveTerminals() {
      await sandbox.killAllTerminals();
    },
    onSessionUpdate(cb) {
      updateCbs.add(cb);
      return () => updateCbs.delete(cb);
    },
    onPermissionRequest(handler) {
      permissionHandler = handler;
    },
    async close() {
      child.kill();
    },
  };
}

/** Maps the SDK's SessionNotification.update to our normalized SessionUpdate. */
function normalizeUpdate(params: schema.SessionNotification): SessionUpdate | undefined {
  const u = params.update;
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return { sessionUpdate: "agent_message_chunk", content: toContentBlock(u.content) };
    case "agent_thought_chunk":
      return { sessionUpdate: "agent_thought_chunk", content: toContentBlock(u.content) };
    case "tool_call":
      return {
        sessionUpdate: "tool_call",
        toolCallId: u.toolCallId,
        title: u.title,
        rawInput: u.rawInput,
      };
    case "tool_call_update":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: u.toolCallId,
        status: u.status ?? "completed",
        content: u.content,
        rawInput: u.rawInput,
        rawOutput: u.rawOutput,
      };
    case "plan":
      return { sessionUpdate: "plan", entries: u.entries ?? [] };
    default:
      return undefined; // ignore user_message_chunk, mode/command updates
  }
}

function toContentBlock(content: schema.ContentBlock): ContentBlock {
  if (content.type === "text") return { type: "text", text: content.text };
  return { type: "text", text: "" };
}
