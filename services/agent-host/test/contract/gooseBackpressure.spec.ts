/**
 * Tier 1 — goose approve-mode back-pressure: auto-answer a permission request
 * (allow normally; reject when a priority item is waiting) WITHOUT a UI prompt.
 * See todo/docs/SUBAGENT_BACKPRESSURE.md.
 */

import { describe, it, expect } from "vitest";

import { autoAnswerPermission } from "../../src/acp/client.js";

const OPTS = [
  { optionId: "allow", kind: "allow_once" },
  { optionId: "allow-always", kind: "allow_always" },
  { optionId: "reject", kind: "reject_once" },
];

describe("autoAnswerPermission (goose approve-mode)", () => {
  it("ALLOWS (picks an allow option) when NOT yielding — preserves auto-run", () => {
    const res = autoAnswerPermission(OPTS, false);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("REJECTS (picks a reject option) when yielding — goose ends the turn", () => {
    const res = autoAnswerPermission(OPTS, true);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("falls back by position when kinds are unrecognized (allow=first, reject=last)", () => {
    const weird = [{ optionId: "a", kind: "?" }, { optionId: "z", kind: "?" }];
    expect(autoAnswerPermission(weird, false)?.outcome).toMatchObject({ optionId: "a" });
    expect(autoAnswerPermission(weird, true)?.outcome).toMatchObject({ optionId: "z" });
  });

  it("returns undefined when there are no options (caller falls through)", () => {
    expect(autoAnswerPermission([], false)).toBeUndefined();
  });
});
