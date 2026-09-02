/**
 * ACP <-> AG-UI bridge — the core of the agent-host.
 *
 * Maps ACP session/update notifications to AG-UI events (docs/DESIGN.md §4c)
 * and routes ACP client methods (terminal/*, fs/*, session/request_permission)
 * to the ExecBackend (agent-sandbox SDK) / permission UI.
 *
 * Note: this interface is UNCHANGED by the agent-outside inversion — only the
 * ExecBackend implementation flipped (local-OS -> agent-sandbox SDK), a sign
 * the seam is in the right place.
 */

import { randomUUID } from "node:crypto";

import type {
  SessionId,
  RunId,
  ThreadId,
  SessionConfig,
  ExecBackend,
} from "./types.js";
import type { AcpClient, SessionUpdate, ContentBlock } from "./acp/client.js";
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

import { formatError, logger } from "./log.js";

const log = logger("bridge");

/** Where binary Slack attachments are materialized inside the sandbox. Kept in sync
 *  with the webhooks handler (services/webhooks) which notes these paths in the
 *  message text so the agent knows where to find each file. */
export const SLACK_FILES_DIR = "/workspace/.slack";

/** Sanitize an attachment filename to a safe basename (no path traversal / dir
 *  separators) so a hostile `name` can't escape SLACK_FILES_DIR. */
function safeSlackName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  // Drop leading dots that could hide it / strip anything odd to a conservative set.
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned || "file";
}

/** Write one binary file attachment (base64) into the sandbox at
 *  SLACK_FILES_DIR/<name>, base64-decoding it pod-side so the bytes land intact.
 *  Uses the exec `run` seam (mkdir + a base64 pipe). Throws on a non-zero exit so
 *  the caller can log + skip (best-effort). */
async function writeSlackFile(exec: ExecBackend, file: { name: string; data: string }): Promise<void> {
  const name = safeSlackName(file.name);
  const path = `${SLACK_FILES_DIR}/${name}`;
  // Build a single shell line: create the dir, then decode base64 from a heredoc
  // into the target path. args:[] marks this as a pass-through shell string.
  const script =
    `mkdir -p ${shellQuote(SLACK_FILES_DIR)} && ` +
    `printf %s ${shellQuote(file.data)} | base64 -d > ${shellQuote(path)}`;
  const res = await exec.run({ command: script, args: [] });
  if (res.exitCode !== 0) {
    throw new Error(`write ${path}: ${res.stderr || `exit ${res.exitCode}`}`);
  }
}

/** POSIX single-quote a string for a `sh -c` line (mirrors k8sExec's shellQuote). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** An AG-UI interrupt: a point where the run pauses for a user response (a
 *  permission/option choice). Matches @ag-ui/core's Interrupt. `metadata.options`
 *  carries the choices the UI renders. */
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

// AG-UI event union (subset used here; full set per AG-UI spec). Every persisted
// event also carries an optional `ts` (epoch ms, stamped at emit time) — an
// explicit chronological ordering key. It's absent on synthetic/test events and
// ignored by the @ag-ui client (which folds by type + id).
export type AguiEvent = AguiEventBase & { ts?: number };

type AguiEventBase =
  // RUN_STARTED and RUN_FINISHED both REQUIRE threadId per the AG-UI schema —
  // the @ag-ui/client validates incoming events and rejects a missing threadId.
  // `host`/`gen` identify WHO started the run, so a later reader can tell a run this
  // pod is still executing from one stranded by a previous host. Without them
  // hasDanglingRun cannot distinguish the two, and revive-on-assign nudged a
  // conversation's own live first run. Optional: events persisted before this
  // existed have neither, and are treated as foreign (the old behaviour).
  | { type: "RUN_STARTED"; threadId: ThreadId; runId: RunId; host?: string; gen?: number }
  | {
      type: "RUN_FINISHED";
      threadId: ThreadId;
      runId: RunId;
      result?: unknown;
      /** When present with outcome "interrupt", the run paused awaiting a user
       *  response (a permission/option choice). assistant-ui surfaces these as
       *  pending interrupts; the user's answer resumes via the next run's
       *  RunAgentInput.resume[]. */
      outcome?: AguiRunOutcome;
      /** The run was stopped by the user (a "stop" click) or a priority
       *  force-interrupt — a clean end, NOT an error. The UI shows "you stopped
       *  this turn." */
      cancelled?: boolean;
    }
  | { type: "RUN_ERROR"; message: string; code?: string }
  // Emitted when a run failed TRANSIENTLY (agent process died / no-activity / ACP threw) and the pump
  // is about to AUTO-RETRY the same batch after `delayMs`. `attempt`/`max` drive the UI's "retrying
  // (n/N)…" banner. NOT persisted as a terminal — a following RUN_STARTED clears it (success) or, on
  // exhaustion, the final RUN_ERROR replaces it. See the pump's retry loop.
  | { type: "RUN_RETRYING"; threadId: ThreadId; attempt: number; max: number; delayMs: number; code?: string }
  // PERSISTED CANCEL INTENT. A user Stop emits this BEFORE the kill takes effect, so
  // the intent survives the pod: if the host dies mid-cancel (a scale-down/rollout
  // races the Stop), the next owner's dangling-run check finds the marker and
  // TERMINATES the run (RUN_FINISHED cancelled) instead of resume-nudging work the
  // user already stopped. Persist-only for the UI (@ag-ui folds by type and ignores
  // it); load-bearing for reviveFromMirror.
  | { type: "CANCEL_REQUESTED"; threadId: ThreadId; runId: RunId }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" | "user" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string }
  | { type: "TOOL_CALL_RESULT"; toolCallId: string; messageId: string; content: string }
  // AG-UI reasoning sequence: START -> MESSAGE_START -> MESSAGE_CONTENT(s) ->
  // MESSAGE_END -> END. The client rejects MESSAGE_CONTENT without MESSAGE_START.
  | { type: "REASONING_START"; messageId: string }
  | { type: "REASONING_MESSAGE_START"; messageId: string; role: "reasoning" }
  | { type: "REASONING_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "REASONING_MESSAGE_END"; messageId: string }
  | { type: "REASONING_END"; messageId: string }
  // Emitted once a permission/option request is answered (or cancelled) so a
  // reattaching/late UI (history replay) knows the request is settled and which
  // option was chosen. The REQUEST itself rides RUN_FINISHED's interrupt outcome
  // (assistant-ui's native interrupt mechanism), not a bespoke event.
  | { type: "PERMISSION_RESOLVED"; toolCallId: string; optionId: string | null }
  // A SNAPSHOT of the run queue's pending items, emitted whenever the queue
  // changes (a prompt enqueued behind an active run, or drained as it starts to
  // run). Persist-only + broadcast: the @ag-ui client folds by type+id and ignores
  // this bespoke event, so it never corrupts the message stream — but it rides the
  // SAME single-source (integrity) path the UI reattaches to, so queued messages
  // survive a refresh + show across tabs (the old queued-message-vanishes bug: the
  // queue lived only in client memory). Latest-wins: the UI renders the items from
  // the most recent QUEUE_UPDATED; an empty `items` means the queue drained.
  | { type: "QUEUE_UPDATED"; items: Array<{ id: string; text: string; priority: number }> }
  // Image REFERENCES attached to a user message (multimodal). Carries only the
  // assetId + mimeType + fetch url — NEVER the base64 bytes — so the event log stays
  // compact + checksum-stable; the UI renders each via its url on replay. Bespoke
  // like QUEUE_UPDATED: the @ag-ui client folds by type and ignores it, so it never
  // corrupts the message stream; the UI reads it explicitly (keyed to the user
  // messageId it follows). Persist + broadcast, so it survives a refresh.
  | {
      type: "MESSAGE_IMAGES";
      messageId: string;
      images: Array<{ assetId: string; mimeType: string; url: string }>;
    }
  // Context-window fill after a turn (used / total tokens) → the UI's context-fill
  // bar. Bespoke like QUEUE_UPDATED: the @ag-ui client folds by type and ignores it,
  // so it never touches the message stream; the UI reads it explicitly. Persist +
  // broadcast, so the latest value survives a refresh.
  | { type: "CONTEXT_USAGE"; usedTokens: number; contextWindow: number }
  // A COMPACTION boundary: the older turns before this marker were summarized (recap
  // in `summary`); the recent turns after it are kept verbatim. It IS the compaction
  // point — loadHistory (index.ts) seeds a revived session from [summary + events
  // after the latest marker], so the agent continues on the compacted context.
  // Rendered inline by the UI as a "Compacted earlier messages" divider. Bespoke;
  // persisted like QUEUE_UPDATED (the @ag-ui client ignores it).
  | { type: "COMPACTION_MARKER"; summary: string; summarizedTurns: number; keptRuns: number }
  // A SYSTEM message: content injected by the PLATFORM (webhook event, scheduler
  // fire, background-job completion, broker error, restart/model-switch nudge), NOT
  // typed by a human. Persisted INSTEAD of a role:user message so the UI can hide /
  // collapse it (they're noise for the human, though the agent still received them).
  // `source` tags the origin (slack/github/scheduler/background/broker/nudge/…) for
  // an icon/label. Bespoke like QUEUE_UPDATED — the @ag-ui client ignores it, so it
  // never enters the user/assistant message stream.
  | { type: "SYSTEM_MESSAGE"; messageId: string; source: string; text: string };

/** The standard decoration prepended to a SYSTEM message so the agent knows it's a
 *  platform event (not a human turn) and shouldn't reply to the user about it. One
 *  format for every source, replacing the ad-hoc "[System: …]" prefixes. */
export function decorateSystemMessage(source: string, text: string): string {
  return (
    `[System message${source ? ` from ${source}` : ""} — this is an automated platform ` +
    `event, not the user speaking. Act on it if relevant to your task; do NOT reply to ` +
    `the user just to acknowledge it.]\n\n${text}`
  );
}

/** Rewrite a raw agent/API error into a clearer user-facing message for the known
 *  cases. Today: CONTEXT OVERFLOW (the conversation exceeded the model's context
 *  window and auto-compaction couldn't recover) → a plain "start a new chat" nudge
 *  instead of a cryptic provider string. Anything unrecognized passes through. */
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

/** An image attached to a user prompt — a reference the bridge resolves to base64
 *  (from the AssetStore) when it builds the ACP image content block. */
export interface PromptImage {
  assetId: string;
  mimeType: string;
}

/** A binary file attached to a user prompt (Slack pdf/zip/…). Unlike images, files
 *  are NOT sent as ACP content blocks — the bridge MATERIALIZES the bytes into the
 *  sandbox at /workspace/.slack/<name> via the exec client, and the agent reads them
 *  from disk (the message text, woven webhooks-side, references the saved paths). */
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
  /** Images the user attached (UI upload / Slack). Empty/undefined = text-only
   *  (the unchanged hot path). Resolved to ACP image blocks when the run prompts. */
  images?: PromptImage[];
  /** Binary file attachments (Slack). Empty/undefined = none (the unchanged path).
   *  Written to /workspace/.slack/<name> in the sandbox when the run prompts. */
  files?: PromptFile[];
  /** SYSTEM message source — set when this prompt is injected by the PLATFORM, not
   *  typed by a human (a webhook event, a scheduler fire, a background-job completion,
   *  a broker error, a restart/model-switch nudge). When set: (1) the agent receives
   *  a standard "[system message from <source> — no need to reply to the user]"
   *  decoration ahead of the text, and (2) the turn is persisted as a SYSTEM_MESSAGE
   *  event (not a role:user message), so the UI can hide/collapse it. Undefined = a
   *  normal human user message (the unchanged path). */
  source?: string;
}

