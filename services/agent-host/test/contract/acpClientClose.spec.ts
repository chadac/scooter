/**
 * Tier 1 contract test — closeChild() AWAITS the goose child's exit.
 *
 * The model-switch race: a mid-conversation switch does bridge.stop() -> close()
 * -> revive() -> spawn a NEW goose with the new GOOSE_MODEL. If close() returned
 * before the OLD goose died, the two coexist and share the per-conversation cwd
 * (goose sessions DB + .goosehints), so the reply could come from the old process
 * (old model). close() must not resolve until the child is actually gone.
 *
 * We test the pure closeChild() against a controllable fake child (no subprocess),
 * so the SIGTERM->wait->SIGKILL sequencing is deterministic.
 */

import { describe, it, expect, vi } from "vitest";

import { closeChild, type KillableChild } from "../../src/acp/client.js";

/** A fake child: records the signals sent; only exits when we tell it to. */
function fakeChild(opts: { exitOnTerm?: boolean } = {}) {
  const signals: NodeJS.Signals[] = [];
  let exitCb: (() => void) | undefined;
  const child: KillableChild = {
    exitCode: null,
    signalCode: null,
    kill(signal?: NodeJS.Signals) {
      const s = signal ?? "SIGTERM";
      signals.push(s);
      // A well-behaved child exits on SIGTERM; a stubborn one only on SIGKILL.
      if ((s === "SIGTERM" && opts.exitOnTerm !== false) || s === "SIGKILL") {
        (child as { signalCode: NodeJS.Signals | null }).signalCode = s;
        queueMicrotask(() => exitCb?.());
      }
      return true;
    },
    once(_event, cb) {
      exitCb = cb;
    },
  };
  return { child, signals };
}

describe("closeChild()", () => {
  it("SIGTERMs the child and resolves once it exits", async () => {
    const { child, signals } = fakeChild();
    await closeChild(child);
    expect(signals).toEqual(["SIGTERM"]); // graceful stop, no SIGKILL needed
  });

  it("does NOT resolve until the child actually exits", async () => {
    // A child that ignores BOTH signals (never exits) — closeChild must stay pending.
    const child: KillableChild = {
      exitCode: null,
      signalCode: null,
      kill: () => true, // swallow signals, never exit
      once: () => {},
    };
    let resolved = false;
    void closeChild(child, 10_000).then(() => (resolved = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false); // still waiting — the old goose isn't gone yet
  });

  it("SIGKILLs a child that ignores SIGTERM after the grace period (bounded)", async () => {
    vi.useFakeTimers();
    try {
      const { child, signals } = fakeChild({ exitOnTerm: false }); // ignores SIGTERM
      let resolved = false;
      void closeChild(child, 10_000).then(() => (resolved = true));
      await Promise.resolve();
      expect(signals).toEqual(["SIGTERM"]); // SIGTERM sent, but child didn't exit
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000); // grace elapses -> SIGKILL
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      await Promise.resolve();
      expect(resolved).toBe(true); // resolved once SIGKILL took effect
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op (resolves immediately) when the child already exited", async () => {
    const child: KillableChild = {
      exitCode: 0, // already dead
      signalCode: null,
      kill: () => { throw new Error("must not kill an already-dead child"); },
      once: () => { throw new Error("must not wait on an already-dead child"); },
    };
    await expect(closeChild(child)).resolves.toBeUndefined();
  });
});
