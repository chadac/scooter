/**
 * A board lane shows its most recent cards, in the order the user arranged them.
 */

import { describe, it, expect } from "vitest";

import { pageLane } from "./Boards.js";

const card = (id: string, lastActivityAt: number) => ({ id, lastActivityAt });

describe("pageLane", () => {
  const lane = [card("old", 1), card("new", 9), card("mid", 5), card("newer", 10)];
  const recent = (c: { lastActivityAt: number }) => c.lastActivityAt;

  it("keeps the most recent cards, in board position order", () => {
    const pos: Record<string, number> = { new: 2, mid: 1, newer: 3 };
    expect(pageLane(lane, 3, recent, (id) => pos[id] ?? 0).map((c) => c.id)).toEqual(["mid", "new", "newer"]);
  });

  it("picks by the recency it's given, not the card's own", () => {
    const seen: Record<string, number> = { old: 20 };
    const picked = pageLane(lane, 1, (c) => seen[c.id] ?? c.lastActivityAt, () => 0);
    expect(picked.map((c) => c.id)).toEqual(["old"]);
  });

  it("breaks position ties by activity and leaves the lane as it was", () => {
    const copy = [...lane];
    expect(pageLane(lane, 4, recent, () => 0).map((c) => c.id)).toEqual(["newer", "new", "mid", "old"]);
    expect(lane).toEqual(copy);
  });
});
