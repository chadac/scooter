/**
 * Graceful shutdown wiring (installShutdownHandlers) — the SIGTERM/preStop drain.
 * On the rollout signal the pod must flush + close cleanly (so clients reconnect
 * instead of eating a raw 502), bounded so a stuck drain can't outlive the pod's
 * terminationGracePeriod.
 */
import { describe, it, expect, vi } from "vitest";

import { installShutdownHandlers } from "../../src/index.js";

/** A fake process that captures signal handlers + exit calls. */
function fakeProc() {
  const handlers: Record<string, (sig: string) => void> = {};
  const exits: number[] = [];
  const proc = {
    on(sig: string, fn: (s: string) => void) { handlers[sig] = fn; return proc; },
    exit(code?: number) { exits.push(code ?? 0); },
    fire: (sig: string) => handlers[sig]?.(sig),
    handlers,
    exits,
  };
  return proc;
}

describe("installShutdownHandlers", () => {
  it("registers SIGTERM and SIGINT", () => {
    const proc = fakeProc();
    installShutdownHandlers(async () => {}, { proc: proc as never });
    expect(Object.keys(proc.handlers).sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("drains then exits 0 on SIGTERM", async () => {
    const proc = fakeProc();
    const drained = vi.fn(async () => {});
    installShutdownHandlers(drained, { proc: proc as never });
    proc.fire("SIGTERM");
    await Promise.resolve(); // let the shutdown().then microtask run
    await Promise.resolve();
    expect(drained).toHaveBeenCalledTimes(1);
    expect(proc.exits).toEqual([0]);
  });

  it("ignores a repeat signal mid-drain (drains once)", async () => {
    const proc = fakeProc();
    let resolve!: () => void;
    const drained = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    installShutdownHandlers(drained, { proc: proc as never });
    proc.fire("SIGTERM");
    proc.fire("SIGTERM"); // repeat while the first drain is still in flight
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toHaveBeenCalledTimes(1);
  });

  it("force-exits if the drain exceeds the timeout (never outlives the grace period)", () => {
    const proc = fakeProc();
    let fireTimeout!: () => void;
    const fakeSetTimeout = ((fn: () => void) => { fireTimeout = fn; return { unref() {} }; }) as unknown as typeof setTimeout;
    installShutdownHandlers(() => new Promise<void>(() => {}) /* never resolves */, {
      proc: proc as never,
      timeoutMs: 10,
      setTimeoutFn: fakeSetTimeout,
    });
    proc.fire("SIGTERM");
    fireTimeout(); // the grace timer fires before the (hung) drain finishes
    expect(proc.exits).toEqual([0]);
  });
});
