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
 * We drive assistant-ui via our OWN external-store runtime (useRepositoryRuntime),
 * NOT useAgUiRuntime — its per-run aggregator would merge our multi-run integrity
 * replay into one bubble. Two things this hands us:
 *
 *   1. RENDER via a message-repository SNAPSHOT, not a full reset. Our render pump
 *      (`agent.renderPump()`) folds the integrity stream into `agent.messages` with
 *      full fidelity (one SSE subscription per connection, re-folded from empty so a
 *      replay never doubles). On each change we build an ExportedMessageRepository
 *      (toRepositorySnapshot) and hand it to the store. Because our message ids are
 *      STABLE (log-derived + the deterministic `sys:` splice), the core reconciles
 *      per-message — unchanged messages stay put (NO re-paint), the head stays pinned
 *      at the bottom. This replaced `runtime.thread.reset(fromAgUiMessages(...))`,
 *      which rebuilt the whole repo every push (fresh ids → the open-conversation
 *      jump/flash) and is also the base for load-earlier/prepend.
 *
 *   2. SEND directly via the store's `onNew` — no runAgent shadow. A resume routes to
 *      agent.submitResume(); an ordinary send routes to agent.send() (one POST /agui
 *      whose reply re-enters through the render pump). There is no core.append ->
 *      startRun -> runAgent chain to intercept (that was useAgUiRuntime's), so the
 *      old instance-shadow of AbstractAgent.runAgent is gone. Net unchanged: remote
 *      runs render from the integrity stream, a user send hits /agui exactly once.
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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AssistantRuntimeProvider, SimpleImageAttachmentAdapter, type AppendMessage } from "@assistant-ui/react";

import { useRepositoryRuntime } from "./useRepositoryRuntime.js";
import { toRepositorySnapshot, type RepositorySnapshot } from "./messageRepository.js";
import { imagesFromContent, downscaleImage, type OutboundImage } from "./imageUpload.js";

import { createConversation } from "./client.js";
import { currentConversation, sessionStore, setConversationMinter, useSessions } from "./sessions.js";
import {
  createIntegrityAgent,
  type IntegrityAgent,
  type PendingInterrupt,
  type ResumeEntry,
} from "./integrityAgent.js";

/** Sentinel prefixing the text part of a spliced-in SYSTEM message, so thread.tsx
 *  can tell a system-event chip apart from a real assistant message and parse out
 *  its source + body. Format: `${MARKER}${source}\n${text}`. Paired with the
 *  `sys:` message-id prefix (the primary discriminator). Kept obscure so it can't
 *  collide with real assistant output. */
export const SYSTEM_MSG_MARKER = " scooter-system ";

/** True + the parsed {source,text} when a thread message is a spliced SYSTEM event
 *  (id starts with `sys:` and its single text part carries SYSTEM_MSG_MARKER). */
export function parseSystemMessage(
  id: string | undefined,
  text: string | undefined,
): { source: string; text: string } | null {
  if (!id?.startsWith("sys:") || !text?.startsWith(SYSTEM_MSG_MARKER)) return null;
  const rest = text.slice(SYSTEM_MSG_MARKER.length);
  const nl = rest.indexOf("\n");
  return nl === -1
    ? { source: rest, text: "" }
    : { source: rest.slice(0, nl), text: rest.slice(nl + 1) };
}

/** A SYSTEM message from IntegrityAgent.getSystemMessages(). */
export interface SplicedSystemMessage {
  id: string;
  source: string;
  text: string;
  /** The id of the real message this follows in the log (null = before all). */
  afterMessageId: string | null;
}

/**
 * Interleave SYSTEM messages (subagent completions, job/broker events) inline at
 * their chronological slot in the folded message list — the EXACT logic the live
 * UI renders from, extracted here so it's unit-testable against a REAL recorded
 * AG-UI log (the render-layer harness). The base @ag-ui applier drops SYSTEM_MESSAGE
 * (bespoke), so we splice a synthetic `sys:`-prefixed assistant message right AFTER
 * the real message with id === afterMessageId (null → before all).
 *
 * KNOWN BUG (see todo/docs/AGENT_TRANSCRIPT_HARNESS.md): a system message anchored
 * to an assistant message that ALSO has tool calls nested into it renders ABOVE
 * those tool cards — because we splice after the message OBJECT but the message's
 * own tool parts render as part of it. The UI-layer replay test captures this.
 */
