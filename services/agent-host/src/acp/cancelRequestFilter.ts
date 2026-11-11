// Drops `$/cancel_request`, which the pinned SDK rejects with -32601.

import type { Stream } from "@zed-industries/agent-client-protocol";

/** Drop `$/cancel_request` notifications, passing each `requestId` to `onCancel`. */
export function filterCancelRequests(stream: Stream, onCancel: (requestId: unknown) => void): Stream {
  const transform = new TransformStream<unknown, unknown>({
    transform(msg, controller) {
      if (!isCancelRequest(msg)) {
        controller.enqueue(msg);
        return;
      }
      try {
        onCancel(msg.params?.requestId);
      } catch {
        // A throw here must not tear down the ACP connection.
      }
    },
  });
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(transform as never) as Stream["readable"],
  };
}

/** Whether `msg` is an id-less `$/cancel_request`; one with an id needs a response. */
export function isCancelRequest(msg: unknown): msg is { params?: { requestId?: unknown } } {
  if (typeof msg !== "object" || msg === null) return false;
  return (msg as { method?: unknown }).method === "$/cancel_request" && !("id" in msg);
}
