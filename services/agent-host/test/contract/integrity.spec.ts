/**
 * Tier 1 contract test — rolling integrity checksum.
 *
 * The chain is the basis for the UI's "did I miss anything?" self-heal: each
 * event carries the checksum through it + the previous checksum, so a client
 * detects a gap when a live event's prevChecksum != the checksum it holds.
 */

import { describe, it, expect } from "vitest";

import {
  EMPTY_CHECKSUM,
  canonicalize,
  chainNext,
  chainAll,
  createChecksumChain,
} from "../../src/agui/integrity.js";
import type { AguiEvent } from "../../src/bridge.js";

const ev = (i: number): AguiEvent => ({
  type: "TEXT_MESSAGE_CONTENT",
  messageId: "m1",
  delta: `chunk-${i}`,
});

describe("rolling integrity checksum", () => {
  it("canonicalize is key-order independent", () => {
    const a = { type: "TEXT_MESSAGE_START", messageId: "m1", role: "user" } as AguiEvent;
    const b = { role: "user", messageId: "m1", type: "TEXT_MESSAGE_START" } as unknown as AguiEvent;
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("is deterministic and order-sensitive", () => {
    const events = [ev(1), ev(2), ev(3)];
    const c1 = chainAll(events);
    const c2 = chainAll(events);
    expect(c1).toBe(c2); // deterministic
    expect(c1).toMatch(/^[0-9a-f]{64}$/); // sha256 hex

    const reordered = chainAll([ev(2), ev(1), ev(3)]);
    expect(reordered).not.toBe(c1); // order matters
  });

  it("changing any event changes every subsequent checksum", () => {
    const base = [ev(1), ev(2), ev(3)];
    const tampered = [ev(1), { ...ev(2), delta: "TAMPERED" } as AguiEvent, ev(3)];
    expect(chainAll(tampered)).not.toBe(chainAll(base));
  });

  it("chainNext(EMPTY, e0) == chainAll([e0]) — the chain starts from the empty seed", () => {
    expect(chainNext(EMPTY_CHECKSUM, ev(1))).toBe(chainAll([ev(1)]));
  });

  it("a stateful chain matches chainAll and exposes prev/next per push", () => {
    const chain = createChecksumChain();
    expect(chain.current).toBe(EMPTY_CHECKSUM);

    const r1 = chain.push(ev(1));
    expect(r1.prev).toBe(EMPTY_CHECKSUM);
    expect(r1.next).toBe(chainAll([ev(1)]));
    expect(chain.current).toBe(r1.next);

    const r2 = chain.push(ev(2));
    expect(r2.prev).toBe(r1.next); // links to the previous checksum
    expect(r2.next).toBe(chainAll([ev(1), ev(2)]));
  });

  it("a client that resyncs to a server checksum continues the same chain", () => {
    // Server has folded 3 events; client only saw the first, then resynced.
    const server = chainAll([ev(1), ev(2), ev(3)]);
    const client = createChecksumChain();
    client.push(ev(1));
    // ...client detects a gap, refetches, and resets to the server's checksum.
    client.reset(server);
    // The next event folds identically on both sides.
    expect(client.push(ev(4)).next).toBe(chainAll([ev(1), ev(2), ev(3), ev(4)]));
  });
});
