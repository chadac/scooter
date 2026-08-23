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

import { resolveTunnelTarget, type TunnelTargetDeps } from "./tunnelTargets.js";
import type { WireFrame } from "./remoteProtocol.js";

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

/** MCP protocol versions our server's SDK accepts, newest first. The tunnel joins two
 *  INDEPENDENTLY-VERSIONED MCP implementations — the user's `claude` CLI and this
 *  agent-host's SDK — so unlike the in-cluster paths (same SDK on both ends) their versions
 *  can and do diverge. Observed live: the CLI offered 2026-07-28, our transport answered
 *  `400 Bad Request: Unsupported protocol version`, and the SDK gave up with no tools. The
 *  spec expects negotiation, so we negotiate. */
const SUPPORTED_MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

/** Rewrite an `initialize` whose protocolVersion our server cannot accept. Everything else —
 *  including every tool call — passes through BYTE FOR BYTE. */
const META_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

function negotiateInitialize(body: Buffer): Buffer {
  if (!body.length) return body;
  let msg: {
    method?: string;
    params?: { protocolVersion?: string; _meta?: Record<string, unknown> };
  };
  try {
    msg = JSON.parse(body.toString()) as typeof msg;
  } catch {
    return body; // not JSON (or a batch we do not parse) — never touch it
  }
  // TWO handshake shapes, both observed: the classic `initialize` with
  // params.protocolVersion, and the newer capability probe (`server/discover`) that carries
  // the version in params._meta under a NAMESPACED key. A first cut handled only the former
  // and silently never fired — the live body is what settled it.
  const classic = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : undefined;
  const meta = msg.params?._meta?.[META_VERSION_KEY];
  const metaVersion = typeof meta === "string" ? meta : undefined;
  const want = classic ?? metaVersion;
  if (!want || SUPPORTED_MCP_VERSIONS.includes(want)) return body;
  if (classic) msg.params!.protocolVersion = SUPPORTED_MCP_VERSIONS[0];
  if (metaVersion) msg.params!._meta![META_VERSION_KEY] = SUPPORTED_MCP_VERSIONS[0];
  // eslint-disable-next-line no-console
  console.log(`[tunnel] negotiated MCP protocol ${want} -> ${SUPPORTED_MCP_VERSIONS[0]} (${msg.method})`);
  return Buffer.from(JSON.stringify(msg));
}

/** One in-flight stream: the request being assembled until `end` arrives. */
interface Pending {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer[];
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
      // eslint-disable-next-line no-console
      console.log(`[tunnel] fetch START stream=${id} ${p.method} ${p.url} bodyBytes=${Buffer.concat(p.body).length}`);
      const res = await doFetch(p.url, {
        method: p.method,
        headers: p.headers,
        body: p.body.length ? negotiateInitialize(Buffer.concat(p.body)).toString() : undefined,
      });
      // eslint-disable-next-line no-console
      console.log(`[tunnel] fetch DONE stream=${id} status=${res.status} hasBody=${!!res.body}`);
      if (res.status >= 400) {
        // The MCP endpoint REJECTED the tunnelled request. Log what it said and what we sent —
        // a 400 here is invisible to the container (it just sees a failed tool call), and this
        // is the difference between guessing at headers and reading the answer.
        const clone = res.clone?.();
        const text = clone ? await clone.text().catch(() => "<unreadable>") : "<no clone>";
        // eslint-disable-next-line no-console
        console.warn(
          `[tunnel] REJECTED stream=${id} status=${res.status} body=${text.slice(0, 300)} ` +
            `sentHeaders=${JSON.stringify(p.headers)} sentBody=${Buffer.concat(p.body).toString().slice(0, 200)}`,
        );
      }
      const headers: Record<string, string> = {};
      res.headers?.forEach?.((v, k) => (headers[k] = v));
      let head = { status: res.status, headers };
      const body = res.body;
      if (body && typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
        // STREAM, don't buffer: MCP StreamableHTTP responses arrive incrementally and the
        // agent should see them the same way.
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
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
      deps.send({ ch: "tunnel", type: "close", id, payload: {} });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[tunnel] fetch FAILED stream=${id}: ${String(err)}`);
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
        // eslint-disable-next-line no-console
        console.log(`[tunnel] open stream=${id} target=${JSON.stringify(payload.target)} conversation=${conversationId}`);
        const resolution = resolveTunnelTarget(payload.target ?? "", conversationId, deps);
        if (!resolution.ok) {
          // Loud on both ends: the container logs the reason, and so do we.
          // eslint-disable-next-line no-console
          console.warn(`[tunnel] refusing target ${JSON.stringify(payload.target)} for ${conversationId}: ${resolution.reason}`);
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
        pending.set(id, { url: resolution.target.url, method: payload.method ?? "GET", headers, body: [] });
        return;
      }

      const p = pending.get(id);
      if (!p) {
        // eslint-disable-next-line no-console
        console.log(`[tunnel] ${frame.type} for UNKNOWN stream=${id} (refused/finished?)`);
        return;
      }

      if (frame.type === "chunk") {
        if (payload.data) p.body.push(Buffer.from(payload.data, "base64"));
        return;
      }
      if (frame.type === "end") {
        // eslint-disable-next-line no-console
        console.log(`[tunnel] end stream=${id} -> calling ${p.url}`);
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
