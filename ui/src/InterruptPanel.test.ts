/**
 * UI unit test — approval-interrupt classification for the greyed option.
 *
 * Only interrupts the host tagged with a contrib name (`metadata.contrib`) get a
 * per-viewer can-approve check, and thus a possibly-greyed option. A plain
 * tool-permission interrupt must NOT — there is nothing to authorize, so its buttons
 * stay live. `approvalOf` is that gate; the full render path (fetch + greying) needs a
 * DOM env this project's `node` test runner doesn't provide.
 *
 * The tag used to be `aws: true`, a boolean that could describe exactly one
 * integration. The name is what lets the UI look up per-contrib gating copy instead of
 * hardcoding aws's. Why: PR #651.
 */

import { describe, it, expect } from "vitest";

import { approvalOf } from "./InterruptPanel.js";
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
    // The point of the seam: a contrib the UI has never heard of still classifies,
    // and its gating copy comes from the manifest at runtime.
    expect(approvalOf(intr({ contrib: "echo", requestId: "r1" }))?.contrib).toBe("echo");
  });

  it("returns undefined for a non-approval interrupt (tool permission) — never greyed", () => {
    expect(approvalOf(intr({ options: [{ optionId: "main" }] }))).toBeUndefined();
    expect(approvalOf(intr(undefined))).toBeUndefined();
  });

  it("ignores a malformed contrib tag rather than greying on garbage", () => {
    // An empty or non-string name cannot index the manifest, so treat it as "not an
    // approval" — the option stays live and the broker still enforces.
    expect(approvalOf(intr({ contrib: "" }))).toBeUndefined();
    expect(approvalOf(intr({ contrib: true }))).toBeUndefined();
    expect(approvalOf(intr({ contrib: 42 }))).toBeUndefined();
  });

  it("does NOT classify the retired aws:true boolean", () => {
    // A stale interrupt persisted before the rename renders as an ordinary interrupt
    // with live buttons, rather than as an approval whose gating can never resolve.
    expect(approvalOf(intr({ aws: true, requestId: "req-42" }))).toBeUndefined();
  });
});