/** System-message sources that are PURELY internal plumbing — the agent needs the nudge
 *  but the human shouldn't see it. "resume" = the restart / model-switch continue-nudge
 *  (agent-host injects it on revive; showing it as a chat message is just noise). Filtered
 *  out of the rendered list entirely (still persisted in the log for the agent's context). */
const HIDDEN_SYSTEM_SOURCES = new Set(["resume"]);

export function spliceSystemMessages(
  messages: readonly unknown[],
  sys: readonly SplicedSystemMessage[],
): unknown[] {
  const out: unknown[] = [];
  const flush = (afterId: string | null) => {
    for (const s of sys) {
      if (s.afterMessageId !== afterId) continue;
      if (HIDDEN_SYSTEM_SOURCES.has(s.source)) continue; // internal nudge — not shown
      out.push({
        id: `sys:${s.id}`,
        role: "assistant",
        content: [{ type: "text", text: `${SYSTEM_MSG_MARKER}${s.source}\n${s.text}` }],
      });
    }
  };
  flush(null); // system messages that preceded any real message
  for (const m of messages) {
    out.push(m);
    flush((m as { id?: string }).id ?? null);
  }
  return out;
}

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
  /** The in-flight tool call's name (e.g. "bash"), or null when between tool calls /
   *  idle — so the indicator can show WHAT the agent is doing, not just a dot. */
  activeTool: string | null;
  /** Epoch ms the current run started, or null — so the indicator can show elapsed
   *  time (a long silent tool call is then visibly "still working", not stuck). */
  runStartedAt: number | null;
  /** Context-window fill fraction 0..1 from the latest turn's usage, or null when
   *  unknown — drives the context-fill bar. */
  contextFill: number | null;
  /** {used,total} context tokens for the fill-bar tooltip, or null. */
  contextTokens: { used: number; total: number } | null;
  /** Stop the running turn (the Stop button). POSTs the agent-host cancel route. */
  cancel: () => Promise<void>;
  /** Optimistic Stop-button feedback (the run's terminal event round-trips through
   *  the integrity stream, so a naive Stop looks dead until then). "stopping" the
   *  instant the button is clicked; back to "idle" once the run actually ends;
   *  "failed" if the cancel POST itself errored (network / non-2xx) so we can tell
   *  the user the stop didn't land instead of leaving them staring. */
  cancelState: "idle" | "stopping" | "failed";
  /** The last run's RUN_ERROR message, or null. The base applier renders NO
   *  message for a RUN_ERROR, so a failed run (e.g. the agent couldn't start —
   *  the hydrate-silent-drop class) would go silent. Surfaced here so the UI can
   *  show a visible error banner. Cleared when the next run starts. */
  runError: string | null;
  /** Non-null while the server is AUTO-RETRYING a transiently-failed run (agent process died / went
   *  silent / ACP threw) — `{attempt, max}` drives a "Agent stopped unexpectedly — retrying (n/N)…"
   *  banner instead of the terminal error. Cleared when the retry's run starts (success) or the final
   *  RUN_ERROR lands (exhausted). See the bridge death-retry loop + integrityAgent.getRunRetrying. */
  runRetrying: { attempt: number; max: number } | null;
  /** True when the live stream is being rejected with a 401/403 — an expired
   *  ingress/auth session in front of the agent-host. Surfaced so the UI can show
   *  a durable "session expired — reconnecting / sign in again" banner instead of
   *  silently retrying forever. Self-clears once a reconnect succeeds. */
  streamAuthError: boolean;
  /** Messages QUEUED behind the active run (empty if none). Sourced from the
   *  bridge run-queue's QUEUE_UPDATED snapshots on the integrity stream, so they
   *  survive a refresh + show across tabs (they used to be client-only). */
  queuedMessages: ReadonlyArray<{ id: string; text: string; priority: number }>;
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
  activeTool: null,
  runStartedAt: null,
  contextFill: null,
  contextTokens: null,
  cancel: async () => {},
  cancelState: "idle",
  runError: null,
  runRetrying: null,
  streamAuthError: false,
  queuedMessages: [],
  renderTick: 0,
});

export const useConversationInterrupts = () => useContext(InterruptContext);

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

// The SERVER owns conversation ids. Install the minter that asks for one (POST
// /conversations) instead of letting the client choose — a client-chosen id would become
// an event-log key and a k8s resource name, and the agent-host refuses an id it never
// issued. Module scope so it is in place before any component renders.
setConversationMinter(() => createConversation({ baseUrl: BASE_URL }));
// Idle-watchdog reconnect threshold (ms). Overridable so e2e fault tests can set a
// small value (via VITE_IDLE_RECONNECT_MS) and not wait the 25s production default.
const IDLE_RECONNECT_MS = import.meta.env.VITE_IDLE_RECONNECT_MS
  ? Number(import.meta.env.VITE_IDLE_RECONNECT_MS)
  : undefined;

