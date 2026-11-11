/**
 * ACP client: drives a `goose acp` subprocess over JSON-RPC 2.0 / stdio on the
 * @zed-industries/agent-client-protocol SDK. The agent-host is the ACP client and
 * Goose the ACP agent: we call agent methods (initialize, session/new, session/prompt,
 * session/cancel) and service Goose's client methods (fs/*, terminal/*,
 * session/request_permission) via the ExecBackend and permission handler. The
 * `AcpClient` facade keeps the bridge decoupled from SDK types so tests can inject
 * an in-process fake.
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
import {
  contextUsageFromUsageUpdate,
  filterUnsupportedSessionUpdates,
  type UnsupportedSessionUpdate,
} from "./sessionUpdateFilter.js";
import { debug, debugError } from "../debug.js";
import { filterCancelRequests } from "./cancelRequestFilter.js";
import { installAcpSdkErrorLog } from "./sdkErrorLog.js";
import { logger, type Logger } from "../log.js";

const gooseLog = logger("acp");

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
  /** The model this session should run, resolved per provider by the bridge (agent/models.ts); providers that fix their model elsewhere may ignore it. */
  model?: string;
  /** Skills as data for a provider that cannot read this pod's filesystem (the BYO container,
   *  which writes them as .claude/skills); in-pod providers ignore this. */
  skills?: ReadonlyArray<{ name: string; content: string }>;
  /** The agent identity prompt for a provider that cannot read this pod's filesystem (the BYO
   *  container, whose SDK has no prompt of its own); in-pod providers build theirs locally. */
  systemPrompt?: string;
  /** Agent tools that block on the user's answer (contribs' `agent.blockingTools`), for a provider that
   *  runs the tools itself (the Claude SDK); others ignore this. */
  blockingTools?: Record<string, BlockingTool>;
}

/** One tool that waits on the user: its input is sent as a request of `kind`. */
export interface BlockingTool {
  kind: string;
  /** The request's heading. */
  title: string;
  /** What the model is told when the user dismisses it. */
  dismissed: string;
}

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string }
  // A base64 image the model can see (the ACP native image block).
  | { type: "image"; data: string; mimeType: string };

/** Normalized session/update variants the bridge consumes. */
export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | { sessionUpdate: "tool_call"; toolCallId: string; title: string; rawInput?: unknown }
  // rawInput/rawOutput ride the update too, since goose typically sends the initial
  // tool_call without rawInput and fills it in on a later tool_call_update.
  | { sessionUpdate: "tool_call_update"; toolCallId: string; status: string; content?: unknown; rawInput?: unknown; rawOutput?: unknown }
  | { sessionUpdate: "plan"; entries: unknown[] }
  // Context-window fill after a turn, which drives the UI fill bar.
  | { sessionUpdate: "context_usage"; usedTokens: number; contextWindow: number };

export interface PermissionRequest {
  sessionId: string;
  toolCallId: string;
  /** Human-readable summary of what is being requested, from the tool call. */
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  /** Set when the agent asks for input a contrib renders (AskUserQuestion is `ask-user.questions`) rather than a plain choice. */
  request?: InterruptRequest;
}

/** A contrib-rendered request: `kind` picks the UI card, and `data` reaches it as the agent sent it. */
export interface InterruptRequest {
  kind: string;
  data: unknown;
}

/** The ACP `_meta` keys that carry a request's kind and data, and the user's result back. */
export const ACP_INTERRUPT_META = "scooter.dev/interrupt";
export const ACP_INTERRUPT_RESULT_META = "scooter.dev/interrupt-result";

/** The request an ACP permission request's `_meta` carries, or undefined for a plain choice. */
export function metaRequest(meta: unknown): InterruptRequest | undefined {
  const m = meta as Record<string, { kind?: unknown; data?: unknown } | undefined> | null | undefined;
  const raw = m?.[ACP_INTERRUPT_META];
  return typeof raw?.kind === "string" && raw.kind ? { kind: raw.kind, data: raw.data } : undefined;
}

