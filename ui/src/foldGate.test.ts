/**
 * The fold gate decides whether a folded message list is painted.
 *
 * The regression it exists for: the transcript stops updating mid-conversation and only
 * a page refresh brings it back. Cause was a high-water mark on message COUNT that was
 * never reset, compared against a list that legitimately shrinks on every reconnect (the
 * server paints only the trailing window, so paged-in older history is gone and
 * opened-but-empty messages the live fold kept are dropped). Once the mark exceeded the
 * window, every later push was suppressed for the life of the mount.
 */

import { describe, it, expect } from "vitest";

import { createFoldGate } from "./RuntimeProvider.js";

describe("createFoldGate", () => {
  it("accepts a list that grows within one fold", () => {
    const gate = createFoldGate();
    expect(gate.accept(1, 0)).toBe(true);
    expect(gate.accept(1, 5)).toBe(true);
    expect(gate.accept(1, 5)).toBe(true); // unchanged length still paints
    expect(gate.accept(1, 12)).toBe(true);
  });

  it("suppresses a shrink WITHIN one fold (the mid-render index crash)", () => {
    const gate = createFoldGate();
    gate.accept(1, 12);
    expect(gate.accept(1, 3)).toBe(false);
    expect(gate.accept(1, 11)).toBe(false);
    expect(gate.accept(1, 12)).toBe(true); // back to the high-water mark
  });

  it("lets a RECONNECT's shorter re-fold through (the latch)", () => {
    const gate = createFoldGate();
    gate.accept(1, 200); // the trailing window
    gate.accept(1, 350); // the user scrolled back; older history paged in

    // Reconnect: a new fold, re-folded from empty over the window alone.
    expect(gate.accept(2, 200)).toBe(true);
    // …and it keeps painting as live messages arrive, instead of freezing at 350.
    expect(gate.accept(2, 201)).toBe(true);
  });

  it("re-arms its shrink protection per fold", () => {
    const gate = createFoldGate();
    gate.accept(1, 40);
    expect(gate.accept(2, 200)).toBe(true);
    // Within the NEW fold, a shrink is still suppressed.
    expect(gate.accept(2, 7)).toBe(false);
  });

  it("does not assume generations increase by one, or at all", () => {
    const gate = createFoldGate();
    gate.accept(0, 9);
    expect(gate.accept(0, 4)).toBe(false); // generation 0 is a real generation
    expect(gate.accept(7, 4)).toBe(true); // a jump is just a different fold
  });
});
