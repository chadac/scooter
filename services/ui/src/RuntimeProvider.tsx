/**
 * AG-UI runtime provider: connects assistant-ui to the agent-host, keyed by the selected
 * session. The open conversation renders solely from an IntegrityAgent folding the
 * agent-host's integrity stream, which the render pump hands to an external-store runtime
 * (useRepositoryRuntime) as a message-repository snapshot with stable ids. Sends go through
 * the store's `onNew` straight to agent.send()/agent.submitResume(), and pending interrupts
 * are published through InterruptContext for InterruptPanel.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
  CompositeAttachmentAdapter,
  type AppendMessage,
} from "@assistant-ui/react";

import { useRepositoryRuntime } from "./useRepositoryRuntime.js";
import { toRepositorySnapshot, enrichMessagesWithImages, type RepositorySnapshot } from "./messageRepository.js";
import { imagesFromMessage, downscaleImage, type OutboundImage } from "./imageUpload.js";
import { filesFromMessage, SandboxFileAttachmentAdapter } from "./fileUpload.js";

import { createConversation } from "./client.js";
import { AWAITING_ID, hasId, type MaybeConversationId } from "./conversation.js";
import { currentConversation, sessionStore, setConversationMinter, useSessions } from "./sessions.js";
import {
  createIntegrityAgent,
  describeSendError,
  type IntegrityAgent,
  type PendingInterrupt,
  type QueuedItem,
  type FoldSnapshot,
  type ResumeEntry,
  type SessionSeedInfo,
} from "./integrityAgent.js";
import { conversationCache } from "./conversationCache.js";
import { ATTR, record } from "./telemetry.js";
import { withReloadHold } from "./appUpdate.js";

/** Sentinel prefixing the text part of a spliced-in system message (`${MARKER}${source}\n${text}`), paired with the `sys:` message-id prefix. */
export const SYSTEM_MSG_MARKER = " scooter-system ";

/** The parsed {source,text} when a thread message is a spliced system event, else null. */
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

/** A system message from IntegrityAgent.getSystemMessages(). */
export interface SplicedSystemMessage {
  id: string;
  source: string;
  text: string;
  /** The id of the real message this follows in the log (null = before all). */
  afterMessageId: string | null;
}

/** System-message sources that are internal plumbing for the agent and are not rendered. */
const HIDDEN_SYSTEM_SOURCES = new Set(["resume"]);

