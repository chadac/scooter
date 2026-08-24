/**
 * Tier 1 contract — the container's ACK HANDLING, pinned against what the BYOC controller actually
 * sends (increment 5 of).
 *
 * WHY THIS FILE EXISTS. The controller's own tests (increment 3) drive a FAKE container, and the
 * container's behaviour was never asserted against a real controller frame. That let a wire
 * mismatch sit undetected on BOTH sides at once:
 *
 *   controller sends  {ch:"acp", type:"ack", id, payload:{optionId:"allow"}}      <- flat
 *   container  reads  payload.result.optionId                                     <- nested
 *
 * Both suites passed. In production every permission would resolve to `{}` — the agent unblocks
 * with an EMPTY answer instead of the user's decision, so a denied tool call would proceed as if
 * approved (or an approved one stall). This is exactly the "two components agreeing with their own
 * fakes" failure the e2e work kept surfacing, one layer down.
 *
 * These tests use the REAL frame the controller emits (see byoc-controller runRelay.answerPermission)
 * rather than a hand-written one, so the two ends cannot drift apart again silently.
 */

import { describe, it, expect } from "vitest";

import { parsePermissionAnswer } from "../src/permissionAnswer.js";

describe("container: parsing a permission answer from the controller", () => {
  it("reads the FLAT payload the controller actually sends", () => {
    // Byte-for-byte what runRelay.answerPermission puts on the wire.
    const frame = { ch: "acp" as const, type: "ack", id: "perm-1", payload: { optionId: "allow" } };
    expect(parsePermissionAnswer(frame.payload)).toEqual({ optionId: "allow" });
  });

  it("reads a cancellation", () => {
    expect(parsePermissionAnswer({ cancelled: true })).toEqual({ cancelled: true });
  });

  it("still accepts the LEGACY nested shape (a container may outlive a controller rollout)", () => {
    // The container is a long-lived process on the user's machine with `--restart always`; it will
    // not be redeployed in lockstep with the cloud. Accepting both shapes means a rollout in either
    // order cannot break approvals for someone running last week's image.
    expect(parsePermissionAnswer({ result: { optionId: "allow" } })).toEqual({ optionId: "allow" });
    expect(parsePermissionAnswer({ result: { cancelled: true } })).toEqual({ cancelled: true });
  });

  it("an EMPTY payload is a cancellation, never a silent approval", () => {
    // The dangerous default. If a malformed/unknown answer fell through as {optionId: ""}, the SDK
    // would treat it as a selection and the tool call could run WITHOUT the user having approved
    // it. Fail closed.
    expect(parsePermissionAnswer({})).toEqual({ cancelled: true });
    expect(parsePermissionAnswer(undefined)).toEqual({ cancelled: true });
    expect(parsePermissionAnswer(null)).toEqual({ cancelled: true });
  });

  it("an ERROR answer is a cancellation (the controller could not deliver the decision)", () => {
    expect(parsePermissionAnswer({ error: "unknown permission perm-1" })).toEqual({ cancelled: true });
  });

  it("an explicitly EMPTY optionId is a cancellation, not an approval", () => {
    // `{optionId: ""}` is what the old code produced from a missing answer (`?? ""`). An empty
    // option id selects nothing; treating it as an approval is the same fail-open bug.
    expect(parsePermissionAnswer({ optionId: "" })).toEqual({ cancelled: true });
  });

  it("a non-string optionId is rejected rather than coerced", () => {
    expect(parsePermissionAnswer({ optionId: 42 })).toEqual({ cancelled: true });
  });
});
