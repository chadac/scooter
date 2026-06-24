/**
 * Rolling integrity checksum for a conversation's AG-UI event log.
 *
 * A Merkle-style chain: checksum_n = sha256(checksum_{n-1} || canonical(event_n)),
 * starting from a fixed seed. Each persisted/broadcast event carries the checksum
 * of the log *through and including* that event, plus the previous checksum.
 *
 * Why: a UI streaming a conversation can only trust it has the complete, in-order
 * log if every event's `prevChecksum` matches the checksum it last held. A
 * mismatch means a gap (dropped SSE frame, reconnect, out-of-order, or a run it
 * never saw) — the client re-fetches history until the checksums agree. The
 * checksum is cheap for the server to maintain (one hash per appended event) and
 * for the client to verify (the same hash as events arrive).
 *
 * The hash input is the event's canonical JSON (stable key order) so the server
 * and client compute identical values from the same logical event.
 */

import { createHash } from "node:crypto";

import type { AguiEvent } from "../bridge.js";

/** Seed checksum for an empty log (checksum_0). Distinct, fixed, documented. */
export const EMPTY_CHECKSUM = "0".repeat(64);

/** Canonical JSON for hashing: keys sorted so {a,b} and {b,a} hash identically.
 *  AG-UI events are flat string/number/boolean records, so a shallow sort is
 *  sufficient and deterministic across server (persist) and client (verify). */
export function canonicalize(event: AguiEvent): string {
  const obj = event as unknown as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

/** Fold one event into the chain: sha256(prev || canonical(event)). */
export function chainNext(prev: string, event: AguiEvent): string {
  return createHash("sha256").update(prev).update(canonicalize(event)).digest("hex");
}

/** Compute the checksum of an in-order event sequence from the seed. */
export function chainAll(events: Iterable<AguiEvent>, seed = EMPTY_CHECKSUM): string {
  let acc = seed;
  for (const e of events) acc = chainNext(acc, e);
  return acc;
}

/** A stateful folder — tracks the running checksum as events are appended.
 *  The server keeps one per conversation; the client keeps one per open thread. */
export interface ChecksumChain {
  /** Checksum through the last folded event (EMPTY_CHECKSUM if none). */
  readonly current: string;
  /** Fold `event`, returning { prev, next } — the checksum before and after. */
  push(event: AguiEvent): { prev: string; next: string };
  /** Reset to a known checksum (e.g. after a resync). */
  reset(to: string): void;
}

export function createChecksumChain(seed = EMPTY_CHECKSUM): ChecksumChain {
  let current = seed;
  return {
    get current() {
      return current;
    },
    push(event) {
      const prev = current;
      current = chainNext(prev, event);
      return { prev, next: current };
    },
    reset(to) {
      current = to;
    },
  };
}
