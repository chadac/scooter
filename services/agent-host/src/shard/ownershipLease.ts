/**
 * Ownership lease — the load-bearing correctness primitive for sharding.
 *
 * With N agent-host shards and SHARD-LOCAL event seq (no per-event DB round-trip),
 * correctness rests entirely on this: at most ONE shard "owns" a conversation at a
 * time, and a superseded owner is FENCED (its stale writes rejected). A shard must
 * hold the current lease generation before it spawns goose or appends an event.
 *
 * Model (a `conversation_shard` row per conversation):
 *   - owner_ord  : which shard currently owns the conversation
 *   - generation : bumped on every (re)acquire/steal — the fencing token
 *   - expires_at : lease expiry; an expired lease is free to acquire
 *
 * A shard:
 *   1. acquire() on first access — grants + returns a generation, OR null if a live
 *      lease is held by another shard.
 *   2. renew() periodically while it holds the conversation (heartbeat) — extends
 *      expiry IFF it still holds that generation.
 *   3. holds() before every goose spawn / event append — cheap guard that it wasn't
 *      superseded (a move/steal bumped the generation).
 *   4. steal() (router/rebalance/dead-shard) — force-acquire, bumping the
 *      generation so the previous owner is fenced on its next holds()/renew().
 *
 * This interface is storage-agnostic: `createInMemoryLease` (tests/dev) and
 * `createPgOwnershipLease` (production, on the shared DB) implement it.
 * See docs/AGENT_HOST_SHARDING.md (stage 0).
 */

/** A granted lease: the fencing token the holder must present. */
export interface Lease {
  conversationId: string;
  ownerOrd: number;
  /** Monotonic per-conversation fencing token; bumped on every (re)acquire/steal. */
  generation: number;
  /** ms epoch when the lease expires unless renewed. */
  expiresAt: number;
}

export interface OwnershipLease {
  /**
   * Try to acquire the conversation for `ownerOrd`. Grants (and bumps the
   * generation) when the conversation is unowned OR its lease has expired OR
   * `ownerOrd` already holds it (idempotent re-acquire, extends expiry). Returns
   * the granted Lease, or null when another shard holds a live lease.
   */
  acquire(conversationId: string, ownerOrd: number): Promise<Lease | null>;

  /**
   * Extend the lease IFF `ownerOrd` still holds `generation`. Returns the renewed
   * Lease, or null if fenced (superseded generation / different owner / gone).
   */
  renew(conversationId: string, ownerOrd: number, generation: number): Promise<Lease | null>;

  /**
   * Cheap guard: does `ownerOrd` still hold `generation` AND the lease is unexpired?
   * Called before a goose spawn / event append. False = fenced; the caller must
   * stop (do NOT spawn/append).
   */
  holds(conversationId: string, ownerOrd: number, generation: number): Promise<boolean>;

  /**
   * Force-acquire for `newOwnerOrd`, bumping the generation so the previous owner
   * is fenced. Used by the router for drain/rebalance and dead-shard reassignment.
   * Always grants (subject to storage availability).
   */
  steal(conversationId: string, newOwnerOrd: number): Promise<Lease>;

  /** Release the lease (owner shutting a conversation down cleanly). No-op if not held. */
  release(conversationId: string, ownerOrd: number, generation: number): Promise<void>;

  close(): Promise<void>;
}

/** How long a freshly acquired/renewed lease is valid (ms). A holder renews well
 *  within this; a dead holder's lease lapses after it, freeing the conversation. */
export const DEFAULT_LEASE_TTL_MS = 30_000;
