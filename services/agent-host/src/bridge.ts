/**
 * ACP <-> AG-UI bridge — the core of the agent-host.
 *
 * Maps ACP session/update notifications to AG-UI events and routes ACP client
 * methods (terminal/*, fs/*, session/request_permission) to the ExecBackend and
 * the permission UI.
 */

import { skillPayloads, skillsFingerprint, sdkPrompt, type Skill } from "./agent/skills.js";
import { randomUUID } from "node:crypto";

import type {
  SessionId,
  RunId,
  ThreadId,
  SessionConfig,
  ExecBackend,
} from "./types.js";
import type { AcpClient, SessionUpdate, ContentBlock, InterruptRequest } from "./acp/client.js";
import {
  pickAcpProvider,
  type AcpProvider,
  type RunContext,
} from "./acp/provider.js";
import type { Recorder } from "./transcript/recorder.js";
import { debug } from "./debug.js";
import { createTitleExtractor } from "./agent/titleMarker.js";
import { buildHistoryPreamble } from "./agent/transcript.js";
import { modelAllowedFor, defaultFor, type ModelCatalog } from "./agent/models.js";
import { fingerprintOffered, type OfferedMcpServer } from "./agent/mcpServerRegistry.js";

import { formatError, logger } from "./log.js";
import type { HookEvent, HookOutcome, HookRunner } from "./hooks/types.js";
import { inlineImage, replaceInlineImages, toImageRef, type StageAsset } from "./session/mediaRefs.js";

const log = logger("bridge");

/** Where user-attached binary files are materialized inside the sandbox; the prompt
 *  gets a note listing the saved paths. */
export const UPLOADS_DIR = "/workspace/uploads";

/** Sanitize an attachment filename to a safe basename so a hostile `name` cannot escape its directory. */
export function safeUploadName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  // Drop leading dots and anything outside a conservative character set.
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned || "file";
}

/** Write a base64 file to `dir`/<sanitized name> in the sandbox; returns the path. */
export async function writeSandboxFile(exec: ExecBackend, dir: string, file: { name: string; data: string }): Promise<string> {
  const name = safeUploadName(file.name);
  const path = `${dir}/${name}`;
  await exec.writeBinaryFile(path, file.data);
  return path;
}

/** Write one base64 file attachment into the sandbox at UPLOADS_DIR/<name>. */
async function writeUploadedFile(exec: ExecBackend, file: { name: string; data: string }): Promise<string> {
  return writeSandboxFile(exec, UPLOADS_DIR, file);
}

/** The note appended to the prompt listing where uploaded files were saved. */
export function buildFileNote(paths: string[]): string {
  return "The following file attachment(s) have been saved into your sandbox:\n" + paths.map((p) => `- ${p}`).join("\n");
}

/** An AG-UI interrupt: a point where the run pauses for a user response, with the
 *  choices the UI renders in `metadata.options`. */