/** How a priority item PREEMPTS the running turn (graduated interrupt levels).
 *  Applies only to a priority prompt (priority > 0); a normal prompt always waits.
 *   - "timeout"   : the default — wait priorityInterruptMs, then cancel (kills the
 *                   in-flight tool call). What an @scooter mention uses.
 *   - "thinking"  : preempt idle text generation, but let an IN-FLIGHT TOOL CALL
 *                   finish first — cancel fires at the next tool-call boundary (or
 *                   immediately if none is running). What the run_background
 *                   completion-watcher wants (don't kill a build to announce a job).
 *   - "tool-call" : the most aggressive — cancel NOW, killing any running tool
 *                   call. What an explicit user Stop does. */
export type InterruptPolicy = "timeout" | "thinking" | "tool-call";

/** Per-prompt options for the bridge's run queue. */
export interface PromptOptions {
  /** Higher runs sooner among queued items. A PRIORITY prompt (>0, e.g. an
   *  @scooter mention) may also force-interrupt the running turn — a normal prompt
   *  (0) only waits its turn. Default 0. */
  priority?: number;
  /** How a priority prompt preempts the running turn. Default "timeout" (the
   *  historical behavior). Ignored for a normal (priority 0) prompt. */
  interrupt?: InterruptPolicy;
}

/** Normal (waits its turn) vs. priority (may force-interrupt) prompt levels. */
export const PRIORITY_NORMAL = 0;
export const PRIORITY_INTERRUPT = 10;

/** The identity of the human answering an external interrupt (e.g. approving an
 *  AWS request). Sent to the broker, which authorizes the configured claim
 *  (email/id/name). Anonymous when no ingress identity. */
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
  /** Cancel the RUNNING turn (a user "stop" or a priority force-interrupt): tell
   *  goose to stop (ACP session/cancel), KILL its active tool call (a running
   *  shell), and end the run cleanly (RUN_FINISHED marked cancelled). `runId` is
   *  optional — omitted cancels whatever run is currently active. A no-op if
   *  nothing is running. Queued prompts are NOT dropped; the next runs after. */
  /** `userInitiated` marks a real Stop press, which gets a grace window for a terminal
   *  that has not spawned yet. Internal preemption must NOT set it. */
  cancel(runId?: RunId, userInitiated?: boolean): Promise<void>;
  stop(): Promise<void>;
  /** Snapshot of the run queue (for observability / the force-interrupt timer):
   *  whether a run is active, how long it's been going, and the queued backlog. */
  queueState(): { running: boolean; currentRunMs: number; queued: number; maxQueuedPriority: number };

  /** Remove every QUEUED (not-yet-running) item and return it, so the caller can
   *  PERSIST it across a bridge teardown. Used by suspend: the run queue lives in
   *  this bridge's closure and the bridge is dropped on suspend, so anything still
   *  queued would otherwise be destroyed (the message the user sent silently never
   *  runs). Each drained item's prompt() promise is REJECTED — it will not run on
   *  THIS bridge; revive re-enqueues the persisted copies on the new one. Also
   *  emits a clearing QUEUE_UPDATED so the durable log's last word is "empty"
   *  (else a reattaching UI folds a phantom queued row nothing will drain). */
  drainQueue(): Array<{ text: string; priority: number }>;

  /** True when a PRIORITY_INTERRUPT item is waiting on the queue — the signal for
   *  tool-call BACK-PRESSURE: a provider's pre-tool gate (SDK canUseTool / goose
   *  approve-mode request_permission) denies the NEXT tool while this is true, so
   *  the run quiesces to a boundary and the queued priority item (e.g. a subagent
   *  result) can inject instead of waiting for the whole run. A normal queued
   *  prompt does NOT trigger this (it waits its turn). See
   *  todo/docs/SUBAGENT_BACKPRESSURE.md. */
  shouldYieldToQueue(): boolean;

  /** TRANSCRIPT RECORDER: record one RAW agent-input frame (goose ACP update /
   *  claude SDK message) under the current run, so the recorded transcript
   *  correlates real input with the AG-UI output the bridge produces. The ACP/SDK
   *  client calls this (late-bound, like shouldYield). No-op when recording off. */
  recordRawInput(data: unknown): void;

  /** Answer a pending permission/option request (resolves the blocked agent run,
   *  or fires the external onAnswer for a raiseInterrupt). optionId must be one
   *  of the offered options; an unknown/empty id cancels. `approver` is the
   *  identity of the human answering (for an external/AWS interrupt the broker
   *  authorizes them); ignored for a blocked goose run. Returns true if a matching
   *  pending request was found. */
  answerPermission(toolCallId: string, optionId: string, approver?: ApproverIdentity): boolean;

  /** Raise an AG-UI interrupt NOT tied to a goose run (e.g. a broker AWS
   *  permission request). Emits the interrupt to the UI; when the user answers
   *  (via answerPermission / the UI resume), `onAnswer(optionId|null, approver?)`
   *  fires with the answering user's identity. `id` is the interrupt/answer key. */
  raiseInterrupt(args: {
    id: string;
    message: string;
    options: Array<{ optionId: string; name: string; kind: string }>;
    onAnswer: (optionId: string | null, approver?: ApproverIdentity) => void;
    /** Extra metadata merged into the emitted interrupt (alongside `options`),
     *  e.g. `{ aws: true }` so the UI knows to run a per-viewer can-approve check. */
    metadata?: Record<string, unknown>;
  }): void;

  /** Subscribe to the AG-UI event stream broadcast to the UI (live). */
  onEvent(cb: (event: AguiEvent) => void): () => void;
  /** Subscribe to events that should be PERSISTED but not broadcast live (e.g.
   *  the user's own prompt — the UI already shows it, so re-broadcasting would
   *  duplicate it; we still need it in the durable log for history replay). The
   *  store subscribes here too. */
  onPersist(cb: (event: AguiEvent) => void): () => void;
  /** Subscribe to an agent-assigned title. The agent emits a <title>…</title>
   *  marker (its first action) in its message stream; the bridge extracts it,
   *  strips it from the displayed text, and fires this once per title. */
  onTitle(cb: (title: string) => void): () => void;
}

