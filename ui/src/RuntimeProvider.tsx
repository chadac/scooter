/**
 * AG-UI runtime provider — connects assistant-ui to our agent-host, keyed by the
 * currently-selected session (sessionStore). Switching sessions in the sidebar
 * tears the runtime down and re-points it at that thread.
 *
 * SINGLE-SOURCE (live-monitoring) model — see docs/LIVE_MONITORING_DESIGN.md.
 * The open conversation renders SOLELY from the agent-host's integrity stream
 * (GET /conversations/:id/events.integrity), which carries EVERY run's events —
 * so a run driven from Slack, a webhook, or another tab appears live, not only on
 * a re-open. The render source is an `IntegrityAgent` (an @ag-ui/client
 * AbstractAgent whose run() is that continuous stream). Its base-class applier
 * folds the log into `agent.messages` with FULL FIDELITY (text, tool calls,
 * reasoning) — the identical rendering path as a locally-driven /agui run, with
 * no second reducer to drift.
 *
 * TWO SUBTLETIES the react-ag-ui runtime forces on us (both handled below):
 *
 *   1. The runtime renders from `core.getMessages()`, NOT `agent.messages`, and
 *      it only applies events through a *per-run* aggregator (one assistant
 *      placeholder + one RUN_STARTED/FINISHED pair per `startRun`). Feeding it
 *      the continuous, multi-run integrity replay through that per-run applier
 *      would merge every run into one bubble. So we do NOT let the runtime drive
 *      rendering: we run our OWN render pump — `agent.renderPump()`, which drives
 *      the base AbstractAgent applier over the integrity stream (with exactly one
 *      subscription per SSE connection, re-folded from empty each connect so the
 *      full-log replay never doubles) and folds it into `agent.messages`; on every
 *      change we push a full snapshot into the thread via
 *      `runtime.thread.reset(fromAgUiMessages(...))` (the same reset + converter
 *      the old history hydration used). We deliberately avoid
 *      AbstractAgent.runAgent here — it subscribes to run() twice and would double
 *      every event.
 *
 *   2. The composer send goes onNew -> core.append -> startRun -> agent.runAgent.
 *      There is no send-override adapter on useAgUiRuntime (checked
 *      react-ag-ui/dist: UseAgUiRuntimeAdapters has no such hook). If we let that
 *      run, it would open a SECOND integrity stream (our run()) that never
 *      completes and NEVER issue the /agui POST — the message would never reach
 *      the server. So we shadow the agent's INSTANCE `runAgent` (what the runtime
 *      calls) to be fire-and-forget: a resume routes to agent.submitResume(), an
 *      ordinary send routes to agent.send() (a single POST /agui whose reply
 *      re-enters through the render pump). It resolves immediately with an empty
 *      result; the reply renders via the stream, not a duplicated direct SSE. The
 *      render pump keeps using the *prototype* runAgent, so the two paths never
 *      collide. Net: messages render from the integrity stream (remote runs
 *      appear), and a user send hits the server as POST /agui exactly once.
 *
 * Interrupts: an interrupt (RUN_FINISHED outcome=interrupt) rides the integrity
 * log. The base AbstractAgent applier does NOT produce the react-ag-ui runtime's
 * requires-action message status (that's the runtime's per-run aggregator, which
 * the single-source model bypasses), so we surface interrupts on the SAME
 * integrity-log path as messages: the IntegrityAgent parses them
 * (getPendingInterrupts) and the pump publishes them into an InterruptContext.
 * InterruptPanel reads that context and answers via agent.submitResume() — a POST
 * /agui with resume[] whose continuation streams back through the same log.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { AbstractAgent, RunAgentInput } from "@ag-ui/client";
import { useAgUiRuntime, fromAgUiMessages } from "@assistant-ui/react-ag-ui";

import { sessionStore, useSessions } from "./sessions.js";
import {
  createIntegrityAgent,
  type IntegrityAgent,
  type PendingInterrupt,
  type ResumeEntry,
} from "./integrityAgent.js";

/** The current conversation's pending interrupts + a resume answerer, sourced
 *  from the IntegrityAgent (the single integrity-log source), so InterruptPanel
 *  reads them directly instead of the react-ag-ui runtime's message-status
 *  machinery — which the single-source render pump bypasses. */
