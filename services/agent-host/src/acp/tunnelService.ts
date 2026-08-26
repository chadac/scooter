/**
 * The agent-host's tunnel service — the cloud half of MCP-over-the-wire (BYOC only).
 *
 * A BYO container opens a stream naming a TARGET; this resolves it (tunnelTargets.ts: names
 * only, conversation scoped server-side), makes the real HTTP call, and streams the response
 * back as tunnel frames. goose and the in-cluster SDK never come here — they reach scooter-env
 * on loopback, unchanged.
 *
 * EVERY FAILURE CLOSES WITH A REASON. A tunnel that goes quiet leaves the agent with a tool
 * call it waits on forever; the container turns a close-with-error into an HTTP 502 the SDK
 * surfaces as a tool error. That difference — a failing tool vs a hanging one — is the whole
 * point of the error paths below.
 */

import { formatError, logger } from "../log.js";
import { resolveTunnelTarget, type TunnelTargetDeps } from "./tunnelTargets.js";
import type { WireFrame } from "./remoteProtocol.js";

const log = logger("tunnel");
const traceLog = logger("tunnel.trace");

export interface TunnelServiceDeps extends TunnelTargetDeps {
  /** Send a frame back toward the container. */
  send(frame: WireFrame): void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface TunnelService {
  /** Handle one inbound tunnel frame for `conversationId` (supplied SERVER-SIDE). */
  onFrame(conversationId: string, frame: WireFrame): Promise<void>;
  /** Await in-flight calls — tests only; production is fire-and-forget. */
  drain?(): Promise<void>;
}

/** Rewrite an `initialize` whose protocolVersion our server cannot accept. Everything else —
 *  including every tool call — passes through BYTE FOR BYTE. */
/** One in-flight stream: the request being assembled until `end` arrives. */
interface Pending {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer[];
  /** The conversation this stream is scoped to — carried so log lines can name it. */
  conversationId: string;
}

/** One structured trace line per tunnel event.
 *
 * WHY STRUCTURED. Debugging this feature took eight deploy cycles of adding one console.log at
 * whichever boundary was suspected next — each iteration a build + rollout, each answering
 * exactly one question. A tunnel carries a CONVERSATION between two processes; you cannot
 * understand it from a single boundary. Every event now emits the same key=value shape,
 * correlated by stream, so one run shows the whole exchange: which JSON-RPC method, which
 * direction, how many bytes, what status.
 *
 * Off by default (TUNNEL_TRACE=1) — it is per-frame and would drown a normal log. The proper
 * home for this is OTel spans (the metrics exporter is already wired); this is the cheap
 * version that makes the next bug readable today. */
const TRACE = process.env.TUNNEL_TRACE === "1";
function trace(event: string, fields: Record<string, unknown>): void {
  if (!TRACE) return;
  // `event` is one of a small closed set ("open"/"request"/"response"/…), so it stays a
  // constant, groupable msg; every value it carries is already a separate field.
  const defined: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) defined[k] = v;
  traceLog.info(event, defined);
}

/** The JSON-RPC method + id in a body, for correlation. Never throws on a non-JSON body. */
function rpcOf(body: Buffer): { method?: string; rpc_id?: string | number } {
  try {
    const m = JSON.parse(body.toString()) as { method?: string; id?: string | number };
    return { method: m?.method, rpc_id: m?.id };
  } catch {
    return {};
  }
}

