/**
 * The sidebar's "!" follows the event log: on while any interrupt is unsettled, and a
 * failed write or log read is retried until the row matches the log again.
 */

import { describe, it, expect } from "vitest";

import type { AguiEvent } from "../../src/bridge.js";
import { awaitingSince, changesAwaiting, createAwaitingInputSync } from "../../src/session/awaitingInputSync.js";
import type { SessionId } from "../../src/types.js";

const id = "c-1" as SessionId;

function raised(ts: number, ...ids: string[]): AguiEvent {
  return {
    type: "RUN_FINISHED",
    threadId: id,
    runId: `r-${ts}`,
    outcome: { type: "interrupt", interrupts: ids.map((i) => ({ id: i, reason: "tool_call" })) },
    ts,
  } as unknown as AguiEvent;
}

function resolved(toolCallId: string): AguiEvent {
  return { type: "PERMISSION_RESOLVED", toolCallId, optionId: null };
}

/** A store whose writes fail while `failing` is true, recording the last good value. */
function fakeStore() {
  const s = {
    failing: false,
    row: undefined as number | null | undefined,
    writes: 0,
    async set(_id: SessionId, at: number | null) {
      s.writes++;
      if (s.failing) throw new Error("too many clients");
      s.row = at;
    },
  };
  return s;
}

/** Collects scheduled retries so a test can run them by hand. */
function manualClock() {
  const due: Array<{ fn: () => void; ms: number }> = [];
  return {
    due,
    schedule: (fn: () => void, ms: number) => void due.push({ fn, ms }),
    async runNext() {
      due.shift()!.fn();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe("awaitingSince", () => {
  it("is null with nothing raised or everything settled", () => {
    expect(awaitingSince([], 0)).toBeNull();
    expect(awaitingSince([raised(5, "q1"), resolved("q1")], 0)).toBeNull();
  });

  it("stays on while one of two cards is open", () => {
    expect(awaitingSince([raised(5, "q1"), raised(9, "a1"), resolved("a1")], 0)).toBe(5);
  });

  it("dates the wait from the latest open raise, re-raises included", () => {
    expect(awaitingSince([raised(5, "q1"), raised(9, "q1")], 0)).toBe(9);
  });
});

describe("changesAwaiting", () => {
  it("picks out raises and resolutions only", () => {
    expect(changesAwaiting(raised(1, "q1"))).toBe(true);
    expect(changesAwaiting(resolved("q1"))).toBe(true);
    expect(changesAwaiting({ type: "RUN_STARTED", threadId: id, runId: "r" } as AguiEvent)).toBe(false);
  });
});

describe("createAwaitingInputSync", () => {
  it("clears the row once a failed clear is retried", async () => {
    const log = [raised(5, "q1"), resolved("q1")];
    const store = fakeStore();
    store.row = 5;
    store.failing = true;
    const clock = manualClock();
    const sync = createAwaitingInputSync({ store, readEvents: async () => log, schedule: clock.schedule, retryDelaysMs: [10, 20] });

    await sync(id);
    expect(store.row).toBe(5);
    expect(clock.due.map((d) => d.ms)).toEqual([10]);

    store.failing = false;
    await clock.runNext();
    expect(store.row).toBeNull();
    expect(clock.due).toHaveLength(0);
  });

  it("retries a log read that throws", async () => {
    const store = fakeStore();
    let reads = 0;
    const clock = manualClock();
    const sync = createAwaitingInputSync({
      store,
      readEvents: async () => {
        if (reads++ === 0) throw new Error("too many clients");
        return [raised(7, "q1")];
      },
      schedule: clock.schedule,
      retryDelaysMs: [10],
    });

    await sync(id);
    expect(store.writes).toBe(0);
    await clock.runNext();
    expect(store.row).toBe(7);
  });

  it("gives up after the last retry", async () => {
    const store = fakeStore();
    store.failing = true;
    const clock = manualClock();
    const sync = createAwaitingInputSync({ store, readEvents: async () => [], schedule: clock.schedule, retryDelaysMs: [10, 20] });

    await sync(id);
    await clock.runNext();
    expect(clock.due.map((d) => d.ms)).toEqual([20]);
    await clock.runNext();
    expect(clock.due).toHaveLength(0);
    expect(store.writes).toBe(3);
  });

  it("re-runs a sync that a change overtook, writing the newest state", async () => {
    const log: AguiEvent[] = [raised(5, "q1")];
    const store = fakeStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const sync = createAwaitingInputSync({
      store,
      readEvents: async () => {
        const snapshot = [...log];
        if (first) {
          first = false;
          await gate;
        }
        return snapshot;
      },
    });

    const running = sync(id);
    log.push(resolved("q1"));
    await sync(id);
    release();
    await running;
    expect(store.row).toBeNull();
    expect(store.writes).toBe(2);
  });
});
