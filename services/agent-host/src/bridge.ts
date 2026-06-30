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

// AG-UI event union (subset used here; full set per AG-UI spec).
export type AguiEvent =
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
  prompt(input: PromptInput): Promise<RunId>;
  cancel(runId: RunId): Promise<void>;
  stop(): Promise<void>;

  /** Answer a pending permission/option request (resolves the blocked agent run,
   *  or fires the external onAnswer for a raiseInterrupt). optionId must be one
   *  of the offered options; an unknown/empty id cancels. Returns true if a
   *  matching pending request was found. */
  answerPermission(toolCallId: string, optionId: string): boolean;

  /** Raise an AG-UI interrupt NOT tied to a goose run (e.g. a broker AWS
   *  permission request). Emits the interrupt to the UI; when the user answers
   *  (via answerPermission / the UI resume), `onAnswer(optionId|null)` fires.
   *  `id` is the interrupt/answer key (e.g. the broker request_id). */
  raiseInterrupt(args: {
    id: string;
    message: string;
    options: Array<{ optionId: string; name: string; kind: string }>;
    onAnswer: (optionId: string | null) => void;
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
}

let runCounter = 0;
let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(idCounter += 1)}`;

export function createSessionBridge(deps: BridgeDeps): SessionBridge {
  const sessionId = `sess-${(idCounter += 1)}`;
  const listeners = new Set<(event: AguiEvent) => void>();
  let acpSessionId: string | undefined;
  let started = false;
  // Serialize runs: a bridge has ONE goose session + ONE RunState. A second
  // prompt arriving while a run is in flight (e.g. the webhook POSTs /agui while
  // the agent is mid-run) must QUEUE, not clobber currentRun — otherwise the
  // first run's open text message never gets its END and RUN_FINISHED is emitted
  // while it's still open (the @ag-ui client rejects that, and the reply is lost).
  let runChain: Promise<unknown> = Promise.resolve();
  // The run currently receiving ACP updates (set during prompt()).
  let currentRun: RunState | undefined;
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
    onExternal?: (optionId: string | null) => void;
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

  const emit = (event: AguiEvent) => {
    // Broadcast subscribers (UI) AND persist subscribers (store) both see live
    // events.
    for (const cb of listeners) cb(event);
    for (const cb of persistListeners) cb(event);
  };

  // Persist-only: the store records it, but the UI does NOT (avoids duplicating
  // something the UI already renders, like the user's own prompt).
  const persist = (event: AguiEvent) => {
    for (const cb of persistListeners) cb(event);
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
    // Set once the run is finishing: late updates are ignored so we never
    // reopen a message after RUN_FINISHED.
    ended?: boolean;
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
        if (u.rawInput !== undefined) {
          emit({ type: "TOOL_CALL_ARGS", toolCallId: u.toolCallId, delta: JSON.stringify(u.rawInput) });
        }
        emit({ type: "TOOL_CALL_END", toolCallId: u.toolCallId });
        st.toolMessage.set(u.toolCallId, nextId("msg"));
        break;
      }
      case "tool_call_update": {
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
    const runId = `run-${(runCounter += 1)}`;
    const st: RunState = { runId, threadId: input.threadId, toolMessage: new Map() };
    const startedAt = Date.now();
    let outcome: "ok" | "error" = "ok";

    // Emit RUN_STARTED before any awaiting so the UI sees the run begin even if
    // agent startup is slow or fails (e.g. goose needs a model provider).
    emit({ type: "RUN_STARTED", threadId: input.threadId, runId });

    // Persist the user's prompt as a message so the conversation history is
    // complete — switching to / reviving a conversation must replay the user
    // turns too. PERSIST-ONLY: the live UI already renders the message the user
    // just sent, so broadcasting it would echo a duplicate.
    const userMsgId = nextId("user");
    persist({ type: "TEXT_MESSAGE_START", messageId: userMsgId, role: "user" });
    persist({ type: "TEXT_MESSAGE_CONTENT", messageId: userMsgId, delta: input.text });
    persist({ type: "TEXT_MESSAGE_END", messageId: userMsgId });

    try {
      if (!started || !acpSessionId) await self.start();
      currentRun = st; // route session/update notifications to this run
      debug("[bridge] prompt: sending to goose, session=%s", acpSessionId);
      const { stopReason } = await acpClient!.prompt({
        sessionId: acpSessionId!,
        prompt: [{ type: "text", text: input.text }],
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
      if (stopReason === "error") {
        outcome = "error";
        emit({ type: "RUN_ERROR", message: "agent reported an error", code: stopReason });
      } else {
        emit({ type: "RUN_FINISHED", threadId: input.threadId, runId });
      }
    } catch (err) {
      outcome = "error";
      st.ended = true;
      closeOpenText(st);
      closeOpenReasoning(st);
      emit({ type: "RUN_ERROR", message: err instanceof Error ? err.message : String(err) });
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

    prompt(input: PromptInput): Promise<RunId> {
      // Chain after any in-flight run so prompts are processed one at a time on
      // this bridge's single goose session. Each run fully completes (its text
      // closed + RUN_FINISHED emitted) before the next RUN_STARTED — preventing
      // the concurrent-run corruption where one run's open message is left
      // unclosed when another run's RUN_FINISHED fires. Errors don't break the chain.
      const next = runChain.catch(() => {}).then(() => runPrompt(input));
      runChain = next;
      return next;
    },

    async cancel(_runId: RunId) {
      if (acpSessionId && acpClient) await acpClient.cancel(acpSessionId);
    },

    async stop() {
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
    answerPermission(toolCallId, optionId) {
      const pending = pendingPermissions.get(toolCallId);
      if (!pending) return false; // no such pending request (or already answered)
      // An unknown optionId cancels rather than forwarding a garbage selection.
      const chosen = pending.validOptions.has(optionId) ? optionId : null;
      if (pending.onExternal) {
        // External interrupt (e.g. broker AWS request): no blocked goose run —
        // fire the callback + clean up + record the resolution for replay.
        pendingPermissions.delete(toolCallId);
        persist({ type: "PERMISSION_RESOLVED", toolCallId, optionId: chosen });
        pending.onExternal(chosen);
      } else {
        pending.resolve(chosen); // unblocks the goose ACP requestPermission call
      }
      return true;
    },
    raiseInterrupt({ id, message, options, onAnswer }) {
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
          interrupts: [{ id, reason: "confirmation", message, metadata: { options } }],
        },
      });
    },
  };

  return self;
}

function blockText(content: { type: string; text?: string } | { type: "text"; text: string }): string {
  return "text" in content && typeof content.text === "string" ? content.text : "";
}
