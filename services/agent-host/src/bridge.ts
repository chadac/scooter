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
  | { type: "PERMISSION_RESOLVED"; toolCallId: string; optionId: string | null };

/** A user prompt entering the run (maps to ACP session/prompt). */
export interface PromptInput {
  threadId: ThreadId;
  text: string;
}

/** Per-prompt options for the bridge's run queue. */
export interface PromptOptions {
  /** Higher runs sooner among queued items. A PRIORITY prompt (>0, e.g. an
   *  @scooter mention) may also force-interrupt the running turn after the
   *  configured timeout — a normal prompt (0) only waits its turn. Default 0. */
  priority?: number;
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
    input: PromptInput;
    priority: number;
    enqueuedAt: number;
    resolve: (runId: RunId) => void;
    reject: (err: unknown) => void;
  }
  const queue: QueueItem[] = [];
  let pumping = false;
  // The run currently receiving ACP updates (set during runPrompt()).
  let currentRun: RunState | undefined;
  const priorityInterruptMs = deps.priorityInterruptMs ?? 0;
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
  }

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
        break;
      }
      case "tool_call_update": {
        // The args (the shell command / the slack text) often arrive HERE, not on
        // the initial tool_call — goose sends the tool_call with no rawInput and
        // fills it in on this update. Emit them now if we haven't yet, so the UI
        // can show WHAT was requested (not just the result).
        emitArgsOnce(st, u.toolCallId, u.rawInput);
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
  const runPrompt = async (input: PromptInput): Promise<RunId> => {
    const runId = nextId("run");
    const st: RunState = { runId, threadId: input.threadId, toolMessage: new Map(), argsEmitted: new Set() };
    const startedAt = Date.now();
    st.startedAt = startedAt;
    currentRun = st; // visible to cancel() from the moment the run begins
    let outcome: "ok" | "error" = "ok";

    // Emit RUN_STARTED before any awaiting so the UI sees the run begin even if
    // agent startup is slow or fails (e.g. goose needs a model provider).
    emit({ type: "RUN_STARTED", threadId: input.threadId, runId });

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

    // Persist the user's prompt as a message so the conversation history is
    // complete — switching to / reviving a conversation must replay the user
    // turns too. PERSIST-ONLY: the live UI already renders the message the user
    // just sent, so broadcasting it would echo a duplicate. NOTE: persist the RAW
    // input.text (not the history-prefixed prompt), so the transcript is never
    // folded back into itself on the next revive.
    const userMsgId = nextId("user");
    persist({ type: "TEXT_MESSAGE_START", messageId: userMsgId, role: "user" });
    persist({ type: "TEXT_MESSAGE_CONTENT", messageId: userMsgId, delta: input.text });
    persist({ type: "TEXT_MESSAGE_END", messageId: userMsgId });

    try {
      if (!started || !acpSessionId) await self.start();
      debug("[bridge] prompt: sending to goose, session=%s", acpSessionId);
      // Prepend the history preamble as a separate text block on the first prompt
      // of a revived session (empty → omitted).
      const promptBlocks = historyPreamble
        ? [{ type: "text" as const, text: historyPreamble }, { type: "text" as const, text: input.text }]
        : [{ type: "text" as const, text: input.text }];
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
      if (st.cancelled || stopReason === "cancelled") {
        // Stopped by the user / a force-interrupt — a CLEAN end, not an error.
        emit({ type: "RUN_FINISHED", threadId: input.threadId, runId, cancelled: true });
      } else if (stopReason === "error") {
        outcome = "error";
        emit({ type: "RUN_ERROR", message: "agent reported an error", code: stopReason });
      } else {
        emit({ type: "RUN_FINISHED", threadId: input.threadId, runId });
      }
    } catch (err) {
      st.ended = true;
      closeOpenText(st);
      closeOpenReasoning(st);
      if (st.cancelled) {
        // A cancel that made the ACP prompt reject (e.g. session/cancel aborted
        // the call) is still a clean user stop — don't surface it as an error.
        emit({ type: "RUN_FINISHED", threadId: input.threadId, runId, cancelled: true });
      } else {
        outcome = "error";
        emit({ type: "RUN_ERROR", message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
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
  const armInterruptTimer = () => {
    clearInterruptTimer();
    if (priorityInterruptMs <= 0 || !currentRun) return;
    const head = topPriorityItem();
    if (!head || head.priority < PRIORITY_INTERRUPT) return;
    const waited = Date.now() - head.enqueuedAt;
    const remaining = Math.max(0, priorityInterruptMs - waited);
    interruptTimer = setTimeout(() => {
      // Still a run going + a priority item still waiting past the timeout → stop
      // the current turn so the priority item runs next.
      const stillWaiting = (topPriorityItem()?.priority ?? 0) >= PRIORITY_INTERRUPT;
      if (currentRun && stillWaiting) {
        void self.cancel().catch(() => {});
      }
    }, remaining);
    // Don't keep the process alive just for this timer.
    (interruptTimer as { unref?: () => void }).unref?.();
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
        queue.splice(queue.indexOf(item), 1);
        clearInterruptTimer(); // the item is now running, not waiting
        try {
          const runId = await runPrompt(item.input);
          item.resolve(runId);
        } catch (err) {
          item.reject(err);
        }
        // A new priority item may have queued during that run — re-arm.
        armInterruptTimer();
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
      // ahead of queued normal prompts AND can force-interrupt the running turn
      // (armInterruptTimer) after the configured timeout.
      const priority = opts?.priority ?? PRIORITY_NORMAL;
      const p = new Promise<RunId>((resolve, reject) => {
        queue.push({ input, priority, enqueuedAt: Date.now(), resolve, reject });
      });
      if (priority >= PRIORITY_INTERRUPT) armInterruptTimer();
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