export interface BridgeDeps {
  config: SessionConfig;
  exec: ExecBackend;
  /** This pod's name (POD_NAME), stamped onto RUN_STARTED so a reader can tell a run
   *  started HERE from one stranded by another host. Unset single-replica. */
  selfPod?: string;
  /** The CR generation this pod owns the conversation at, stamped alongside `selfPod`.
   *  UNSET today: no accessor exposes it per-conversation, so a run left by an EARLIER
   *  assignment to this same pod still reads as ours. That window needs the pod to be
   *  reassigned away and back while a run dangles — rare, and it fails toward not
   *  resuming rather than toward a spurious nudge. Wire this when the registry can
   *  answer it. */
  generation?: () => number | undefined;
  /** The conversation's chosen model (per-conversation override; undefined = deployment
   *  default). Combined with `modelCatalog` + each provider's `modelTag` to pick the model a
   *  RUN actually gets: the choice when the run's provider offers it, else that provider's
   *  default — never a model id from the wrong provider's namespace. */
  model?: string;
  /** The deployment's model catalog (GET /models). Needed for the per-provider resolution
   *  above; absent = every provider gets the conversation model as-is (legacy). */
  modelCatalog?: ModelCatalog;
  /**
   * The ACP client, or an async factory that creates one on first start().
   * Tests inject a ready in-process fake; production passes a factory that
   * spawns `goose acp` lazily (so the connection isn't established until the
   * first prompt). A factory avoids the brittle sync/async adapter shims.
   *
   * Single-provider shorthand: internally wrapped into a one-entry AcpProvider registry
   * (always-eligible) so the bridge's per-run resolution path is uniform. Most tests use this.
   * Mutually exclusive with `acpProviders`.
   */
  acpClient?: AcpClient | (() => Promise<AcpClient>);

  /**
   * MULTI-PROVIDER path: a capability-tagged registry resolved PER RUN (pickAcpProvider). The
   * bridge picks the provider for each run from its RunContext (owner + source), so a conversation
   * can use a personalized brain for a human trigger and the cloud brain for a scheduled one. When
   * set, takes precedence over `acpClient`. makeBridge (index.ts) passes this. See acp/provider.ts.
   */
  acpProviders?: readonly AcpProvider[];

  /**
   * The conversation OWNER (Scooter user), if known — part of the per-run RunContext an
   * owner-bound provider (e.g. the remote personalized agent) selects on. Optional; the ported
   * Increment-1 providers don't use it.
   */
  owner?: string;

  /**
   * Optional run-completion hook for metrics. Called once per run (after the
   * run resolves, success or error) with its goose ACP session id, wall-clock
   * duration, and outcome. The host wires this to the metrics sink; absent in
   * tests / when metrics are off. Must not throw (fire-and-forget).
   */
  onRunComplete?: (info: { acpSessionId?: string; durationMs: number; outcome: "ok" | "error" }) => void;

  /**
   * Optional history provider for REVIVE reinjection. A revived conversation
   * spawns a fresh ACP session with no memory of prior turns, so on this bridge's
   * FIRST prompt we prepend a transcript of the persisted log (built via
   * buildHistoryPreamble) ahead of the user's message. Returns the persisted
   * AG-UI events for this conversation (BEFORE the current turn is appended).
   * Absent in tests / when there's nothing to inject → no prepend.
   */
  loadHistory?: () => Promise<AguiEvent[]>;

  /**
   * Resolve an attached image's bytes (from the AssetStore) so the run can build
   * the ACP image content block goose sees. Absent → image parts are ignored (the
   * text-only path is unchanged). Returns null for an unknown/unreadable asset.
   */
  readAsset?: (assetId: string) => Promise<{ data: Buffer; mimeType: string } | null>;

  /**
   * Force-interrupt timeout (ms). When a queued PRIORITY prompt (an @scooter
   * mention) has waited longer than this while a run is active, the queue cancels
   * the running turn so the priority item can take over. 0 (default) disables it —
   * a priority item then only jumps the queue order, never force-cancels.
   */
  priorityInterruptMs?: number;

  /**
   * Watchdog for a run that goes DEAD ON ARRIVAL: after RUN_STARTED we arm a timer,
   * and if the agent emits NO ACP activity (not a single session/update) within this
   * many ms, we conclude it's wedged — the observed failure was the agent hanging on
   * a model-provider credential error (e.g. an STS assume-role denial for Bedrock),
   * producing zero events and never returning from the prompt, so the conversation
   * sat "running" forever. On timeout we cancel the stuck run and emit RUN_ERROR so
   * the UI unfreezes and
   * shows why. The FIRST ACP update disarms it — a legitimately long-thinking run
   * that has started streaming is never touched (this only catches silence from the
   * start). Default 60_000; 0 disables.
   */
  firstActivityTimeoutMs?: number;

  /**
   * LIVENESS watchdog for a run that wedges mid-stream. This does NOT guess from
   * silence — silence is normal (a long `sleep 600` / build / test run emits no ACP
   * updates for minutes, and the ExecBackend's own commandTimeoutMs already bounds a
   * genuinely hung command). Instead, while a run is active it periodically PROBES a
   * DEFINITIVE health signal — `acpClient.isAlive()` — and only force-terminates when
   * the agent PROCESS has died (crashed/exited) without emitting a terminal event:
   * an unambiguous wedge. Everything else (a tool in flight, a paused permission
   * request, an alive-but-idle agent) is left alone — the run keeps waiting, the
   * user's Stop still works, and the UI idle-watchdog heals the client view. This
   * guarantees a DEAD agent can't leave the pump blocked forever, without ever
   * killing a healthy long-running task. `livenessProbeMs` is the probe cadence.
   * Default 30_000; 0 disables.
   */
  livenessProbeMs?: number;
  /** AUTO-RETRY a TRANSIENTLY-failed run (agent process death / no-activity / ACP throw): the pump
   *  re-drives the same batch up to `deathRetryMax` times with `deathRetryBaseMs`·2ⁿ backoff (capped
   *  at `deathRetryCapMs`), emitting RUN_RETRYING between tries, then gives up (the RUN_ERROR stands).
   *  The rest of the queue is NEVER cleared. Defaults 5 / 500ms / 30_000ms; small values in tests. */
  deathRetryMax?: number;
  deathRetryBaseMs?: number;
  deathRetryCapMs?: number;

  /** TRANSCRIPT RECORDER (test-harness). When enabled, the bridge records the RAW
   *  agent input (goose ACP frames / claude SDK messages) AND its own emitted
   *  AG-UI events, correlated by runId, so tests can REPLAY real behavior instead
   *  of hand-authored fakes. Off by default (no-op recorder). `provider` labels
   *  which agent produced the input. See todo/docs/AGENT_TRANSCRIPT_HARNESS.md. */
  recorder?: Recorder;
  provider?: "goose" | "claude";
}

// Event ids (runId, messageId, sessionId, …) MUST be globally unique across the
// WHOLE life of a conversation's log — including across agent-host RESTARTS. They
// used to be module-global counters (run-1, msg-1, …) that reset to 0 on every
// process start, so a revived conversation re-minted run-1/msg-1/user-1 that
// COLLIDED with ids already in its persisted log. The UI folds by messageId and
// keys runs by runId, so colliding ids merged unrelated turns (doubled tool-call
// args, scrambled run order, history that won't render while a new run is live).
// A UUID per id makes collision impossible regardless of restarts. The readable
// prefix is kept for debugging; nothing parses the id as a number (order comes
// from the append-only log, not the id value).
const nextId = (prefix: string) => `${prefix}-${randomUUID()}`;

