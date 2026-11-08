/**
 * An approval card answered after its run ended (idle-suspend, rollout) is answered from
 * the event log, straight to the broker, with no live bridge.
 */

import { describe, it, expect, vi } from "vitest";

import { answerApprovalFromLog, loggedApproval } from "../../src/session/approvalAnswer.js";
import type { AguiEvent } from "../../src/bridge.js";

const OPTIONS = [
  { optionId: "approve", name: "Approve", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

const card = (id: string, metadata: Record<string, unknown>): AguiEvent =>
  ({
    type: "RUN_FINISHED",
    threadId: "c",
    runId: `ext-${id}`,
    outcome: { type: "interrupt", interrupts: [{ id, reason: "confirmation", message: "ok?", metadata }] },
  }) as AguiEvent;
const resolved = (id: string): AguiEvent => ({ type: "PERMISSION_RESOLVED", toolCallId: id, optionId: "approve" });
const approvalCard = (id: string) => card(id, { contrib: "handoff", requestId: `req-${id}`, options: OPTIONS });

describe("loggedApproval", () => {
  it("reads the contrib, request id and options a raised card recorded", () => {
    expect(loggedApproval([approvalCard("a1")], "a1")).toEqual({
      contrib: "handoff",
      requestId: "req-a1",
      options: ["approve", "deny"],
    });
  });

  it("uses the interrupt id when the card recorded no request id", () => {
    expect(loggedApproval([card("a1", { contrib: "aws", options: OPTIONS })], "a1")?.requestId).toBe("a1");
  });

  it("is undefined for a question, which has no contrib", () => {
    expect(loggedApproval([card("q1", { options: OPTIONS })], "q1")).toBeUndefined();
  });

  it("is undefined once the card was settled", () => {
    expect(loggedApproval([approvalCard("a1"), resolved("a1")], "a1")).toBeUndefined();
  });

  it("finds a card re-raised after it was settled", () => {
    expect(loggedApproval([approvalCard("a1"), resolved("a1"), approvalCard("a1")], "a1")).toBeDefined();
  });
});

describe("answerApprovalFromLog", () => {
  const approval = { contrib: "handoff", requestId: "req-a1", options: ["approve", "deny"] };
  const who = { id: "chad" };
  const deps = () => ({ relay: vi.fn(async () => {}), settle: vi.fn(async () => {}) });

  it("relays the verb to the broker, then closes the card", async () => {
    const d = deps();
    expect(await answerApprovalFromLog(approval, "a1", "approve", who, d)).toEqual({ ok: true, settled: true });
    expect(d.relay).toHaveBeenCalledWith("handoff", "req-a1", "approve", who);
    expect(d.settle).toHaveBeenCalledWith("a1", "approve");
  });

  it("closes a dismissed card without telling the broker, so the request stays pending", async () => {
    const d = deps();
    expect(await answerApprovalFromLog(approval, "a1", "", who, d)).toEqual({ ok: true, settled: true });
    expect(d.relay).not.toHaveBeenCalled();
    expect(d.settle).toHaveBeenCalledWith("a1", null);
  });

  it("treats an option the card never offered as a dismissal", async () => {
    const d = deps();
    await answerApprovalFromLog(approval, "a1", "approve-all", who, d);
    expect(d.relay).not.toHaveBeenCalled();
    expect(d.settle).toHaveBeenCalledWith("a1", null);
  });

  it("leaves the card open when the broker did not record the answer", async () => {
    const d = deps();
    d.relay.mockRejectedValueOnce(new Error("broker rejected handoff 'approve': 500"));
    const out = await answerApprovalFromLog(approval, "a1", "approve", who, d);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("500");
    expect(d.settle).not.toHaveBeenCalled();
  });
});
