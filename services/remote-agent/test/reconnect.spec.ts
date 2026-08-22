/**
 * Tier 1 contract — the container's reconnect backoff (increment 5, §M).
 *
 * The container is a long-lived process on the USER'S machine (`--restart always`), reconnecting to
 * a cloud that gets rolled out regularly. Its reconnect behaviour is therefore load-bearing in a
 * way the cloud side's is not: it is the thing standing between a controller restart and the user
 * having to notice and intervene.
 *
 * The shipped loop is `setTimeout(connect, 3000)` — a FIXED 3s, forever, with no jitter. Two real
 * problems:
 *   1. No cap on total attempts is fine (we WANT it to keep trying), but a fixed short interval
 *      means a controller that is down for maintenance takes a steady 20 req/min per container
 *      indefinitely — and every container reconnects in lockstep after a rollout, a thundering herd
 *      against the single-replica controller (§L decision 3).
 *   2. No jitter means N containers retry on the same tick forever, so the herd never disperses.
 */

import { describe, it, expect } from "vitest";

import { nextReconnectDelay, RECONNECT_BASE_MS, RECONNECT_CAP_MS } from "../src/reconnect.js";

describe("container reconnect backoff", () => {
  it("the first retry is prompt — a rollout should not feel like an outage", () => {
    const d = nextReconnectDelay(1, () => 0.5);
    expect(d).toBeGreaterThanOrEqual(RECONNECT_BASE_MS * 0.5);
    expect(d).toBeLessThanOrEqual(RECONNECT_BASE_MS * 1.5);
  });

  it("backs off exponentially across attempts", () => {
    const mid = () => 0.5; // no jitter, so the growth is visible
    const d1 = nextReconnectDelay(1, mid);
    const d2 = nextReconnectDelay(2, mid);
    const d3 = nextReconnectDelay(3, mid);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
  });

  it("is CAPPED — a long outage must not back off to hours", () => {
    // The container must still recover promptly whenever the cloud returns; an uncapped doubling
    // would leave a user's agent offline long after the controller came back.
    for (const attempt of [10, 20, 50, 100]) {
      for (const r of [0, 0.5, 1]) {
        expect(nextReconnectDelay(attempt, () => r), `attempt ${attempt}, jitter ${r}`)
          .toBeLessThanOrEqual(RECONNECT_CAP_MS);
      }
    }
    // And the cap must BIND: by attempt 10 the raw exponential (1s * 2^9 = 512s) is far past the
    // cap, so a capped implementation sits AT it under full jitter while an uncapped one shoots
    // past. Asserting only "<= cap" let an uncapped mutant survive, because half-jitter happened
    // to land under the ceiling at the attempts sampled.
    expect(nextReconnectDelay(10, () => 1)).toBe(RECONNECT_CAP_MS);
  });

  it("applies JITTER so containers do not retry in lockstep", () => {
    // Every container reconnects at once after a controller rollout. Without jitter they stay
    // synchronised forever and hammer the single-replica controller on the same tick.
    const low = nextReconnectDelay(5, () => 0);
    const high = nextReconnectDelay(5, () => 1);
    expect(high).toBeGreaterThan(low);
  });

  it("never returns a negative or zero delay (a busy-loop would pin the user's CPU)", () => {
    for (const attempt of [1, 2, 3, 10, 100]) {
      for (const r of [0, 0.5, 1]) {
        expect(nextReconnectDelay(attempt, () => r)).toBeGreaterThan(0);
      }
    }
  });

  it("attempt 0 or negative is treated as the first attempt (defensive)", () => {
    expect(nextReconnectDelay(0, () => 0.5)).toBeGreaterThan(0);
    expect(nextReconnectDelay(-5, () => 0.5)).toBeGreaterThan(0);
  });
});

// --- closeDisposition: the close-code policy ------------------------------------------------

import {
  closeDisposition,
  CLOSE_AUTH_REJECTED,
  CLOSE_SUPERSEDED,
  AUTH_RETRY_MS,
  SUPERSEDED_RETRY_MS,
} from "../src/reconnect.js";

describe("closeDisposition", () => {
  it("AUTH REJECTION is loud and slow — the observed silent-fast-loop failure", () => {
    // The live bug: token auth failed, the container logged a generic 1005, retried every
    // second forever, and the machine looked "totally fine" while permanently unauthenticated.
    const d = closeDisposition(CLOSE_AUTH_REJECTED, "join token expired", 1);
    expect(d.message).toMatch(/AUTHENTICATION FAILED/);
    expect(d.message).toMatch(/join token expired/);
    expect(d.message).toMatch(/Settings/); // actionable: where the human gets a fresh command
    expect(d.delayMs).toBe(AUTH_RETRY_MS); // no fast hammering on a failure retries can't fix
  });

  it("SUPERSEDED backs off so two containers for one owner cannot ping-pong", () => {
    const d = closeDisposition(CLOSE_SUPERSEDED, "", 1);
    expect(d.message).toMatch(/superseded/i);
    expect(d.delayMs).toBe(SUPERSEDED_RETRY_MS);
  });

  it("any other close keeps the jittered fast-reconnect behaviour", () => {
    const d = closeDisposition(1005, "", 3, () => 1);
    expect(d.message).toBeNull();
    expect(d.delayMs).toBe(nextReconnectDelay(3, () => 1));
  });
});
