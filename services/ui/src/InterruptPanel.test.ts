/**
 * Approval-interrupt classification for the greyed option.
 *
 * Only interrupts tagged with a contrib name (`metadata.contrib`) get a per-viewer
 * can-approve check and a possibly-greyed option; a plain tool-permission interrupt
 * keeps live buttons. `approvalOf` is that gate; the full render path needs a DOM
 * environment this test runner does not provide.
 */

import { describe, it, expect } from "vitest";

import { approvalOf, blockedFor, isGone } from "./InterruptPanel.js";
import type { PendingInterrupt } from "./integrityAgent.js";

const intr = (metadata?: Record<string, unknown>): PendingInterrupt => ({
  id: "int-1",
  reason: "confirmation",
  metadata,
});

describe("approvalOf", () => {
  it("returns the contrib and its explicit requestId", () => {
    expect(approvalOf(intr({ contrib: "aws", requestId: "req-42", options: [] }))).toEqual({
      contrib: "aws",
      requestId: "req-42",
    });
  });

  it("falls back to the interrupt id when no requestId is carried", () => {
    expect(approvalOf(intr({ contrib: "aws" }))).toEqual({ contrib: "aws", requestId: "int-1" });
  });

  it("reads ANY contrib name, not a known list", () => {
    // A contrib the UI has never heard of still classifies; its gating copy comes from the manifest at runtime.
    expect(approvalOf(intr({ contrib: "echo", requestId: "r1" }))?.contrib).toBe("echo");
  });

  it("returns undefined for a non-approval interrupt (tool permission) — never greyed", () => {
    expect(approvalOf(intr({ options: [{ optionId: "main" }] }))).toBeUndefined();
    expect(approvalOf(intr(undefined))).toBeUndefined();
  });

  it("ignores a malformed contrib tag rather than greying on garbage", () => {
    // An empty or non-string name cannot index the manifest, so the option stays live and the broker still enforces.
    expect(approvalOf(intr({ contrib: "" }))).toBeUndefined();
    expect(approvalOf(intr({ contrib: true }))).toBeUndefined();
    expect(approvalOf(intr({ contrib: 42 }))).toBeUndefined();
  });

  it("does NOT classify the retired aws:true boolean", () => {
    // A stale persisted interrupt carrying the boolean tag renders as an ordinary interrupt with live buttons.
    expect(approvalOf(intr({ aws: true, requestId: "req-42" }))).toBeUndefined();
  });
});

describe("blockedFor", () => {
  const gating = { gatedOption: "approve", blockedTitle: "Only an account approver can approve this.", blockedHint: "Ask an admin." };
  const titleOf = (can: Parameters<typeof blockedFor>[1]) => blockedFor(gating, can)?.title;

  it("leaves the option live while loading, when allowed, or without gating", () => {
    expect(blockedFor(gating, undefined)).toBeUndefined();
    expect(blockedFor(gating, { canApprove: true, pending: true })).toBeUndefined();
    expect(blockedFor(undefined, { canApprove: false, pending: true, reason: "not_eligible" })).toBeUndefined();
  });

  it("uses the contrib's admin wording only for a viewer who is not eligible", () => {
    expect(titleOf({ canApprove: false, pending: true, reason: "not_eligible" })).toBe(gating.blockedTitle);
    // No reason from the contrib means its admin wording.
    expect(titleOf({ canApprove: false, pending: true })).toBe(gating.blockedTitle);
  });

  it("treats a request the contrib no longer has as gone, not greyed", () => {
    for (const can of [{ canApprove: false, pending: false, reason: "not_pending" as const }, { canApprove: false, pending: false }]) {
      expect(isGone(can)).toBe(true);
      expect(blockedFor(gating, can)).toBeUndefined();
    }
    expect(isGone({ canApprove: false, pending: true, reason: "not_eligible" })).toBe(false);
    expect(isGone(undefined)).toBe(false);
  });

  it("says the viewer already approved, or that the check failed", () => {
    expect(titleOf({ canApprove: false, pending: true, reason: "already_approved" })).toBe("You already approved this.");
    expect(titleOf({ canApprove: false, pending: true, reason: "error" })).toBe("Couldn't check your approval rights.");
  });

  it("greys the contrib's gated option", () => {
    expect(blockedFor(gating, { canApprove: false, pending: true, reason: "error" })?.optionId).toBe("approve");
  });
});
