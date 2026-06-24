/**
 * Session manager — owns conversation lifecycle in the agent-host.
 *
 * Topology-agnostic: hosts N sessions (N goose processes) per host pod now;
 * one-per-pod later is a deployment change, not an interface change.
 *
 * Per conversation it ties together:
 *   - a Sandbox (cold, per-conversation SA + 2 PVCs)        -> provisioner
 *   - a goose acp process + ACP<->AG-UI bridge              -> SessionBridge
 *   - the conversation-state PVC (goose state + event log)  -> store
 *   - the AG-UI connection(s) to the browser                -> AguiServer
 */

import type { SessionId, ThreadId, SandboxRef } from "../types.js";
import type { SessionBridge, AguiEvent } from "../bridge.js";

/** An event plus the rolling integrity checksum through it. `prevChecksum` is
 *  the chain value before this event (so a client links each event to the one
 *  before); `checksum` is the value through and including it. */
export interface ChecksummedEvent {
  event: AguiEvent;
  prevChecksum: string;
  checksum: string;
}

/** Provisions / suspends / resumes the per-conversation Sandbox. */
export interface SandboxProvisioner {
  /** Cold-create a Sandbox: SA sandbox-{id}, workspace + conversation PVCs. */
  create(conversationId: string): Promise<SandboxRef>;
  /** operatingMode: Suspended (drops Pod, keeps PVCs + Sandbox object). */
  suspend(ref: SandboxRef): Promise<void>;
  /** operatingMode: Running (recreates Pod, re-mounts PVCs, same SA). */
  resume(ref: SandboxRef): Promise<SandboxRef>;
  /** Delete the Sandbox + GC the per-conversation SA/RBAC. */
  destroy(ref: SandboxRef): Promise<void>;
}

/** Durable, restart-surviving metadata for one conversation. */
export interface ConversationMeta {
  id: SessionId;
  threadId: ThreadId;
  title: string;
  createdAt: number;
  lastActivityAt: number;
}

/** Durable conversation store (event log replay + goose state pointer). */
export interface ConversationStore {
  appendEvent(id: SessionId, event: AguiEvent): Promise<void>;
  readEvents(id: SessionId): AsyncIterable<AguiEvent>;
  /** Like readEvents, but each item carries the rolling integrity checksum
   *  through that event (and the previous one) so a streaming client can verify
   *  the chain. Computed deterministically from the persisted log order, so it
   *  survives a restart. Optional (in-memory test stores may skip it). */
  readEventsWithChecksum?(id: SessionId): AsyncIterable<ChecksummedEvent>;
  /** Subscribe to events as they are durably appended, each carrying its rolling
   *  checksum (folded in persisted order). This is the authority the live
   *  integrity stream broadcasts — it sees EVERY logged event (incl. the user's
   *  own prompt), exactly once, in order. Returns an unsubscribe fn. Optional. */
  onAppend?(cb: (id: SessionId, event: ChecksummedEvent) => void): () => void;
  /** Path on the conversation-state PVC where goose session data lives. */
  gooseStatePath(id: SessionId): string;
  /** Persist last-activity (ms epoch) so it survives restarts and is queryable
   *  by an external lifecycle manager. Optional. */
  recordActivity?(id: SessionId, at: number): Promise<void>;
  /** Persist conversation metadata (title/createdAt) so the list survives an
   *  agent-host restart. Optional (in-memory stores skip it). */
  saveMeta?(meta: ConversationMeta): Promise<void>;
  /** Reconstruct all persisted conversations (for the list after a restart).
   *  Optional. */
  listConversations?(): Promise<ConversationMeta[]>;
  /** Permanently remove a conversation's persisted state so an ended/deleted
   *  conversation does not reappear on the next hydrate(). Optional. */
  removeConversation?(id: SessionId): Promise<void>;
}

export type ConversationStatus = "running" | "suspended" | "ended";

export interface Conversation {
  readonly id: SessionId;
  readonly threadId: ThreadId;
  readonly sandbox: SandboxRef;
  readonly bridge?: SessionBridge;
  readonly status: ConversationStatus;
  readonly title: string;
  readonly createdAt: number;
  /** ms epoch of the last prompt or agent event. Drives idle-suspend. */
  readonly lastActivityAt: number;
  /** Model this conversation runs on (undefined = the host default). */
  readonly model?: string;
}

