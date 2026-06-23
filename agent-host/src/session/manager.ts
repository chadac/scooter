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
}

export type ConversationStatus = "running" | "suspended" | "ended";

export interface Conversation {
  readonly id: SessionId;
  readonly threadId: ThreadId;
  readonly sandbox: SandboxRef;
  readonly bridge?: SessionBridge;
  readonly status: ConversationStatus;
}

export interface SessionManager {
  /** Start a brand-new conversation (cold Sandbox + goose + PVCs). */
  start(threadId: ThreadId): Promise<Conversation>;
  /** Re-attach to / revive a suspended conversation (resume + replay log). */
  revive(id: SessionId): Promise<Conversation>;
  /** Forward a user prompt into the conversation's goose session. */
  prompt(id: SessionId, text: string): Promise<void>;
  suspend(id: SessionId): Promise<void>;
  end(id: SessionId): Promise<void>;

  get(id: SessionId): Conversation | undefined;
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
}

let convCounter = 0;

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { provisioner, store, bridgeFactory } = deps;
  const entries = new Map<SessionId, Entry>();

  const toConversation = (e: Entry): Conversation => ({
    id: e.id,
    threadId: e.threadId,
    sandbox: e.sandbox,
    bridge: e.bridge,
    status: e.status,
  });

  const wireEventLog = (e: Entry) => {
    if (!e.bridge) return;
    e.bridge.onEvent((event) => {
      void store.appendEvent(e.id, event);
    });
  };

  return {
    async start(threadId) {
      const id: SessionId = `conv${(convCounter += 1)}`;
      const sandbox = await provisioner.create(id);
      const bridge = bridgeFactory?.({ conversationId: id, sandbox });
      const entry: Entry = { id, threadId, sandbox, bridge, status: "running" };
      entries.set(id, entry);
      wireEventLog(entry);
      await bridge?.start();
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
      if (entry.status !== "running") await this.revive(id);
      await entry.bridge?.prompt({ threadId: entry.threadId, text });
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
  };
}