export interface InterruptContextValue {
  interrupts: readonly PendingInterrupt[];
  submitResume: (entries: readonly ResumeEntry[]) => Promise<void>;
  /** The current conversation id + agent-host base URL, so the panel can hit
   *  host endpoints (e.g. the per-viewer AWS can-approve check). */
  conversationId: string;
  baseUrl: string;
  /** True while a goose run is in flight — drives the Stop button + thinking
   *  indicator. Sourced from the IntegrityAgent's log-derived isRunning(). */
  isRunning: boolean;
  /** Stop the running turn (the Stop button). POSTs the agent-host cancel route. */
  cancel: () => Promise<void>;
  /** Bumps on every render-pump push (message change). Used as the Thread error
   *  boundary's reset key so a transient runtime crash recovers on the next frame. */
  renderTick: number;
}

export const InterruptContext = createContext<InterruptContextValue>({
  interrupts: [],
  submitResume: async () => {},
  conversationId: "",
  baseUrl: "",
  isRunning: false,
  cancel: async () => {},
  renderTick: 0,
});

export const useConversationInterrupts = () => useContext(InterruptContext);

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

export function RuntimeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { currentId } = useSessions();

  // Remount the runtime per conversation. useAgUiRuntime owns the thread's
  // message state internally; handing it a new agent mid-render does NOT reset
  // it, so switching/deleting would leave the previous conversation's messages
  // on screen. Keying by currentId tears the runtime (and the IntegrityAgent +
  // its render pump) down and recreates it for the selected conversation.
  return (
    <ConversationRuntime key={currentId} conversationId={currentId}>
      {children}
    </ConversationRuntime>
  );
}

