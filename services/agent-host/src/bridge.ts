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
import type { AcpClient, SessionUpdate } from "./acp/client.js";
import { debug } from "./debug.js";
import { createTitleExtractor } from "./agent/titleMarker.js";
import { buildHistoryPreamble } from "./agent/transcript.js";

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
  | { type: "RUN_STARTED"; threadId: ThreadId; runId: RunId }
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
  | { type: "QUEUE_UPDATED"; items: Array<{ id: string; text: string; priority: number }> };

/** A user prompt entering the run (maps to ACP session/prompt). */
export interface PromptInput {
  threadId: ThreadId;
  text: string;
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
  cancel(runId?: RunId): Promise<void>;
  stop(): Promise<void>;
  /** Snapshot of the run queue (for observability / the force-interrupt timer):
   *  whether a run is active, how long it's been going, and the queued backlog. */
  queueState(): { running: boolean; currentRunMs: number; queued: number; maxQueuedPriority: number };

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
  /**
   * The ACP client, or an async factory that creates one on first start().
   * Tests inject a ready in-process fake; production passes a factory that
   * spawns `goose acp` lazily (so the connection isn't established until the
   * first prompt). A factory avoids the brittle sync/async adapter shims.
   */
  acpClient: AcpClient | (() => Promise<AcpClient>);

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
  let started = false;
  // Revive history reinjection: this bridge is re-created per revive (a fresh
  // closure ⇒ fresh ACP session), so a bridge-scoped one-shot flag fires exactly
  // once — on the first prompt after (re)start — and naturally resets next revive.
  let historyInjected = false;
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
  // The run currently receiving ACP updates (set during runPrompt()).
  let currentRun: RunState | undefined;
  const priorityInterruptMs = deps.priorityInterruptMs ?? 0;
  const firstActivityTimeoutMs = deps.firstActivityTimeoutMs ?? 60_000;
  // Resolved on first start(); a ready client or the result of the factory.
  let acpClient: AcpClient | undefined =
    typeof deps.acpClient === "function" ? undefined : deps.acpClient;

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
  const stamp = <E extends AguiEvent>(event: E): E =>
    ("ts" in event ? event : { ...event, ts: Date.now() }) as E;

  const emit = (event: AguiEvent) => {
    // Broadcast subscribers (UI) AND persist subscribers (store) both see live
    // events.
    const e = stamp(event);
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
    // Set once a terminal event (RUN_FINISHED/RUN_ERROR) has been emitted for this
    // run — by the watchdog OR the normal path — so the other path can't emit a
    // SECOND terminal (which would corrupt the @ag-ui stream).
    terminated?: boolean;
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
        const hasRealContent = u.content !== undefined && !isTerminalHandoff(u.content);
        // A TERMINAL HANDOFF means the command is now running async in that terminal.
        // Remember it and DON'T finish — the real finish is a later update.
        if (isTerminalHandoff(u.content)) {
          st.terminalPending.add(u.toolCallId);
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
          content: typeof u.content === "string" ? u.content : JSON.stringify(u.content ?? ""),
        });
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

