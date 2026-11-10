/**
 * The agent-host's tunnel service, the cloud half of MCP-over-the-wire for BYOC. A
 * container opens a stream naming a target; this resolves it (tunnelTargets.ts),
 * makes the real HTTP call, and streams the response back as tunnel frames. Every
 * failure closes with a reason, since a tunnel that goes quiet leaves the agent
 * with a tool call it waits on forever.
 */

import { formatError, logger } from "../log.js";
import { resolveTunnelTarget, type ResolvedTarget, type TunnelTargetDeps } from "./tunnelTargets.js";
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
  /** Handle one inbound tunnel frame for `conversationId`, which is supplied server-side. */
  onFrame(conversationId: string, frame: WireFrame): Promise<void>;
  /** Await in-flight calls (tests only). */
  drain?(): Promise<void>;
}

/** One in-flight stream: the request being assembled until `end` arrives. */
interface Pending {
  /** Settles undefined when refused; frames keep arriving while it resolves. */
  target: Promise<ResolvedTarget | undefined>;
  method: string;
  /** The container's headers, before the resolved target's are injected. */
  headers: Record<string, string>;
  body: Buffer[];
  /** The conversation this stream is scoped to, so log lines can name it. */
  conversationId: string;
}

/** One structured trace line per tunnel event, correlated by stream, enabled with TUNNEL_TRACE=1 since it is per-frame. */
const TRACE = process.env.TUNNEL_TRACE === "1";
function trace(event: string, fields: Record<string, unknown>): void {
  if (!TRACE) return;
  // `event` is a small closed set, so it stays a constant, groupable msg.
  const defined: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) defined[k] = v;
  traceLog.info(event, defined);
}

/** The JSON-RPC method and id in a body, for correlation; never throws on a non-JSON body. */
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

  /** The container's headers with the target's injected over them. */
  const requestHeaders = (fromContainer: Record<string, string>, target: ResolvedTarget): Record<string, string> => {
    const headers = { ...fromContainer };
    delete headers.host; // the container's Host names its own loopback proxy
    delete headers["content-length"]; // recomputed by fetch
    // An injected credential replaces any header the container supplied under the
    // same name (case-insensitively), so the user's machine cannot present its own.
    for (const { name } of target.headers) {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
      }
    }
    for (const { name, value } of target.headers) headers[name] = value;
    return headers;
  };

  /** Run the resolved request and stream its response back. */
  const run = async (id: string, p: Pending): Promise<void> => {
    const target = await p.target;
    if (!target) return; // already closed with the refusal
    const reqBody = Buffer.concat(p.body);
    trace("request", {
      stream: id,
      conversation_id: p.conversationId,
      url: target.url,
      bytes: reqBody.length,
      ...rpcOf(reqBody),
    });
    try {
      // The resolved URL is used as resolved, with the container's `path` not appended,
      // since honouring it would let the container reach other conversations' resources.
      const res = await doFetch(target.url, {
        method: p.method,
        headers: requestHeaders(p.headers, target),
        body: reqBody.length ? reqBody.toString() : undefined,
      });
      // Do not read or clone the body here to log it (undici's clone shares the stream),
      // and forward a 4xx rather than swallow it, since the CLI relies on rejections to
      // fall back to the standard initialize handshake.
      trace("response", { stream: id, status: res.status, has_body: !!res.body });
      const headers: Record<string, string> = {};
      res.headers?.forEach?.((v, k) => (headers[k] = v));
      let head = { status: res.status, headers };
      let total = 0;
      const body = res.body;
      if (body && typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
        // Stream rather than buffer, since MCP StreamableHTTP responses arrive incrementally.
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
          head = {} as never; // status/headers ride the first chunk only
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
        const target = resolveTunnelTarget(payload.target ?? "", conversationId, deps).then(
          (resolution) => {
            if (resolution.ok) return resolution.target;
            // Loud on both ends.
            log.warn("refusing target", {
              conversation_id: conversationId,
              target: payload.target,
              reason: resolution.reason,
            });
            if (pending.get(id) === entry) closeWithError(id, resolution.reason);
            return undefined;
          },
          (err: unknown) => {
            log.warn("target resolution FAILED", { conversation_id: conversationId, target: payload.target, error: formatError(err) });
            if (pending.get(id) === entry) closeWithError(id, `could not resolve target: ${formatError(err)}`);
            return undefined;
          },
        );
        // Registered before resolving, since the stream's chunks do not wait for it.
        const entry: Pending = { target, method: payload.method ?? "GET", headers: payload.headers ?? {}, body: [], conversationId };
        pending.set(id, entry);
        await target;
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
