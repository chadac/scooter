/**
 * ConversationRegistry: the multi-replica assignment table, backed by the `conversations`
 * row (pgConversationRegistry), the source of truth for a conversation's existence,
 * ownership and liveness; the in-memory entries and the Sandbox are caches or bodies of it.
 * The router inserts the row, the router or controller assigns it a host_pod, the router
 * forwards on that, and the OwnershipGuard fences stale writers by it. Single-replica
 * agent-host (POD_NAME unset) uses noopRegistry.
 */

import type { ConversationKind, Visibility } from "./visibility.js";

export interface ConversationSpec {
  /** The model the conversation runs (the row's model). */
  model?: string;
  /** Owning user id, or undefined for anonymous/single-user (owner). */
  owner?: string;
  /** Parent conversation id for a subagent, else undefined (parent_id). */
  parentId?: string;
  /** Read-only here: set by the router's insert. */
  kind?: ConversationKind;
  /** Read-only here: set by the router's insert. */
  origin?: string;
  /** The backing Sandbox name, if known at start (sandbox_ref). */
  sandboxRef?: string;
  /** The pod that created the conversation (creator_pod), a placement hint the controller
   *  prefers while that pod is ready, since the run physically lives there. */
  creatorPod?: string;
  /** Read-only here: the router's insert and setVisibility write it (visibility). */
  visibility?: Visibility;
}

/** Conversation liveness folded into the row's `phase`: the controller owns the assignment
 *  phases, and agent-host publishes Suspended on idle-suspend and Assigned (alive) again on revive. */
export type ConversationPhase = "Assigned" | "Suspended";

export interface ConversationRegistry {
  /**
   * Record the placement hints (sandbox_ref, creator_pod) on the row; idempotent and never
   * throws, so the conversation still starts when the write fails.
   */
  register(id: string, spec: ConversationSpec): Promise<void>;
  /**
   * Publish a liveness transition to `phase` for a conversation this pod owns;
   * idempotent, never throws, a no-op single-replica.
   */
  setPhase(id: string, phase: ConversationPhase): Promise<void>;

  /**
   * Delete the row, since a surviving row would be re-adopted by hydrate(); idempotent and
   * never throws, but a failure is logged.
   */
  remove(id: string): Promise<void>;

  /**
   * List every conversation, the authoritative answer to which conversations exist; callers
   * filter to what they own, and unlike the write methods this throws on failure so a pod
   * cannot serve a stale view.
   */
  list(): Promise<ConversationRecord[]>;

  /**
   * One conversation, or undefined when it does not exist; throws on a real read failure.
   */
  get(id: string): Promise<ConversationRecord | undefined>;
}

/**
 * A conversation as the host reads it: the spec plus the router/controller-owned placement,
 * enough to rebuild an in-memory entry.
 */
export interface ConversationRecord {
  id: string;
  spec: ConversationSpec;
  /** phase, absent until the conversation is first placed (or when Pending/Failed). */
  phase?: ConversationPhase;
  /** host_pod, the pod the conversation is assigned to; ownership is `hostPod === selfPod`. */
  hostPod?: string;
  /** host_generation, bumped on reassignment; the fencing token for stale writers. */
  generation?: number;
}

/** The single-replica / test default: registering a conversation does nothing. */
export const noopRegistry: ConversationRegistry = {
  async register() {
    /* no assignment table in single-replica mode */
  },
  async setPhase() {
    /* no assignment table in single-replica mode */
  },
  async remove() {
    /* no assignment table in single-replica mode */
  },
  async list() {
    // Single-replica has no assignments, so [] keeps the adopt-what-is-mine hydrate path a no-op.
    return [];
  },
  async get() {
    return undefined;
  },
};
