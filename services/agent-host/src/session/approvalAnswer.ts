/**
 * A contrib approval blocks no run: the agent learns the outcome from a new prompt. So an
 * answer needs no live bridge, only the contrib and request id the event log recorded
 * when the card was raised, and it goes straight to the contrib's broker half.
 */

import type { AguiEvent, ApproverIdentity } from "../bridge.js";
import type { ResumeOutcome } from "../agui/server.js";
import { unansweredInterrupt } from "./danglingRun.js";

/** An unsettled approval card, as the log recorded it. */
export interface LoggedApproval {
  contrib: string;
  requestId: string;
  /** The card's optionIds; any other answer dismisses it. */
  options: string[];
}

/** Unsettled approval card `id`; undefined for questions or settled cards. */
export function loggedApproval(events: AguiEvent[], id: string): LoggedApproval | undefined {
  const meta = unansweredInterrupt(events, id)?.metadata;
  const contrib = meta?.contrib;
  if (typeof contrib !== "string" || !contrib) return undefined;
  const requestId = typeof meta?.requestId === "string" && meta.requestId ? meta.requestId : id;
  const options = Array.isArray(meta?.options)
    ? meta.options
        .map((o) => (o as { optionId?: unknown } | null)?.optionId)
        .filter((o): o is string => typeof o === "string")
    : [];
  return { contrib, requestId, options };
}

export interface AnswerFromLogDeps {
  /** Relay the verb to the broker; throws when the broker did not record it. */
  relay(contrib: string, requestId: string, optionId: string, approver: ApproverIdentity): Promise<void>;
  /** Append the PERMISSION_RESOLVED that closes the card. */
  settle(interruptId: string, optionId: string | null): Promise<void>;
}

/** Answer a logged card; a failed relay leaves it open to retry. */
export async function answerApprovalFromLog(
  approval: LoggedApproval,
  interruptId: string,
  optionId: string,
  approver: ApproverIdentity,
  deps: AnswerFromLogDeps,
): Promise<ResumeOutcome> {
  // A dismissal leaves the broker request pending, like a live bridge.
  const chosen = approval.options.includes(optionId) ? optionId : null;
  if (chosen) {
    try {
      await deps.relay(approval.contrib, approval.requestId, chosen, approver);
    } catch (err) {
      return { ok: false, reason: `the ${approval.contrib} broker did not record it (${errorText(err)}); please try again` };
    }
  }
  await deps.settle(interruptId, chosen);
  return { ok: true, settled: true };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
