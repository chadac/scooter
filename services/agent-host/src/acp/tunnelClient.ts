/**
 * The agent-host's INBOUND tunnel connection — holds `GET /byoc/:id/tunnel` open and serves
 * the container-initiated MCP streams that arrive on it.
 *
 * WHY THIS EXISTS. The agent-host reaches the BYOC controller over HTTP/SSE PER PROMPT, so it
 * has no channel for a stream the CONTAINER opens. Exec frames only work because they arrive
 * during a prompt; tunnel frames are deliberately kept OUT of run streams (a run's stream is
 * the conversation's transcript, and a tunnel close there would look like run output). Found
 * live: the container proxied scooter-env correctly, the agent SAW the server, and every tool
 * list came back empty because nothing on the cloud side was listening.
 *
 * Replies go back via `POST /byoc/:id/tunnel/:streamId` — the same asymmetric shape the exec
 * and permission paths already use.
 */

import { createTunnelService, type TunnelServiceDeps } from "./tunnelService.js";
import type { WireFrame } from "./remoteProtocol.js";

export interface TunnelClientDeps extends Omit<TunnelServiceDeps, "send"> {
  /** The controller's in-cluster base URL. */
  baseUrl: string;
  /** The container session whose inbound stream this follows. */
  sessionId: string;
  /** The conversation this session serves — the SERVER-SIDE scope for every target it
   *  resolves. Never read from a container frame. */
  conversationId: string;
  fetchImpl?: typeof fetch;
}

export interface TunnelClient {
  /** Stop following the stream. */
  close(): void;
}

/**
 * Follow a session's inbound tunnel stream, serving each frame. Reconnects on drop: a broken
 * stream would silently strip a BYO agent of its MCP tools — a capability regression the user
 * would experience as "the tool disappeared", with nothing in the log.
 */
export function startTunnelClient(deps: TunnelClientDeps): TunnelClient {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = `${deps.baseUrl.replace(/\/$/, "")}/byoc/${encodeURIComponent(deps.sessionId)}`;
  let closed = false;
  let controller: AbortController | undefined;

  const service = createTunnelService({
    ...deps,
    // Responses ride the REPLY route, not the stream (which is inbound-only).
    send: (frame: WireFrame) => {
      if (!frame.id) return;
      void doFetch(`${base}/tunnel/${encodeURIComponent(frame.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(frame),
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[tunnel] reply for ${frame.id} failed: ${String(err)}`);
      });
    },
  });

  const follow = async (): Promise<void> => {
    while (!closed) {
      try {
        controller = new AbortController();
        const res = await doFetch(`${base}/tunnel`, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          // 404 = the session is gone (the container re-attached elsewhere); stop rather than
          // spin against a stream that will never exist.
          if (res.status === 404) return;
          throw new Error(`tunnel stream ${res.status}`);
        }
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const frame = JSON.parse(line.slice(5).trim()) as WireFrame;
                void service.onFrame(deps.conversationId, frame);
              } catch {
                // one malformed frame must not kill the stream
              }
            }
          }
        }
      } catch (err) {
        if (closed) return;
        // eslint-disable-next-line no-console
        console.warn(`[tunnel] inbound stream dropped (reconnecting): ${String(err)}`);
      }
      if (closed) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  };

  // Say so, once, per session. A silent tunnel client is indistinguishable from one that never
  // started — which is exactly what made the first live failure hard to place.
  // eslint-disable-next-line no-console
  console.log(`[tunnel] following inbound stream for session=${deps.sessionId} conversation=${deps.conversationId}`);
  void follow();

  return {
    close() {
      closed = true;
      controller?.abort();
    },
  };
}
