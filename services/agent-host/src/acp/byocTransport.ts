/**
 * The BYOC transport — a RemoteTransport that speaks HTTP/SSE to the BYOC controller instead of
 * holding a WebSocket to the user's container.
 *
 * This is the swap that deletes a whole bug class.
 * Before, each agent-host pod held the container socket in its own memory, so only the pod the
 * container happened to reach could drive that brain: a user with conversations spread across
 * replicas would find half of them dead. Same shape as the conversation-list bug in #284 — asking
 * one arbitrary pod what it happens to know, instead of the component that owns the answer.
 *
 * Here the pod holds NOTHING durable. Every outbound frame is a stateless POST; the ACP frames come
 * back as SSE on the prompt response. Any replica can serve any conversation and a rollout cannot
 * strand a run.
 *
 * ROUTING. `RemoteAcpClient` sends three kinds of frame, and each has its own endpoint because they
 * mean different things to the controller:
 *   prompt/cancel/initialize/... -> POST /byoc/:session/prompt       (starts a run, streams back)
 *   ack for a permission id      -> POST /byoc/:session/permission/:id  (unblocks the agent)
 *   exec_result for an exec id   -> POST /byoc/:session/exec/:id        (Channel B reply)
 * Posting an answer to the prompt endpoint would start a SECOND run rather than resolve the
 * blocked call — hence the explicit split rather than one catch-all route.
 *
 * FAILURE IS LOUD. Every error path closes the transport, because RemoteAcpClient's onClose is what
 * rejects in-flight requests and lets the bridge emit RUN_ERROR. A transport that merely goes quiet
 * would leave the bridge awaiting an ack that can never arrive — the user watching a spinner
 * forever, which is exactly the class of "weird detached state" this project keeps chasing.
 */

import type { RemoteTransport, WireFrame } from "./remoteProtocol.js";

export interface ByocTransportConfig {
  /** Base URL of the BYOC controller Service (in-cluster), e.g. http://byoc-controller:8080. */
  baseUrl: string;
  /** The controller-issued session id for THIS owner's container. */
  sessionId: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export function createByocTransport(config: ByocTransportConfig): RemoteTransport {
  const { baseUrl, sessionId } = config;
  const doFetch = config.fetchImpl ?? fetch;
  const base = `${baseUrl.replace(/\/$/, "")}/byoc/${encodeURIComponent(sessionId)}`;

  const frameCbs = new Set<(frame: WireFrame) => void>();
  const closeCbs = new Set<() => void>();
  let open = true;
  const inflight = new Set<AbortController>();

  const emit = (frame: WireFrame): void => {
    if (!open) return;
    for (const cb of [...frameCbs]) cb(frame);
  };

  const shutdown = (): void => {
    if (!open) return;
    open = false;
    for (const ac of inflight) ac.abort();
    inflight.clear();
    for (const cb of [...closeCbs]) cb();
  };

  /** Which endpoint a frame belongs to. See ROUTING above. */
  const endpointFor = (frame: WireFrame): string => {
    if (frame.ch === "exec" && frame.id) return `${base}/exec/${encodeURIComponent(frame.id)}`;
    // An ACP `ack` going OUT is always an answer to a permission the container is blocked on
    // the agent-host never acks anything else (it is the requester on Channel A).
    if (frame.ch === "acp" && frame.type === "ack" && frame.id) {
      return `${base}/permission/${encodeURIComponent(frame.id)}`;
    }
    return `${base}/prompt`;
  };

  /** Read an SSE body, dispatching each `data:` line as a frame. */
  const pump = async (res: Response): Promise<void> => {
    const body = res.body;
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line; a frame can span reads.
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            emit(JSON.parse(line.slice(5).trim()) as WireFrame);
          } catch {
            // A malformed frame is skipped, never fatal: one bad line must not kill a live run.
          }
        }
      }
    }
  };

  return {
    send(frame) {
      if (!open) return;
      const ac = new AbortController();
      inflight.add(ac);
      void (async () => {
        try {
          const res = await doFetch(endpointFor(frame), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(frame),
            signal: ac.signal,
          });
          if (!res.ok) {
            // 503 = the container is not connected. Closing (rather than retrying silently) is
            // deliberate: the bridge should tell the user their Claude is offline.
            shutdown();
            return;
          }
          await pump(res);
        } catch {
          if (!ac.signal.aborted) shutdown(); // an abort is OUR close(), not a failure
        } finally {
          inflight.delete(ac);
        }
      })();
    },

    onFrame(cb) {
      frameCbs.add(cb);
      return () => frameCbs.delete(cb);
    },

    isOpen() {
      return open;
    },

    onClose(cb) {
      closeCbs.add(cb);
      return () => closeCbs.delete(cb);
    },

    close() {
      shutdown();
    },
  };
}