export function createTunnelService(deps: TunnelServiceDeps): TunnelService {
  const doFetch = deps.fetchImpl ?? fetch;
  const pending = new Map<string, Pending>();
  const inflight = new Set<Promise<void>>();

  const closeWithError = (id: string, error: string): void => {
    pending.delete(id);
    deps.send({ ch: "tunnel", type: "close", id, payload: { error } });
  };

  /** Run the resolved request and stream its response back. */
  const run = async (id: string, p: Pending): Promise<void> => {
    try {
      const res = await doFetch(p.url, {
        method: p.method,
        headers: p.headers,
        body: p.body.length ? Buffer.concat(p.body).toString() : undefined,
      });
      // NB: do NOT read (or clone-and-read) the body here to log it. undici's clone shares the
      // underlying stream, so consuming the clone leaves the original yielding nothing — the
      // response reached the container EMPTY. A 4xx is not an error to swallow either: the CLI
      // probes optional methods (server/discover) and RELIES on receiving the rejection so it
      // can fall back to the standard initialize handshake. Eating that response is what left
      // the SDK with no server at all.
      trace("response", { stream: id, status: res.status, has_body: !!res.body });
      const headers: Record<string, string> = {};
      res.headers?.forEach?.((v, k) => (headers[k] = v));
      let head = { status: res.status, headers };
      let total = 0;
      const body = res.body;
      if (body && typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
        // STREAM, don't buffer: MCP StreamableHTTP responses arrive incrementally and the
        // agent should see them the same way.
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        let first = true;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (first) {
            first = false;
            trace("body", { stream: id, bytes: value.length, preview: Buffer.from(value).toString().slice(0, 200) });
          }
          deps.send({
            ch: "tunnel", type: "chunk", id,
            payload: { data: Buffer.from(value).toString("base64"), ...head },
          });
          head = {} as never; // status/headers ride the FIRST chunk only
        }
      } else {
        const text = await res.text();
        deps.send({ ch: "tunnel", type: "chunk", id, payload: { data: Buffer.from(text).toString("base64"), ...head } });
      }
      trace("close", { stream: id, total_bytes: total });
      deps.send({ ch: "tunnel", type: "close", id, payload: {} });
    } catch (err) {
      trace("failed", { stream: id, error: formatError(err) });
      log.warn("fetch FAILED", {
        conversation_id: p.conversationId,
        stream: id,
        error: formatError(err),
      });
      closeWithError(id, err instanceof Error ? err.message : String(err));
    } finally {
      pending.delete(id);
    }
  };

  return {
    async onFrame(conversationId, frame) {
      if (frame.ch !== "tunnel" || !frame.id) return;
      const id = frame.id;
      const payload = (frame.payload ?? {}) as {
        target?: string; method?: string; path?: string; headers?: Record<string, string>; data?: string;
      };

      if (frame.type === "open") {
        trace("open", { stream: id, conversation_id: conversationId, target: payload.target, method: payload.method });
        const resolution = resolveTunnelTarget(payload.target ?? "", conversationId, deps);
        if (!resolution.ok) {
          // Loud on both ends: the container logs the reason, and so do we.
          log.warn("refusing target", {
            conversation_id: conversationId,
            target: payload.target,
            reason: resolution.reason,
          });
          closeWithError(id, resolution.reason);
          return;
        }
        // NOTE: the resolved URL is used AS RESOLVED — the container's `path` is deliberately
        // NOT appended. The target already encodes the endpoint + this conversation's scope,
        // and honouring a container-supplied path would let it reach other conversations'
        // resources (the cross-owner hole the attach path guards against).
        const headers = { ...(payload.headers ?? {}) };
        delete headers.host; // the container's Host names its own loopback proxy
        delete headers["content-length"]; // recomputed by fetch
        pending.set(id, {
          url: resolution.target.url,
          method: payload.method ?? "GET",
          headers,
          body: [],
          conversationId,
        });
        return;
      }

      const p = pending.get(id);
      if (!p) {
        return;
      }

      if (frame.type === "chunk") {
        if (payload.data) p.body.push(Buffer.from(payload.data, "base64"));
        return;
      }
      if (frame.type === "end") {
        trace("request", {
          stream: id,
          conversation_id: p.conversationId,
          url: p.url,
          bytes: Buffer.concat(p.body).length,
          ...rpcOf(Buffer.concat(p.body)),
        });
        const task = run(id, p);
        inflight.add(task);
        void task.finally(() => inflight.delete(task));
        return;
      }
      if (frame.type === "close") {
        // The container gave up (its SDK client went away).
        pending.delete(id);
      }
    },

    async drain() {
      while (inflight.size) await Promise.all([...inflight]);
    },
  };
}
