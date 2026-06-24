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

// AG-UI event union (subset used here; full set per AG-UI spec).
export type AguiEvent =
  // RUN_STARTED and RUN_FINISHED both REQUIRE threadId per the AG-UI schema —
  // the @ag-ui/client validates incoming events and rejects a missing threadId.
  | { type: "RUN_STARTED"; threadId: ThreadId; runId: RunId }
  | { type: "RUN_FINISHED"; threadId: ThreadId; runId: RunId; result?: unknown }
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
  | { type: "REASONING_END"; messageId: string };

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

  /** Subscribe to the AG-UI event stream broadcast to the UI (live). */
  onEvent(cb: (event: AguiEvent) => void): () => void;
  /** Subscribe to events that should be PERSISTED but not broadcast live (e.g.
   *  the user's own prompt — the UI already shows it, so re-broadcasting would
   *  duplicate it; we still need it in the durable log for history replay). The
   *  store subscribes here too. */
  onPersist(cb: (event: AguiEvent) => void): () => void;
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
}

let runCounter = 0;
let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(idCounter += 1)}`;

export function createSessionBridge(deps: BridgeDeps): SessionBridge {
  const sessionId = `sess-${(idCounter += 1)}`;
  const listeners = new Set<(event: AguiEvent) => void>();
  let acpSessionId: string | undefined;
  let started = false;
  // The run currently receiving ACP updates (set during prompt()).
  let currentRun: RunState | undefined;
  // Resolved on first start(); a ready client or the result of the factory.
  let acpClient: AcpClient | undefined =
    typeof deps.acpClient === "function" ? undefined : deps.acpClient;

  const persistListeners = new Set<(event: AguiEvent) => void>();

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
        if (!st.openText) {
          st.openText = nextId("msg");
          emit({ type: "TEXT_MESSAGE_START", messageId: st.openText, role: "assistant" });
        }
        emit({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: st.openText,
          delta: blockText(u.content),
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

  return {
    sessionId,

    async start() {
      if (started) return;
      // eslint-disable-next-line no-console
      console.log("[bridge] start: creating ACP client");
      if (!acpClient) {
        acpClient = await (deps.acpClient as () => Promise<AcpClient>)();
      }
      // eslint-disable-next-line no-console
      console.log("[bridge] start: client created, initialize()");
      await acpClient.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      });
      // eslint-disable-next-line no-console
      console.log("[bridge] start: initialized, newSession(cwd=%s)", deps.config.cwd);
      const { sessionId: sid } = await acpClient.newSession({ cwd: deps.config.cwd });
      // eslint-disable-next-line no-console
      console.log("[bridge] start: newSession ->", sid);
      acpSessionId = sid;
      // Subscribe to updates ONCE for the lifetime of the session and route
      // them to the current run. Avoids per-prompt subscribe/unsubscribe (which
      // mis-wired updates across runs).
      acpClient.onSessionUpdate((_sid, u) => {
        if (currentRun) handleUpdate(currentRun, u);
      });
      started = true;
    },

    async prompt(input: PromptInput): Promise<RunId> {
      const runId = `run-${(runCounter += 1)}`;
      const st: RunState = { runId, toolMessage: new Map() };

      // Emit RUN_STARTED before any awaiting so the UI sees the run begin even
      // if agent startup is slow or fails (e.g. goose needs a model provider).
      emit({ type: "RUN_STARTED", threadId: input.threadId, runId });

      // Persist the user's prompt as a message so the conversation history is
      // complete — switching to / reviving a conversation must replay the user
      // turns too, not just the agent's replies. PERSIST-ONLY: the live UI
      // already renders the message the user just sent, so broadcasting it would
      // echo it back as a duplicate.
      const userMsgId = nextId("user");
      persist({ type: "TEXT_MESSAGE_START", messageId: userMsgId, role: "user" });
      persist({ type: "TEXT_MESSAGE_CONTENT", messageId: userMsgId, delta: input.text });
      persist({ type: "TEXT_MESSAGE_END", messageId: userMsgId });

      try {
        if (!started || !acpSessionId) await this.start();
        currentRun = st; // route session/update notifications to this run
        // eslint-disable-next-line no-console
        console.log("[bridge] prompt: sending to goose, session=%s", acpSessionId);
        const { stopReason } = await acpClient!.prompt({
          sessionId: acpSessionId!,
          prompt: [{ type: "text", text: input.text }],
        });
        // eslint-disable-next-line no-console
        console.log("[bridge] prompt: stopReason=%s", stopReason);
        // The ACP prompt response can resolve before the final session/update
        // notifications have been dispatched. Drain a macrotask so trailing
        // text/reasoning chunks are processed (their messages opened) BEFORE we
        // close them and emit RUN_FINISHED — the AG-UI client rejects
        // RUN_FINISHED while a message is still open.
        await drain();
        st.ended = true; // stop routing further late updates into this run
        closeOpenText(st);
        closeOpenReasoning(st);
        if (stopReason === "error") {
          emit({ type: "RUN_ERROR", message: "agent reported an error", code: stopReason });
        } else {
          emit({ type: "RUN_FINISHED", threadId: input.threadId, runId });
        }
      } catch (err) {
        st.ended = true;
        closeOpenText(st);
        closeOpenReasoning(st);
        emit({ type: "RUN_ERROR", message: err instanceof Error ? err.message : String(err) });
      } finally {
        if (currentRun === st) currentRun = undefined;
      }
      return runId;
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
  };
}

function blockText(content: { type: string; text?: string } | { type: "text"; text: string }): string {
  return "text" in content && typeof content.text === "string" ? content.text : "";
}
