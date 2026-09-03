/**
 * ConversationRegistry — the multi-replica assignment table.
 *
 * THE CR IS THE SOURCE OF TRUTH for a conversation's existence, ownership and liveness.
 * Everything else is a cache of it (LOCAL_STATE_PATH, the in-memory `entries` map), history
 * hanging off it (the durable mirror), or its body (the Sandbox). Where any of those disagree
 * with the CR, the CR is right. See docs/CONVERSATION_STATE_MODEL.md.
 *
 * This interface was WRITE-ONLY, which is why that was true on paper and false in practice: a
 * source of truth nothing reads back cannot be one. `hydrate()` asked the ephemeral local store
 * "which conversations exist?" instead — a question an emptyDir cannot answer after a restart —
 * so every pod booted with zero conversations and the idle sweep reclaimed nothing, forever.
 * list()/get() below are the missing read side.
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
  /** The pod that CREATED the conversation (spec.creatorPod) — a placement hint. The
   *  run physically lives here (bridge, sandbox exec, local event log), but the
   *  controller's least-loaded pick could not know that and routinely assigned the
   *  OTHER pod: the run's appends were then fenced off mid-run, the "owner" had
   *  nothing live to stream, and the UI sat at "Working…" forever. The controller
   *  prefers this pod when it is ready — same reasoning as a subagent pinning to its
   *  parent's pod. */
  creatorPod?: string;
}

/** Conversation liveness, folded into the CR's `status.phase` so it's observable via
 *  `kubectl get conversations`. The controller owns the ASSIGNMENT phases (Pending →
 *  Assigned, Orphaned); agent-host owns the LIVENESS transition of an already-assigned
 *  conversation (Assigned ⇄ Suspended) — it publishes Suspended when it idle-suspends the
 *  sandbox and Assigned again on revive. `Assigned` doubles as "alive". These never race:
 *  the controller only patches phase during (re)assignment (NoOp on a still-ready host), and
 *  suspend drops the SANDBOX pod, not the agent-host owner pod — so assignment is unchanged.
 *  See todo/docs/CONVERSATION_LIFECYCLE_CONTROLLER.md. */
export type ConversationPhase = "Assigned" | "Suspended";

export interface ConversationRegistry {
  /**
   * Ensure a `Conversation` CR exists for `id`. Idempotent (already-exists => no-op) and
   * never throws — a k8s failure is logged, not propagated, so the conversation still
   * starts. Fire-and-forget from the caller's perspective; awaiting is optional.
   */
  register(id: string, spec: ConversationSpec): Promise<void>;
  /**
   * Publish a liveness transition to `status.phase` (Assigned ⇄ Suspended). Called by
   * agent-host when it suspends/revives a conversation it OWNS. Idempotent, never throws
   * (a k8s failure is logged, not propagated), fire-and-forget. A no-op single-replica.
   */
  setPhase(id: string, phase: ConversationPhase): Promise<void>;

  /**
   * DELETE the `Conversation` CR — the conversation no longer exists.
   *
   * Required because the CR is the source of truth for EXISTENCE: end() removing local
   * state and the store record is not enough, since a surviving CR is re-adopted by
   * hydrate() and the conversation comes back. Observed on a real cluster — DELETE
   * answered 204 and the conversation stayed listed as `running` indefinitely, because
   * nothing could remove its CR.
   *
   * Idempotent (already gone => no-op) and never throws, matching register/setPhase: a
   * k8s failure must not turn a successful local delete into a 500. It IS logged — a CR
   * outliving its conversation is a leak, and a silent one is how this bug survived.
   */
  remove(id: string): Promise<void>;

  /**
   * LIST every Conversation CR in the namespace — the authoritative answer to "which
   * conversations exist?". Callers filter to what they own (`hostPod === selfPod`); adoption of
   * an UNASSIGNED CR is deliberately not a host's job, because the controller is the single
   * assigner and self-assignment would race its load accounting (decision Q1).
   *
   * Unlike the write methods this THROWS on failure. A pod that cannot read the source of truth
   * must not serve on a stale view: boot retries with backoff and then fails readiness rather
   * than silently serving the local cache (decision Q4).
   *
   * Design stage: SIGNATURE ONLY.
   */
  list(): Promise<ConversationRecord[]>;

  /**
   * GET one CR, or undefined if it does not exist. Used to re-check ownership at a point where
   * a stale view is dangerous, without paying for a full list. Throws on a real k8s failure —
   * "not found" is `undefined`, not an exception.
   *
   * Design stage: SIGNATURE ONLY.
   */
  get(id: string): Promise<ConversationRecord | undefined>;
}

/**
 * A Conversation CR as the host reads it: spec (what the conversation IS) plus the status the
 * controller owns (where it is assigned, whether it is alive). Sufficient to rebuild an in-memory
 * entry with no ephemeral store involved — verified against a live CR, which carries owner,
 * sandboxRef, phase and generation.
 */
export interface ConversationRecord {
  id: string;
  spec: ConversationSpec;
  /** status.phase — Assigned (alive) or Suspended. Absent on a CR the controller has not
   *  reconciled yet (status: null), which reads as Pending. */
  phase?: ConversationPhase;
  /** status.hostPod — the pod the CONTROLLER assigned. Ownership is `hostPod === selfPod`. */
  hostPod?: string;
  /** status.hostIP — the routing address the router proxies to. */
  hostIP?: string;
  /** status.generation — bumped on reassignment; the fencing token for stale writers. */
  generation?: number;
}

/** The single-replica / test default: registering a conversation does nothing. */
export const noopRegistry: ConversationRegistry = {
  async register() {
    /* no CR in single-replica mode */
  },
  async setPhase() {
    /* no CR in single-replica mode */
  },
  async remove() {
    /* no CR in single-replica mode */
  },
  async list() {
    // Single-replica has no CRs at all. Returning [] (rather than throwing) keeps the
    // CR-driven hydrate path a no-op here, so single-replica keeps hydrating from the local
    // store exactly as it does today.
    return [];
  },
  async get() {
    return undefined;
  },
};