export interface SessionManager {
  /** Start a brand-new conversation (cold Sandbox + goose + PVCs). The optional
   *  model selects which agent model this conversation runs on (validated by
   *  the caller against the offered set). */
  start(threadId: ThreadId, model?: string): Promise<Conversation>;
  /** Re-attach to / revive a suspended conversation (resume + replay log). */
  revive(id: SessionId): Promise<Conversation>;
  /** Forward a user prompt into the conversation's goose session. */
  prompt(id: SessionId, text: string): Promise<void>;
  /** Find-or-start the conversation for an AG-UI thread, then prompt it. */
  promptByThread(threadId: ThreadId, text: string): Promise<void>;
  suspend(id: SessionId): Promise<void>;
  end(id: SessionId): Promise<void>;

  get(id: SessionId): Conversation | undefined;
  /** All conversations, newest first. */
  list(): Conversation[];
  /** Set a conversation's title (e.g. agent-assigned). */
  setTitle(id: SessionId, title: string): void;
  /** Load persisted conversations from the store into the in-memory list, so
   *  the session list (and GET /conversations) survives an agent-host restart.
   *  Persisted-but-not-live conversations come back as "suspended". */
  hydrate(): Promise<void>;
  /**
   * Suspend conversations that have been idle (no prompt/event) longer than
   * idleMs. Native-friendly: the agent-host owns the activity signal, so it
   * does this itself; the activity metadata is exposed so an external
   * controller could take over. Returns the ids suspended.
   */
  sweepIdle(idleMs: number, now?: number): Promise<SessionId[]>;
}

/** Builds the ACP<->AG-UI bridge for a conversation (spawns goose in prod). */
export type BridgeFactory = (args: {
  conversationId: SessionId;
  sandbox: SandboxRef;
  /** Per-conversation model override (undefined = host default). */
  model?: string;
}) => SessionBridge | undefined;

export interface SessionManagerDeps {
  provisioner: SandboxProvisioner;
  store: ConversationStore;
  /** Optional: how to build a bridge per conversation. Omitted in unit tests
   *  that only assert lifecycle/provisioning. */
  bridgeFactory?: BridgeFactory;
}

interface Entry {
  id: SessionId;
  threadId: ThreadId;
  sandbox: SandboxRef;
  bridge?: SessionBridge;
  status: ConversationStatus;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  model?: string;
}

