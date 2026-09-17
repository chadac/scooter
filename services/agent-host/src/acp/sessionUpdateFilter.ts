/**
 * Guards the ACP SDK against `session/update` variants it was never taught.
 *
 * The SDK validates the WHOLE notification with a closed zod union
 * (`sessionNotificationSchema`) before our `Client.sessionUpdate` is called. A
 * variant the pinned SDK doesn't know — `session_info_update`, `usage_update`,
 * anything newer — fails that parse, so the notification is rejected outright
 * with JSON-RPC -32602 and `normalizeUpdate`'s `default:` branch never runs.
 * Tolerating unknown variants therefore HAS to happen upstream of the SDK.
 *
 * `@zed-industries/agent-client-protocol` is deprecated at its final 0.4.5 and
 * the successor (`@agentclientprotocol/sdk`) is a rename onto a v2 schema, so
 * there is no version to bump to that accepts these. This filter drops the
 * unknown variants off the message stream instead, which also keeps working
 * for variants added after this was written.
 */

import type { Stream } from "@zed-industries/agent-client-protocol";

/**
 * The `sessionUpdate` discriminants the PINNED SDK's `sessionNotificationSchema`
 * accepts (0.4.5 dist/schema.js). Anything outside this set makes the SDK reject
 * the notification, so it must be filtered out before the SDK sees it.
 *
 * KEEP IN SYNC with the SDK on upgrade: a variant missing here is silently
 * dropped even though the SDK would have accepted it. Why: PR #535.
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

/** An update the SDK would have rejected, surfaced so the caller can salvage it. */
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
 * NOTIFICATION carrying a variant the SDK can't parse, else undefined.
 *
 * Only `id`-less messages qualify — a message with an id expects a response, and
 * swallowing one would hang the caller rather than merely lose an update.
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
 * Wrap a `Stream` so unparseable `session/update` notifications are removed from
 * the readable side before the SDK decodes them. Everything else passes through
 * untouched, in order; the writable side is returned as-is.
 *
 * `onDropped` is called for each removed notification (to salvage or log it) and
 * is never allowed to break the stream: a throw there would tear down the whole
 * ACP connection over a log line.
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
        // Deliberately swallowed — see the doc comment.
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
 * Field names come from the ACP spec's `UsageUpdate` — `used` ("tokens currently
 * in context") and `size` ("total context window size in tokens"). An agent that
 * disagrees yields undefined rather than a wrong context bar, which is why every
 * field is checked instead of coerced.
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
