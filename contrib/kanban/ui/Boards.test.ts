/**
 * A board lane shows its most recent cards, in the order the user arranged them.
 */

import { describe, it, expect } from "vitest";

import { gatesOnTheWay, pageLane, skillSlug } from "./Boards.js";

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

describe("skillSlug", () => {
  // The same names kanban's boards.skill_slug gives the agent.
  it("names a board skill as the agent sees it", () => {
    expect(skillSlug("Release steps!")).toBe("board-release-steps");
    expect(skillSlug("  UI / Layout ")).toBe("board-ui-layout");
    expect(skillSlug("***")).toBe("");
    expect(skillSlug("x".repeat(60)).length).toBeLessThanOrEqual(64);
  });
});

describe("gatesOnTheWay", () => {
  const stages = [{ id: "design" }, { id: "build" }, { id: "review" }, { id: "done" }];
  const gate = (id: string, stage: string) => ({ id, stage });
  const gates = [gate("plan-ok", "design"), gate("tests", "build"), gate("lint", "build"), gate("signoff", "review")];
  const ids = (gs: Array<{ id: string }>) => gs.map((g) => g.id);

  it("owes the gates of the stage a card leaves", () => {
    expect(ids(gatesOnTheWay(stages, gates, "build", "review"))).toEqual(["tests", "lint"]);
  });

  it("owes every skipped stage's gates on a jump, but not the target's", () => {
    expect(ids(gatesOnTheWay(stages, gates, "design", "review"))).toEqual(["plan-ok", "tests", "lint"]);
  });

  it("owes nothing moving back, within a stage, or from a stage it doesn't know", () => {
    expect(gatesOnTheWay(stages, gates, "review", "design")).toEqual([]);
    expect(gatesOnTheWay(stages, gates, "build", "build")).toEqual([]);
    expect(gatesOnTheWay(stages, gates, "gone", "done")).toEqual([]);
  });
});