/** Short, DNS-1123-safe id derived from a (possibly UUID) thread id. */
function shortId(threadId: string): string {
  let h = 0;
  for (let i = 0; i < threadId.length; i++) h = (h * 31 + threadId.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { provisioner, store, bridgeFactory } = deps;
  const entries = new Map<SessionId, Entry>();

  const toConversation = (e: Entry): Conversation => ({
    id: e.id,
    threadId: e.threadId,
    sandbox: e.sandbox,
    bridge: e.bridge,
    status: e.status,
    title: e.title,
    createdAt: e.createdAt,
    lastActivityAt: e.lastActivityAt,
    model: e.model,
  });

  const touch = (e: Entry) => {
    e.lastActivityAt = nowMs();
    void store.recordActivity?.(e.id, e.lastActivityAt);
  };

  // Returns the persist promise so callers that must guarantee durability (e.g.
  // start(), before returning to the caller) can await it; fire-and-forget
  // callers (setTitle) just ignore it.
  const saveMeta = (e: Entry): Promise<void> =>
    store.saveMeta?.({
      id: e.id,
      threadId: e.threadId,
      title: e.title,
      createdAt: e.createdAt,
      lastActivityAt: e.lastActivityAt,
    }) ?? Promise.resolve();

  const wireEventLog = (e: Entry) => {
    if (!e.bridge) return;
    // Persist via the onPersist channel ONLY. The bridge's emit() fires BOTH the
    // broadcast (onEvent) and persist (onPersist) listener sets, and persist-only
    // events (the user's own prompt) fire onPersist alone — so onPersist sees
    // EVERY event that should be logged, exactly once. Subscribing to onEvent too
    // would double-log every broadcast event (bloated, replay-confusing history).
    e.bridge.onPersist((event) => {
      e.lastActivityAt = nowMs();
      void store.appendEvent(e.id, event);
    });
  };

  return {
    async start(threadId, model) {
      // The conversation id IS the thread id, so AG-UI events broadcast/persist
      // under the same key the UI subscribes by. The sandbox (k8s) name uses a
      // short DNS-safe hash of it.
      const id: SessionId = threadId;
      const sandbox = await provisioner.create(shortId(threadId));
      const bridge = bridgeFactory?.({ conversationId: id, sandbox, model });
      const entry: Entry = {
        id, threadId, sandbox, bridge, status: "running",
        title: "New chat", createdAt: nowMs(), lastActivityAt: nowMs(), model,
      };
      entries.set(id, entry);
      wireEventLog(entry);
      // Await the persist so a started conversation is durable before we return
      // (a crash right after start() must not lose it; and hydrate() in another
      // process must see it). setTitle stays fire-and-forget.
      await saveMeta(entry);
      // NOTE: do NOT eagerly bridge.start() here — that spawns goose and blocks
      // on its ACP newSession. bridge.prompt() lazily starts on first use, after
      // emitting RUN_STARTED, so the UI always sees the run begin.
      return toConversation(entry);
    },

    async revive(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      // A HYDRATED conversation (restored from disk after a restart) has a
      // placeholder sandbox ref with no namespace — its pod was never created in
      // THIS process (and a suspended Sandbox may have been GC'd). Re-create the
      // sandbox rather than resume a ref this process never owned.
      entry.sandbox = entry.sandbox.namespace
        ? await provisioner.resume(entry.sandbox)
        : await provisioner.create(shortId(entry.threadId));
      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model: entry.model }) ?? entry.bridge;
      entry.status = "running";
      wireEventLog(entry);
      saveMeta(entry);
      await entry.bridge?.start();
      // Event-log replay to a reattaching UI is driven by the AG-UI server's
      // onAttach handler reading store.readEvents(id); nothing to do here.
      return toConversation(entry);
    },

    async prompt(id, text) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      touch(entry);
      if (entry.status !== "running") await this.revive(id);
      await entry.bridge?.prompt({ threadId: entry.threadId, text });
    },

    async promptByThread(threadId, text) {
      // Find the conversation for this thread, or start one on first prompt.
      let entry = [...entries.values()].find((e) => e.threadId === threadId);
      if (!entry) {
        const conv = await this.start(threadId);
        entry = entries.get(conv.id)!;
      } else if (entry.status !== "running") {
        await this.revive(entry.id);
      }
      touch(entry);
      await entry.bridge?.prompt({ threadId, text });
    },

    async suspend(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      await entry.bridge?.stop();
      await provisioner.suspend(entry.sandbox);
      entry.bridge = undefined;
      entry.status = "suspended";
    },

    async end(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      await entry.bridge?.stop();
      await provisioner.destroy(entry.sandbox);
      entry.bridge = undefined;
      entry.status = "ended";
      // Delete-don't-tombstone: drop it from the in-memory list AND remove its
      // persisted state, so it neither shows in GET /conversations nor returns
      // on the next hydrate(). (Suspend, not end, is the durable handle.)
      entries.delete(id);
      await store.removeConversation?.(id);
    },

    get(id) {
      const entry = entries.get(id);
      return entry ? toConversation(entry) : undefined;
    },

    list() {
      return [...entries.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(toConversation);
    },

    setTitle(id, title) {
      const entry = entries.get(id);
      if (entry) {
        entry.title = title;
        saveMeta(entry); // persist the (possibly agent-assigned) title
      }
    },

    async hydrate() {
      const metas = (await store.listConversations?.()) ?? [];
      for (const m of metas) {
        if (entries.has(m.id)) continue; // a live one already exists
        // Persisted but not currently live -> a resumable (suspended)
        // conversation. No bridge/sandbox yet; revive() recreates them on use.
        entries.set(m.id, {
          id: m.id,
          threadId: m.threadId,
          sandbox: { name: `conv-${shortId(m.threadId)}`, namespace: "" },
          bridge: undefined,
          status: "suspended",
          title: m.title,
          createdAt: m.createdAt,
          lastActivityAt: m.lastActivityAt,
        });
      }
    },

    async sweepIdle(idleMs, now = nowMs()) {
      const suspended: SessionId[] = [];
      for (const entry of entries.values()) {
        if (entry.status !== "running") continue;
        if (now - entry.lastActivityAt < idleMs) continue;
        try {
          await this.suspend(entry.id);
          suspended.push(entry.id);
        } catch {
          /* best-effort; a failed suspend is retried next sweep */
        }
      }
      return suspended;
    },
  };
}

/** Wall-clock ms. Wrapped so it's mockable / avoids new Date() in pure code. */
function nowMs(): number {
  return Date.now();
}