  const runPrompt = async (input: PromptInput, batch: PromptInput[] = [input]): Promise<RunId> => {
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
        emit({
          type: "RUN_ERROR",
          message:
            "The agent didn't respond — it started but produced nothing. This usually " +
            "means a model/credential error (e.g. the Bedrock role can't be assumed). " +
            "Try again; if it persists, check the agent-host logs.",
          code: "no_activity_timeout",
        });
        // Unblock the wedged goose so the next prompt gets a fresh run.
        void self.cancel(runId).catch(() => {});
      }, firstActivityTimeoutMs);
    }

    // REVIVE reinjection: on this bridge's FIRST prompt, snapshot the persisted
    // log (the PRIOR turns) BEFORE we append the current user turn below, so the
    // transcript never includes — and can't duplicate — the message we're about
    // to send. A fresh conversation's log is empty here → preamble "" → no-op.
    let historyPreamble = "";
    if (!historyInjected && deps.loadHistory) {
      historyInjected = true;
      try {
        historyPreamble = buildHistoryPreamble(await deps.loadHistory());
      } catch (err) {
        debug("[bridge] loadHistory failed (continuing without reinjection): %s", err);
      }
    }

    // Persist the user's prompt(s) as messages so the conversation history is
    // complete — switching to / reviving a conversation must replay the user
    // turns too. PERSIST-ONLY: the live UI already renders the message the user
    // just sent, so broadcasting it would echo a duplicate. NOTE: persist the RAW
    // texts (not the history-prefixed / batch-joined prompt), so the transcript is
    // never folded back into itself on the next revive. A batched turn persists
    // EACH original message as its own user message — history stays faithful even
    // though goose received them combined as one prompt.
    for (const b of batch) {
      const userMsgId = nextId("user");
      persist({ type: "TEXT_MESSAGE_START", messageId: userMsgId, role: "user" });
      persist({ type: "TEXT_MESSAGE_CONTENT", messageId: userMsgId, delta: b.text });
      persist({ type: "TEXT_MESSAGE_END", messageId: userMsgId });
    }

    try {
      if (!started || !acpSessionId) await self.start();
      debug("[bridge] prompt: sending to goose, session=%s", acpSessionId);
      // Prepend the history preamble as a separate text block on the first prompt
      // of a revived session (empty → omitted). The user text is the COMBINED batch
      // (a burst of queued messages sent as one turn), so the agent reads them all
      // at once instead of one-at-a-time.
      const combined = combineTexts(batch.map((b) => b.text));
      const promptBlocks = historyPreamble
        ? [{ type: "text" as const, text: historyPreamble }, { type: "text" as const, text: combined }]
        : [{ type: "text" as const, text: combined }];
      const { stopReason } = await acpClient!.prompt({
        sessionId: acpSessionId!,
        prompt: promptBlocks,
      });
      debug("[bridge] prompt: stopReason=%s", stopReason);
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
          emit({ type: "RUN_ERROR", message: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      // Always clear the watchdog timer (normal completion, error, or already fired).
      if (st.activityTimer) {
        clearTimeout(st.activityTimer);
        st.activityTimer = undefined;
      }
      if (currentRun === st) currentRun = undefined;
      // Metrics hook — fire-and-forget, never let it break the run.
      try {
        deps.onRunComplete?.({ acpSessionId, durationMs: Date.now() - startedAt, outcome });
      } catch {
        /* ignore */
      }
    }
    return runId;
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
        // The batch just left the queue to run — surface the shrunk queue (the
        // running batch will render as normal user messages via runPrompt's
        // persist). An empty queue emits items:[] so the UI clears its queued list.
        emitQueueSnapshot();
        clearInterruptTimer(); // the batch is now running, not waiting
        try {
          const runId = await runPrompt(batch[0].input, batch.map((b) => b.input));
          for (const b of batch) b.resolve(runId); // all coalesced items share the run
        } catch (err) {
          for (const b of batch) b.reject(err);
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

  const self: SessionBridge = {
    sessionId,

    async start() {
      if (started) return;
            debug("[bridge] start: creating ACP client");
      if (!acpClient) {
        acpClient = await (deps.acpClient as () => Promise<AcpClient>)();
      }
            debug("[bridge] start: client created, initialize()");
      await acpClient.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      });
            debug("[bridge] start: initialized, newSession(cwd=%s)", deps.config.cwd);
      const { sessionId: sid } = await acpClient.newSession({
        cwd: deps.config.cwd,
        mcpServers: deps.config.mcpServers,
      });
            debug("[bridge] start: newSession ->", sid);
      acpSessionId = sid;
      // Subscribe to updates ONCE for the lifetime of the session and route
      // them to the current run. Avoids per-prompt subscribe/unsubscribe (which
      // mis-wired updates across runs).
      acpClient.onSessionUpdate((_sid, u) => {
        if (currentRun) handleUpdate(currentRun, u);
      });

      // The agent asks the user to choose (ACP session/request_permission). We
      // emit a PERMISSION_REQUEST to the UI and BLOCK the agent on a promise that
      // answerPermission() resolves. The text/reasoning currently streaming is
      // closed first so the request renders as its own affordance.
      acpClient.onPermissionRequest(async (req) => {
        const run = currentRun;
        // Close any open text/reasoning so the run is well-formed before it pauses.
        if (run) {
          closeOpenText(run);
          closeOpenReasoning(run);
        }
        // Pause the run as an AG-UI INTERRUPT: RUN_FINISHED with outcome
        // "interrupt" carrying this request. assistant-ui surfaces it as a pending
        // interrupt and resumes via the next run's RunAgentInput.resume[]. The
        // ACP requestPermission call stays blocked here until answerPermission().
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
                  // The choices the UI renders + answers with.
                  metadata: { options: req.options },
                },
              ],
            },
          });
        });
        pendingPermissions.delete(req.toolCallId);
        // PERSIST-ONLY: PERMISSION_RESOLVED is OUR record for history replay, not
        // a standard AG-UI event — broadcasting it to the @ag-ui client would be
        // rejected (invalid event type). The store logs it; the live UI already
        // reflects the answer via assistant-ui's interrupt resolution.
        persist({ type: "PERMISSION_RESOLVED", toolCallId: req.toolCallId, optionId });
        // Resume: a fresh RUN_STARTED so the continued turn is well-formed.
        if (run) {
          emit({ type: "RUN_STARTED", threadId: run.threadId, runId: run.runId });
          run.ended = false;
        }
        return optionId ? { optionId } : { cancelled: true as const };
      });
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

    async cancel(_runId?: RunId) {
      // Stop the RUNNING turn: mark it cancelled (so it ends as RUN_FINISHED
      // cancelled, not an error), KILL its active tool call (a running shell), then
      // tell goose to stop (session/cancel unblocks the prompt). A no-op if nothing
      // is running. Queued prompts stay queued — the next runs after.
      const run = currentRun;
      if (!run || !acpClient) return;
      run.cancelled = true;
      try {
        await acpClient.killActiveTerminals();
      } catch {
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

    async stop() {
      clearInterruptTimer();
      if (acpClient) await acpClient.close();
      started = false;
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
