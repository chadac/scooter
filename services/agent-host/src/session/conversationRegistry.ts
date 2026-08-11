/**
 * ConversationRegistry — the write side of the multi-replica assignment table.
 *
 * When agent-host starts a conversation it registers it as a `Conversation` CR
 * (scooter.chadac.dev/v1alpha1). The controller then assigns the CR a hostPod
 * (status.hostPod); the router reads that to forward subsequent requests, and the
 * OwnershipGuard watches it to fence stale writers. Without a CR the controller has
 * nothing to assign and the router falls back to DEFAULT_POD — so every conversation
 * lands on one pod. Registration is what makes routing actually split.
 *
 * register() is idempotent: creating a CR that already exists (a re-`start()` after a
 * revive, or another pod that raced us) is a no-op, not an error. It never THROWS on a
 * k8s failure — a conversation must still start locally even if the CR write fails; the
 * guard fails open for an unregistered conversation, so the only cost is that request
 * pins to the default pod until the CR appears.
 *
 * Single-replica agent-host (POD_NAME unset) uses noopRegistry — no CR, no k8s call.
 */

export interface ConversationSpec {
  /** The model the conversation runs (mirrors Conversation.spec.model). */
  model?: string;
  /** Owning user id, or undefined for anonymous/single-user (spec.owner). */
  owner?: string;
  /** Parent conversation id for a subagent, else undefined (spec.parentId). */
  parentId?: string;
  /** The backing Sandbox name, if known at start (spec.sandboxRef). */
  sandboxRef?: string;
}

export interface ConversationRegistry {
  /**
   * Ensure a `Conversation` CR exists for `id`. Idempotent (already-exists => no-op) and
   * never throws — a k8s failure is logged, not propagated, so the conversation still
   * starts. Fire-and-forget from the caller's perspective; awaiting is optional.
   */
  register(id: string, spec: ConversationSpec): Promise<void>;
}

/** The single-replica / test default: registering a conversation does nothing. */
export const noopRegistry: ConversationRegistry = {
  async register() {
    /* no CR in single-replica mode */
  },
};
