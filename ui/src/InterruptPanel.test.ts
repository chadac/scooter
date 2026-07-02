/**
 * UI unit test — AWS-interrupt classification for the greyed Approve button.
 *
 * Only interrupts the host tagged `metadata.aws` get a per-viewer can-approve
 * check (and thus a possibly-greyed Approve button). A plain tool-permission
 * interrupt must NOT — it has no AWS request to authorize, so its buttons stay
 * live. `awsRequestId` is that gate; the full render path (fetch + greying) needs
 * a DOM env this project's `node` test runner doesn't provide.
 */

import { describe, it, expect } from "vitest";

import { awsRequestId } from "./InterruptPanel.js";
import type { PendingInterrupt } from "./integrityAgent.js";

const intr = (metadata?: Record<string, unknown>): PendingInterrupt => ({
  id: "int-1",
  reason: "confirmation",
  metadata,
});

describe("awsRequestId", () => {
  it("returns the explicit requestId for an AWS-tagged interrupt", () => {
    expect(awsRequestId(intr({ aws: true, requestId: "req-42", options: [] }))).toBe("req-42");
  });

  it("falls back to the interrupt id when aws:true but no requestId", () => {
    expect(awsRequestId(intr({ aws: true }))).toBe("int-1");
  });

  it("returns undefined for a non-AWS interrupt (tool permission) — never greyed", () => {
    expect(awsRequestId(intr({ options: [{ optionId: "main" }] }))).toBeUndefined();
    expect(awsRequestId(intr(undefined))).toBeUndefined();
    expect(awsRequestId(intr({ aws: false }))).toBeUndefined();
  });
});
