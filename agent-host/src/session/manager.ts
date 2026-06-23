/**
 * Session manager — owns conversation lifecycle in the agent-host.
 *
 * Design stage: interfaces only. Topology-agnostic: hosts N sessions (N goose
 * processes) per host pod now; one-per-pod later is a deployment change, not an
 * interface change.
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

export interface Conversation {
  readonly id: SessionId;
  readonly threadId: ThreadId;
  readonly sandbox: SandboxRef;
  readonly bridge: SessionBridge;
  readonly status: "running" | "suspended" | "ended";
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

export interface SessionManagerDeps {
  provisioner: SandboxProvisioner;
  store: ConversationStore;
}

export declare function createSessionManager(deps: SessionManagerDeps): SessionManager;