export function createSessionBridge(deps: BridgeDeps): SessionBridge {
  const sessionId = nextId("sess");
  const listeners = new Set<(event: AguiEvent) => void>();
  let acpSessionId: string | undefined;
  /** The provider serving the CURRENT run — part of the reinjection key: session ids come from
   *  independent providers (goose mints its own, the SDK its own, a fake both), so two
   *  providers can coincide on an id; provider+session is the true session identity. */
  let currentProviderId = "";
  /** The established session THIS run resolved to — carries its own historySeeded flag. */
  let currentReady: { historySeeded: boolean } | undefined;
  let started = false;
  // Revive history reinjection, PER ESTABLISHED SESSION. This was a bridge-scoped one-shot
  // flag, which assumed one session per bridge lifetime — true for goose, false everywhere BYO
  // lives: a mid-conversation provider switch, a container restart, or a container that has
  // never seen this conversation each create a NEW session on the same bridge, and the flag
  // being spent left that session's brain BLANK (the reported "restoring a BYOC conversation
  // doesn't restore it"). The seeded state lives ON each readySessions entry (object identity),
  // not in a provider:sessionId keyed set: a re-established session after a container restart
  // can mint a COLLIDING session id, and a keyed set would then skip the seeding exactly when
  // it matters most.
  // Serialize runs: a bridge has ONE goose session + ONE RunState. A second
  // prompt arriving while a run is in flight (e.g. the webhook POSTs /agui while
  // the agent is mid-run) must QUEUE, not clobber currentRun — otherwise the
  // first run's open text message never gets its END and RUN_FINISHED is emitted
  // while it's still open (the @ag-ui client rejects that, and the reply is lost).
  // The run queue. A bridge has ONE goose session, so runs are serialized — but
  // via an INSPECTABLE queue (not an opaque promise chain), so we can order by
  // priority, see the backlog, and force-interrupt the current run when a priority
  // item waits too long. The invariant is unchanged: each run fully completes (its
  // text closed + RUN_FINISHED emitted) BEFORE the next RUN_STARTED — a second run
  // whose RUN_FINISHED fired while the first's message was still open corrupts the
  // @ag-ui stream. `pump()` guarantees that by awaiting each runPrompt fully.
  interface QueueItem {
    /** Stable id for this queued item, so the QUEUE_UPDATED snapshot is diffable
     *  by the UI (it can keep a queued bubble stable across snapshots). */
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

  // Broadcast + persist a snapshot of what's currently QUEUED (waiting behind the
  // active run), so a refreshing/reattaching UI re-derives the queue from the log
  // instead of losing it (it used to be client-only). Called on every enqueue and
  // whenever the pump pulls items out to run. Ordered highest-priority-then-FIFO,
  // matching the drain order the user will see them run in.
  const emitQueueSnapshot = () => {
    const items = [...queue]
      .sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt)
      .map((q) => ({ id: q.id, text: q.input.text, priority: q.priority }));
    emit({ type: "QUEUE_UPDATED", items });
  };
  let pumping = false;
  // The batch the pump is CURRENTLY running. The pump splices items OUT of `queue`
  // before running them, so an in-flight message is in NEITHER `queue` nor anywhere
  // else — drainQueue() would miss it and the user's message would be lost on a
  // mid-run suspend (exactly the reported case). Tracked here so drainQueue can
  // preserve it too. Cleared when the batch settles.
  let runningBatch: QueueItem[] = [];
  // The run currently receiving ACP updates (set during runPrompt()).
  let currentRun: RunState | undefined;
  // terminalId -> the command goose asked to run in it (from terminal/create).
  // Consumed by the tool_call_update that hands off the terminal, to surface the
  // command as the tool call's args. Bridge-lifetime (terminalIds are unique per
  // spawn); pruned on lookup so it doesn't grow unbounded across a long session.
  const terminalCommands = new Map<string, string>();
  const priorityInterruptMs = deps.priorityInterruptMs ?? 0;
  const firstActivityTimeoutMs = deps.firstActivityTimeoutMs ?? 60_000;
  const livenessProbeMs = deps.livenessProbeMs ?? 30_000;
  // AUTO-RETRY of a transiently-failed run (agent process death / no-activity / ACP throw). The pump
  // re-drives the SAME batch up to RETRY_MAX times with exponential backoff (RETRY_BASE·2ⁿ, capped),
  // then gives up (the last RUN_ERROR stands). Overridable for tests (small delays). See the pump.
  const RETRY_MAX = deps.deathRetryMax ?? 5;
  const RETRY_BASE_MS = deps.deathRetryBaseMs ?? 500;
  const RETRY_CAP_MS = deps.deathRetryCapMs ?? 30_000;
  // Set by stop(): abandon an in-progress backoff so a torn-down bridge doesn't keep retrying.
  let closed = false;
  // Resolved on first start(); a ready client or the result of the factory.
  // ACP PROVIDER REGISTRY. Either the explicit multi-provider list (makeBridge) or a single
  // always-eligible provider wrapping the legacy `acpClient` shorthand (tests + single-provider
  // deploys). Selection is per-run (pickAcpProvider); today one provider is eligible so the choice
  // is stable — behavior-identical to the old single-client bridge.
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

  // One READY (initialize+newSession+hooks-wired) client per provider id, plus the client serving
  // the CURRENT run. `acpClient`/`acpSessionId` track the ACTIVE run's client so the run loop,
  // cancel(), and the liveness probe operate on it (unchanged shape; now sourced per-run).
  const readySessions = new Map<string, Promise<{ client: AcpClient; acpSessionId: string; historySeeded: boolean }>>();
  let acpClient: AcpClient | undefined;

  /** Drop the cached ready-session so the next attempt re-initializes a fresh one.
   *  A wedged session fails IDENTICALLY on every retry, so retrying through it just
   *  burns the budget. */
  const dropCachedSession = (why: string) => {
    if (!currentProviderId) return;
    log.warn("dropping the cached agent session; the next attempt re-initializes", {
      provider: currentProviderId,
      reason: why,
    });
    readySessions.delete(currentProviderId);
  };

  // Permission/option requests awaiting a user answer. Two kinds:
  //  - goose tool-permission: the ACP requestPermission call blocks on `resolve`.
  //  - EXTERNAL (e.g. a broker AWS request): no blocked goose run; `onExternal`
  //    is invoked with the chosen optionId so the caller (agent-host) can act
  //    (approve/deny the broker request). Keyed by toolCallId; validOptions
  //    guards a stale/garbage id.
  interface Pending {
    resolve: (optionId: string | null) => void;
    validOptions: Set<string>;
    onExternal?: (optionId: string | null, approver?: ApproverIdentity) => void;
  }
  const pendingPermissions = new Map<string, Pending>();

  const persistListeners = new Set<(event: AguiEvent) => void>();
  const titleListeners = new Set<(title: string) => void>();

  // Extracts a <title>…</title> marker from the assistant's streamed text. One
  // per bridge (per conversation): the agent emits the marker as its first
  // action, and we only report the first title (the extractor self-guards).
  const titleExtractor = createTitleExtractor();
  const emitTitle = (title: string) => {
    if (title) for (const cb of titleListeners) cb(title);
  };

  // Stamp a wall-clock timestamp (epoch ms) on every event BEFORE it forks to the
  // live-broadcast and persist paths, so both copies are byte-identical (the
  // integrity self-heal compares their checksums — a ts on only one side would
  // read as a false gap). `ts` is an explicit chronological ordering key that
  // survives persistence, so the log / tail window can order by real time instead
  // of trusting append order alone. The @ag-ui client folds by type+id and ignores
  // this extra field. Stamped once here; never re-stamped on replay.
  const stamp = <E extends AguiEvent>(event: E): E => {
    const e = ("ts" in event ? event : { ...event, ts: Date.now() }) as E;
    // Stamp run ORIGIN on RUN_STARTED (same rationale as `ts`: an extra field the
    // @ag-ui client ignores, but which survives persistence). This is what lets
    // hasDanglingRun tell "my in-flight run" from "a run a dead pod left behind".
    if (e.type === "RUN_STARTED" && deps.selfPod && !("host" in e)) {
      return { ...e, host: deps.selfPod, gen: deps.generation?.() } as E;
    }
    return e;
  };

  // TRANSCRIPT RECORDER: correlate every recorded entry with THIS conversation +
  // the current run. `recordAguiOut` taps emitted AG-UI events; `recordRawInput`
  // is handed to the ACP/SDK client so it records the RAW agent input under the
  // same runId. All no-ops when no recorder is configured.
  const recorder = deps.recorder;
  const recProvider = deps.provider ?? "goose";
  const recordAguiOut = (event: AguiEvent) => {
    if (!recorder?.enabled) return;
    recorder.record({ layer: "agui-out", provider: recProvider, conversationId: sessionId, runId: currentRun?.runId ?? "no-run", data: event });
  };
  const recordRawInput = (data: unknown) => {
    if (!recorder?.enabled) return;
    recorder.record({ layer: recProvider === "claude" ? "sdk-in" : "acp-in", provider: recProvider, conversationId: sessionId, runId: currentRun?.runId ?? "no-run", data });
  };

  const emit = (event: AguiEvent) => {
    // Broadcast subscribers (UI) AND persist subscribers (store) both see live
    // events.
    const e = stamp(event);
    recordAguiOut(e);
    for (const cb of listeners) cb(e);
    for (const cb of persistListeners) cb(e);
  };

  // Persist-only: the store records it, but the UI does NOT (avoids duplicating
  // something the UI already renders, like the user's own prompt).
  const persist = (event: AguiEvent) => {
    const e = stamp(event);
    for (const cb of persistListeners) cb(e);
  };

  // Flush pending stream notifications (a macrotask) so late session/update
  // events are handled before we finish a run.
  const drain = () => new Promise<void>((r) => setTimeout(r, 0));

  // Per-run mutable mapping state for translating ACP updates -> AG-UI events.
  interface RunState {
    runId: RunId;
    /** The thread this run belongs to (needed for RUN_STARTED/FINISHED events,
     *  which the @ag-ui client validates require a threadId). */
    threadId: ThreadId;
    // The currently-open assistant text message, if any.
    openText?: string;
    // The currently-open reasoning message, if any.
    openReasoning?: string;
    // tool_call_id -> the messageId we attribute its result to.
    toolMessage: Map<string, string>;
    // tool_call_ids for which we've already emitted TOOL_CALL_ARGS, so a later
    // tool_call_update carrying rawInput doesn't double-emit the args.
    argsEmitted: Set<string>;
    // Set once the run is finishing: late updates are ignored so we never
    // reopen a message after RUN_FINISHED.
    ended?: boolean;
    // Set by cancel(): the run was stopped by a user / force-interrupt, so it
    // ends with a RUN_FINISHED marked { cancelled: true } (not an error).
    cancelled?: boolean;
    // When the run actually began executing (RUN_STARTED) — for the queue's
    // force-interrupt age check.
    startedAt?: number;
    // Count of tool calls STARTED but whose result hasn't arrived yet. The
    // "thinking" interrupt policy defers its cancel while this is > 0 (don't kill
    // an in-flight tool call to preempt idle thinking) and fires at the boundary
    // when it drops to 0.
    inFlightTools: number;
    // Set when a "thinking"-policy interrupt wanted to cancel but a tool call was
    // in flight: fire the cancel the moment inFlightTools hits 0.
    cancelWhenToolsIdle?: boolean;
    // tool_call_ids whose LAST update handed off a live TERMINAL HANDLE
    // (content: [{terminalId, type:"terminal"}]) — goose marks the update
    // status="completed" the instant the terminal is created, but the COMMAND is
    // still running async in that terminal; the real finish is a LATER update. We
    // must not emit a TOOL_CALL_RESULT (which folds a result onto the part and makes
    // the UI show the tool as done) until that later update — otherwise a long
    // command (sleep 30) shows no running state. See handleUpdate.
    terminalPending: Set<string>;
    // The dead-on-arrival watchdog (see firstActivityTimeoutMs): armed at
    // RUN_STARTED, disarmed by the FIRST ACP update. `sawActivity` guards against a
    // late update re-firing anything once the run is alive.
    sawActivity?: boolean;
    activityTimer?: ReturnType<typeof setTimeout>;
    // The mid-stream LIVENESS watchdog (see livenessProbeMs): a rearming timer that
    // probes acpClient.isAlive() and terminates the run ONLY if the agent process
    // has died without a terminal event. Silence alone never fires it.
    livenessTimer?: ReturnType<typeof setTimeout>;
    // Set once a terminal event (RUN_FINISHED/RUN_ERROR) has been emitted for this
    // run — by the watchdog OR the normal path — so the other path can't emit a
    // SECOND terminal (which would corrupt the @ag-ui stream).
    terminated?: boolean;
    // Set true when the run ended with a TRANSIENT/RECOVERABLE failure that the pump
    // should AUTO-RETRY: the agent PROCESS died (agent_process_died), started but went
    // silent (no_activity_timeout, usually a transient credential/model blip), or the
    // ACP call threw (init/session/stream failure). NOT set for a clean finish, a user
    // cancel, or a genuine model-reported error ("agent reported an error") — those are
    // real terminal states, not crashes to retry.
    retryable?: boolean;
  }

  /** A tool_call_update's content is JUST a live terminal HANDLE
   *  ([{terminalId, type:"terminal"}]) — goose created the terminal and considers
   *  the tool call structurally "completed", but the command runs async in it; the
   *  actual finish arrives on a LATER update. Such an update is NOT the real result. */
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

  // goose's shell tool is usually invoked as `<shell> -c "<script>"` — collapse that
  // to just the script (what the user cares about); otherwise join command + args.
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
  // Emit TOOL_CALL_ARGS exactly ONCE per tool call, from whichever ACP update
  // first carries a non-empty rawInput (the initial tool_call OR a later
  // tool_call_update — goose often uses the latter). Guards against a null/empty
  // rawInput and against double-emitting the args.
  const emitArgsOnce = (st: RunState, toolCallId: string, rawInput: unknown) => {
    if (st.argsEmitted.has(toolCallId)) return;
    if (rawInput === undefined || rawInput === null) return;
    // An empty object ({}) carries nothing useful — wait for a real update.
    if (typeof rawInput === "object" && Object.keys(rawInput as object).length === 0) return;
    st.argsEmitted.add(toolCallId);
    emit({ type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(rawInput) });
  };

  const handleUpdate = (st: RunState, u: SessionUpdate) => {
    if (st.ended) return; // never reopen a message after the run is finishing
    // First ACP activity — the run is ALIVE, so disarm the dead-on-arrival
    // watchdog. (Guarded by st.ended above: an update arriving after the watchdog
    // already fired is ignored, not treated as a late revival.)
    if (!st.sawActivity) {
      st.sawActivity = true;
      if (st.activityTimer) {
        clearTimeout(st.activityTimer);
        st.activityTimer = undefined;
      }
    }
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        // Reasoning and text are distinct streams; close reasoning first.
        closeOpenReasoning(st);
        // Run the chunk through the title extractor: an agent-emitted
        // <title>…</title> marker is pulled out (-> onTitle) and stripped from
        // the text the user sees.
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
        emitArgsOnce(st, u.toolCallId, u.rawInput);
        emit({ type: "TOOL_CALL_END", toolCallId: u.toolCallId });
        st.toolMessage.set(u.toolCallId, nextId("msg"));
        st.inFlightTools++; // a tool call is now running (see the "thinking" policy)
        break;
      }
      case "tool_call_update": {
        // The args (the shell command / the slack text) often arrive HERE, not on
        // the initial tool_call — goose sends the tool_call with no rawInput and
        // fills it in on this update. Emit them now if we haven't yet, so the UI
        // can show WHAT was requested (not just the result).
        emitArgsOnce(st, u.toolCallId, u.rawInput);
        // Deciding when a tool call is REALLY finished, from goose's shell shape
        // (captured live):
        //   tool_call(Shell)
        //   update{completed, no content}                    ← speculative, NOT done
        //   update{completed, content:[{terminalId,…}]}      ← command STARTED in a terminal
        //   … (command runs; sleep 30 blocks here) …
        //   update{completed, no content}                    ← the REAL finish
        // goose marks EVERY update status="completed", and the empty ones bracket the
        // real work, so `status==="completed"` alone is not "done". We emit the
        // TOOL_CALL_RESULT (which folds a result onto the part → UI shows the tool as
        // finished) only on a genuine finish; until then the part stays result-less so
        // the UI shows a running spinner (e.g. across a `sleep 30`).
        const status = (u as { status?: string }).status;
        // The structured result rides `content` (goose) OR `rawOutput` (the claude-sdk
        // provider — its adapter maps a tool_result's content to rawOutput). Either is
        // "real content" that finishes the tool + carries a result to the UI; without
        // the rawOutput fallback, EVERY claude MCP tool result was dropped (no
        // TOOL_CALL_RESULT), so e.g. a marimo_embed island never reached the chat.
        const resultContent = u.content !== undefined ? u.content : u.rawOutput;
        const hasRealContent = resultContent !== undefined && !isTerminalHandoff(resultContent);
        // A TERMINAL HANDOFF means the command is now running async in that terminal.
        // Remember it and DON'T finish — the real finish is a later update.
        if (isTerminalHandoff(u.content)) {
          st.terminalPending.add(u.toolCallId);
          // Surface the command that ran (goose put it in terminal/create, not in
          // the tool_call's rawInput) as this tool call's args, so the UI shows
          // `$ <command>` instead of an empty shell card. Look it up by terminalId.
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
        // The tool is finished when EITHER: it produced real (non-terminal) content,
        // OR it completed/failed AFTER a terminal was handed off (the post-terminal
        // update). A bare completed/failed with NO content and NO prior terminal is
        // goose's SPECULATIVE marker — skip it, or we'd finish the tool before it ran.
        const isFinish = hasRealContent || ((status === "completed" || status === "failed") && terminalWasPending);
        if (!isFinish) break;
        st.terminalPending.delete(u.toolCallId);
        if (st.inFlightTools > 0) {
          st.inFlightTools--;
          // A "thinking" interrupt that deferred while a tool call ran fires now
          // that the tool boundary is reached (and no other tool call is in flight).
          if (st.cancelWhenToolsIdle && st.inFlightTools === 0) {
            st.cancelWhenToolsIdle = false;
            void self.cancel().catch(() => {});
          }
        }
        const messageId = st.toolMessage.get(u.toolCallId) ?? nextId("msg");
        emit({
          type: "TOOL_CALL_RESULT",
          toolCallId: u.toolCallId,
          messageId,
          content: typeof resultContent === "string" ? resultContent : JSON.stringify(resultContent ?? ""),
        });
        break;
      }
      case "context_usage": {
        // Context-window fill after the turn — forward it as its own event for the
        // UI's fill bar. Persisted, so the latest value survives a refresh.
        emit({ type: "CONTEXT_USAGE", usedTokens: u.usedTokens, contextWindow: u.contextWindow });
        break;
      }
    }
  };

  // The actual run, executed serially via the prompt() chain above. One run at a
  // time per bridge — see the runChain comment.
  // Combine a batch of queued user messages into the single text sent to goose.
  // When the user fired several messages while a run was in flight, they all
  // queued; sending them as ONE turn (instead of one-at-a-time) means the agent
  // reads the whole burst at once — it never answers message 1, then re-reads a
  // now-stale message 2 and gets confused. A single message is passed through
  // verbatim; a burst is joined so each is a distinct, ordered block.
  const combineTexts = (texts: string[]): string =>
    texts.length === 1
      ? texts[0]
      : "The user sent several messages while you were working — handle them together as one request:\n\n" +
        texts.map((t, i) => `[Message ${i + 1}]\n${t}`).join("\n\n");

  const runPrompt = async (
    input: PromptInput,
    batch: PromptInput[] = [input],
    // A RETRY re-drives the same batch; the user's message is already in the log from
    // the first attempt. Re-persisting it wrote the same prompt 6 times on a run that
    // wedged and retried 5 times, inflating the very history the next attempt reads.
    alreadyPersisted = false,
  ): Promise<{ runId: RunId; retryable: boolean }> => {
    const runId = nextId("run");
    const st: RunState = { runId, threadId: input.threadId, toolMessage: new Map(), argsEmitted: new Set(), inFlightTools: 0, terminalPending: new Set() };
    const startedAt = Date.now();
    st.startedAt = startedAt;
    currentRun = st; // visible to cancel() from the moment the run begins
    let outcome: "ok" | "error" = "ok";

    // Emit RUN_STARTED before any awaiting so the UI sees the run begin even if
    // agent startup is slow or fails (e.g. goose needs a model provider).
    emit({ type: "RUN_STARTED", threadId: input.threadId, runId });

    // DEAD-ON-ARRIVAL watchdog: if the agent emits no ACP activity within
    // firstActivityTimeoutMs, treat the run as wedged and surface a RUN_ERROR so the
    // conversation unfreezes (observed: goose hung on a model-provider credential
    // failure, emitted nothing, and never returned from prompt()). Disarmed by the
    // first update in handleUpdate. We mark the run ended + cancel goose so the stuck
    // subprocess unblocks; the prompt()'s own resolution/rejection is then ignored
    // (st.ended guards it, and the finally clears everything).
    if (firstActivityTimeoutMs > 0) {
      st.activityTimer = setTimeout(() => {
        if (st.sawActivity || st.ended) return;
        st.ended = true;
        st.terminated = true; // the watchdog owns this run's terminal event now
        closeOpenText(st);
        closeOpenReasoning(st);
        outcome = "error";
        // LOUD: the RUN_ERROR below tells the USER to check these logs, so this must be
        // in them. Without it a wedged-then-retried run leaves no trace at all — the
        // only evidence is a "prompt: sending" with no matching "returned".
        log.warn("run wedged: no ACP activity before the deadline (dead on arrival)", {
          run_id: st.runId,
          waited_ms: firstActivityTimeoutMs,
          retryable: true,
        });
        emit({
          type: "RUN_ERROR",
          message:
            "The agent didn't respond — it started but produced nothing. This usually " +
            "means a model/credential error (e.g. the Bedrock role can't be assumed). " +
            "Try again; if it persists, check the agent-host logs.",
          code: "no_activity_timeout",
        });
        st.retryable = true; // transient (credential/model blip) — the pump auto-retries with backoff
        // The SESSION is suspect, not just this prompt: a session that produced nothing
        // produces nothing on the retry too (observed: 5 identical dead-on-arrival runs
        // through one cached session after a cancel left it wedged). Force a fresh one.
        dropCachedSession("no ACP activity before the deadline");
        // Unblock the wedged goose so the next prompt gets a fresh run.
        void self.cancel(runId).catch(() => {});
      }, firstActivityTimeoutMs);
    }

    // LIVENESS watchdog: a rearming probe that force-terminates a run ONLY when the
    // agent PROCESS has died (crashed/exited) without emitting a terminal event — an
    // unambiguous wedge that would otherwise block the pump's queue forever. It does
    // NOT guess from silence: a long tool call is silent but healthy (the agent is
    // alive; the ExecBackend commandTimeoutMs already bounds a hung command). So a
    // tool in flight, a paused permission request, or an alive-but-idle agent all
    // just re-arm. The DOA watchdog (firstActivityTimeoutMs) covers "never started".
    if (livenessProbeMs > 0) {
      const armLiveness = () => {
        st.livenessTimer = setTimeout(() => {
          if (st.ended || st.terminated) return;
          // DEFINITIVE health signal: is the agent process still alive? If it is
          // (or we can't tell — no client yet), keep watching; silence is fine.
          if (!acpClient || acpClient.isAlive()) return armLiveness();
          // The agent DIED without a terminal event — the run is genuinely wedged.
          st.ended = true;
          st.terminated = true; // this watchdog owns the terminal event now
          closeOpenText(st);
          closeOpenReasoning(st);
          outcome = "error";
          // LOUD, same reason as the DOA watchdog: the user is told to check these logs.
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
        }, livenessProbeMs);
        // Don't let this timer keep the process alive on its own.
        (st.livenessTimer as { unref?: () => void }).unref?.();
      };
      armLiveness();
    }

    // Message ids persisted for THIS turn — the reinjection below reads the log AFTER the
    // session is resolved (it cannot know which session runs until then), which is after the
    // current turn is persisted; excluding these ids keeps the preamble strictly PRIOR turns,
    // so the message being sent is never folded into its own history.
    const thisTurnIds = new Set<string>();

    // Persist the user's prompt(s) as messages so the conversation history is
    // complete — switching to / reviving a conversation must replay the user
    // turns too. PERSIST-ONLY: the live UI already renders the message the user
    // just sent, so broadcasting it would echo a duplicate. NOTE: persist the RAW
    // texts (not the history-prefixed / batch-joined prompt), so the transcript is
    // never folded back into itself on the next revive. A batched turn persists
    // EACH original message as its own user message — history stays faithful even
    // though goose received them combined as one prompt.
    for (const b of alreadyPersisted ? [] : batch) {
      // A PLATFORM-injected message persists as a SYSTEM_MESSAGE (hideable in the UI),
      // NOT a role:user turn — the human didn't type it. The agent still receives the
      // (decorated) text below. A normal human message persists as user text.
      if (b.source) {
        const sysId = nextId("sys");
        thisTurnIds.add(sysId);
        persist({ type: "SYSTEM_MESSAGE", messageId: sysId, source: b.source, text: b.text });
        continue;
      }
      const userMsgId = nextId("user");
      thisTurnIds.add(userMsgId);
      persist({ type: "TEXT_MESSAGE_START", messageId: userMsgId, role: "user" });
      persist({ type: "TEXT_MESSAGE_CONTENT", messageId: userMsgId, delta: b.text });
      persist({ type: "TEXT_MESSAGE_END", messageId: userMsgId });
      // Attach the message's images as REFERENCES (assetId + url, not bytes) so a
      // refresh re-renders them under this user message. The url is the fixed
      // assets-route shape (same as AssetStore.urlFor); the UI fetches it.
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
      // PER-RUN provider selection: resolve the provider for THIS run's context (owner + trigger
      // source) and point acpClient/acpSessionId at its ready client. Under Increment-1 config a
      // single provider is eligible, so this returns the same client every run (behavior-
      // identical). Increment 2's remote provider makes this vary by source (human vs scheduled).
      await resolveForRun(runContextFor(input));
      debug("[bridge] prompt: sending to goose, session=%s", acpSessionId);
      // PER-SESSION reinjection (see injectedSessions above): if the session THIS run resolved
      // to has never been seeded with this conversation's transcript, seed it now — that is
      // what lets a BYO container that has never seen the conversation resume it, fed over the
      // same wire as everything else. Strictly prior turns (thisTurnIds excluded).
      let historyPreamble = "";
      if (deps.loadHistory && currentReady && !currentReady.historySeeded) {
        currentReady.historySeeded = true;
        try {
          const events = await deps.loadHistory();
          historyPreamble = buildHistoryPreamble(
            events.filter((e) => !thisTurnIds.has((e as { messageId?: string }).messageId ?? "")),
          );
        } catch (err) {
          debug("[bridge] loadHistory failed (continuing without reinjection): %s", err);
        }
      }
      // Prepend the history preamble as a separate text block on the first prompt
      // of a revived session (empty → omitted). The user text is the COMBINED batch
      // (a burst of queued messages sent as one turn), so the agent reads them all
      // at once instead of one-at-a-time.
      // Decorate SYSTEM-sourced items so the agent knows they're platform events (not
      // the user), then combine the burst into one prompt. Human items pass through.
      const combined = combineTexts(batch.map((b) => (b.source ? decorateSystemMessage(b.source, b.text) : b.text)));
      const textBlocks: ContentBlock[] = historyPreamble
        ? [{ type: "text", text: historyPreamble }, { type: "text", text: combined }]
        : [{ type: "text", text: combined }];
      // Resolve attached images to ACP image blocks (base64), appended after the
      // text so the model sees them with the message. Missing/unreadable assets are
      // skipped (best-effort — a dropped image must not fail the turn). No images
      // (or no readAsset dep) → the text-only prompt is unchanged.
      const imageBlocks: ContentBlock[] = [];
      const images = batch.flatMap((b) => b.images ?? []);
      if (images.length && deps.readAsset) {
        for (const img of images) {
          const bytes = await deps.readAsset(img.assetId).catch(() => null);
          if (bytes) imageBlocks.push({ type: "image", data: bytes.data.toString("base64"), mimeType: bytes.mimeType });
        }
      }
      // Materialize any binary file attachments (Slack pdf/zip/…) into the sandbox
      // at /workspace/.slack/<name> so the agent can read them from disk (the woven
      // message text references those paths). Best-effort: a failed write is logged
      // and skipped — it must not kill the turn. No files → the path is unchanged.
      const files = batch.flatMap((b) => b.files ?? []);
      if (files.length) {
        for (const f of files) {
          try {
            await writeSlackFile(deps.exec, f);
          } catch (err) {
            debug("[bridge] failed to write slack file %s (continuing): %s", f.name, err);
          }
        }
      }
      const promptBlocks = [...textBlocks, ...imageBlocks];
        // The turn boundary, structured. A turn that produces neither a reply NOR an
        // error left no trace at all on a real cluster — debug() only surfaces behind a
        // flag, so the whole prompt path was silent. These two lines bracket the one
        // call that can hang, and say which provider actually took the run.
        log.info("acp prompt: sending", {
          run_id: st.runId,
          blocks: promptBlocks.length,
          has_session: acpSessionId !== undefined,
        });
      const { stopReason } = await acpClient!.prompt({
        sessionId: acpSessionId!,
        prompt: promptBlocks,
      });
      debug("[bridge] prompt: stopReason=%s", stopReason);
        log.info("acp prompt: returned", { run_id: st.runId, stop_reason: stopReason });
      // The ACP prompt response can resolve before the final session/update
      // notifications have been dispatched. Drain a macrotask so trailing
      // text/reasoning chunks are processed (their messages opened) BEFORE we
      // close them and emit RUN_FINISHED — the AG-UI client rejects RUN_FINISHED
      // while a message is still open.
      await drain();
      st.ended = true; // stop routing further late updates into this run
      closeOpenText(st);
      closeOpenReasoning(st);
      // If the dead-on-arrival watchdog already terminated this run (goose finally
      // returned AFTER we gave up), don't emit a second terminal event.
      if (!st.terminated) {
        st.terminated = true;
        if (st.cancelled || stopReason === "cancelled") {
          // Stopped by the user / a force-interrupt — a CLEAN end, not an error.
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
      // The watchdog's self.cancel() makes the pending prompt() reject here — but the
      // watchdog already emitted RUN_ERROR, so skip a duplicate terminal.
      if (!st.terminated) {
        st.terminated = true;
        if (st.cancelled) {
          // A cancel that made the ACP prompt reject (e.g. session/cancel aborted
          // the call) is still a clean user stop — don't surface it as an error.
          emit({ type: "RUN_FINISHED", threadId: input.threadId, runId, cancelled: true });
        } else {
          outcome = "error";
          const raw = err instanceof Error ? err.message : String(err);
          emit({ type: "RUN_ERROR", message: clarifyRunError(raw) });
          st.retryable = true; // the ACP call threw (init/session/stream) — transient; pump retries
          // A DEAD REMOTE SESSION (the BYO container restarted; its per-session clients are
          // gone) is not transient for the CACHED session — every retry through it fails
          // identically, and before the container refused unknown sessions it silently served
          // them from a blank client (the "agent has no context" amnesia). Drop this
          // provider's cached ready-session so the pump's next attempt re-initializes on the
          // CURRENT container instance — and, because that mints a new session key, the
          // history reinjection fires again.
          if (/unknown session/i.test(raw) && currentProviderId) {
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

  // Force-interrupt: while a run is active, if the highest-priority QUEUED item is
  // a priority item that has waited past the timeout, cancel the running turn so it
  // can take over. Armed only when priorityInterruptMs > 0 and a priority item is
  // waiting; re-checked each pump tick + on a timer.
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  const clearInterruptTimer = () => {
    if (interruptTimer) { clearTimeout(interruptTimer); interruptTimer = undefined; }
  };
  // Apply the waiting priority item's interrupt policy against the running turn:
  //   - "tool-call": cancel NOW (cancel() kills the in-flight tool call).
  //   - "thinking" : cancel now IF no tool call is in flight; else defer to the
  //                  next tool-call boundary (cancelWhenToolsIdle) — AND arm the
  //                  timeout fallback, so a tool that NEVER yields (a real
  //                  `sleep 3600`, not a short poll) still gets hard-cancelled after
  //                  priorityInterruptMs rather than deferring forever.
  //   - "timeout"  : arm the timer; cancel after priorityInterruptMs still waiting.
  // Re-evaluated on each enqueue + pump tick. A no-op with no run / no priority item.
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
    // "timeout": the historical behavior. Disabled when priorityInterruptMs <= 0.
    armTimeoutFallback(head);
  };

  const topPriorityItem = (): QueueItem | undefined => {
    if (queue.length === 0) return undefined;
    // Highest priority, ties broken by earliest enqueue (stable FIFO within tier).
    return queue.reduce((best, it) =>
      it.priority > best.priority || (it.priority === best.priority && it.enqueuedAt < best.enqueuedAt) ? it : best,
    );
  };

  // Drain the queue one run at a time (the single goose session), highest priority
  // first. Preserves the "one run fully completes before the next RUN_STARTED"
  // invariant by awaiting each runPrompt fully.
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const item = topPriorityItem()!;
        // BATCH: coalesce every OTHER queued item of the SAME priority tier into
        // this run, in FIFO (enqueue) order. When the user fired a burst of
        // messages while a run was in flight, they all queued at the same tier;
        // sending them as ONE turn means the agent reads the whole burst at once
        // instead of answering the first then re-reading a stale later one. Only
        // same-tier items batch — a priority @mention never merges with normal
        // messages (it may need to force-interrupt on its own terms). The picked
        // item leads (it's the highest-priority / earliest); its tier-mates follow.
        const batch = [item, ...queue.filter((q) => q !== item && q.priority === item.priority)]
          .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
        for (const b of batch) queue.splice(queue.indexOf(b), 1);
        runningBatch = batch; // in-flight: not in `queue`, but must survive a suspend
        // The batch just left the queue to run — surface the shrunk queue (the
        // running batch will render as normal user messages via runPrompt's
        // persist). An empty queue emits items:[] so the UI clears its queued list.
        emitQueueSnapshot();
        clearInterruptTimer(); // the batch is now running, not waiting
        try {
          // AUTO-RETRY on transient death: the agent process can crash / go silent / fail to
          // init mid-run (agent_process_died, no_activity_timeout, an ACP throw). Rather than
          // strand the user's prompt on a dead-end error, re-drive THIS batch with exponential
          // backoff. Crucially this only re-runs the failed batch — the REST OF THE QUEUE is
          // untouched (items queued behind it survive and run after). A genuine model error
          // ("agent reported an error") or a user cancel is NOT retryable → we stop immediately.
          const inputs = batch.map((b) => b.input);
          let res = await runPrompt(batch[0].input, inputs);
          for (let attempt = 1; res.retryable && attempt <= RETRY_MAX; attempt++) {
            const delayMs = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
            // A run that fails and silently succeeds on retry looks to the user like
            // "it failed once" with nothing to point at afterwards.
            log.warn("retrying a wedged run", { attempt, max: RETRY_MAX, delay_ms: delayMs });
            emit({ type: "RUN_RETRYING", threadId: batch[0].input.threadId, attempt, max: RETRY_MAX, delayMs });
            await new Promise((r) => setTimeout(r, delayMs));
            if (closed) break; // bridge stopped while backing off — abandon the retry
            res = await runPrompt(batch[0].input, inputs, true);
          }
          if (res.retryable) {
            log.error("run FAILED after exhausting retries", { attempts: RETRY_MAX });
          }
          for (const b of batch) b.resolve(res.runId); // all coalesced items share the (last) run
        } catch (err) {
          for (const b of batch) b.reject(err);
        } finally {
          runningBatch = [];
        }
        // A new priority item may have queued during that run — re-evaluate its
        // preemption against the (next) run.
        applyPreemption();
      }
    } finally {
      pumping = false;
      clearInterruptTimer();
    }
  };

  // --- ACP client resolution (per-run provider selection) ---------------------------------
  // The RunContext for a run: this conversation + its owner + the run's trigger source. The
  // ported Increment-1 providers ignore owner/source (single eligible provider), so selection is
  // stable; Increment 2's remote provider keys on them.
  const defaultRunContext = (): RunContext => ({
    conversationId: sessionId,
    owner: deps.owner,
  });
  const runContextFor = (input: PromptInput): RunContext => ({
    conversationId: sessionId,
    owner: deps.owner,
    source: input.source,
  });

  // Lazily ready ONE client per provider: initialize → newSession → wire the update/terminal/
  // permission hooks ONCE (the same lifecycle the old single-client start() ran). Cached by
  // provider id; a failed init drops the cache entry so the next run retries.
  const readyProvider = (provider: AcpProvider): Promise<{ client: AcpClient; acpSessionId: string; historySeeded: boolean }> => {
    let ready = readySessions.get(provider.id);
    if (ready) return ready;
    ready = (async () => {
      debug("[bridge] readyProvider(%s): createClient + initialize", provider.id);
      const client = await provider.createClient(defaultRunContext());
      await client.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      });
      // The model THIS provider's session runs: the conversation's choice when this provider
      // offers it, else the provider's own default. Sending the raw choice regardless handed a
      // Bedrock id to the BYO container (which ignored it entirely) — the provider dimension
      // makes the substitution explicit instead of silent nonsense.
      const model =
        deps.modelCatalog
          ? deps.model && modelAllowedFor(deps.modelCatalog, deps.model, provider.modelTag)
            ? deps.model
            : defaultFor(deps.modelCatalog, provider.modelTag)
          : deps.model;
      // A provider that cannot reach the bridge's default MCP endpoint supplies its own set —
      // the BYO container gets tunnel NAMES it proxies locally, since the default is a
      // loopback URL only in-cluster agents can reach.
      const mcpServers = provider.mcpServersFor?.(sessionId) ?? deps.config.mcpServers;
      const { sessionId: sid } = await client.newSession({
        cwd: deps.config.cwd,
        mcpServers,
        model,
      });
      debug("[bridge] readyProvider(%s): newSession -> %s", provider.id, sid);
      // Subscribe ONCE per client and route updates to the current run (handleUpdate keys on
      // currentRun; only the in-flight run's provider emits at a time).
      client.onSessionUpdate((sid, u) => {
        // FILTER BY SESSION. For goose this is always our own sid. For a BYO remote agent, all
        // of an owner's conversations share ONE wire; the relay routes by session, but this is
        // the defense-in-depth: an update for a session we are not driving must never be
        // applied to our run — that interleaves another conversation's transcript into ours.
        // An update with NO sid (older stacks) keeps the old behaviour.
        if (sid && acpSessionId && sid !== acpSessionId) return;
        if (currentRun) handleUpdate(currentRun, u);
      });
      // goose's shell tool carries the COMMAND in terminal/create, not the tool_call rawInput —
      // stash it by terminalId so the tool_call_update can show `$ <command>`.
      client.onTerminalCreated((terminalId, command, args) => {
        terminalCommands.set(terminalId, formatCommand(command, args));
      });
      // The agent asks the user to choose (ACP session/request_permission): emit a PERMISSION
      // interrupt + BLOCK the agent until answerPermission() resolves.
      client.onPermissionRequest(async (req) => {
        const run = currentRun;
        if (run) {
          closeOpenText(run);
          closeOpenReasoning(run);
        }
        const optionId = await new Promise<string | null>((resolve) => {
          pendingPermissions.set(req.toolCallId, {
            resolve,
            validOptions: new Set(req.options.map((o) => o.optionId)),
          });
          emit({
            type: "RUN_FINISHED",
            threadId: run?.threadId ?? sessionId,
            runId: run?.runId ?? "run",
            outcome: {
              type: "interrupt",
              interrupts: [
                {
                  id: req.toolCallId,
                  reason: "confirmation",
                  message: req.title ?? "The agent needs your choice",
                  toolCallId: req.toolCallId,
                  metadata: { options: req.options },
                },
              ],
            },
          });
        });
        pendingPermissions.delete(req.toolCallId);
        // PERSIST-ONLY record for history replay (not a live AG-UI event).
        persist({ type: "PERMISSION_RESOLVED", toolCallId: req.toolCallId, optionId });
        if (run) {
          emit({ type: "RUN_STARTED", threadId: run.threadId, runId: run.runId });
          run.ended = false;
        }
        return optionId ? { optionId } : { cancelled: true as const };
      });
      return { client, acpSessionId: sid, historySeeded: false };
    })();
    readySessions.set(provider.id, ready);
    ready.catch(() => readySessions.delete(provider.id));
    return ready;
  };

  // Resolve the provider for a run + set acpClient/acpSessionId to its ready client. Throws if no
  // provider is eligible (a registry must include an always-eligible floor).
  const resolveForRun = async (ctx: RunContext): Promise<void> => {
    const provider = await pickAcpProvider(acpProviders, ctx);
    if (!provider) {
      throw new Error(
        `no ACP provider eligible (source=${ctx.source ?? "-"}, owner=${ctx.owner ?? "-"})`,
      );
    }
    const ready = await readyProvider(provider);
    acpClient = ready.client;
    acpSessionId = ready.acpSessionId;
    currentProviderId = provider.id;
    currentReady = ready;
  };

  const self: SessionBridge = {
    sessionId,

    async start() {
      if (started) return;
      // Warm the provider eligible for a default (interactive, human) context. The run loop
      // re-resolves per run; this just establishes the first session so start() keeps its
      // "connection ready" contract. resolveForRun sets acpClient/acpSessionId.
      await resolveForRun(defaultRunContext());
      started = true;
    },

    prompt(input: PromptInput, opts?: PromptOptions): Promise<RunId> {
      // Enqueue and let the pump drain one run at a time on this bridge's single
      // goose session — highest priority first, FIFO within a tier. Each run fully
      // completes (its text closed + RUN_FINISHED emitted) before the next
      // RUN_STARTED (the concurrent-run corruption guard). A priority prompt jumps
      // ahead of queued normal prompts AND can PREEMPT the running turn per its
      // interrupt policy (timeout / thinking / tool-call).
      const priority = opts?.priority ?? PRIORITY_NORMAL;
      const interrupt: InterruptPolicy = opts?.interrupt ?? "timeout";
      const p = new Promise<RunId>((resolve, reject) => {
        queue.push({ id: nextId("queue"), input, priority, interrupt, enqueuedAt: Date.now(), resolve, reject });
      });
      // Surface the (now longer) queue so a message waiting behind an active run
      // shows up durably — and doesn't vanish on refresh. When nothing is running,
      // pump() drains it immediately and emits the empty snapshot on the way out,
      // so a normal single prompt just flashes through.
      emitQueueSnapshot();
      if (priority >= PRIORITY_INTERRUPT) applyPreemption();
      void pump();
      return p;
    },

    async cancel(_runId?: RunId, userInitiated = false) {
      // Stop the RUNNING turn: mark it cancelled (so it ends as RUN_FINISHED
      // cancelled, not an error), KILL its active tool call (a running shell), then
      // tell goose to stop (session/cancel unblocks the prompt). A no-op if nothing
      // is running. Queued prompts stay queued — the next runs after.
      const run = currentRun;
      if (!run || !acpClient) return;
      run.cancelled = true;
      // USER stops persist their intent (see CANCEL_REQUESTED in the event union).
      // Internal cancels (model switch, priority preemption) do NOT: they cancel in
      // order to immediately continue, and a persisted intent would make a
      // reassignment terminate the very run their nudge starts... the marker names
      // THIS runId, so only the run being stopped can match it later.
      if (userInitiated) emit({ type: "CANCEL_REQUESTED", threadId: run.threadId, runId: run.runId });
      try {
        // This is what actually ends the run: killing the shell makes the prompt
        // return. session/cancel alone does not (the fake agent ignores it).
        // Only a USER stop gets the pending-spawn grace window. Preemption must leave the
        // next terminal alone: it belongs to the run that did the preempting.
        await acpClient.killActiveTerminals(userInitiated);
      } catch (e) {
        // Was `catch {}` — a swallowed failure here presents as a dead Stop button.
        log.warn("killActiveTerminals failed", { error: formatError(e) });
        /* best-effort — session/cancel below still stops goose */
      }
      if (acpSessionId) await acpClient.cancel(acpSessionId);
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

    recordRawInput,

    drainQueue() {
      // Include the batch the pump is CURRENTLY running: it was spliced out of `queue`
      // to run, so on a mid-run suspend it is in-flight and invisible to `queue` alone.
      // Its run is about to be killed with the pod (runPrompt throws → the item rejects),
      // so without capturing it here the user's message is destroyed — the very case
      // this preservation exists for. Running items lead (they were picked first).
      const inFlight = runningBatch;
      runningBatch = [];
      const waiting = queue.splice(0, queue.length);
      if (waiting.length === 0 && inFlight.length === 0) return [];
      // The log's final word on the queue must be "empty" — see the interface doc.
      emitQueueSnapshot();
      // REJECT only the items that never STARTED. An in-flight item is a run that is
      // already executing: its promise settles through the pump's own resolve/reject
      // when runPrompt returns (or throws as the pod goes away). Rejecting it here
      // too would turn a NORMAL turn into a RUN_ERROR — a suspend that lands just as
      // a run is finishing (waitForReply returns on the reply TEXT, before the run
      // terminates) would report "the conversation was suspended before this queued
      // message could run" for a message that in fact ran and answered.
      for (const item of waiting) {
        item.reject(
          new Error("the conversation was suspended before this queued message could run"),
        );
      }
      // Preserve BOTH for replay: the in-flight item may be cut short mid-run by the
      // teardown, so its text is re-enqueued on revive (idempotent from the user's
      // point of view — a turn that already completed simply re-asks).
      return [...inFlight, ...waiting].map((q) => ({ text: q.input.text, priority: q.priority }));
    },

    async stop() {
      closed = true; // abandon any in-progress death-retry backoff
      clearInterruptTimer();
      // DRAIN THE QUEUE. A suspend (or model switch / rollout) tears the bridge down
      // via stop() and then DROPS it (manager.suspend: `entry.bridge = undefined`),
      // and revive() builds a brand-new bridge with a fresh empty queue — so anything
      // still queued here can never run on this bridge. Left alone that produced two
      // bugs: the queued prompt() promises leaked (an awaiting caller hung forever),
      // and the last persisted QUEUE_UPDATED still LISTED the items, so a reattaching
      // UI folded a phantom queued row nothing would ever drain.
      // manager.suspend() calls drainQueue() FIRST to persist the items (so revive
      // re-runs them); this call is the belt-and-braces path for every OTHER stop()
      // caller (model switch, end, shutdown) so a teardown never leaks or leaves a
      // stale snapshot behind.
      self.drainQueue();
      // Close EVERY started provider client (there may be more than one after provider switches).
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
    answerPermission(toolCallId, optionId, approver) {
      const pending = pendingPermissions.get(toolCallId);
      if (!pending) return false; // no such pending request (or already answered)
      // An unknown optionId cancels rather than forwarding a garbage selection.
      const chosen = pending.validOptions.has(optionId) ? optionId : null;
      if (pending.onExternal) {
        // External interrupt (e.g. broker AWS request): no blocked goose run —
        // fire the callback (with the answering user's identity) + clean up +
        // record the resolution for replay.
        pendingPermissions.delete(toolCallId);
        persist({ type: "PERMISSION_RESOLVED", toolCallId, optionId: chosen });
        pending.onExternal(chosen, approver);
      } else {
        pending.resolve(chosen); // unblocks the goose ACP requestPermission call
      }
      return true;
    },
    raiseInterrupt({ id, message, options, onAnswer, metadata }) {
      pendingPermissions.set(id, {
        resolve: () => {},
        validOptions: new Set(options.map((o) => o.optionId)),
        onExternal: onAnswer,
      });
      // Emit the interrupt on the conversation stream (not tied to a run). The UI
      // surfaces it via assistant-ui's pending interrupts; answerPermission(id, …)
      // resolves it. threadId == sessionId for a bridge.
      emit({
        type: "RUN_FINISHED",
        threadId: sessionId,
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