/** A permission handler selects an option or cancels; `result` is the user's answer to a contrib-rendered request. */
export type PermissionAnswer = { optionId: string; result?: Record<string, unknown> } | { cancelled: true };

export interface AcpClient {
  initialize(params: InitializeParams): Promise<{ protocolVersion: number }>;
  newSession(params: NewSessionParams): Promise<{ sessionId: string }>;
  prompt(params: PromptParams): Promise<{ stopReason: string }>;
  cancel(sessionId: string): Promise<void>;
  /** Best-effort kill of every live sandbox terminal for this client, stopping a running command rather than only future ones.
   *  `sessionId` scopes the kill on a client that multiplexes several conversations (a BYOC container). */
  killActiveTerminals(graceForPendingSpawn?: boolean, sessionId?: string): Promise<void>;

  /** Liveness of the underlying agent process, false once it has exited; the bridge's stall watchdog uses it to tell a dead agent from a long-running tool. */
  isAlive(): boolean;

  /** The agent's most recent diagnostic lines (oldest first), the only record of why a run that never spoke died. */
  recentDiagnostics?(): string[];

  onSessionUpdate(cb: (sessionId: string, update: SessionUpdate) => void): () => void;
  /** Notified when goose creates a terminal to run a shell command, the only place the command text is available. */
  onTerminalCreated(cb: (terminalId: string, command: string, args: string[]) => void): () => void;
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
  /** Back-pressure: when set, goose runs with GOOSE_MODE=approve and each per-tool permission request is auto-answered, allowed normally but rejected when this returns true so goose ends the turn and the queued item injects. */
  shouldYield?: () => boolean;
  /** PreToolUse hooks at the tool gate; a returned reason rejects. */
  gateTool?: (call: { toolCallId: string; title: string; rawInput: unknown }) => Promise<string | undefined>;
  /** Transcript recorder for the test harness, called with each normalized ACP session/update goose sends. */
  recordRaw?: (update: SessionUpdate) => void;
}

/** A request is an auto-answerable tool gate only when it offers both an allow-kind and a reject-kind option; an agent-presented choice must reach the UI. */
export function isToolGate(options: ReadonlyArray<{ kind: string }>): boolean {
  const hasAllow = options.some((o) => o.kind === "allow_once" || o.kind === "allow_always");
  const hasReject = options.some((o) => o.kind === "reject_once" || o.kind === "reject_always");
  return hasAllow && hasReject;
}

/** Auto-answer a goose approve-mode permission request, rejecting when `yield_` is true and allowing otherwise, or undefined when this is not a tool gate so the caller falls through to the UI. */
export function autoAnswerPermission(
  options: ReadonlyArray<{ optionId: string; kind: string }>,
  yield_: boolean,
): schema.RequestPermissionResponse | undefined {
  if (options.length === 0) return undefined;
  // Anything the agent presents for the user to choose falls through so the interrupt reaches the UI.
  if (!isToolGate(options)) return undefined;
  const pick = (kinds: string[]) => options.find((o) => kinds.includes(o.kind))?.optionId;
  if (yield_) {
    const reject = pick(["reject_once", "reject_always"]) ?? options[options.length - 1].optionId;
    return { outcome: { outcome: "selected", optionId: reject } };
  }
  const allow = pick(["allow_once", "allow_always"]) ?? options[0].optionId;
  return { outcome: { outcome: "selected", optionId: allow } };
}

