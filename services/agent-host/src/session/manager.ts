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

/** Durable conversation store (event log replay + goose state pointer). */
export interface ConversationStore {
  appendEvent(id: SessionId, event: AguiEvent): Promise<void>;
  readEvents(id: SessionId): AsyncIterable<AguiEvent>;
  /** Path on the conversation-state PVC where goose session data lives. */
  gooseStatePath(id: SessionId): string;
  /** Persist last-activity (ms epoch) so it survives restarts and is queryable
   *  by an external lifecycle manager. Optional. */
  recordActivity?(id: SessionId, at: number): Promise<void>;
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
}

export interface SessionManager {
  /** Start a brand-new conversation (cold Sandbox + goose + PVCs). */
  start(threadId: ThreadId): Promise<Conversation>;
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
  });

  const touch = (e: Entry) => {
    e.lastActivityAt = nowMs();
    void store.recordActivity?.(e.id, e.lastActivityAt);
  };

  const wireEventLog = (e: Entry) => {
    if (!e.bridge) return;
    e.bridge.onEvent((event) => {
      e.lastActivityAt = nowMs(); // agent events count as activity
      void store.appendEvent(e.id, event);
    });
  };

  return {
    async start(threadId) {
      // The conversation id IS the thread id, so AG-UI events broadcast/persist
      // under the same key the UI subscribes by. The sandbox (k8s) name uses a
      // short DNS-safe hash of it.
      const id: SessionId = threadId;
      const sandbox = await provisioner.create(shortId(threadId));
      const bridge = bridgeFactory?.({ conversationId: id, sandbox });
      const entry: Entry = {
        id, threadId, sandbox, bridge, status: "running",
        title: "New chat", createdAt: nowMs(), lastActivityAt: nowMs(),
      };
      entries.set(id, entry);
      wireEventLog(entry);
      // NOTE: do NOT eagerly bridge.start() here — that spawns goose and blocks
      // on its ACP newSession. bridge.prompt() lazily starts on first use, after
      // emitting RUN_STARTED, so the UI always sees the run begin.
      return toConversation(entry);
    },

    async revive(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      entry.sandbox = await provisioner.resume(entry.sandbox);
      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox }) ?? entry.bridge;
      entry.status = "running";
      wireEventLog(entry);
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
      if (entry) entry.title = title;
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
