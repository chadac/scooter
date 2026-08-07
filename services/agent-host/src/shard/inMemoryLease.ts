/**
 * In-memory OwnershipLease — the reference semantics, for tests + single-shard
 * (replicas=1) dev where no shared DB is needed. The Postgres impl
 * (createPgOwnershipLease) must behave identically; this is the spec the contract
 * test pins. See ownershipLease.ts.
 */

import { DEFAULT_LEASE_TTL_MS, type Lease, type OwnershipLease } from "./ownershipLease.js";

interface Row {
  ownerOrd: number;
  generation: number;
  expiresAt: number;
}

export interface InMemoryLeaseOpts {
  ttlMs?: number;
  /** Injectable clock for deterministic tests (default Date.now). */
  now?: () => number;
}

export function createInMemoryLease(opts: InMemoryLeaseOpts = {}): OwnershipLease {
  const ttl = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const rows = new Map<string, Row>();

  const expired = (r: Row): boolean => r.expiresAt <= now();
  const grant = (id: string, r: Row): Lease => ({
    conversationId: id,
    ownerOrd: r.ownerOrd,
    generation: r.generation,
    expiresAt: r.expiresAt,
  });

  return {
    async acquire(conversationId, ownerOrd) {
      const r = rows.get(conversationId);
      if (r && !expired(r) && r.ownerOrd !== ownerOrd) return null; // a live lease held by another shard
      // Free, expired, or re-acquire by the same owner -> grant + bump generation.
      const next: Row = {
        ownerOrd,
        generation: (r?.generation ?? 0) + 1,
        expiresAt: now() + ttl,
      };
      rows.set(conversationId, next);
      return grant(conversationId, next);
    },

    async renew(conversationId, ownerOrd, generation) {
      const r = rows.get(conversationId);
      if (!r || r.ownerOrd !== ownerOrd || r.generation !== generation || expired(r)) return null;
      r.expiresAt = now() + ttl;
      return grant(conversationId, r);
    },

    async holds(conversationId, ownerOrd, generation) {
      const r = rows.get(conversationId);
      return !!r && r.ownerOrd === ownerOrd && r.generation === generation && !expired(r);
    },

    async steal(conversationId, newOwnerOrd) {
      const r = rows.get(conversationId);
      const next: Row = {
        ownerOrd: newOwnerOrd,
        generation: (r?.generation ?? 0) + 1, // bump -> fences the previous owner
        expiresAt: now() + ttl,
      };
      rows.set(conversationId, next);
      return grant(conversationId, next);
    },

    async release(conversationId, ownerOrd, generation) {
      const r = rows.get(conversationId);
      if (r && r.ownerOrd === ownerOrd && r.generation === generation) rows.delete(conversationId);
    },

    async close() {
      rows.clear();
    },
  };
}