/** Answer goose's tool gate from hooks and back-pressure, else undefined. */
export async function answerToolGate(
  params: { options: ReadonlyArray<{ optionId: string; kind: string }>; toolCall: { toolCallId: string; title?: string | null; rawInput?: unknown } },
  deps: Pick<AcpClientDeps, "gateTool" | "shouldYield">,
): Promise<schema.RequestPermissionResponse | undefined> {
  if (!isToolGate(params.options)) return undefined;
  if (deps.gateTool) {
    const deny = await deps
      .gateTool({ toolCallId: params.toolCall.toolCallId, title: params.toolCall.title ?? "", rawInput: params.toolCall.rawInput })
      .catch(() => undefined);
    return autoAnswerPermission(params.options, deny !== undefined || (deps.shouldYield?.() ?? false));
  }
  return deps.shouldYield ? autoAnswerPermission(params.options, deps.shouldYield()) : undefined;
}

/** Handle a session/update the SDK could not parse: `usage_update` is salvaged as `context_usage`, and every other variant is logged once per variant by the returned stateful handler. */
export function handleDroppedSessionUpdate(deps: {
  emit: (sessionId: string, update: SessionUpdate) => void;
  log: (message: string) => void;
}): (dropped: UnsupportedSessionUpdate) => void {
  const seen = new Set<string>();
  return (dropped) => {
    const usage = contextUsageFromUsageUpdate(dropped);
    if (usage) {
      deps.emit(dropped.sessionId, { sessionUpdate: "context_usage", ...usage });
      return;
    }
    if (seen.has(dropped.variant)) return;
    seen.add(dropped.variant);
    deps.log(`[acp] ignoring session/update variant the SDK cannot parse: ${dropped.variant}`);
  };
}

/** Spawns `goose acp` and returns a connected ACP client. */
export async function createAcpClient(deps: AcpClientDeps): Promise<AcpClient> {
  // stdout is the ACP ndjson channel; stderr carries goose's own diagnostics and a spawned
  // `claude` CLI's failures, so it is piped rather than lost.
  const child = spawn(deps.command, deps.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...deps.env },
  });

  // Ring buffer of the last stderr lines, attached to the exit log so a crash shows its cause.
  const stderrTail: string[] = [];
  const STDERR_TAIL_MAX = 50;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (!line) continue;
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_MAX) stderrTail.shift();
      // Under DEBUG, stream stderr live.
      debug(`[goose:stderr] ${line}`);
    }
  });

  // A spawn error or a non-zero exit is almost always the real cause behind an "agent
  // terminated unexpectedly", so always surface it with the stderr tail.
  child.on("error", (err) => {
    debugError(`[acp] goose spawn error (command="${deps.command}"):`, err);
  });
  // Set by close(), so its SIGTERM isn't logged as a crash.
  let stopping = false;
  child.on("exit", (code, signal) => {
    logGooseExit(gooseLog, { code, signal, stopping, stderrTail });
  });

  // Adapt the child's Node stdio to the Web streams ndJsonStream expects.
  const toAgent = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const fromAgent = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const rawStream: Stream = ndJsonStream(toAgent, fromAgent);

  const updateCbs = new Set<(sessionId: string, u: SessionUpdate) => void>();
  const terminalCreatedCbs = new Set<(terminalId: string, command: string, args: string[]) => void>();
  let permissionHandler:
    | ((req: PermissionRequest) => Promise<PermissionAnswer>)
    | undefined;

  // fs/* and terminal/* handlers come from a standalone factory; terminal-create is
  // forwarded to subscribers so the bridge can surface the command as the tool call's args.
  const sandbox = createSandboxClientHandlers(deps.exec, (terminalId, command, args) => {
    for (const cb of terminalCreatedCbs) cb(terminalId, command, args);
  });

  // The Client implementation Goose calls back into.
  const makeClient = (_agent: Agent): Client => ({
    async sessionUpdate(params: schema.SessionNotification): Promise<void> {
      const norm = normalizeUpdate(params);
      if (norm) {
        // Record the normalized update for the transcript harness.
        deps.recordRaw?.(norm);
        for (const cb of updateCbs) cb(params.sessionId, norm);
      }
    },

    async requestPermission(
      params: schema.RequestPermissionRequest,
    ): Promise<schema.RequestPermissionResponse> {
      // An agent-presented choice falls through to the UI handler.
      const auto = await answerToolGate(params, deps);
      if (auto) return auto;
      if (!permissionHandler) {
        // No handler is a host wiring bug, not a user cancel; still answer cancelled so
        // the run does not hang, but log loudly.
        debugError(
          "[acp] requestPermission with NO handler registered (host wiring bug) — " +
            "returning cancelled for toolCall",
          params.toolCall.toolCallId,
        );
        return { outcome: { outcome: "cancelled" } };
      }
      const request = metaRequest(params._meta);
      const answer = await permissionHandler({
        sessionId: params.sessionId,
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title ?? "The agent needs your choice",
        options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
        ...(request ? { request } : {}),
      });
      if ("cancelled" in answer) {
        return { outcome: { outcome: "cancelled" } };
      }
      return {
        outcome: { outcome: "selected", optionId: answer.optionId },
        ...(answer.result ? { _meta: { [ACP_INTERRUPT_RESULT_META]: answer.result } } : {}),
      };
    },

    readTextFile: sandbox.readTextFile,
    writeTextFile: sandbox.writeTextFile,
    createTerminal: sandbox.createTerminal,
    terminalOutput: sandbox.terminalOutput,
    waitForTerminalExit: sandbox.waitForTerminalExit,
    releaseTerminal: sandbox.releaseTerminal,
    killTerminal: sandbox.killTerminal,
  });

  // Strip session/update variants the pinned SDK's closed zod union would reject with
  // -32602, salvaging the ones we can use on the way past.
  const stream = filterUnsupportedSessionUpdates(
    filterCancelRequests(rawStream, (requestId) =>
      debug(`[acp] agent cancelled request ${String(requestId)}`),
    ),
    handleDroppedSessionUpdate({
      emit: (sessionId, norm) => {
        deps.recordRaw?.(norm);
        for (const cb of updateCbs) cb(sessionId, norm);
      },
      log: debug,
    }),
  );

  installAcpSdkErrorLog();
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
        // MCP servers the agent may call; empty when none are configured.
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
    async killActiveTerminals(graceForPendingSpawn = false) {
      await sandbox.killAllTerminals(graceForPendingSpawn);
    },
    isAlive() {
      // A ChildProcess reports exitCode/signalCode === null while running.
      return child.exitCode === null && child.signalCode === null;
    },
    recentDiagnostics() {
      return [...stderrTail];
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
      stopping = true;
      await closeChild(child);
    },
  };
}