export interface AguiInterrupt {
  id: string;
  /** "confirmation" | "input_required" | "tool_call" | custom. */
  reason: string;
  message?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

/** RUN_FINISHED outcome: a normal success, or an interrupt awaiting a response. */
export type AguiRunOutcome =
  | { type: "success" }
  | { type: "interrupt"; interrupts: AguiInterrupt[] };

// AG-UI event union (the subset used here); `ts` is the emit-time epoch-ms ordering
// key, absent on synthetic events.
export type AguiEvent = AguiEventBase & { ts?: number };

type AguiEventBase =
  // RUN_STARTED and RUN_FINISHED require threadId per the AG-UI schema; `host`/`gen`
  // identify which pod and generation started the run, so a reader can tell a live
  // run from one stranded by a previous host.
  | { type: "RUN_STARTED"; threadId: ThreadId; runId: RunId; host?: string; gen?: number }
  | {
      type: "RUN_FINISHED";
      threadId: ThreadId;
      runId: RunId;
      result?: unknown;
      /** With type "interrupt", the run paused awaiting a user response, resumed via
       *  the next run's RunAgentInput.resume[]. */
      outcome?: AguiRunOutcome;
      /** The run was stopped by the user or a priority force-interrupt: a clean end,
       *  not an error. */
      cancelled?: boolean;
      /** Synthesized by the adopting pod for a run whose owner was fenced mid-run, so
       *  the UI stops reading it as in-flight. */
      interrupted?: boolean;
    }
  | { type: "RUN_ERROR"; message: string; code?: string }
  // Emitted when a run failed transiently and the pump is about to retry the same batch after
  // `delayMs`; not a terminal event.
  | { type: "RUN_RETRYING"; threadId: ThreadId; attempt: number; max: number; delayMs: number; code?: string }
  // A user Stop persists this before the kill takes effect, so a later owner's
  // dangling-run check terminates the run instead of resuming it.
  | { type: "CANCEL_REQUESTED"; threadId: ThreadId; runId: RunId }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" | "user" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string }
  | { type: "TOOL_CALL_RESULT"; toolCallId: string; messageId: string; content: string }
  // AG-UI reasoning sequence: START -> MESSAGE_START -> MESSAGE_CONTENT(s) -> MESSAGE_END -> END.
  | { type: "REASONING_START"; messageId: string }
  | { type: "REASONING_MESSAGE_START"; messageId: string; role: "reasoning" }
  | { type: "REASONING_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "REASONING_MESSAGE_END"; messageId: string }
  | { type: "REASONING_END"; messageId: string }
  // Emitted once a permission/option request is answered or cancelled, so a replaying
  // UI knows it is settled and which option was chosen.
  | { type: "PERMISSION_RESOLVED"; toolCallId: string; optionId: string | null }
  // A latest-wins snapshot of the run queue's pending items, persisted and broadcast
  // so queued messages survive a refresh.
  | { type: "QUEUE_UPDATED"; items: Array<{ id: string; text: string; priority: number; interrupt?: InterruptPolicy; source?: string }> }
  // Image references (assetId + url, never bytes) attached to a user or assistant message,
  // keyed to the messageId they follow. Several events for one messageId accumulate.
  | {
      type: "MESSAGE_IMAGES";
      messageId: string;
      images: Array<{ assetId: string; mimeType: string; url: string }>;
    }
  // Context-window fill after a turn, for the UI's context-fill bar.
  | { type: "CONTEXT_USAGE"; usedTokens: number; contextWindow: number }
  // A compaction boundary: the turns before it are summarized in `summary`, and
  // loadHistory seeds a revived session from the summary plus the events after the
  // latest marker.
  | { type: "COMPACTION_MARKER"; summary: string; summarizedTurns: number; keptRuns: number }
  // A platform-injected message (webhook, scheduler, background job, broker, nudge)
  // persisted instead of a role:user message so the UI can collapse it; `source`
  // tags the origin.
  | { type: "SYSTEM_MESSAGE"; messageId: string; source: string; text: string; sender?: string; level?: number };

/** Who sent an inbound message: an `identities` row id, and how close they are to the
 *  conversation (0 closest, 100 unknown). */
export interface MessageSender {
  id: string;
  level: number;
}

/** The decoration prepended to a system message so the agent treats it as a platform
 *  event rather than a human turn. */
export function decorateSystemMessage(source: string, text: string): string {
  return (
    `[System message${source ? ` from ${source}` : ""} — this is an automated platform ` +
    `event, not the user speaking. Act on it if relevant to your task; do NOT reply to ` +
    `the user just to acknowledge it.]\n\n${text}`
  );
}

/** A provider's ACP session and what it has seen. */
interface ReadySession {
  client: AcpClient;
  acpSessionId: string;
  mcpFingerprint: string;
  /** Skills the session started with, compared every run. */
  skillsFingerprint: string;
  /** Shown the conversation's history at least once. */
  historySeeded: boolean;
  /** SessionStart hooks have run for this session. */
  sessionStartFired?: boolean;
  /** Last run served; later events were missed. */
  lastRunId?: RunId;
}

/** Events after `runId`'s last event, or all when absent. */
export function eventsAfterRun(events: AguiEvent[], runId: RunId | undefined): AguiEvent[] {
  if (runId === undefined) return events;
  for (let i = events.length - 1; i >= 0; i--) {
    if ((events[i] as { runId?: string }).runId === runId) return events.slice(i + 1);
  }
  // Run not in the log: replay everything.
  return events;
}

/** Rewrite a known raw agent/API error (context overflow) into a clearer user-facing
 *  message; anything unrecognized passes through. */
export function clarifyRunError(raw: string): string {
  const m = raw.toLowerCase();
  const contextOverflow =
    m.includes("context_length_exceeded") ||
    m.includes("prompt is too long") ||
    m.includes("too many tokens") ||
    (m.includes("context") && (m.includes("exceed") || m.includes("too long") || m.includes("maximum")));
  if (contextOverflow) {
    return "This conversation is too long — its context window is full and couldn't be compacted further. Start a new chat to continue.";
  }
  return raw;
}

/** Longest provider diagnostic we paste into a user-facing RUN_ERROR. */
const DIAGNOSTIC_MAX = 300;

/** Pick the stderr line that explains a run which produced nothing, preferring
 *  `[ede_diagnostic]` (the stalled-permission-prompt signature) over a generic error line. */
export function providerDiagnostic(lines: readonly string[] | undefined): string | undefined {
  if (!lines?.length) return undefined;
  const clean = lines.map((l) => l.trim()).filter(Boolean);
  const pick =
    [...clean].reverse().find((l) => l.includes("ede_diagnostic")) ??
    [...clean].reverse().find((l) => /error|fail|refus|denied/i.test(l));
  if (!pick) return undefined;
  return pick.length > DIAGNOSTIC_MAX ? `${pick.slice(0, DIAGNOSTIC_MAX)}…` : pick;
}

/** The user-facing text for a dead-on-arrival run, naming the candidate causes since
 *  `no_activity_timeout` has several. */
export function deadOnArrivalMessage(diagnostic?: string): string {
  return (
    "The agent didn't respond — it started but produced nothing. This has several " +
    "possible causes: a sandbox/platform version skew (the sandbox pod is running an " +
    "image from before the last upgrade), a model or credential error (e.g. the " +
    "Bedrock role can't be assumed), or the agent stalling on a tool permission " +
    "prompt nobody can answer. " +
    (diagnostic ? `The agent's last diagnostic was: ${diagnostic}. ` : "") +
    "Try again; if it persists, check the agent-host logs."
  );
}

/** An image attached to a user prompt, resolved to base64 from the AssetStore when the
 *  ACP image block is built. */
export interface PromptImage {
  assetId: string;
  mimeType: string;
}

/** A binary file attached to a user prompt, materialized into the sandbox at
 *  /workspace/uploads/<name> rather than sent as an ACP content block. */
export interface PromptFile {
  name: string;
  /** base64-encoded bytes. */
  data: string;
  mimeType: string;
}

/** A user prompt entering the run (maps to ACP session/prompt). */
export interface PromptInput {
  threadId: ThreadId;
  text: string;
  /** Images the user attached, resolved to ACP image blocks when the run prompts. */
  images?: PromptImage[];
  /** Binary file attachments, written to /workspace/uploads/<name> in the sandbox when the run prompts. */
  files?: PromptFile[];
  /** Set when the platform injected this prompt: the agent receives a system-message
   *  decoration and the turn persists as a SYSTEM_MESSAGE event. */
  source?: string;
  /** Who sent a sourced prompt, recorded on its SYSTEM_MESSAGE. */
  sender?: MessageSender;
  /** The inherited trigger, passed to RunContext.humanInitiated. */
  humanInitiated?: boolean;
}

/** How a priority prompt preempts the running turn: "timeout" waits priorityInterruptMs
 *  then cancels, "thinking" cancels at the next tool-call boundary, and "tool-call"
 *  cancels immediately. */
export type InterruptPolicy = "timeout" | "thinking" | "tool-call";

/** Per-prompt options for the bridge's run queue. */
export interface PromptOptions {
  /** Higher runs sooner among queued items, and a priority prompt (>0) may also
   *  force-interrupt the running turn (default 0). */
  priority?: number;
  /** How a priority prompt preempts the running turn (default "thinking"). */
  interrupt?: InterruptPolicy;
}

/** Normal (waits its turn) vs. priority (may force-interrupt) prompt levels. */
export const PRIORITY_NORMAL = 0;
export const PRIORITY_INTERRUPT = 10;

/** The identity of the human answering an external interrupt, sent to the broker for
 *  authorization. */
export interface ApproverIdentity {
  id: string;
  email?: string;
  name?: string;
}

/**
 * Drives one ACP session and emits AG-UI events.
 *
 * Lifecycle:
 *   start()    -> ACP initialize + session/new
 *   prompt()   -> ACP session/prompt, stream AG-UI events via onEvent
 *   cancel()   -> ACP session/cancel
 *   stop()     -> tear down the agent
 */
export interface SessionBridge {
  readonly sessionId: SessionId;

  start(): Promise<void>;
  prompt(input: PromptInput, opts?: PromptOptions): Promise<RunId>;
  /** Cancel the running turn (omitted `runId` means whatever is active), ending it as a
   *  cancelled RUN_FINISHED without dropping queued prompts; `userInitiated` marks a real
   *  Stop press, which gets a grace window for a terminal that has not spawned yet. */
  cancel(runId?: RunId, userInitiated?: boolean): Promise<void>;
  stop(): Promise<void>;
  /** Snapshot of the run queue for observability and the force-interrupt timer. */
  queueState(): { running: boolean; currentRunMs: number; queued: number; maxQueuedPriority: number };

  /** Remove every queued item and return it for persistence across a bridge teardown,
   *  rejecting each drained prompt() and emitting a clearing QUEUE_UPDATED. */
  drainQueue(): Array<{ text: string; priority: number; source?: string; sender?: MessageSender; humanInitiated?: boolean }>;

  /** True when a PRIORITY_INTERRUPT item is waiting, which tells a provider's pre-tool
   *  gate to deny the next tool so the run quiesces to a boundary. */
  shouldYieldToQueue(): boolean;

  /** Run tool hooks in this run; `defer` saves feedback for turn end. */
  runToolHook(
    event: "PreToolUse" | "PostToolUse",
    toolName: string,
    toolInput: unknown,
    extra?: Record<string, unknown>,
    defer?: boolean,
  ): Promise<HookOutcome>;

  /** Record one raw agent-input frame under the current run for the transcript recorder
   *  (a no-op when recording is off). */
  recordRawInput(data: unknown): void;

  /** Answer a pending permission/option request, returning true if one matched; an
   *  unknown optionId cancels, and `approver` identifies the answering human for an
   *  external interrupt; `result` is the user's answer to a contrib-rendered request. */
  answerPermission(
    toolCallId: string,
    optionId: string,
    approver?: ApproverIdentity,
    result?: Record<string, unknown>,
  ): boolean;

  /** Raise an AG-UI interrupt not tied to an agent run; `onAnswer` fires with the chosen
   *  optionId (or null) and the answering user's identity. */
  raiseInterrupt(args: {
    id: string;
    message: string;
    options: Array<{ optionId: string; name: string; kind: string }>;
    onAnswer: (optionId: string | null, approver?: ApproverIdentity) => void;
    /** Extra metadata merged into the emitted interrupt alongside `options`. */
    metadata?: Record<string, unknown>;
  }): void;

  /** Settle an external interrupt unanswered; false if none is pending. */
  withdrawInterrupt(id: string): boolean;

  /** Subscribe to the AG-UI event stream broadcast to the UI (live). */
  onEvent(cb: (event: AguiEvent) => void): () => void;
  /** Subscribe to events that are persisted but not broadcast live, such as the user's
   *  own prompt. */
  onPersist(cb: (event: AguiEvent) => void): () => void;
  /** Subscribe to the agent-assigned title, extracted from a <title>…</title> marker in
   *  the message stream. */
  onTitle(cb: (title: string) => void): () => void;
}

export interface BridgeDeps {
  config: SessionConfig;
  exec: ExecBackend;
  /** The conversation (thread) this bridge serves. Providers mint the scooter-env token and
   *  open the BYO tunnel for it, and MCP tools look the conversation up by it, so it must be
   *  the real thread id, never the bridge's own `sess-` id (unset only in unit tests). */
  conversationId?: string;
  /** This pod's name, stamped onto RUN_STARTED so a reader can tell a run started here
   *  from one stranded by another host. */
  selfPod?: string;
  /** The generation this pod owns the conversation at, resolved per run so a mid-session
   *  reassignment stamps the epoch the run actually started under. */
  generation?: () => number | undefined;
  /** The conversation's chosen model, applied to a run only when that run's provider
   *  offers it (else the provider's default). */
  model?: string;
  /** The conversation's explicitly picked provider; outranks priority. */
  pickedProvider?: string;
  /** The deployment's model catalog (GET /models), needed for per-provider resolution; absent
   *  means every provider gets the conversation model as-is. */
  modelCatalog?: ModelCatalog;
  /** The ACP client, or an async factory that creates one on first start(), wrapped into a
   *  one-entry provider registry; mutually exclusive with `acpProviders`. */
  acpClient?: AcpClient | (() => Promise<AcpClient>);

  /** A capability-tagged provider registry resolved per run from its RunContext (owner +
   *  source); takes precedence over `acpClient`. */
  acpProviders?: readonly AcpProvider[];

  /** The MCP servers to offer a new session, resolved fresh per run and fingerprinted so a
   *  changed set drops the cached agent session (absent = the static `config.mcpServers`). */
  resolveMcpServers?: (conversationId: string) => Promise<OfferedMcpServer[]>;

  /** The conversation owner, part of the per-run RunContext an owner-bound provider selects on. */
  owner?: string;
  /** The owner's personal skills, re-read every run. */
  personalSkills?: () => Promise<readonly Skill[]>;

  /** Run-completion hook for metrics, called once per run with the ACP session id, duration
   *  and outcome; must not throw. */
  onRunComplete?: (info: { acpSessionId?: string; durationMs: number; outcome: "ok" | "error" }) => void;

  /** Returns the persisted AG-UI events (before the current turn) so a fresh session's first
   *  prompt is prefixed with a transcript of prior turns. */
  loadHistory?: () => Promise<AguiEvent[]>;

  /** Resolve an attached image's bytes from the AssetStore, or null for an unknown asset;
   *  absent, image parts are ignored. */
  readAsset?: (assetId: string) => Promise<{ data: Buffer; mimeType: string } | null>;

  /** Store an image the agent or a tool produced and return its reference, so events carry
   *  an assetId and url instead of base64; absent, such images are dropped to a marker. */
  stageAsset?: StageAsset;

  /** How long (ms) a queued priority prompt waits while a run is active before the running
   *  turn is cancelled (0, the default, disables it). */
  priorityInterruptMs?: number;

  /** Dead-on-arrival watchdog: a run that emits no ACP activity within this many ms is
   *  cancelled with a RUN_ERROR, and the first update disarms it (default 60_000; 0 disables). */
  firstActivityTimeoutMs?: number;

  /** Liveness probe cadence for a run in flight: the run is force-terminated only when
   *  `acpClient.isAlive()` reports the agent process dead, never on silence alone
   *  (default 30_000; 0 disables). */
  livenessProbeMs?: number;
  /** Auto-retry budget for a transiently failed run: up to `deathRetryMax` tries with
   *  `deathRetryBaseMs`·2ⁿ backoff capped at `deathRetryCapMs` (defaults 5 / 500ms / 30_000ms). */
  deathRetryMax?: number;
  deathRetryBaseMs?: number;
  deathRetryCapMs?: number;

  /** Transcript recorder for the test harness, recording raw agent input and emitted AG-UI
   *  events correlated by runId; `provider` labels the agent. */
  recorder?: Recorder;
  provider?: "goose" | "claude";

  /** This conversation's deployment hooks. */
  hooks?: HookRunner;
  /** Stop-hook continuations allowed per turn (default 3). */
  maxStopBlocks?: number;
  /** The spawning conversation when this is a subagent. */
  parentId?: () => string | undefined;
  /** Whether the conversation is unnamed, for `when: untitled` hooks; read each stop. */
  untitled?: () => boolean;
}

// Event ids must stay unique across agent-host restarts, so each is a UUID with a
// readable prefix.
const nextId = (prefix: string) => `${prefix}-${randomUUID()}`;

/** The largest request data the bridge forwards to the UI, serialized. */
const MAX_REQUEST_DATA_BYTES = 64 * 1024;

/** `req` when its data is small enough to forward, else undefined, which draws the plain option card. */
function boundedRequest(req: InterruptRequest | undefined): InterruptRequest | undefined {
  if (!req) return undefined;
  try {
    if ((JSON.stringify(req.data ?? null) ?? "").length <= MAX_REQUEST_DATA_BYTES) return req;
  } catch {
    /* unserializable data is dropped like oversized data */
  }
  log.warn("dropping an interrupt request's data: too large or unserializable", { kind: req.kind });
  return undefined;
}

export function createSessionBridge(deps: BridgeDeps): SessionBridge {
  const sessionId = nextId("sess");
  /** The conversation this bridge serves; distinct from `sessionId`, the bridge's own id. */
  const conversationId = (deps.conversationId ?? sessionId) as SessionId;
  const listeners = new Set<(event: AguiEvent) => void>();
  let acpSessionId: string | undefined;
  /** The provider serving the current run; provider+session is the true session identity
   *  since providers mint ids independently. */
  let currentProviderId = "";
  /** The session this run resolved to. */
  let currentReady: ReadySession | undefined;
  /** Goose runs need the bridge to fire tool hooks. */
  let currentProviderKind: AcpProvider["kind"] | undefined;
  /** The session that served the previous run. */
  let lastRunReady: ReadySession | undefined;
  let started = false;
  // The run queue: a bridge has one agent session, so runs are serialized through an
  // inspectable queue that orders by priority and can force-interrupt the current run,
  // and each run fully completes (text closed, RUN_FINISHED emitted) before the next
  // RUN_STARTED.
  interface QueueItem {
    /** Stable id so the UI can keep a queued bubble stable across QUEUE_UPDATED snapshots. */
    id: string;
    input: PromptInput;
    priority: number;
    /** How this item preempts the running turn (only meaningful when priority>0). */
    interrupt: InterruptPolicy;
    enqueuedAt: number;
    resolve: (runId: RunId) => void;
    reject: (err: unknown) => void;
  }
  const queue: QueueItem[] = [];

  // Broadcast and persist a snapshot of the queued items, ordered highest-priority then
  // FIFO, on every enqueue and drain.
  const emitQueueSnapshot = () => {
    const items = [...queue]
      .sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt)
      .map((q) => ({
        id: q.id,
        text: q.input.text,
        priority: q.priority,
        // The UI styles a tool-killing interrupt differently from one that waits for tools.
        ...(q.priority >= PRIORITY_INTERRUPT ? { interrupt: q.interrupt } : {}),
        // A platform-injected item renders as a collapsed system line, not a user bubble.
        ...(q.input.source ? { source: q.input.source } : {}),
      }));
    emit({ type: "QUEUE_UPDATED", items });
  };
  let pumping = false;
  // The batch the pump is currently running, which is no longer in `queue` but must still
  // survive a suspend via drainQueue().
  let runningBatch: QueueItem[] = [];
  // The run currently receiving ACP updates (set during runPrompt()).
  let currentRun: RunState | undefined;
  // terminalId -> the command goose asked to run in it, consumed by the tool_call_update
  // that hands off the terminal.
  const terminalCommands = new Map<string, string>();
  const priorityInterruptMs = deps.priorityInterruptMs ?? 0;
  const firstActivityTimeoutMs = deps.firstActivityTimeoutMs ?? 60_000;
  const livenessProbeMs = deps.livenessProbeMs ?? 30_000;
  // Auto-retry budget for a transiently failed run (see deathRetry* in BridgeDeps).
  const RETRY_MAX = deps.deathRetryMax ?? 5;
  const RETRY_BASE_MS = deps.deathRetryBaseMs ?? 500;
  const RETRY_CAP_MS = deps.deathRetryCapMs ?? 30_000;
  // Set by stop(): abandon an in-progress backoff so a torn-down bridge doesn't keep retrying.
  let closed = false;
  // The provider registry: the explicit list, or a single always-eligible provider wrapping
  // `acpClient`.
  const acpProviders: readonly AcpProvider[] =
    deps.acpProviders ??
    [
      {
        id: "default",
        kind: deps.provider ?? "goose",
        priority: 0,
        eligible: () => true,
        createClient: () =>
          typeof deps.acpClient === "function"
            ? (deps.acpClient as () => Promise<AcpClient>)()
            : (deps.acpClient as AcpClient),
      },
    ];

  // One ready client per provider id, plus the client and session serving the current run.
  const readySessions = new Map<string, Promise<ReadySession>>();
  let acpClient: AcpClient | undefined;

  // A wedged run's cause usually arrives after the watchdog gave up and the client was
  // dropped, so recent diagnostics are kept per conversation.
  const runDiagnostics: string[] = [];
  const RUN_DIAGNOSTICS_MAX = 5;
  const noteRunDiagnostic = (line: string): void => {
    if (!line) return;
    runDiagnostics.push(line);
    if (runDiagnostics.length > RUN_DIAGNOSTICS_MAX) runDiagnostics.shift();
  };

  /** Drop the cached ready-session so the next attempt re-initializes a fresh one, since a
   *  wedged session fails identically on every retry. */
  const dropCachedSession = (why: string) => {
    // Settle pending requests FIRST: the session that would receive the answer is going away.
    abandonAgentPermissions(why);
    if (!currentProviderId) return;
    log.warn("dropping the cached agent session; the next attempt re-initializes", {
      provider: currentProviderId,
      reason: why,
    });
    readySessions.delete(currentProviderId);
  };

  // Permission/option requests awaiting a user answer, keyed by toolCallId: a goose
  // tool-permission blocks on `resolve`, while an external one (a broker AWS request)
  // fires `onExternal` with the chosen optionId.
  interface Pending {
    resolve: (optionId: string | null, result?: Record<string, unknown>) => void;
    validOptions: Set<string>;
    onExternal?: (optionId: string | null, approver?: ApproverIdentity) => void;
    /** Set when the asking session is gone, so the answer is not treated as the user's. */
    abandoned?: boolean;
  }
  const pendingPermissions = new Map<string, Pending>();

  /** Settle every agent-session request awaiting an answer, since the session that asked is
   *  gone and nothing would ever resolve it. An external (broker) interrupt outlives the
   *  session, so it stays pending. Why: #763. */
  const abandonAgentPermissions = (why: string) => {
    const orphaned = [...pendingPermissions].filter(([, p]) => !p.onExternal && !p.abandoned);
    if (orphaned.length === 0) return;
    log.warn("abandoning permission requests awaiting an answer; the session that asked is gone", {
      count: orphaned.length,
      tool_call_ids: orphaned.map(([id]) => id),
      reason: why,
    });
    for (const [, p] of orphaned) {
      p.abandoned = true;
      // Resolving unblocks the request handler, which deletes the entry and persists the
      // PERMISSION_RESOLVED that clears the card.
      p.resolve(null);
    }
  };

  const persistListeners = new Set<(event: AguiEvent) => void>();
  const titleListeners = new Set<(title: string) => void>();

  // Extracts a <title>…</title> marker from the assistant's streamed text, reporting only
  // the first title.
  const titleExtractor = createTitleExtractor();
  // Set by a <title> marker, whose async save may still be in flight at stop.
  let markedTitle = false;
  const emitTitle = (title: string) => {
    if (!title) return;
    markedTitle = true;
    for (const cb of titleListeners) cb(title);
  };

  // Stamp `ts` once, before the event forks to the broadcast and persist paths, so both
  // copies are byte-identical for the integrity checksum.
  const stamp = <E extends AguiEvent>(event: E): E => {
    const e = ("ts" in event ? event : { ...event, ts: Date.now() }) as E;
    // Stamp the run's origin on RUN_STARTED so hasDanglingRun can tell this pod's in-flight
    // run from one a dead pod left behind.
    if (e.type === "RUN_STARTED" && deps.selfPod && !("host" in e)) {
      return { ...e, host: deps.selfPod, gen: deps.generation?.() } as E;
    }
    return e;
  };

  // Transcript recorder taps: `recordAguiOut` records emitted AG-UI events and
  // `recordRawInput` records the raw agent input under the same runId.
  const recorder = deps.recorder;
  const recProvider = deps.provider ?? "goose";
  const recordAguiOut = (event: AguiEvent) => {
    if (!recorder?.enabled) return;
    recorder.record({ layer: "agui-out", provider: recProvider, conversationId, runId: currentRun?.runId ?? "no-run", data: event });
  };
  const recordRawInput = (data: unknown) => {
    if (!recorder?.enabled) return;
    recorder.record({ layer: recProvider === "claude" ? "sdk-in" : "acp-in", provider: recProvider, conversationId, runId: currentRun?.runId ?? "no-run", data });
  };

  const emit = (event: AguiEvent) => {
    // Broadcast subscribers (UI) and persist subscribers (store) both see live events.
    const e = stamp(event);
    recordAguiOut(e);
    for (const cb of listeners) cb(e);
    for (const cb of persistListeners) cb(e);
  };

  // Persist-only: the store records it but the UI does not, since it already renders the
  // user's own prompt.
  const persist = (event: AguiEvent) => {
    const e = stamp(event);
    for (const cb of persistListeners) cb(e);
  };

  // Flush pending stream notifications (a macrotask) so late session/update events are
  // handled before a run finishes.
  const drain = () => new Promise<void>((r) => setTimeout(r, 0));

  // Per-run mutable mapping state for translating ACP updates -> AG-UI events.
  interface RunState {
    runId: RunId;
    /** The thread this run belongs to, required on RUN_STARTED/FINISHED. */
    threadId: ThreadId;
    // The currently-open assistant text message, if any.
    openText?: string;
    // The currently-open reasoning message, if any.
    openReasoning?: string;
    // tool_call_id -> the messageId we attribute its result to.
    toolMessage: Map<string, string>;
    // tool_call_ids whose TOOL_CALL_ARGS were already emitted, so a later rawInput doesn't
    // double-emit.
    argsEmitted: Set<string>;
    // Set once the run is finishing, so late updates never reopen a message after RUN_FINISHED.
    ended?: boolean;
    // Set by cancel(): the run ends with a RUN_FINISHED marked cancelled, not an error.
    cancelled?: boolean;
    // When the run began executing, for the queue's force-interrupt age check.
    startedAt?: number;
    // Tool calls started but not yet finished; the "thinking" interrupt policy defers its
    // cancel while this is > 0.
    inFlightTools: number;
    // Set when a "thinking" interrupt deferred behind an in-flight tool call, so the cancel
    // fires when inFlightTools hits 0.
    cancelWhenToolsIdle?: boolean;
    // tool_call_ids whose last update handed off a live terminal handle, meaning the command
    // is still running and the real finish is a later update.
    terminalPending: Set<string>;
    // The dead-on-arrival watchdog, armed at RUN_STARTED and disarmed by the first ACP update.
    sawActivity?: boolean;
    activityTimer?: ReturnType<typeof setTimeout>;
    // The liveness watchdog timer, which terminates the run only if the agent process died.
    livenessTimer?: ReturnType<typeof setTimeout>;
    // Set once a terminal event has been emitted for this run, so no path emits a second one.
    terminated?: boolean;
    // Set when the run ended with a transient failure the pump should auto-retry (process
    // death, no activity, an ACP throw), never for a clean finish, a cancel or a
    // model-reported error.
    retryable?: boolean;
    // The latest reply, for Stop's last_assistant_message.
    lastText: string;
    // Hook feedback delivered when the agent tries to stop.
    hookFeedback: string[];
    // Awaited before the turn may end.
    pendingHooks: Promise<unknown>[];
    toolInfo: Map<string, { name: string; input: unknown }>;
    source?: string;
  }

  /** True when a tool_call_update's content is just a live terminal handle, meaning the
   *  command is still running and this is not the real result. */
  const isTerminalHandoff = (content: unknown): boolean => {
    if (!Array.isArray(content) || content.length === 0) return false;
    return content.every((c) => {
      const o = c as { type?: string; terminalId?: unknown };
      return o?.type === "terminal" && o.terminalId !== undefined;
    });
  };

  // The terminalIds in a handoff update's content (to look up the command that ran).
  const handoffTerminalIds = (content: unknown): string[] =>
    Array.isArray(content)
      ? content
          .map((c) => (c as { terminalId?: unknown }).terminalId)
          .filter((t): t is string => typeof t === "string")
      : [];

  // Collapse `<shell> -c "<script>"` to the script; otherwise join command and args.
  const formatCommand = (command: string, args: string[]): string => {
    if ((command === "sh" || command === "bash" || command.endsWith("/sh") || command.endsWith("/bash")) && args[0] === "-c" && args[1] !== undefined) {
      return args[1];
    }
    return [command, ...args].join(" ").trim();
  };

  const closeOpenText = (st: RunState) => {
    if (st.openText) {
      emit({ type: "TEXT_MESSAGE_END", messageId: st.openText });
      st.openText = undefined;
    }
  };
  const closeOpenReasoning = (st: RunState) => {
    if (st.openReasoning) {
      emit({ type: "REASONING_MESSAGE_END", messageId: st.openReasoning });
      emit({ type: "REASONING_END", messageId: st.openReasoning });
      st.openReasoning = undefined;
    }
  };
  // Emit TOOL_CALL_ARGS exactly once per tool call, from whichever update first carries a
  // non-empty rawInput.
  const emitArgsOnce = (st: RunState, toolCallId: string, rawInput: unknown) => {
    if (st.argsEmitted.has(toolCallId)) return;
    if (rawInput === undefined || rawInput === null) return;
    // An empty object ({}) carries nothing useful — wait for a real update.
    if (typeof rawInput === "object" && Object.keys(rawInput as object).length === 0) return;
    st.argsEmitted.add(toolCallId);
    emit({ type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(rawInput) });
  };

  /** Disarm the dead-on-arrival watchdog on a run's first ACP traffic. A permission request
   *  counts: the wait that follows is the user's, not the agent's. Why: #763. */
  const noteActivity = (st: RunState) => {
    if (st.sawActivity) return;
    st.sawActivity = true;
    if (st.activityTimer) {
      clearTimeout(st.activityTimer);
      st.activityTimer = undefined;
    }
  };

  const handleUpdate = (st: RunState, u: SessionUpdate) => {
    if (st.ended) return; // never reopen a message after the run is finishing
    noteActivity(st);
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        // Reasoning and text are distinct streams; close reasoning first.
        closeOpenReasoning(st);
        // An image the agent sent inline is stored and attached to the open assistant message
        // as a reference, the same event a user message's images ride.
        const img = inlineImage(u.content);
        if (img) {
          if (!st.openText) {
            st.openText = nextId("msg");
            emit({ type: "TEXT_MESSAGE_START", messageId: st.openText, role: "assistant" });
          }
          const ref = toImageRef(img, deps.stageAsset);
          if ("url" in ref) {
            emit({ type: "MESSAGE_IMAGES", messageId: st.openText, images: [{ assetId: ref.assetId, mimeType: ref.mimeType, url: ref.url }] });
          } else {
            const delta = `\n\n_[${ref.mimeType} image not shown: ${ref.omitted}]_\n\n`;
            emit({ type: "TEXT_MESSAGE_CONTENT", messageId: st.openText, delta });
          }
          break;
        }
        // Pull an agent-emitted <title>…</title> marker out of the chunk and strip it from
        // the displayed text.
        const { text, title } = titleExtractor.push(blockText(u.content));
        if (title !== undefined) emitTitle(title);
        if (text.length === 0) break; // marker-only chunk -> nothing to show
        if (!st.openText) {
          st.openText = nextId("msg");
          emit({ type: "TEXT_MESSAGE_START", messageId: st.openText, role: "assistant" });
        }
        emit({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: st.openText,
          delta: text,
        });
        st.lastText += text;
        break;
      }
      case "agent_thought_chunk": {
        closeOpenText(st);
        if (!st.openReasoning) {
          st.openReasoning = nextId("reason");
          emit({ type: "REASONING_START", messageId: st.openReasoning });
          emit({ type: "REASONING_MESSAGE_START", messageId: st.openReasoning, role: "reasoning" });
        }
        emit({
          type: "REASONING_MESSAGE_CONTENT",
          messageId: st.openReasoning,
          delta: blockText(u.content),
        });
        break;
      }
      case "plan": {
        closeOpenText(st);
        const mid = nextId("reason");
        emit({ type: "REASONING_START", messageId: mid });
        emit({ type: "REASONING_MESSAGE_START", messageId: mid, role: "reasoning" });
        emit({ type: "REASONING_MESSAGE_CONTENT", messageId: mid, delta: JSON.stringify(u.entries) });
        emit({ type: "REASONING_MESSAGE_END", messageId: mid });
        emit({ type: "REASONING_END", messageId: mid });
        break;
      }
      case "tool_call": {
        closeOpenText(st);
        closeOpenReasoning(st);
        emit({ type: "TOOL_CALL_START", toolCallId: u.toolCallId, toolCallName: u.title });
        st.toolInfo.set(u.toolCallId, { name: u.title, input: u.rawInput });
        emitArgsOnce(st, u.toolCallId, u.rawInput);
        emit({ type: "TOOL_CALL_END", toolCallId: u.toolCallId });
        st.toolMessage.set(u.toolCallId, nextId("msg"));
        st.inFlightTools++; // a tool call is now running (see the "thinking" policy)
        break;
      }
      case "tool_call_update": {
        // goose often sends the args on this update rather than the initial tool_call, so
        // emit them now if not yet emitted.
        emitArgsOnce(st, u.toolCallId, u.rawInput);
        const info = st.toolInfo.get(u.toolCallId);
        if (info && u.rawInput !== undefined && info.input === undefined) info.input = u.rawInput;
        // goose marks every shell update status="completed" and the empty ones bracket the
        // real work, so the TOOL_CALL_RESULT is emitted only on a genuine finish and the part
        // stays result-less (a running spinner) until then.
        const status = (u as { status?: string }).status;
        // The structured result rides `content` (goose) or `rawOutput` (the claude-sdk provider).
        const resultContent = u.content !== undefined ? u.content : u.rawOutput;
        const hasRealContent = resultContent !== undefined && !isTerminalHandoff(resultContent);
        // A terminal handoff means the command is now running async in that terminal, so
        // don't finish yet.
        if (isTerminalHandoff(u.content)) {
          st.terminalPending.add(u.toolCallId);
          // Surface the command goose put in terminal/create as this tool call's args, so
          // the UI shows `$ <command>`.
          for (const tid of handoffTerminalIds(u.content)) {
            const cmd = terminalCommands.get(tid);
            if (cmd !== undefined) {
              terminalCommands.delete(tid); // consume — ids are unique per spawn
              emitArgsOnce(st, u.toolCallId, { command: cmd });
              break;
            }
          }
          break;
        }
        const terminalWasPending = st.terminalPending.has(u.toolCallId);
        // The tool is finished when it produced real content, or completed/failed after a
        // terminal handoff; a bare completed with neither is goose's speculative marker.
        const isFinish = hasRealContent || ((status === "completed" || status === "failed") && terminalWasPending);
        if (!isFinish) break;
        st.terminalPending.delete(u.toolCallId);
        if (st.inFlightTools > 0) {
          st.inFlightTools--;
          // A "thinking" interrupt deferred behind this tool call fires now that no tool is
          // in flight.
          if (st.cancelWhenToolsIdle && st.inFlightTools === 0) {
            st.cancelWhenToolsIdle = false;
            void self.cancel().catch(() => {});
          }
        }
        const messageId = st.toolMessage.get(u.toolCallId) ?? nextId("msg");
        // Images in the result move to the asset store; the logged result keeps refs the
        // UI's tool card renders inline.
        const logged = typeof resultContent === "string" ? resultContent : replaceInlineImages(resultContent, deps.stageAsset).value;
        emit({
          type: "TOOL_CALL_RESULT",
          toolCallId: u.toolCallId,
          messageId,
          content: typeof logged === "string" ? logged : JSON.stringify(logged ?? ""),
        });
        // The SDK fires its own PostToolUse; goose needs ours.
        if (deps.hooks && currentProviderKind === "goose" && info) {
          st.pendingHooks.push(
            self
              .runToolHook("PostToolUse", info.name, info.input ?? {}, { tool_response: resultContent ?? null, tool_use_id: u.toolCallId }, true)
              .catch(() => {}),
          );
        }
        break;
      }
      case "context_usage": {
        // Forward the context-window fill as its own persisted event for the UI's fill bar.
        emit({ type: "CONTEXT_USAGE", usedTokens: u.usedTokens, contextWindow: u.contextWindow });
        break;
      }
    }
  };

  // Combine a batch of queued messages into one turn so the agent reads the whole burst at
  // once; a single message passes through verbatim.
  const combineTexts = (texts: string[]): string =>
    texts.length === 1
      ? texts[0]
      : "The user sent several messages while you were working — handle them together as one request:\n\n" +
        texts.map((t, i) => `[Message ${i + 1}]\n${t}`).join("\n\n");

  const maxStopBlocks = deps.maxStopBlocks ?? 3;

  const emitHookNote = (text: string) => emit({ type: "SYSTEM_MESSAGE", messageId: nextId("sys"), source: "hook", text });

  // Run an event's hooks and show the user what they refused.
  const fireHooks = async (
    st: RunState | undefined,
    event: HookEvent,
    input: Record<string, unknown>,
    target?: string,
    scooterExtra: Record<string, unknown> = {},
  ): Promise<HookOutcome> => {
    const out = await deps.hooks!.run(
      event,
      {
        session_id: conversationId,
        transcript_path: "",
        permission_mode: "default",
        ...input,
        scooter: {
          conversation_id: conversationId,
          owner: deps.owner ?? null,
          parent_id: deps.parentId?.() ?? null,
          provider: currentProviderKind ?? null,
          run_id: st?.runId ?? null,
          source: st?.source ?? null,
          ...scooterExtra,
        },
      },
      target,
    );
    for (const m of out.systemMessages) emitHookNote(m);
    const refusers = out.runs.filter((r) => r.decision === "block" || r.decision === "stop").map((r) => r.id);
    if (out.block) emitHookNote(`${event} hook ${refusers.join(", ")}: ${out.block}`);
    else if (out.stop) emitHookNote(`${event} hook ${refusers.join(", ")} ended the turn: ${out.stop}`);
    return out;
  };

  // The prompt sending a stopping agent back, or undefined.
  const stopContinuation = async (st: RunState, stopBlocks: number): Promise<string | undefined> => {
    if (!deps.hooks) return undefined;
    const feedback = st.hookFeedback.splice(0);
    // A waiting message outranks a hook's continuation.
    if (queue.length > 0) return undefined;
    let reason: string | undefined;
    if (await deps.hooks.has("Stop")) {
      const out = await fireHooks(
        st,
        "Stop",
        { stop_hook_active: stopBlocks > 0, last_assistant_message: st.lastText },
        undefined,
        { stop_blocks: stopBlocks, untitled: !markedTitle && deps.untitled?.() === true },
      );
      if (out.stop) return undefined;
      reason = out.block;
    }
    const parts = [...feedback, ...(reason ? [reason] : [])];
    if (parts.length === 0) return undefined;
    if (stopBlocks >= maxStopBlocks) {
      log.warn("hooks kept the agent going past the limit; letting it stop", { run_id: st.runId, limit: maxStopBlocks });
      emitHookNote(`Hooks sent the agent back ${maxStopBlocks} times this turn; letting it stop.`);
      return undefined;
    }
    return decorateSystemMessage("hook", parts.join("\n\n"));
  };

  const runPrompt = async (
    input: PromptInput,
    batch: PromptInput[] = [input],
    // A retry re-drives the same batch, and its messages are already in the log.
    alreadyPersisted = false,
  ): Promise<{ runId: RunId; retryable: boolean }> => {
    const runId = nextId("run");
    const st: RunState = {
      runId,
      threadId: input.threadId,
      toolMessage: new Map(),
      argsEmitted: new Set(),
      inFlightTools: 0,
      terminalPending: new Set(),
      lastText: "",
      hookFeedback: [],
      pendingHooks: [],
      toolInfo: new Map(),
      source: input.source,
    };
    const startedAt = Date.now();
    st.startedAt = startedAt;
    currentRun = st; // visible to cancel() from the moment the run begins
    let outcome: "ok" | "error" = "ok";

    // Emit RUN_STARTED before any await so the UI sees the run begin even if agent startup
    // is slow or fails.
    emit({ type: "RUN_STARTED", threadId: input.threadId, runId });

    // Resolved by either watchdog so the prompt() await can give up, since a stalled agent
    // may never settle it and the pump is what performs the retry.
    let signalWedged: () => void = () => {};
    const wedged = new Promise<void>((resolve) => {
      signalWedged = resolve;
    });

    // Dead-on-arrival watchdog: no ACP activity within firstActivityTimeoutMs ends the run
    // with a RUN_ERROR and cancels the agent so the stuck subprocess unblocks.
    // Re-armed after pre-prompt hooks; their time isn't the agent's.
    const armActivityWatchdog = () => {
      if (firstActivityTimeoutMs <= 0) return;
      st.activityTimer = setTimeout(() => {
        if (st.sawActivity || st.ended) return;
        st.ended = true;
        st.terminated = true; // the watchdog owns this run's terminal event now
        closeOpenText(st);
        closeOpenReasoning(st);
        outcome = "error";
        // Logged loudly because the RUN_ERROR tells the user to check these logs; the
        // provider's stderr is read before the process is killed.
        const diagnostic = providerDiagnostic([
          ...runDiagnostics, // carried over from earlier attempts
          ...(acpClient?.recentDiagnostics?.() ?? []),
        ]);
        log.warn("run wedged: no ACP activity before the deadline (dead on arrival)", {
          run_id: st.runId,
          waited_ms: firstActivityTimeoutMs,
          retryable: true,
          ...(diagnostic ? { provider_diagnostic: diagnostic } : {}),
        });
        emit({
          type: "RUN_ERROR",
          message: deadOnArrivalMessage(diagnostic),
          code: "no_activity_timeout",
        });
        st.retryable = true; // transient — the pump auto-retries with backoff
        // The session itself is suspect, so force a fresh one.
        dropCachedSession("no ACP activity before the deadline");
        // Unblock the wedged goose so the next prompt gets a fresh run.
        void self.cancel(runId).catch(() => {});
        // Stop waiting regardless, since the cancel above is best-effort.
        signalWedged();
      }, firstActivityTimeoutMs);
    };
    armActivityWatchdog();

    // Liveness watchdog: force-terminates a run only when the agent process has died without
    // a terminal event, so silence (a long tool call, a paused permission request) just
    // re-arms.
    if (livenessProbeMs > 0) {
      const armLiveness = () => {
        st.livenessTimer = setTimeout(() => {
          if (st.ended || st.terminated) return;
          // Keep watching while the agent process is alive or there is no client to ask.
          if (!acpClient || acpClient.isAlive()) return armLiveness();
          // The agent died without a terminal event.
          st.ended = true;
          st.terminated = true; // this watchdog owns the terminal event now
          closeOpenText(st);
          closeOpenReasoning(st);
          outcome = "error";
          // Logged loudly because the user is told to check these logs.
          log.warn("run wedged: the agent process died without a terminal event", {
            run_id: st.runId,
            saw_activity: st.sawActivity,
            retryable: true,
          });
          emit({
            type: "RUN_ERROR",
            message:
              "The agent process exited unexpectedly mid-task. The run was ended so the " +
              "conversation isn't stuck; your next message will start a fresh run. If this " +
              "recurs, check the agent-host logs.",
            code: "agent_process_died",
          });
          st.retryable = true; // process crash — the pump auto-retries the batch with backoff
          // The process behind this session is gone; the cached entry can only fail.
          dropCachedSession("the agent process died");
          // Best-effort cleanup so the next prompt gets a fresh run.
          void self.cancel(runId).catch(() => {});
          // A dead process never resolves its pending prompt(); don't hold the pump on it.
          signalWedged();
        }, livenessProbeMs);
        // Don't let this timer keep the process alive on its own.
        (st.livenessTimer as { unref?: () => void }).unref?.();
      };
      armLiveness();
    }

    // Message ids persisted for this turn, excluded from the history preamble so the message
    // being sent is never folded into its own history.
    const thisTurnIds = new Set<string>();

    // Persist each raw user message (not the batch-joined prompt) persist-only, since the
    // live UI already renders what the user sent.
    for (const b of alreadyPersisted ? [] : batch) {
      // A platform-injected message persists as a SYSTEM_MESSAGE rather than a role:user turn.
      if (b.source) {
        const sysId = nextId("sys");
        thisTurnIds.add(sysId);
        persist({
          type: "SYSTEM_MESSAGE",
          messageId: sysId,
          source: b.source,
          text: b.text,
          ...(b.sender ? { sender: b.sender.id, level: b.sender.level } : {}),
        });
        continue;
      }
      const userMsgId = nextId("user");
      thisTurnIds.add(userMsgId);
      persist({ type: "TEXT_MESSAGE_START", messageId: userMsgId, role: "user" });
      persist({ type: "TEXT_MESSAGE_CONTENT", messageId: userMsgId, delta: b.text });
      persist({ type: "TEXT_MESSAGE_END", messageId: userMsgId });
      // Attach the message's images as references (assetId + url, not bytes) so a refresh
      // re-renders them.
      if (b.images && b.images.length) {
        persist({
          type: "MESSAGE_IMAGES",
          messageId: userMsgId,
          images: b.images.map((img) => ({
            assetId: img.assetId,
            mimeType: img.mimeType,
            url: `/conversations/${encodeURIComponent(b.threadId)}/assets/${encodeURIComponent(img.assetId)}`,
          })),
        });
      }
    }

    try {
      if (!started) await self.start();
      // Resolve the provider for this run's context and point acpClient/acpSessionId at its
      // ready client.
      await resolveForRun(runContextFor(input));
      debug("[bridge] prompt: sending to goose, session=%s", acpSessionId);
      // Seed new sessions fully, returning ones with missed turns.
      let historyPreamble = "";
      const ready = currentReady;
      if (deps.loadHistory && ready && (!ready.historySeeded || ready !== lastRunReady)) {
        const fresh = !ready.historySeeded;
        const sinceRun = ready.lastRunId;
        ready.historySeeded = true;
        try {
          const events = (await deps.loadHistory()).filter(
            (e) => !thisTurnIds.has((e as { messageId?: string }).messageId ?? ""),
          );
          historyPreamble = fresh
            ? buildHistoryPreamble(events)
            : buildHistoryPreamble(eventsAfterRun(events, sinceRun), undefined, "catch-up");
        } catch (err) {
          debug("[bridge] loadHistory failed (continuing without reinjection): %s", err);
        }
      }
      if (ready) {
        ready.lastRunId = runId;
        lastRunReady = ready;
      }
      // Decorate system-sourced items, combine the burst into one prompt, and prepend the
      // history preamble as a separate block when present.
      const combined = combineTexts(batch.map((b) => (b.source ? decorateSystemMessage(b.source, b.text) : b.text)));
      const textBlocks: ContentBlock[] = historyPreamble
        ? [{ type: "text", text: historyPreamble }, { type: "text", text: combined }]
        : [{ type: "text", text: combined }];
      // Resolve attached images to base64 ACP image blocks after the text, skipping
      // unreadable assets.
      const imageBlocks: ContentBlock[] = [];
      const images = batch.flatMap((b) => b.images ?? []);
      if (images.length && deps.readAsset) {
        for (const img of images) {
          const bytes = await deps.readAsset(img.assetId).catch(() => null);
          if (bytes) imageBlocks.push({ type: "image", data: bytes.data.toString("base64"), mimeType: bytes.mimeType });
        }
      }
      // Materialize binary file attachments into the sandbox, logging and skipping a failed
      // write.
      const files = batch.flatMap((b) => b.files ?? []);
      const savedFilePaths: string[] = [];
      for (const f of files) {
        try {
          savedFilePaths.push(await writeUploadedFile(deps.exec, f));
        } catch (err) {
          debug("[bridge] failed to write uploaded file %s (continuing): %s", f.name, err);
        }
      }
      // A prompt-only note (not persisted) telling the agent where the files landed.
      const fileNoteBlocks: ContentBlock[] =
        savedFilePaths.length > 0 ? [{ type: "text", text: buildFileNote(savedFilePaths) }] : [];
      const hookContext: string[] = [];
      if (deps.hooks) {
        if (st.activityTimer) clearTimeout(st.activityTimer);
        if (ready && !ready.sessionStartFired) {
          ready.sessionStartFired = true;
          const started = await fireHooks(st, "SessionStart", { source: "startup" }, "startup");
          hookContext.push(...started.context);
        }
        const submit = await fireHooks(st, "UserPromptSubmit", { prompt: combined });
        if (submit.block || submit.stop) {
          // A refused prompt never reaches the agent.
          st.ended = true;
          st.terminated = true;
          emit({ type: "RUN_FINISHED", threadId: input.threadId, runId });
          return { runId, retryable: false };
        }
        hookContext.push(...submit.context);
        if (!st.sawActivity && !st.ended) armActivityWatchdog();
      }
      const hookBlocks: ContentBlock[] = hookContext.length
        ? [{ type: "text", text: decorateSystemMessage("hook", hookContext.join("\n\n")) }]
        : [];
      const promptBlocks = [...textBlocks, ...hookBlocks, ...fileNoteBlocks, ...imageBlocks];
        // These two log lines bracket the one call that can hang and say which provider took
        // the run.
        log.info("acp prompt: sending", {
          run_id: st.runId,
          blocks: promptBlocks.length,
          has_session: acpSessionId !== undefined,
        });
      // Raced against the watchdogs: a rejection still lands in the catch below, and
      // Promise.race marks the loser handled.
      // A Stop hook's block sends the agent back in this run.
      let turnBlocks = promptBlocks;
      let stopReason = "end_turn";
      for (let stopBlocks = 0; ; stopBlocks++) {
        st.lastText = "";
        const promptCall = acpClient!.prompt({ sessionId: acpSessionId!, prompt: turnBlocks });
        const raced = await Promise.race([
          promptCall.then((r) => ({ abandoned: false as const, stopReason: r.stopReason })),
          wedged.then(() => ({ abandoned: true as const })),
        ]);
        if (raced.abandoned) {
          // Record the abandoned call's eventual rejection, often the only account of why the
          // run produced nothing.
          promptCall.catch((err) => noteRunDiagnostic(err instanceof Error ? err.message : String(err)));
          // A watchdog already emitted this run's terminal event and set `retryable`, so return
          // and let the pump re-drive the batch.
          return { runId, retryable: st.retryable === true };
        }
        stopReason = raced.stopReason;
        debug("[bridge] prompt: stopReason=%s", stopReason);
        log.info("acp prompt: returned", { run_id: st.runId, stop_reason: stopReason });
        // The ACP response can resolve before the final session/update notifications dispatch,
        // so drain a macrotask before closing messages and emitting RUN_FINISHED.
        await drain();
        await Promise.allSettled(st.pendingHooks.splice(0));
        if (st.cancelled || st.terminated || stopReason === "cancelled" || stopReason === "error") break;
        const next = await stopContinuation(st, stopBlocks);
        if (next === undefined || st.cancelled || st.terminated) break;
        closeOpenText(st);
        closeOpenReasoning(st);
        turnBlocks = [{ type: "text", text: next }];
      }
      st.ended = true; // stop routing further late updates into this run
      closeOpenText(st);
      closeOpenReasoning(st);
      // A watchdog may already have terminated this run; never emit a second terminal event.
      if (!st.terminated) {
        st.terminated = true;
        if (st.cancelled || stopReason === "cancelled") {
          // A clean end, not an error.
          emit({ type: "RUN_FINISHED", threadId: input.threadId, runId, cancelled: true });
        } else if (stopReason === "error") {
          outcome = "error";
          emit({ type: "RUN_ERROR", message: "agent reported an error", code: stopReason });
        } else {
          emit({ type: "RUN_FINISHED", threadId: input.threadId, runId });
        }
      }
    } catch (err) {
      st.ended = true;
      closeOpenText(st);
      closeOpenReasoning(st);
      // Record it even when the watchdog already terminated the run, since this rejection is
      // the only account of why.
      noteRunDiagnostic(err instanceof Error ? err.message : String(err));
      // The watchdog's own cancel makes the pending prompt() reject here, and it already
      // emitted the terminal event.
      if (!st.terminated) {
        st.terminated = true;
        if (st.cancelled) {
          // A cancel that made the ACP prompt reject is still a clean user stop.
          emit({ type: "RUN_FINISHED", threadId: input.threadId, runId, cancelled: true });
        } else {
          outcome = "error";
          const raw = err instanceof Error ? err.message : String(err);
          // Replaying a turn that already ran tools re-sends the user's message on top of work it
          // may have finished (a commit, a PR edit), so only a turn that never started is retried.
          const replaySafe = !st.sawActivity;
          log.warn("acp prompt rejected", { run_id: runId, error: raw, saw_activity: st.sawActivity === true, retry: replaySafe });
          emit({
            type: "RUN_ERROR",
            message: replaySafe
              ? clarifyRunError(raw)
              : `${clarifyRunError(raw)} The turn was interrupted after it had started working, so it was not retried automatically; send a message to continue.`,
          });
          st.retryable = replaySafe; // the ACP call threw (init/session/stream) before any work — transient; pump retries
          // A dead remote session fails identically on every retry, so drop the cached session
          // and let the next attempt re-initialize (and re-seed history).
          if (/unknown session|not connected|disconnected/i.test(raw) && currentProviderId) {
            debug("[bridge] remote session invalid (%s) — dropping cached session for %s", raw, currentProviderId);
            readySessions.delete(currentProviderId);
          }
        }
      }
    } finally {
      // Always clear the watchdog timers (normal completion, error, or already fired).
      if (st.activityTimer) {
        clearTimeout(st.activityTimer);
        st.activityTimer = undefined;
      }
      if (st.livenessTimer) {
        clearTimeout(st.livenessTimer);
        st.livenessTimer = undefined;
      }
      if (currentRun === st) currentRun = undefined;
      // Metrics hook — fire-and-forget, never let it break the run.
      try {
        deps.onRunComplete?.({ acpSessionId, durationMs: Date.now() - startedAt, outcome });
      } catch {
        /* ignore */
      }
    }
    return { runId, retryable: st.retryable === true };
  };

  // Force-interrupt: cancel the running turn once the highest-priority queued item has
  // waited past the timeout.
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  const clearInterruptTimer = () => {
    if (interruptTimer) { clearTimeout(interruptTimer); interruptTimer = undefined; }
  };
  // Apply the waiting priority item's interrupt policy: "tool-call" cancels now, "thinking"
  // cancels at the next tool-call boundary with the timeout as a fallback, and "timeout"
  // arms the timer.
  const armTimeoutFallback = (head: QueueItem) => {
    if (priorityInterruptMs <= 0) return; // fallback disabled
    const remaining = Math.max(0, priorityInterruptMs - (Date.now() - head.enqueuedAt));
    interruptTimer = setTimeout(() => {
      const stillWaiting = (topPriorityItem()?.priority ?? 0) >= PRIORITY_INTERRUPT;
      if (currentRun && stillWaiting) void self.cancel().catch(() => {});
    }, remaining);
    (interruptTimer as { unref?: () => void }).unref?.();
  };
  const applyPreemption = () => {
    clearInterruptTimer();
    if (!currentRun) return;
    const head = topPriorityItem();
    if (!head || head.priority < PRIORITY_INTERRUPT) return;

    if (head.interrupt === "tool-call") {
      void self.cancel().catch(() => {}); // immediate, kills the running tool call
      return;
    }
    if (head.interrupt === "thinking") {
      if (currentRun.inFlightTools === 0) {
        void self.cancel().catch(() => {}); // idle thinking — preempt now
      } else {
        currentRun.cancelWhenToolsIdle = true; // let the tool call finish, then cancel
        armTimeoutFallback(head); // ...but don't wait forever on a non-yielding tool
      }
      return;
    }
    // "timeout": arm the timer (disabled when priorityInterruptMs <= 0).
    armTimeoutFallback(head);
  };

  const topPriorityItem = (): QueueItem | undefined => {
    if (queue.length === 0) return undefined;
    // Highest priority, ties broken by earliest enqueue (stable FIFO within tier).
    return queue.reduce((best, it) =>
      it.priority > best.priority || (it.priority === best.priority && it.enqueuedAt < best.enqueuedAt) ? it : best,
    );
  };

  // Drain the queue one run at a time, highest priority first, awaiting each run fully.
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const item = topPriorityItem()!;
        // Coalesce every other queued item of the same priority tier into this run in FIFO
        // order, so a burst is read as one turn; a priority item never merges with normal
        // messages.
        const batch = [item, ...queue.filter((q) => q !== item && q.priority === item.priority)]
          .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
        for (const b of batch) queue.splice(queue.indexOf(b), 1);
        runningBatch = batch; // in-flight: not in `queue`, but must survive a suspend
        // Surface the shrunk queue; an empty queue emits items:[] so the UI clears its list.
        emitQueueSnapshot();
        clearInterruptTimer(); // the batch is now running, not waiting
        try {
          // Re-drive this batch with exponential backoff on a transient failure, leaving the
          // rest of the queue untouched.
          const inputs = batch.map((b) => b.input);
          let res = await runPrompt(batch[0].input, inputs);
          // Count runs performed, and distinguish a closed bridge from a spent budget.
          let attempts = 1;
          let abandoned = false;
          for (let attempt = 1; res.retryable && attempt <= RETRY_MAX; attempt++) {
            const delayMs = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
            // Logged so a run that fails and then succeeds on retry leaves a trace.
            log.warn("retrying a wedged run", { attempt, max: RETRY_MAX, delay_ms: delayMs });
            emit({ type: "RUN_RETRYING", threadId: batch[0].input.threadId, attempt, max: RETRY_MAX, delayMs });
            await new Promise((r) => setTimeout(r, delayMs));
            if (closed) {
              abandoned = true; // bridge stopped while backing off — abandon the retry
              break;
            }
            res = await runPrompt(batch[0].input, inputs, true);
            attempts++;
          }
          if (res.retryable) {
            if (abandoned) {
              log.warn("abandoned a wedged run: the bridge closed during the retry backoff", {
                attempts,
                max: RETRY_MAX,
              });
            } else {
              log.error("run FAILED after exhausting retries", { attempts, max: RETRY_MAX });
            }
          }
          for (const b of batch) b.resolve(res.runId); // all coalesced items share the (last) run
        } catch (err) {
          for (const b of batch) b.reject(err);
        } finally {
          runningBatch = [];
        }
        // A priority item may have queued during that run; re-evaluate preemption against
        // the next run.
        applyPreemption();
      }
    } finally {
      pumping = false;
      clearInterruptTimer();
    }
  };

  // --- ACP client resolution (per-run provider selection) ---------------------------------
  // The RunContext for a run: this conversation, its owner, and the run's trigger source.
  const defaultRunContext = (): RunContext => ({
    conversationId,
    owner: deps.owner,
    model: deps.model,
    provider: deps.pickedProvider,
  });
  const runContextFor = (input: PromptInput): RunContext => ({
    conversationId,
    owner: deps.owner,
    source: input.source,
    humanInitiated: input.humanInitiated,
    model: deps.model,
    provider: deps.pickedProvider,
  });

  // Lazily ready one client per provider (initialize, newSession, hooks wired once), cached
  // by provider id; a failed init drops the entry.
  const readyProvider = (provider: AcpProvider): Promise<ReadySession> => {
    let ready = readySessions.get(provider.id);
    if (ready) return ready;
    ready = (async () => {
      // Read before createClient: a racing edit errs toward rebuilding.
      const skills = await currentSkills();
      debug("[bridge] readyProvider(%s): createClient + initialize", provider.id);
      const client = await provider.createClient(defaultRunContext());
      await client.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      });
      // The model this provider's session runs: the conversation's choice when the provider
      // offers it, else the provider's default.
      const model =
        deps.modelCatalog
          ? deps.model && modelAllowedFor(deps.modelCatalog, deps.model, provider.modelTag)
            ? deps.model
            : defaultFor(deps.modelCatalog, provider.modelTag, conversationId)
          : deps.model;
      // A provider with its own MCP set (the BYO tunnel names) wins; otherwise the per-run
      // resolver, falling back to the static `config.mcpServers`.
      const resolved = provider.mcpServersFor
        ? provider.mcpServersFor(conversationId)
        : ((await deps.resolveMcpServers?.(conversationId)) ?? (deps.config.mcpServers as OfferedMcpServer[] | undefined));
      const mcpServers = resolved;
      // Remember what this session was created with, so a later run can tell whether the
      // sandbox's set changed.
      const mcpFingerprint = fingerprintOffered((resolved ?? []) as OfferedMcpServer[]);
      const { sessionId: sid } = await client.newSession({
        cwd: deps.config.cwd,
        mcpServers,
        model,
        // A provider that cannot read this pod's filesystem takes the skills as data and
        // writes its own .claude/skills.
        skills: provider.needsSkillPayloads ? skills : undefined,
        // One that builds no identity of its own takes the host's prompt, without which it
        // runs anonymous and never emits the <title> marker.
        systemPrompt: provider.needsSystemPrompt
          ? sdkPrompt({ name: deps.config.agentName ?? "Scooter" })
          : undefined,
        // A provider that runs the tools itself (the Claude SDK) makes these wait on the user.
        blockingTools: deps.config.blockingTools,
      });
      debug("[bridge] readyProvider(%s): newSession -> %s", provider.id, sid);
      // Subscribe once per client and route updates to the current run.
      client.onSessionUpdate((sid, u) => {
        // Filter by session, since a BYO owner's conversations share one wire and another
        // session's update must never land in this run.
        if (sid && acpSessionId && sid !== acpSessionId) return;
        if (currentRun) handleUpdate(currentRun, u);
      });
      // goose's shell tool carries the command in terminal/create, so stash it by terminalId
      // for the tool_call_update.
      client.onTerminalCreated((terminalId, command, args) => {
        terminalCommands.set(terminalId, formatCommand(command, args));
      });
      // The agent asks the user to choose: emit a permission interrupt and block until
      // answerPermission() resolves.
      client.onPermissionRequest(async (req) => {
        const run = currentRun;
        if (run) {
          // Often a run's FIRST traffic (goose gates a first-turn tool), so it must disarm
          // the DOA watchdog or a slow human answer kills the run.
          noteActivity(run);
          closeOpenText(run);
          closeOpenReasoning(run);
        }
        const request = boundedRequest(req.request);
        const { optionId, result } = await new Promise<{ optionId: string | null; result?: Record<string, unknown> }>((resolve) => {
          pendingPermissions.set(req.toolCallId, {
            resolve: (optionId, result) => resolve({ optionId, result }),
            validOptions: new Set(req.options.map((o) => o.optionId)),
          });
          emit({
            type: "RUN_FINISHED",
            threadId: run?.threadId ?? conversationId,
            runId: run?.runId ?? "run",
            outcome: {
              type: "interrupt",
              interrupts: [
                {
                  id: req.toolCallId,
                  reason: "confirmation",
                  message: req.title ?? "The agent needs your choice",
                  toolCallId: req.toolCallId,
                  // A contrib request's kind picks the UI card that draws its data.
                  metadata: request
                    ? { options: req.options, kind: request.kind, data: request.data }
                    : { options: req.options },
                },
              ],
            },
          });
        });
        // Abandoned = settled by teardown, not the user; its run already ended, so don't reopen it.
        const abandoned = pendingPermissions.get(req.toolCallId)?.abandoned === true;
        pendingPermissions.delete(req.toolCallId);
        // Persist-only record for history replay.
        persist({ type: "PERMISSION_RESOLVED", toolCallId: req.toolCallId, optionId });
        if (run && !abandoned) {
          emit({ type: "RUN_STARTED", threadId: run.threadId, runId: run.runId });
          run.ended = false;
        }
        if (!optionId) return { cancelled: true as const };
        return result ? { optionId, result } : { optionId };
      });
      return { client, acpSessionId: sid, historySeeded: false, mcpFingerprint, skillsFingerprint: skillsFingerprint(skills) };
    })();
    readySessions.set(provider.id, ready);
    ready.catch(() => readySessions.delete(provider.id));
    return ready;
  };

  /** Drop a cached session whose MCP set no longer matches the sandbox's, since a
   *  `scooter-rebuild` can hand an auto-assigned port to a different server and the old
   *  session would silently talk to the wrong one; a resolver failure keeps the existing
   *  session rather than blocking the run. */
  const dropSessionIfMcpChanged = async (providerId: string): Promise<void> => {
    if (!deps.resolveMcpServers) return;
    const cached = readySessions.get(providerId);
    if (!cached) return; // nothing cached: the next readyProvider builds it fresh anyway
    let settled: { client: AcpClient; mcpFingerprint: string };
    try {
      settled = await cached;
    } catch (err) {
      // readyProvider's own `ready.catch` already dropped this entry, so the next run rebuilds.
      debug("[bridge] dropSessionIfMcpChanged: cached session had failed (%s)", formatError(err));
      return;
    }
    let next: string;
    try {
      next = fingerprintOffered(await deps.resolveMcpServers(conversationId));
    } catch (err) {
      log.warn("could not resolve MCP servers; keeping the current agent session", {
        conversation_id: conversationId,
        error: formatError(err),
      });
      return;
    }
    if (next === settled.mcpFingerprint) return;
    log.info("sandbox MCP servers changed; rebuilding the agent session", {
      conversation_id: conversationId,
      provider: providerId,
    });
    readySessions.delete(providerId);
    // Close the old client so its process does not linger, without letting a failed close
    // abort the rebuild.
    try {
      await settled.client.close();
    } catch (err) {
      // A close that keeps failing leaks one agent process per `scooter-rebuild`, so it is
      // logged rather than swallowed.
      log.warn("failed to close the superseded agent client; rebuilding anyway", {
        conversation_id: conversationId,
        provider: providerId,
        error: formatError(err),
      });
    }
  };

  /** Deployment skills merged with the owner's personal ones, read fresh. */
  const currentSkills = async () => skillPayloads(deps.config.skillsDir, (await deps.personalSkills?.()) ?? []);

  /** Drop a session whose skills changed; agents read them only at start. */
  const dropSessionIfSkillsChanged = async (providerId: string): Promise<void> => {
    const cached = readySessions.get(providerId);
    if (!cached) return;
    let settled: ReadySession;
    try {
      settled = await cached;
    } catch {
      return; // readyProvider already dropped it
    }
    let next: string;
    try {
      next = skillsFingerprint(await currentSkills());
    } catch (err) {
      log.warn("could not read skills; keeping the current agent session", {
        conversation_id: conversationId,
        error: formatError(err),
      });
      return;
    }
    if (next === settled.skillsFingerprint) return;
    log.info("skills changed; rebuilding the agent session", { conversation_id: conversationId, provider: providerId });
    readySessions.delete(providerId);
    await settled.client.close().catch((err) =>
      log.warn("failed to close the superseded agent client; rebuilding anyway", {
        conversation_id: conversationId,
        provider: providerId,
        error: formatError(err),
      }));
  };

  /** Drop a dead client's session; the run reconnects and re-seeds. */
  const dropSessionIfDead = async (providerId: string): Promise<void> => {
    const cached = readySessions.get(providerId);
    if (!cached) return;
    let settled: { client: AcpClient };
    try {
      settled = await cached;
    } catch {
      return; // readyProvider already dropped it
    }
    if (settled.client.isAlive()) return;
    log.warn("cached agent client is dead; reconnecting", { conversation_id: conversationId, provider: providerId });
    readySessions.delete(providerId);
    await settled.client.close().catch(() => {});
  };

  // Resolve the provider for a run and point acpClient/acpSessionId at its ready client,
  // throwing if none is eligible.
  const resolveForRun = async (ctx: RunContext): Promise<void> => {
    const provider = await pickAcpProvider(acpProviders, ctx);
    if (!provider) {
      throw new Error(
        `no ACP provider eligible (source=${ctx.source ?? "-"}, owner=${ctx.owner ?? "-"})`,
      );
    }
    await dropSessionIfDead(provider.id);
    await dropSessionIfMcpChanged(provider.id);
    await dropSessionIfSkillsChanged(provider.id);
    const ready = await readyProvider(provider);
    acpClient = ready.client;
    acpSessionId = ready.acpSessionId;
    currentProviderId = provider.id;
    currentProviderKind = provider.kind;
    currentReady = ready;
  };

  const self: SessionBridge = {
    sessionId,

    async start() {
      if (started) return;
      // Establish the first session for a default (interactive) context; the run loop
      // re-resolves per run.
      await resolveForRun(defaultRunContext());
      started = true;
    },

    prompt(input: PromptInput, opts?: PromptOptions): Promise<RunId> {
      // Enqueue and let the pump drain one run at a time, highest priority first and FIFO
      // within a tier; a priority prompt may also preempt the running turn per its
      // interrupt policy.
      const priority = opts?.priority ?? PRIORITY_NORMAL;
      const interrupt: InterruptPolicy = opts?.interrupt ?? "thinking";
      const p = new Promise<RunId>((resolve, reject) => {
        queue.push({ id: nextId("queue"), input, priority, interrupt, enqueuedAt: Date.now(), resolve, reject });
      });
      // Surface the longer queue so a waiting message shows up durably; with nothing
      // running, pump() drains it immediately.
      emitQueueSnapshot();
      if (priority >= PRIORITY_INTERRUPT) applyPreemption();
      void pump();
      return p;
    },

    async cancel(_runId?: RunId, userInitiated = false) {
      // Mark the running turn cancelled, kill its active tool call, then tell the agent to
      // stop; queued prompts stay queued.
      const run = currentRun;
      if (!run || !acpClient) return;
      // Bind the client and session now, since a watchdog's cancel can still be in flight
      // after the pump's retry resolved a fresh session.
      const client = acpClient;
      const cancelSessionId = acpSessionId;
      run.cancelled = true;
      // Only a user Stop persists its intent; the marker names this runId, so only the run
      // being stopped can match it later.
      if (userInitiated) emit({ type: "CANCEL_REQUESTED", threadId: run.threadId, runId: run.runId });
      try {
        // Killing the shell is what makes the prompt return, and only a user Stop gets the
        // pending-spawn grace window.
        await client.killActiveTerminals(userInitiated, cancelSessionId);
      } catch (e) {
        // Logged rather than swallowed, since a silent failure here presents as a dead Stop
        // button; session/cancel below still stops the agent.
        log.warn("killActiveTerminals failed", { error: formatError(e) });
      }
      if (cancelSessionId) await client.cancel(cancelSessionId);
    },

    queueState() {
      const head = topPriorityItem();
      return {
        running: currentRun !== undefined,
        currentRunMs: currentRun?.startedAt ? Date.now() - currentRun.startedAt : 0,
        queued: queue.length,
        maxQueuedPriority: head?.priority ?? 0,
      };
    },

    shouldYieldToQueue() {
      return (topPriorityItem()?.priority ?? 0) >= PRIORITY_INTERRUPT;
    },

    async runToolHook(event, toolName, toolInput, extra = {}, defer = false) {
      const st = currentRun;
      if (!deps.hooks) return { context: [], systemMessages: [], runs: [] };
      const out = await fireHooks(st, event, { tool_name: toolName, tool_input: toolInput ?? {}, ...extra }, toolName);
      if (defer && st) {
        if (out.block) {
          st.hookFeedback.push(
            event === "PreToolUse" ? `A hook refused your ${toolName} call: ${out.block}` : `Hook feedback on your ${toolName} call: ${out.block}`,
          );
        }
        st.hookFeedback.push(...out.context);
      }
      return out;
    },

    recordRawInput,

    drainQueue() {
      // Include the batch the pump is currently running, since it was spliced out of `queue`
      // and would otherwise be lost on a mid-run suspend.
      const inFlight = runningBatch;
      runningBatch = [];
      const waiting = queue.splice(0, queue.length);
      if (waiting.length === 0 && inFlight.length === 0) return [];
      // The log's final word on the queue must be "empty".
      emitQueueSnapshot();
      // Reject only the items that never started; an in-flight item settles through the
      // pump's own resolve/reject.
      for (const item of waiting) {
        item.reject(
          new Error("the conversation was suspended before this queued message could run"),
        );
      }
      // Preserve both for replay; the in-flight item is re-enqueued on revive, so a completed
      // turn simply re-asks.
      return [...inFlight, ...waiting].map((q) => ({
        text: q.input.text,
        priority: q.priority,
        source: q.input.source,
        sender: q.input.sender,
        humanInitiated: q.input.humanInitiated,
      }));
    },

    async stop() {
      closed = true; // abandon any in-progress death-retry backoff
      clearInterruptTimer();
      // Drain the queue so a teardown neither leaks queued prompt() promises nor leaves a
      // stale QUEUE_UPDATED behind; manager.suspend() drains first to persist the items.
      self.drainQueue();
      // Close every started provider client.
      const settled = await Promise.allSettled([...readySessions.values()]);
      readySessions.clear();
      acpClient = undefined;
      acpSessionId = undefined;
      started = false;
      await Promise.allSettled(
        settled.map((r) => (r.status === "fulfilled" ? r.value.client.close() : Promise.resolve())),
      );
    },

    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onPersist(cb) {
      persistListeners.add(cb);
      return () => persistListeners.delete(cb);
    },
    onTitle(cb) {
      titleListeners.add(cb);
      return () => titleListeners.delete(cb);
    },
    answerPermission(toolCallId, optionId, approver, result) {
      const pending = pendingPermissions.get(toolCallId);
      if (!pending) return false; // no such pending request (or already answered)
      // An unknown optionId cancels rather than forwarding a garbage selection.
      const chosen = pending.validOptions.has(optionId) ? optionId : null;
      if (pending.onExternal) {
        // An external interrupt has no blocked agent run: fire the callback, clean up, and
        // record the resolution for replay.
        pendingPermissions.delete(toolCallId);
        persist({ type: "PERMISSION_RESOLVED", toolCallId, optionId: chosen });
        pending.onExternal(chosen, approver);
      } else {
        pending.resolve(chosen, chosen ? result : undefined); // unblocks the agent's permission request
      }
      return true;
    },
    withdrawInterrupt(id) {
      const pending = pendingPermissions.get(id);
      if (!pending?.onExternal) return false;
      pendingPermissions.delete(id);
      persist({ type: "PERMISSION_RESOLVED", toolCallId: id, optionId: null });
      return true;
    },
    raiseInterrupt({ id, message, options, onAnswer, metadata }) {
      pendingPermissions.set(id, {
        resolve: () => {},
        validOptions: new Set(options.map((o) => o.optionId)),
        onExternal: onAnswer,
      });
      // Emit the interrupt on the conversation stream, not tied to a run.
      emit({
        type: "RUN_FINISHED",
        threadId: conversationId,
        runId: `ext-${id}`,
        outcome: {
          type: "interrupt",
          interrupts: [{ id, reason: "confirmation", message, metadata: { ...metadata, options } }],
        },
      });
    },
  };

  return self;
}

function blockText(content: { type: string; text?: string } | { type: "text"; text: string }): string {
  return "text" in content && typeof content.text === "string" ? content.text : "";
}