/** Interleave system messages inline by splicing a synthetic `sys:`-prefixed assistant message right after the real message with id === afterMessageId (null = before all). */
export function spliceSystemMessages(
  messages: readonly unknown[],
  sys: readonly SplicedSystemMessage[],
): unknown[] {
  const out: unknown[] = [];
  const flush = (afterId: string | null) => {
    for (const s of sys) {
      if (s.afterMessageId !== afterId) continue;
      if (HIDDEN_SYSTEM_SOURCES.has(s.source)) continue;
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

/**
 * Decides whether a folded message list may be painted. Within one fold a shrinking list
 * must be suppressed, because handing assistant-ui a shorter list mid-render throws an
 * index-out-of-bounds and blanks the page; across folds a shorter list is correct, since each
 * reconnect re-folds only the server's trailing window. The high-water mark is therefore
 * scoped to IntegrityAgent.foldGeneration() and resets when it changes.
 */
export interface FoldGate {
  /** True if this list should be painted. */
  accept(generation: number, length: number): boolean;
}

export function createFoldGate(): FoldGate {
  let generation: number | null = null;
  let highWater = 0;
  return {
    accept(gen, length) {
      if (gen !== generation) {
        generation = gen;
        highWater = 0;
      }
      if (length < highWater) return false;
      highWater = length;
      return true;
    },
  };
}

/** The current conversation's pending interrupts, run state and a resume answerer, sourced from the IntegrityAgent for InterruptPanel and the status bar. */
export interface InterruptContextValue {
  interrupts: readonly PendingInterrupt[];
  submitResume: (entries: readonly ResumeEntry[]) => Promise<void>;
  /** The server's conversation id, or AWAITING_ID before creation. */
  conversationId: MaybeConversationId;
  baseUrl: string;
  /** True while a goose run is in flight. */
  isRunning: boolean;
  /** The in-flight tool call's name, or null between tool calls or when idle. */
  activeTool: string | null;
  /** Epoch ms the current run started, or null. */
  runStartedAt: number | null;
  /** Context-window fill fraction 0..1 from the latest turn's usage, or null when unknown. */
  contextFill: number | null;
  /** {used,total} context tokens for the fill-bar tooltip, or null. */
  contextTokens: { used: number; total: number } | null;
  /** The session's parent context; null for a blank start. */
  sessionSeed: SessionSeedInfo | null;
  /** True while older history remains to page in. */
  hasOlderHistory: boolean;
  /** Fetch and prepend the next older page, resolving with how many messages were added. */
  loadOlderHistory: () => Promise<number>;
  /** Stop the running turn via the agent-host cancel route. */
  cancel: () => Promise<void>;
  /** Optimistic Stop-button feedback: "stopping" on click, "idle" once the run ends, "failed" if the cancel POST errored. */
  cancelState: "idle" | "stopping" | "failed";
  /** The last run's RUN_ERROR message, or null, cleared when the next run starts. */
  runError: string | null;
  /** Why the last send or resume never reached the server (e.g. a 413 for an oversized image), or null; cleared by the next successful one. */
  sendError: string | null;
  /** Dismiss the sendError banner. */
  clearSendError: () => void;
  /** The server's auto-retry progress for a transiently failed run, or null when not retrying. */
  runRetrying: { attempt: number; max: number } | null;
  /** True while the live stream is rejected with 401/403, self-clearing once a reconnect succeeds. */
  streamAuthError: boolean;
  /** Messages queued behind the active run, from the integrity stream's QUEUE_UPDATED snapshots. */
  queuedMessages: ReadonlyArray<QueuedItem>;
  /** A cached thread is painted, awaiting the server. */
  syncing: boolean;
  /** Bumps on every render-pump push, used as the Thread error boundary's reset key. */
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
  sessionSeed: null,
  hasOlderHistory: false,
  loadOlderHistory: async () => 0,
  cancel: async () => {},
  cancelState: "idle",
  runError: null,
  sendError: null,
  clearSendError: () => {},
  runRetrying: null,
  streamAuthError: false,
  queuedMessages: [],
  renderTick: 0,
  syncing: false,
});

export const useConversationInterrupts = () => useContext(InterruptContext);

// Quiet period before a changed fold is written to the cache.
const CACHE_SAVE_DEBOUNCE_MS = 2000;

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

// The server owns conversation ids, so the minter is installed at module scope before any component renders.
setConversationMinter(() => createConversation({ baseUrl: BASE_URL }));
// Idle-watchdog reconnect threshold in ms, overridable via VITE_IDLE_RECONNECT_MS for e2e fault tests.
const IDLE_RECONNECT_MS = import.meta.env.VITE_IDLE_RECONNECT_MS
  ? Number(import.meta.env.VITE_IDLE_RECONNECT_MS)
  : undefined;

export function RuntimeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { currentId } = useSessions();

  // Keying by currentId tears the runtime, agent, render pump and snapshot down per conversation.
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
  // Only an unsent pick rides the prompt, so the agent's own switches stand.
  const model = session?.pendingModel;
  // The server's id, or AWAITING_ID until the server creates it; the mount stays keyed on the stable key, so nothing is torn down when the id arrives.
  const conversationId: MaybeConversationId = session?.serverId ?? AWAITING_ID;
  // The Conversation object owns whether a server id exists yet, so nothing here branches on id presence.
  const conversation = useMemo(
    () => currentConversation(),
    // The object is stable across creation, so it is re-resolved only when the mounted conversation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationKey],
  );

  // The render source, keyed to the stable conversation key only: the server id and the model are updated in place, since rebuilding the agent would tear down the render pump mid-run.
  const agent = useMemo(
    () =>
      createIntegrityAgent({
        baseUrl: BASE_URL,
        conversationId,
        model,
        onModelSent: (m) => sessionStore.modelSent(conversationKey, m),
        idleReconnectMs: IDLE_RECONNECT_MS,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationKey],
  );

  // Follow the server id in place once a new conversation is created on its first send.
  useEffect(() => {
    if (hasId(conversationId)) agent.setConversationId(conversationId);
  }, [agent, conversationId]);

  // Applied synchronously during render rather than in an effect, so a select-then-send in the same tick carries the new model.
  agent.setModel(model);

  // Optimistic pending sends, shown as queued items until the server's queue or log confirms them.
  const [optimisticSends, setOptimisticSends] = useState<
    ReadonlyArray<QueuedItem>
  >([]);
  // A refused or failed POST /agui starts no run, so nothing on the stream reports it; the banner is the user's only signal.
  const [sendError, setSendError] = useState<string | null>(null);
  const clearSendError = useCallback(() => setSendError(null), []);
  const submitResume = useCallback(
    async (entries: readonly ResumeEntry[]) => {
      try {
        await agent.submitResume(entries);
        setSendError(null);
      } catch (e) {
        setSendError(describeSendError(e));
        throw e;
      }
    },
    [agent],
  );

  // The composer send: a resume answers a pending interrupt and an ordinary send goes to agent.send(), with the reply re-entering through the render pump.
  const onNew = useCallback(
    withReloadHold(async (message: AppendMessage) => {
      // A resume rides on the append message's `resume` extra.
      const resume = (message as unknown as { resume?: ResumeEntry[] }).resume;
      if (resume && resume.length > 0) {
        await submitResume(resume);
        return;
      }
      // content is a plain string or an array of parts.
      const content = message.content as unknown;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((p) => (p as { type?: string })?.type === "text").map((p) => (p as { text?: string }).text ?? "").join("")
          : "";
      // Downscale each attached image under the client cap before sending.
      const rawImages = await imagesFromMessage(message);
      const images: OutboundImage[] = [];
      for (const raw of rawImages) {
        if (!raw.mimeType || !raw.data) {
          console.warn("[RuntimeProvider] Skipping image with missing mimeType or data:", raw);
          continue;
        }
        const scaled = await downscaleImage(`data:${raw.mimeType};base64,${raw.data}`).catch(() => raw);
        if (scaled) images.push(scaled);
      }
      // Non-image file attachments are sent as-is for the agent-host to materialize into the sandbox.
      const files = filesFromMessage(message);
      if (text || images.length || files.length) {
        // Sending creates the conversation if it does not exist yet and re-points the agent at the server's id in place.
        if (!conversation) throw new Error("no conversation selected");
        await conversation.withId(async (serverId) => {
          agent.setConversationId(serverId);
        });
        if (text) sessionStore.titleFromFirstMessage(conversationKey, text);
        // A mid-run send interrupts the turn once in-flight tools finish ("thinking" policy server-side).
        const priority = agent.runIsActive() ? 10 : undefined;
        // Show the message as a pending queued item until the server confirms it (text only).
        const optId = text ? `optimistic-${crypto.randomUUID()}` : null;
        if (optId) {
          setOptimisticSends((cur) => [...cur, { id: optId, text, priority: priority ?? 0, ...(priority ? { interrupt: "thinking" as const } : {}) }]);
        }
        try {
          await agent.send(text, {
            priority,
            images: images.length ? images : undefined,
            files: files.length ? files : undefined,
          });
          setSendError(null);
        } catch (e) {
          // The server will never confirm a send that never landed, so drop the optimistic entry and say why.
          if (optId) setOptimisticSends((cur) => cur.filter((o) => o.id !== optId));
          setSendError(describeSendError(e));
          throw e;
        }
      }
    }),
    [agent, conversationId, submitResume],
  );

  const threadListAdapter = useMemo(
    () => ({
      // assistant-ui's thread identity is the stable key, not a server address.
      threadId: conversationKey,
      onSwitchToNewThread: async () => {
        sessionStore.startFresh();
      },
      onSwitchToThread: async (threadId: string) => {
        // Selection only, since the component remounts on currentId and renders from the repository snapshot.
        sessionStore.switchTo(threadId);
      },
    }),
    [conversationId],
  );

  // The image adapter comes first so images match "image/*" and ride as vision blocks, and the wildcard file adapter catches everything else.
  const attachmentAdapter = useMemo(
    () => new CompositeAttachmentAdapter([new SimpleImageAttachmentAdapter(), new SandboxFileAttachmentAdapter()]),
    [],
  );

  // The message-repository snapshot the external store renders, replaced with a fresh object (stable inner ids) on every fold.
  const EMPTY_REPO = useMemo<RepositorySnapshot>(() => ({ headId: null, messages: [] }), []);
  const [repoSnapshot, setRepoSnapshot] = useState<RepositorySnapshot>(EMPTY_REPO);

  // Run state mirrored from the IntegrityAgent on every push, published through InterruptContext.
  const [interrupts, setInterrupts] = useState<readonly PendingInterrupt[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [contextFill, setContextFill] = useState<number | null>(null);
  const [contextTokens, setContextTokens] = useState<{ used: number; total: number } | null>(null);
  const [sessionSeed, setSessionSeed] = useState<SessionSeedInfo | null>(null);
  const [cancelState, setCancelState] = useState<"idle" | "stopping" | "failed">("idle");
  const [runError, setRunError] = useState<string | null>(null);
  const [runRetrying, setRunRetrying] = useState<{ attempt: number; max: number } | null>(null);
  const [streamAuthError, setStreamAuthError] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<
    ReadonlyArray<QueuedItem>
  >([]);
  const [renderTick, setRenderTick] = useState(0);
  const [hasOlder, setHasOlder] = useState(false);
  // Suppresses a shrinking list within one fold but not across folds (see createFoldGate).
  const foldGate = useRef(createFoldGate());

  // The external-store runtime renders the repository snapshot incrementally and sends via onNew.
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
      // Error state first, because a 401 never reaches `synced` and anything below the replay guard would be deferred forever.
      setRunError(agent.getRunError());
      setHasOlder(agent.hasOlderHistory());
      setRunRetrying(agent.getRunRetrying());
      setStreamAuthError(agent.getStreamAuthError());
      setSyncing(agent.isSyncingFromCache());
      if (agent.isReplaying()) return; // else a reconnect animates the indicators through history
      const active = agent.runIsActive();
      setIsRunning(active);
      setActiveTool(agent.activeTool());
      setRunStartedAt(agent.runStartedAtMs());
      setContextFill(agent.contextFill());
      setContextTokens(agent.contextTokens());
      setSessionSeed(agent.getSessionSeed());
      if (!active) setCancelState("idle"); // an idle run drops the optimistic stopping/failed state
      setInterrupts(agent.getPendingInterrupts());
      const serverQueue = agent.getQueuedMessages();
      setQueuedMessages(serverQueue);
      // Clear an optimistic pending send once its text is in the server's queue or the message log.
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

      const folded = agent.messages as unknown as unknown[];
      if (!foldGate.current.accept(agent.foldGeneration(), folded.length)) {
        // A suppression looks like a frozen transcript, so leave a breadcrumb.
        const convId = agent.currentConversationId();
        record("ui.fold_suppressed", {
          [ATTR.conversationId]: hasId(convId) ? convId : "(awaiting-id)",
          "fold.generation": agent.foldGeneration(),
          "fold.length": folded.length,
        });
        return;
      }
      // Attach the images the base applier ignores as AG-UI wire image parts (BASE_URL is "" in prod, the webService prefix in dev).
      const enriched = enrichMessagesWithImages(folded, (id) => agent.getMessageImages(id), BASE_URL);
      const withSystem = spliceSystemMessages(enriched, agent.getSystemMessages());
      // A new snapshot with stable inner ids lets the core reconcile per message.
      setRepoSnapshot(
        toRepositorySnapshot(withSystem, (id) => agent.getMessageTime(id), {
          get: (id) => agent.getMessageImages(id),
          baseUrl: BASE_URL,
        }),
      );
      // Advance the error-boundary reset key so a transient runtime crash recovers on the next push.
      setRenderTick((n) => n + 1);
    };
    // Debounced, so a streaming run is not rewritten per token.
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      const id = agent.currentConversationId();
      const fold = agent.snapshotFold();
      if (hasId(id) && fold) void conversationCache.save(id, fold);
    };
    const { unsubscribe } = agent.subscribe({
      onMessagesChanged: () => {
        push();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, CACHE_SAVE_DEBOUNCE_MS);
      },
    });
    let stopPump: (() => void) | undefined;
    const startedAt = Date.now();
    void (hasId(conversationId) ? conversationCache.load<FoldSnapshot>(conversationId) : Promise.resolve(undefined))
      .catch(() => undefined)
      .then((cached) => {
        if (disposed) return;
        record("cache.lookup", {
          [ATTR.conversationId]: hasId(conversationId) ? conversationId : "(awaiting-id)",
          "cache.hit": cached !== undefined,
          "cache.lookup_ms": Date.now() - startedAt,
        });
        if (cached) agent.restoreFold(cached);
        stopPump = agent.renderPump();
      });
    return () => {
      disposed = true;
      clearTimeout(saveTimer);
      save();
      stopPump?.();
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
      if (text) sessionStore.titleFromFirstMessage(conversationKey, text);
    });
  }, [runtime, conversationId]);

  // Stop-button feedback: "stopping" on click, "failed" if the POST errors or nothing confirms the stop within a grace period, and "idle" once push() sees the terminal event.
  const cancelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const doCancel = useCallback(async () => {
    if (cancelTimer.current) clearTimeout(cancelTimer.current);
    setCancelState("stopping");
    // push() clears the stopping state when the terminal event arrives, which makes this timer moot.
    cancelTimer.current = setTimeout(() => {
      setCancelState((s) => (s === "stopping" ? "failed" : s));
    }, 8000);
    try {
      await agent.cancel();
    } catch {
      // The POST itself failed, so fail immediately rather than waiting out the grace timer.
      if (cancelTimer.current) clearTimeout(cancelTimer.current);
      setCancelState("failed");
    }
  }, [agent]);

  useEffect(() => {
    return () => {
      if (cancelTimer.current) clearTimeout(cancelTimer.current);
    };
  }, []);

  // The rendered queue is the server's confirmed queue plus any optimistic pending send not yet in it, deduped by text.
  const renderedQueue = useMemo(() => {
    if (optimisticSends.length === 0) return queuedMessages;
    const serverTexts = new Set(queuedMessages.map((q) => q.text));
    const extras = optimisticSends.filter((o) => !serverTexts.has(o.text));
    return extras.length === 0 ? queuedMessages : [...queuedMessages, ...extras];
  }, [queuedMessages, optimisticSends]);

  // Stable identity: the thread's scroll handler holds this in an effect dep.
  const loadOlder = useCallback(async () => {
    const n = await agent.loadOlderHistory();
    setHasOlder(agent.hasOlderHistory());
    return n;
  }, [agent]);

  const interruptValue = useMemo<InterruptContextValue>(
    () => ({
      interrupts,
      submitResume,
      conversationId,
      baseUrl: BASE_URL,
      isRunning,
      activeTool,
      runStartedAt,
      contextFill,
      contextTokens,
      sessionSeed,
      hasOlderHistory: hasOlder,
      loadOlderHistory: loadOlder,
      cancel: doCancel,
      cancelState,
      runError,
      sendError,
      clearSendError,
      runRetrying,
      streamAuthError,
      queuedMessages: renderedQueue,
      renderTick,
      syncing,
    }),
    [interrupts, submitResume, conversationId, isRunning, activeTool, runStartedAt, contextFill, contextTokens, sessionSeed, hasOlder, loadOlder, doCancel, cancelState, runError, sendError, clearSendError, runRetrying, streamAuthError, renderedQueue, renderTick, syncing],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <InterruptContext.Provider value={interruptValue}>{children}</InterruptContext.Provider>
    </AssistantRuntimeProvider>
  );
}