function ConversationRuntime({
  conversationId,
  children,
}: Readonly<{ conversationId: string; children: ReactNode }>) {
  const { sessions } = useSessions();
  const model = sessions.find((s) => s.id === conversationId)?.model;

  // The render source: an IntegrityAgent bound to this conversation. run() is the
  // continuous integrity stream; send()/submitResume() are fire-and-forget POST
  // /agui. Keyed to conversationId ONLY — NOT model. The model only rides the
  // X-Agent-Model header on the next send and has no effect on the render stream,
  // so recreating the agent (+ tearing down the render pump) on a model switch is
  // needless — and it RACES the next send's events in a slow environment, dropping
  // the reply (the model-switch-mid-conversation bug). Instead we keep the agent
  // stable and update the model in place (effect below).
  const agent = useMemo(
    () => createIntegrityAgent({ baseUrl: BASE_URL, conversationId, model }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId],
  );

  // Model switch mid-conversation: update the agent in place (no teardown). Do it
  // SYNCHRONOUSLY during render, NOT in an effect — an effect runs after render, so
  // a select-then-send-immediately (the composer, and the e2e) would fire the send
  // with the STALE model before the effect ran. setModel is idempotent.
  agent.setModel(model);

  // Shadow the INSTANCE runAgent so the composer's send (onNew -> core.append ->
  // startRun -> agent.runAgent) becomes fire-and-forget instead of opening a
  // second integrity stream. A resume answers a pending interrupt; otherwise the
  // last user message is the prompt. Resolves immediately — the reply renders via
  // the render pump (below), which uses the PROTOTYPE runAgent and is unaffected
  // by this shadow. See the file header (subtlety 2).
  useEffect(() => {
    const send = (async (input?: RunAgentInput) => {
      const resume = input?.resume;
      if (resume && resume.length > 0) {
        await agent.submitResume(resume as ResumeEntry[]);
      } else {
        const lastUser = [...(input?.messages ?? [])]
          .reverse()
          .find((m) => m.role === "user");
        const text = typeof lastUser?.content === "string" ? lastUser.content : "";
        if (text) {
          // If a run is ALREADY active, the user is sending to interrupt it (e.g. a
          // stuck polling loop). Send with PRIORITY so the agent-host force-interrupts
          // the running turn (bridge "thinking" policy) instead of queuing the message
          // behind a turn that may never end. Read the LIVE run state (not React
          // state) so there's no stale-closure race. PRIORITY_INTERRUPT = 10.
          const priority = agent.runIsActive() ? 10 : undefined;
          await agent.send(text, { priority });
        }
      }
      return { result: undefined, newMessages: [], newState: agent.state };
    }) as unknown as AbstractAgent["runAgent"];
    // Instance property shadows the prototype method the runtime invokes; the
    // render pump calls the prototype directly, so it keeps the real applier.
    (agent as unknown as { runAgent: AbstractAgent["runAgent"] }).runAgent = send;
  }, [agent]);

  const threadListAdapter = useMemo(
    () => ({
      threadId: conversationId,
      onSwitchToNewThread: async () => {
        sessionStore.newSession();
      },
      onSwitchToThread: async (threadId: string) => {
        sessionStore.switchTo(threadId);
        return { messages: [] as never };
      },
    }),
    [conversationId],
  );

  const runtime = useAgUiRuntime({ agent, adapters: { threadList: threadListAdapter } });

  // The RENDER PUMP. agent.renderPump() folds the integrity stream into
  // agent.messages with full fidelity across all runs, using EXACTLY ONE
  // subscription per SSE connection and re-folding each connection from an empty
  // accumulator — so the log's full-log replay (on connect AND on every reconnect)
  // rebuilds identical state instead of DOUBLING tool-call args / duplicating
  // messages (the page-refresh replay bug). We do NOT use AbstractAgent.runAgent
  // here: it subscribes to run() twice and would double every event. On each
  // message change, replace the thread with the folded snapshot — fromAgUiMessages
  // preserves tool calls + reasoning, and reset() makes the integrity log the
  // SINGLE writer (a Slack-driven run and a local run render through the identical
  // path). This replaces the old one-shot loadHistory: the stream's replay IS the
  // history.
  // The current pending interrupt(s), sourced from the IntegrityAgent (parsed from
  // the integrity log's RUN_FINISHED outcome=interrupt). The base applier does NOT
  // produce the runtime's requires-action status, so InterruptPanel reads these via
  // context (useConversationInterrupts) rather than the runtime — keeping interrupts
  // on the same single-source path as messages.
  const [interrupts, setInterrupts] = useState<readonly PendingInterrupt[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [renderTick, setRenderTick] = useState(0);
  // Highest message count applied so far — suppresses a SHRINKING reset during a
  // reconnect re-fold (see push() below). Reset per conversation (this component
  // remounts on currentId).
  const lastLen = useRef(0);

  useEffect(() => {
    let disposed = false;
    const push = () => {
      if (disposed) return;
      // While REPLAYING a conversation's history (on open / switch / reconnect),
      // don't reset the thread on every folded event — that visibly builds the
      // history top-down and looks ugly for a long conversation. Skip until the
      // stream's `synced` marker, which fires one final render with the whole
      // history at once (landing at the latest message). Live events after that
      // render per-event as usual.
      if (agent.isReplaying()) return;
      // Guard against a SHRINKING reset within THIS conversation. A reconnect
      // re-folds agent.messages from empty (0,1,2,…back up to N); a reset applied
      // while that fold is still climbing hands assistant-ui a SHORTER list than it
      // is mid-rendering → "useClientLookup: Index N out of bounds" → the page
      // blanks (the model-switch flake). The full history only ever GROWS back to
      // (at least) its prior length, so suppressing shrinking resets drops only the
      // transient mid-reconnect frames, not any real state. (A thread SWITCH remounts
      // this component — keyed on currentId — so lastLen resets and can't wrongly
      // suppress the new, shorter conversation.)
      const folded = agent.messages as unknown as unknown[];
      if (folded.length < lastLen.current) return;
      lastLen.current = folded.length;
      runtime.thread.reset(fromAgUiMessages(folded));
      // Interrupts ride the log too; surface them (or clear them) on every change.
      setInterrupts(agent.getPendingInterrupts());
      // Run-in-flight state (Stop button + thinking indicator) rides the log too.
      setIsRunning(agent.runIsActive());
      // Advance the error-boundary reset key so a transient runtime crash during
      // this reset recovers on the next push.
      setRenderTick((n) => n + 1);
    };
    const { unsubscribe } = agent.subscribe({ onMessagesChanged: () => push() });
    const stopPump = agent.renderPump();
    return () => {
      disposed = true;
      stopPump();
      unsubscribe();
      agent.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  // Derive the session title from the first user message of the current thread.
  useEffect(() => {
    return runtime.thread.subscribe(() => {
      const msgs = runtime.thread.getState().messages;
      const firstUser = msgs.find((m) => m.role === "user");
      const text = firstUser?.content
        ?.map((c) => ("text" in c ? c.text : ""))
        .join(" ")
        .trim();
      if (text) sessionStore.titleFromFirstMessage(conversationId, text);
    });
  }, [runtime, conversationId]);

  const interruptValue = useMemo<InterruptContextValue>(
    () => ({
      interrupts,
      submitResume: (entries) => agent.submitResume(entries),
      conversationId,
      baseUrl: BASE_URL,
      isRunning,
      cancel: () => agent.cancel(),
      renderTick,
    }),
    [interrupts, agent, conversationId, isRunning, renderTick],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <InterruptContext.Provider value={interruptValue}>{children}</InterruptContext.Provider>
    </AssistantRuntimeProvider>
  );
}
