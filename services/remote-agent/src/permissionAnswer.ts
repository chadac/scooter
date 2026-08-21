/**
 * Parsing a permission answer that came back from the cloud.
 *
 * Small on purpose, because it is a SECURITY boundary: this function decides whether the user
 * approved a tool call. It is extracted from remoteAgentClient's inline `ack` handling so it can be
 * tested directly against the exact frame the BYOC controller emits — the two ends previously
 * disagreed about the payload shape (flat vs nested) and both test suites passed anyway, because
 * each drove its own fake.
 *
 * TWO RULES:
 *   1. Accept BOTH the flat shape (what the controller sends today) and the legacy nested one. The
 *      container is a long-lived process on the user's machine with `--restart always`; it does not
 *      redeploy in lockstep with the cloud, so a rollout in either order must not break approvals.
 *   2. FAIL CLOSED. Anything unrecognised — empty payload, an error, a missing or empty optionId —
 *      is a CANCELLATION. The old code did `optionId ?? ""`, which turns a missing answer into a
 *      selection of "", and the SDK would treat that as a decision: a tool call could run without
 *      the user ever approving it.
 */

/** What the local SDK expects back from its permission handler. */
export type PermissionAnswer = { optionId: string } | { cancelled: true };

const CANCELLED: PermissionAnswer = { cancelled: true };

export function parsePermissionAnswer(payload: unknown): PermissionAnswer {
  if (!payload || typeof payload !== "object") return CANCELLED;
  const p = payload as Record<string, unknown>;

  // An error means the controller could not deliver the decision (unknown/expired permission,
  // container reconnected). Never treat that as an approval.
  if (typeof p.error === "string") return CANCELLED;

  // Legacy nested shape: {result: {...}}. Unwrap once, then apply the same rules.
  const body = (p.result && typeof p.result === "object" ? (p.result as Record<string, unknown>) : p);

  if (body.cancelled === true) return CANCELLED;
  // A non-empty string is the only thing that counts as a real selection.
  if (typeof body.optionId === "string" && body.optionId.length > 0) return { optionId: body.optionId };
  return CANCELLED;
}
