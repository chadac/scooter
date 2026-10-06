/**
 * Tier 1 contract test — the startup hydrate retry budget.
 *
 * Startup refuses to serve on a stale view, so a hydrate that never succeeds MUST still
 * exit. The budget is what separates "the dependency is cold" from "the dependency is
 * broken", and it is wall-clock: see hydrateWithRetry.
 */

import { describe, it, expect, vi } from "vitest";

import { hydrateWithRetry, HYDRATE_BUDGET_MS } from "../../src/index.js";

/** A logger that records instead of printing (errorWith takes the error as arg 2). */
const recorder = () => {
  const warns: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  return {
    warns,
    errors,
    log: {
      warn: (_m: string, f?: Record<string, unknown>) => void warns.push(f ?? {}),
      errorWith: (_m: string, _e: unknown, f?: Record<string, unknown>) =>
        void errors.push(f ?? {}),
    } as never,
  };
};

/** Virtual clock: sleep() advances `now` instead of waiting, so a 60s budget is instant. */
const virtualClock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    elapsed: () => t,
  };
};

describe("hydrateWithRetry", () => {
  it("returns on the first success without sleeping", async () => {
    const { log } = recorder();
    const clock = virtualClock();
    const hydrate = vi.fn().mockResolvedValue(undefined);

    await hydrateWithRetry(hydrate, log, { now: clock.now, sleep: clock.sleep });

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(clock.elapsed()).toBe(0);
  });

  it("OUTLASTS a dependency that is cold for 20s — the case that crashed agent-host at every cold bring-up", async () => {
    // The regression: Postgres accepted connections ~20s after the pod started, and the old
    // budget (5 attempts, 250ms doubling = 3.75s of wall clock) expired first. So a NORMAL
    // cold bring-up logged `fatal` and depended on the kubelet restart to come up — which
    // made restarts=1 routine and therefore useless as a signal that something had crashed.
    const { log, errors } = recorder();
    const clock = virtualClock();
    const COLD_UNTIL_MS = 20_000;
    const hydrate = vi.fn(async () => {
      if (clock.now() < COLD_UNTIL_MS) throw new Error("ECONNREFUSED");
    });

    await expect(hydrateWithRetry(hydrate, log, { now: clock.now, sleep: clock.sleep }))
      .resolves.toBeUndefined();

    expect(errors).toHaveLength(0); // never reached the fatal path
    expect(clock.elapsed()).toBeGreaterThanOrEqual(COLD_UNTIL_MS);

    // NEGATIVE CONTROL, so this test cannot pass for the wrong reason: the same cold
    // dependency against the old 3.75s budget must still fail. Without this, a regression
    // that shrank the budget back would leave the assertions above satisfied by luck.
    const old = virtualClock();
    const coldAgain = vi.fn(async () => {
      if (old.now() < COLD_UNTIL_MS) throw new Error("ECONNREFUSED");
    });
    await expect(
      hydrateWithRetry(coldAgain, recorder().log, {
        now: old.now,
        sleep: old.sleep,
        budgetMs: 3_750,
      }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("still gives up — and rethrows — when the dependency is genuinely broken", async () => {
    const { log, errors } = recorder();
    const clock = virtualClock();
    const hydrate = vi.fn().mockRejectedValue(new Error("relation does not exist"));

    await expect(
      hydrateWithRetry(hydrate, log, { now: clock.now, sleep: clock.sleep }),
    ).rejects.toThrow("relation does not exist");

    expect(errors).toHaveLength(1);
    expect(errors[0].budget_ms).toBe(HYDRATE_BUDGET_MS);
    // Bounded by the budget: refusing to serve is only correct if it actually happens.
    expect(clock.elapsed()).toBeLessThan(HYDRATE_BUDGET_MS);
  });

  it("caps the backoff so the budget buys attempts rather than sleep", async () => {
    // An uncapped 250ms·2^n curve reaches 64s on attempt 9, so the budget would be spent
    // almost entirely inside one sleep: few attempts, and the last one landing nowhere near
    // the deadline.
    const { log, warns } = recorder();
    const clock = virtualClock();
    const hydrate = vi.fn().mockRejectedValue(new Error("nope"));

    await expect(
      hydrateWithRetry(hydrate, log, { now: clock.now, sleep: clock.sleep }),
    ).rejects.toThrow();

    expect(Math.max(...warns.map((w) => w.retry_in_ms as number))).toBeLessThanOrEqual(5_000);
    expect(hydrate.mock.calls.length).toBeGreaterThan(10);
  });

  it("honors an explicit budget", async () => {
    const { log } = recorder();
    const clock = virtualClock();
    const hydrate = vi.fn().mockRejectedValue(new Error("nope"));

    await expect(
      hydrateWithRetry(hydrate, log, { now: clock.now, sleep: clock.sleep, budgetMs: 1_000 }),
    ).rejects.toThrow();

    expect(clock.elapsed()).toBeLessThan(1_000);
  });
});
