/**
 * Keeps `session/update` variants the pinned ACP SDK was never taught off its parser.
 *
 * The SDK validates the WHOLE notification against a CLOSED zod union
 * (`sessionNotificationSchema`) before `Client.sessionUpdate` is ever called. One
 * unknown discriminant — `usage_update`, `session_info_update`, anything newer — fails
 * that parse, so the SDK rejects the notification with JSON-RPC -32602 and logs it. The
 * update is lost either way; the only thing the rejection adds is the error line.
 * `normalizeUpdate`'s `default:` branch cannot help, because it never runs.
 *
 * So tolerating an unknown variant HAS to happen upstream of the SDK. This filter drops
 * those notifications off the message stream before the SDK decodes them, which keeps
 * working for variants invented after this was written.
 *
 * Bumping is not an option: `@zed-industries/agent-client-protocol` is deprecated at its
 * final 0.4.5, and its successor `@agentclientprotocol/sdk` is a rename onto the v1/v2
 * schema — a protocol migration, not a version bump.
 */

import type { Stream } from "@zed-industries/agent-client-protocol";

/**
 * The `sessionUpdate` discriminants the PINNED SDK's `sessionNotificationSchema` accepts.
 * Anything outside this set makes the SDK reject the whole notification, so it must be
 * removed before the SDK sees it.
 *
 * A variant wrongly ABSENT here is silently dropped even though the SDK would have
 * handled it — which is why `sessionUpdateFilter.spec.ts` derives the same set from the
 * SDK's live zod schema and fails if the two disagree. Do not "keep this in sync" by
 * hand; the test does it. Why: PR #536.
 */
export const SDK_SESSION_UPDATE_VARIANTS: ReadonlySet<string> = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
]);

/** A notification the SDK would have rejected, surfaced so the caller can salvage it. */
export interface UnsupportedSessionUpdate {
  sessionId: string;
  /** The `sessionUpdate` discriminant, e.g. "usage_update". */
  variant: string;
  /** The raw `params.update` object. */
  update: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Classify one JSON-RPC message: returns the update when it is a `session/update`
 * NOTIFICATION carrying a variant the SDK cannot parse, else undefined.
 *
 * Only id-less messages qualify. A message with an `id` expects a RESPONSE, so dropping
 * one would hang whoever is awaiting it — an unanswered request is a far worse failure
 * than a lost update, and this filter must never be able to cause it.
 */
export function unsupportedSessionUpdate(msg: unknown): UnsupportedSessionUpdate | undefined {
  if (!isRecord(msg)) return undefined;
  if (msg.method !== "session/update" || "id" in msg) return undefined;
  const params = msg.params;
  if (!isRecord(params)) return undefined;
  const update = params.update;
  if (!isRecord(update)) return undefined;
  const variant = update.sessionUpdate;
  if (typeof variant !== "string" || SDK_SESSION_UPDATE_VARIANTS.has(variant)) return undefined;
  return {
    sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
    variant,
    update,
  };
}

/**
 * Wrap a `Stream` so unparseable `session/update` notifications are removed from the
 * readable side before the SDK decodes them. Everything else passes through untouched and
 * IN ORDER; the writable side is returned as-is.
 *
 * `onDropped` is called for each removed notification (to salvage or log it). A throw
 * there is swallowed: it must not tear down the ACP connection over a log line.
 */
export function filterUnsupportedSessionUpdates(
  stream: Stream,
  onDropped: (dropped: UnsupportedSessionUpdate) => void,
): Stream {
  const transform = new TransformStream<unknown, unknown>({
    transform(msg, controller) {
      const dropped = unsupportedSessionUpdate(msg);
      if (!dropped) {
        controller.enqueue(msg);
        return;
      }
      try {
        onDropped(dropped);
      } catch {
        // Deliberately swallowed — see the doc comment above.
      }
    },
  });
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(transform as never) as Stream["readable"],
  };
}

const finiteNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Salvage a dropped `usage_update` as our `context_usage` numbers.
 *
 * Field names are the ACP spec's `UsageUpdate`: `used` ("tokens currently in context")
 * and `size` ("total context window size in tokens"). Every field is CHECKED rather than
 * coerced — an agent that disagrees about the shape yields undefined, because no context
 * bar is better than a wrong one.
 */
export function contextUsageFromUsageUpdate(
  dropped: UnsupportedSessionUpdate,
): { usedTokens: number; contextWindow: number } | undefined {
  if (dropped.variant !== "usage_update") return undefined;
  const usedTokens = finiteNumber(dropped.update.used);
  const contextWindow = finiteNumber(dropped.update.size);
  if (usedTokens === undefined || contextWindow === undefined || contextWindow <= 0) {
    return undefined;
  }
  return { usedTokens, contextWindow };
}