export function RuntimeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { currentId } = useSessions();

  // Remount the runtime per conversation. The runtime + its repository snapshot are
  // per-conversation state; handing it a new agent mid-render would leave the previous
  // conversation's messages on screen. Keying by currentId tears the runtime (and the
  // IntegrityAgent + its render pump + the snapshot) down and recreates it fresh.
  return (
    <ConversationRuntime key={currentId} conversationKey={currentId}>
      {children}
    </ConversationRuntime>
  );
}

function ConversationRuntime({
  conversationKey,
  children,
}: Readonly<{ conversationKey: string; children: ReactNode }>) {
  const { sessions } = useSessions();
  const session = sessions.find((s) => s.id === conversationKey);
  const model = session?.model;
  // The SERVER's id for this conversation, or the key while it does not exist yet. The
  // agent reads it at call time and is re-pointed in place by setConversationId() the
  // moment the server assigns one — the MOUNT stays keyed on the stable key, so nothing is
  // torn down when that happens.
  const conversationId = session?.serverId ?? conversationKey;
  // The conversation OBJECT for this mount. It owns whether a server id exists yet and
  // what each operation means before it does, so nothing here branches on id presence.
  const conversation = useMemo(
    () => currentConversation(),
    // Re-resolve when the mounted conversation changes; the object itself is stable across
    // creation (its key never changes), which is why this component is not torn down when
    // the server id arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationKey],
  );

  // The render source: an IntegrityAgent bound to this conversation. run() is the
  // continuous integrity stream; send()/submitResume() are fire-and-forget POST
  // /agui. Keyed to the stable conversation KEY — NOT the server id, and NOT model.
  //
  // Not the server id, because that id ARRIVES (on the first send of a new conversation).
  // Rebuilding the agent then would tear down the render pump mid-run and lose the
  // in-flight run's state — the Stop button stops responding. setConversationId() re-points
  // it in place instead, and reads happen at call time.
  //
  // Not model, for the same reason: the model only rides the X-Agent-Model header on the
  // next send and has no effect on the render stream, so recreating the agent on a model
  // switch is needless — and it RACES the next send's events in a slow environment,
  // dropping the reply (the model-switch-mid-conversation bug).
  const agent = useMemo(
    () => createIntegrityAgent({ baseUrl: BASE_URL, conversationId, model, idleReconnectMs: IDLE_RECONNECT_MS }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationKey],
  );

  // Follow the server id in place. It appears when a brand-new conversation is created on
  // its first send, and after a RELOAD the agent is built from the persisted id directly.
  useEffect(() => {
    agent.setConversationId(conversationId);
  }, [agent, conversationId]);

  // Model switch mid-conversation: update the agent in place (no teardown). Do it
  // SYNCHRONOUSLY during render, NOT in an effect — an effect runs after render, so
  // a select-then-send-immediately (the composer, and the e2e) would fire the send
  // with the STALE model before the effect ran. setModel is idempotent.
  agent.setModel(model);

  // OPTIMISTIC pending sends: a message the user just submitted, shown INSTANTLY (as a queued
  // item) so it doesn't "disappear" in the window between the /agui POST and the server's first
  // confirmation (the QUEUE_UPDATED snapshot, or the message landing in the log). Each is
  // cleared once the server confirms it (see the push pump). Declared before onNew so the send
  // handler can add to it.
  const [optimisticSends, setOptimisticSends] = useState<
    ReadonlyArray<{ id: string; text: string; priority: number }>
  >([]);

  // The composer send: the external store calls this `onNew` with the appended user
  // message. Fire-and-forget to /agui — a resume answers a pending interrupt, an
  // ordinary send routes to agent.send(); the reply re-enters through the render pump
  // (below). No runAgent shadow needed (we don't use useAgUiRuntime's append→startRun
  // chain). See the file header (send). Stable across renders (only depends on agent).
  const onNew = useCallback(
    async (message: AppendMessage) => {
      // A resume rides on the append message's `resume` extra (InterruptPanel path).
      const resume = (message as unknown as { resume?: ResumeEntry[] }).resume;
      if (resume && resume.length > 0) {
        await agent.submitResume(resume);
        return;
      }
      // content is a string (text-only) OR an array of parts (text + image
      // attachments). Extract text + images either way.
      const content = message.content as unknown;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((p) => (p as { type?: string })?.type === "text").map((p) => (p as { text?: string }).text ?? "").join("")
          : "";
      // Downscale each attached image under the client cap before sending (the
      // agent-host also hard-rejects over its cap).
      const rawImages = imagesFromContent(content);
      const images: OutboundImage[] = [];
      for (const raw of rawImages) {
        const scaled = await downscaleImage(`data:${raw.mimeType};base64,${raw.data}`).catch(() => raw);
        if (scaled) images.push(scaled);
      }
      if (text || images.length) {
        // OPTIMISTIC solidify: title the session from this first message NOW, before the
        // fire-and-forget send round-trips, so a brand-new "New chat" doesn't stay pristine
        // (and droppable by the background merge) until the server echoes it back.
        // Sending is an ACTION, so the conversation is created if it does not exist yet —
        // withId() does that and hands us the SERVER's id. The session's key is untouched,
        // so this component (mounted on the key) is not torn down mid-send. The agent is
        // re-pointed in place; it reads the id at call time.
        if (!conversation) throw new Error("no conversation selected");
        await conversation.withId(async (serverId) => {
          agent.setConversationId(serverId);
        });
        if (text) sessionStore.titleFromFirstMessage(conversationId, text);
        // If a run is ALREADY active, the user is sending to interrupt it (e.g. a
        // stuck polling loop). Send with PRIORITY so the agent-host force-interrupts
        // the running turn (bridge "thinking" policy) instead of queuing the message
        // behind a turn that may never end. Read the LIVE run state (not React state)
        // so there's no stale-closure race. PRIORITY_INTERRUPT = 10.
        const priority = agent.runIsActive() ? 10 : undefined;
        // OPTIMISTIC show: surface the message as a pending queued item IMMEDIATELY so it
        // never "disappears" between this POST and the server's first confirmation. The push
        // pump clears it once the server's queue/log contains this text. Only for text (an
        // image-only send has nothing to show as a queued line).
        const optId = text ? `optimistic-${crypto.randomUUID()}` : null;
        if (optId) {
          setOptimisticSends((cur) => [...cur, { id: optId, text, priority: priority ?? 0 }]);
        }
        try {
          await agent.send(text, { priority, images: images.length ? images : undefined });
        } catch (e) {
          // The POST itself failed — drop the optimistic entry so it doesn't linger forever
          // (the server will never confirm a send that never landed). The composer surfaces
          // the error separately; this just cleans up the pending line.
          if (optId) setOptimisticSends((cur) => cur.filter((o) => o.id !== optId));
          throw e;
        }
      }
    },
    [agent, conversationId],
  );

  const threadListAdapter = useMemo(
    () => ({
      threadId: conversationId,
      onSwitchToNewThread: async () => {
        sessionStore.newSession();
      },
      onSwitchToThread: async (threadId: string) => {
        // Selection only — the render pump re-points at the new thread's log (the
        // component remounts on currentId). No messages to return: our store renders
        // from the repository snapshot, not from a switch-time payload.
        sessionStore.switchTo(threadId);
      },
    }),
    [conversationId],
  );

  // The image attachment adapter lets the composer accept image uploads: it turns
  // an attached image File into an image content part on the user message (which
  // the send override above extracts, downscales, and forwards to /agui).
  const attachmentAdapter = useMemo(() => new SimpleImageAttachmentAdapter(), []);

  // The message-repository SNAPSHOT the external store renders. Updated by the render
  // pump (below) with a fresh object (stable inner ids) on every fold, so the core
  // reconciles per-message instead of re-painting. Starts empty (fresh thread).
  const EMPTY_REPO = useMemo<RepositorySnapshot>(() => ({ headId: null, messages: [] }), []);
  const [repoSnapshot, setRepoSnapshot] = useState<RepositorySnapshot>(EMPTY_REPO);

  // The RENDER PUMP. agent.renderPump() folds the integrity stream into
  // agent.messages with full fidelity across all runs, using EXACTLY ONE
  // subscription per SSE connection and re-folding each connection from an empty
  // accumulator — so the log's full-log replay (on connect AND on every reconnect)
  // rebuilds identical state instead of DOUBLING tool-call args / duplicating
  // messages (the page-refresh replay bug). On each message change we build an
  // ExportedMessageRepository (toRepositorySnapshot) and hand it to the store; the
  // core reconciles per-message (stable ids → unchanged messages stay put, no
  // re-paint, head pinned). This replaced the old thread.reset(fromAgUiMessages(...)),
  // which rebuilt the whole repo (fresh ids) every push. The stream's replay IS the
  // history.
  // The current pending interrupt(s), sourced from the IntegrityAgent (parsed from
  // the integrity log's RUN_FINISHED outcome=interrupt). The base applier does NOT
  // produce the runtime's requires-action status, so InterruptPanel reads these via
  // context (useConversationInterrupts) rather than the runtime — keeping interrupts
  // on the same single-source path as messages.
  const [interrupts, setInterrupts] = useState<readonly PendingInterrupt[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [contextFill, setContextFill] = useState<number | null>(null);
  const [contextTokens, setContextTokens] = useState<{ used: number; total: number } | null>(null);
  const [cancelState, setCancelState] = useState<"idle" | "stopping" | "failed">("idle");
  const [runError, setRunError] = useState<string | null>(null);
  const [runRetrying, setRunRetrying] = useState<{ attempt: number; max: number } | null>(null);
  const [streamAuthError, setStreamAuthError] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<
    ReadonlyArray<{ id: string; text: string; priority: number }>
  >([]);
  const [renderTick, setRenderTick] = useState(0);
  // Highest message count applied so far — suppresses a SHRINKING reset during a
  // reconnect re-fold (see push() below). Reset per conversation (this component
  // remounts on currentId).
  const lastLen = useRef(0);

  // Our external-store runtime: renders the repository snapshot incrementally + sends
  // via onNew. Replaces useAgUiRuntime (whose per-run aggregator would merge our
  // multi-run replay). Interrupts/run-state come from the IntegrityAgent, not here.
  const runtime = useRepositoryRuntime({
    messageRepository: repoSnapshot,
    isRunning,
    onNew,
    adapters: { threadList: threadListAdapter, attachments: attachmentAdapter },
  });

  useEffect(() => {
    let disposed = false;
    const push = () => {
      if (disposed) return;
      // LOG-DERIVED STATE (run-in-flight, interrupts, error, queue) updates on EVERY
      // push — even during replay / a suppressed message reset. It's cheap (no thread
      // reset) and MUST stay in sync, or the thinking dot / Stop button / approvals go
      // stale. The bug this fixes: opening a conversation whose last run is in-flight
      // but SILENT (blocked on a long tool call, no streaming) showed no thinking
      // indicator, because the message-render guards below returned before isRunning
      // was ever set. runIsActive() is derived from the replayed log, so it's correct
      // here regardless of the render guards.
      const active = agent.runIsActive();
      setIsRunning(active);
      setActiveTool(agent.activeTool());
      setRunStartedAt(agent.runStartedAtMs());
      setContextFill(agent.contextFill());
      setContextTokens(agent.contextTokens());
      if (!active) setCancelState("idle"); // run idle → drop optimistic stopping/failed
      setInterrupts(agent.getPendingInterrupts());
      setRunError(agent.getRunError());
      setRunRetrying(agent.getRunRetrying());
      setStreamAuthError(agent.getStreamAuthError());
      const serverQueue = agent.getQueuedMessages();
      setQueuedMessages(serverQueue);
      // Clear an optimistic pending send once the SERVER has confirmed it — either it's now in
      // the server's queue (same text) or it landed in the message log as a user message. Until
      // then it stays visible (merged into queuedMessages for the render), so the message never
      // vanishes between POST and confirmation.
      setOptimisticSends((cur) => {
        if (cur.length === 0) return cur;
        const queuedTexts = new Set(serverQueue.map((q) => q.text));
        const loggedUserTexts = new Set(
          (agent.messages as unknown as Array<{ role?: string; content?: unknown }>)
            .filter((m) => m.role === "user")
            .map((m) => (typeof m.content === "string"
              ? m.content
              : Array.isArray(m.content)
                ? m.content.filter((p) => (p as { type?: string })?.type === "text").map((p) => (p as { text?: string }).text ?? "").join("")
                : "")),
        );
        const next = cur.filter((o) => !queuedTexts.has(o.text) && !loggedUserTexts.has(o.text));
        return next.length === cur.length ? cur : next;
      });

      // MESSAGE RESET is what the guards protect. While REPLAYING history (on open /
      // switch / reconnect), don't reset the thread on every folded event — that
      // visibly builds the history top-down. Skip until the stream's `synced` marker,
      // which fires one final render with the whole history. Live events after that
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
      // Enrich user messages with their attached images (MESSAGE_IMAGES rides the
      // log but the base applier ignores it): append an image part per ref so the
      // image renders live + after a refresh. The url is a same-origin assets route.
      const enriched = folded.map((m) => {
        const msg = m as { id?: string; role?: string; content?: unknown };
        const imgs = msg.id ? agent.getMessageImages(msg.id) : undefined;
        if (!imgs?.length) return m;
        const parts = Array.isArray(msg.content) ? [...(msg.content as unknown[])] : msg.content ? [{ type: "text", text: msg.content }] : [];
        for (const img of imgs) parts.push({ type: "image", image: img.url });
        return { ...msg, content: parts };
      });
      // Interleave SYSTEM messages inline at their chronological slot. The base applier
      // drops SYSTEM_MESSAGE (bespoke), so we splice a synthetic message carrying a
      // `sys:`-prefixed id + a source/text-tagged text part right AFTER the real
      // message it followed in the log (afterMessageId; null = before all). thread.tsx
      // detects the `sys:` id and renders an auto-collapsed event chip, NOT a bubble.
      // Role is "assistant" only so fromAgUiMessages keeps it (it drops role-less
      // messages) — the custom renderer overrides all assistant styling.
      const withSystem = spliceSystemMessages(enriched, agent.getSystemMessages());
      // Hand the store a NEW repository snapshot (stable inner ids). The core
      // reconciles per-message — unchanged messages keep their place (no re-paint),
      // the head stays pinned. Replaces the old thread.reset (full rebuild).
      setRepoSnapshot(toRepositorySnapshot(withSystem));
      // Advance the error-boundary reset key so a transient runtime crash during
      // this render recovers on the next push.
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

  // Stop-button control flow with immediate feedback. The run's terminal event
  // round-trips through the integrity stream (which flips isRunning false and
  // resets cancelState to idle in push() above), so without an optimistic state
  // the button looks dead between the click and that round-trip. Show "stopping"
  // the instant it's clicked; surface a "failed" state if the POST itself errors;
  // and, as a backstop for a run that never emits a terminal event (the hang
  // class), fall back to "failed" if nothing has confirmed the stop after a grace
  // period — so the user is never left in limbo.
  const cancelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const doCancel = useCallback(async () => {
    if (cancelTimer.current) clearTimeout(cancelTimer.current);
    setCancelState("stopping");
    // If the run hasn't gone idle within the grace period, the stop didn't visibly
    // land — surface that rather than spinning forever. push() clears this the
    // moment the terminal event arrives, cancelling the effect of this timer.
    cancelTimer.current = setTimeout(() => {
      setCancelState((s) => (s === "stopping" ? "failed" : s));
    }, 8000);
    try {
      await agent.cancel();
    } catch {
      // The POST itself failed (network / non-2xx) — the stop definitely didn't
      // land. Fail immediately; don't wait out the grace timer.
      if (cancelTimer.current) clearTimeout(cancelTimer.current);
      setCancelState("failed");
    }
  }, [agent]);

  useEffect(() => {
    return () => {
      if (cancelTimer.current) clearTimeout(cancelTimer.current);
    };
  }, []);

  // The queue the UI renders = the server's confirmed queue PLUS any optimistic pending send
  // not yet reflected there. Dedup by text so a send that already made it into the server queue
  // isn't shown twice (the optimistic clear + the server snapshot can briefly overlap).
  const renderedQueue = useMemo(() => {
    if (optimisticSends.length === 0) return queuedMessages;
    const serverTexts = new Set(queuedMessages.map((q) => q.text));
    const extras = optimisticSends.filter((o) => !serverTexts.has(o.text));
    return extras.length === 0 ? queuedMessages : [...queuedMessages, ...extras];
  }, [queuedMessages, optimisticSends]);

  const interruptValue = useMemo<InterruptContextValue>(
    () => ({
      interrupts,
      submitResume: (entries) => agent.submitResume(entries),
      conversationId,
      baseUrl: BASE_URL,
      isRunning,
      activeTool,
      runStartedAt,
      contextFill,
      contextTokens,
      cancel: doCancel,
      cancelState,
      runError,
      runRetrying,
      streamAuthError,
      queuedMessages: renderedQueue,
      renderTick,
    }),
    [interrupts, agent, conversationId, isRunning, activeTool, runStartedAt, contextFill, contextTokens, doCancel, cancelState, runError, runRetrying, streamAuthError, renderedQueue, renderTick],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <InterruptContext.Provider value={interruptValue}>{children}</InterruptContext.Provider>
    </AssistantRuntimeProvider>
  );
}