/** Log a goose exit: error for a crash, info for a stop close() asked for. */
export function logGooseExit(
  log: Pick<Logger, "debug" | "info" | "error">,
  exit: { code: number | null; signal: NodeJS.Signals | null; stopping: boolean; stderrTail: readonly string[] },
): void {
  const { code, signal, stopping } = exit;
  if (code === 0) {
    log.debug("goose exited cleanly", { code });
    return;
  }
  if (code === null && stopping) {
    log.info("goose stopped", { signal });
    return;
  }
  // Tail as a field keeps each exit one log event.
  log.error("goose exited unexpectedly", { code, signal, stopping, stderr_tail: exit.stderrTail });
}

/** Minimal shape of a child process `closeChild` needs (testable without spawning). */
export interface KillableChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", cb: () => void): void;
}

/** Terminate the goose child with SIGTERM (SIGKILL after `graceMs`) and resolve only once it has actually exited, so a model switch never has two goose processes sharing the conversation cwd. */
export function closeChild(child: KillableChild, graceMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(); // already dead
  return new Promise<void>((resolve) => {
    let killTimer: ReturnType<typeof setTimeout>;
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    (killTimer as { unref?: () => void }).unref?.();
  });
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
  // An inline image reaches the bridge intact; it stores the bytes and logs a reference.
  if (content.type === "image") return { type: "image", data: content.data, mimeType: content.mimeType };
  return { type: "text", text: "" };
}
