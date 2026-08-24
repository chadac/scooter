/**
 * Tier 1 — goose approve-mode back-pressure: auto-answer a permission request
 * (allow normally; reject when a priority item is waiting) WITHOUT a UI prompt.
 * See todo/done/SUBAGENT_BACKPRESSURE.md.
 */

import { describe, it, expect } from "vitest";

import { autoAnswerPermission, isToolGate } from "../../src/acp/client.js";

// A goose approve-mode TOOL GATE: allow + reject options for running a tool.
const OPTS = [
  { optionId: "allow", kind: "allow_once" },
  { optionId: "allow-always", kind: "allow_always" },
  { optionId: "reject", kind: "reject_once" },
];

// An AGENT-PRESENTED CHOICE the user must answer (the "?pick a color" flow / a
// real approval): distinct semantic options, NO reject-kind — NOT a tool gate.
const USER_CHOICE = [
  { optionId: "red", kind: "allow_once" },
  { optionId: "green", kind: "allow_once" },
  { optionId: "blue", kind: "allow_once" },
];

describe("isToolGate", () => {
  it("is TRUE only when both an allow-kind AND a reject-kind option are present", () => {
    expect(isToolGate(OPTS)).toBe(true);
    expect(isToolGate(USER_CHOICE)).toBe(false); // no reject → a user choice
    expect(isToolGate([{ kind: "reject_once" }])).toBe(false); // no allow
    expect(isToolGate([])).toBe(false);
  });
});

describe("autoAnswerPermission (goose approve-mode)", () => {
  it("ALLOWS (picks an allow option) when NOT yielding — preserves auto-run", () => {
    const res = autoAnswerPermission(OPTS, false);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("REJECTS (picks a reject option) when yielding — goose ends the turn", () => {
    const res = autoAnswerPermission(OPTS, true);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("does NOT auto-answer an agent-presented CHOICE — returns undefined so it reaches the UI", () => {
    // The regression this guards: back-pressure silently auto-picked an option for
    // the "?pick a color" interrupt, so the user never saw the approval.
    expect(autoAnswerPermission(USER_CHOICE, false)).toBeUndefined();
    expect(autoAnswerPermission(USER_CHOICE, true)).toBeUndefined();
  });

  it("returns undefined when there are no options (caller falls through)", () => {
    expect(autoAnswerPermission([], false)).toBeUndefined();
  });
});
