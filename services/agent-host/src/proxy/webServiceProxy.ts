/**
 * Web-service reverse proxy — forwards `/c/<id>/<service>/...` from the browser
 * (via UI nginx) into the conversation's sandbox pod, over HTTP AND WebSocket.
 *
 * Why this lives in the agent-host (not nginx): nginx can't resolve <id> -> pod IP
 * (dynamic IPs, no per-conversation Service, agent-host lacks create-Service RBAC).
 * The agent-host already resolves the pod (exec/k8sExec.ts) and knows the caller.
 *
 * Attaches at two seams in agui/server.ts:
 *   - HTTP:  a fallback in handle(req,res) BEFORE the 404, when the path is /c/*.
 *   - WS:    a `server.on("upgrade", ...)` listener registered in listen().
 *
 * Auth is whatever the ingress already applied (x-auth-user) — NO extra
 * per-conversation check (any authenticated user, matching today's view-filter
 * model). See docs/WEB_SERVICES_PROXY.md.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import type { SessionManager } from "../session/manager.js";
import type { SandboxRef } from "../types.js";

// --- pod target resolution ----------------------------------------------------

/** A conversation pod's reachable address for direct in-cluster HTTP/WS. */
export interface PodTarget {
  name: string;
  /** status.podIP — re-resolve after suspend/resume (the IP changes). */
  podIP: string;
}

/** Resolve a sandbox ref to its pod name + IP (exec/k8sExec.ts resolvePodTarget). */
export type ResolvePodTarget = (ref: SandboxRef) => Promise<PodTarget>;

// --- service discovery (id + name -> port) -----------------------------------

/** One proxyable service as declared by the in-pod `webServices` option
 *  (mirrors the discovery manifest entry rendered by web-services.nix). */
export interface WebServiceDescriptor {
  name: string;
  displayName: string;
  /** In-pod listen port. */
  port: number;
  /** External sub-path prefix, with the conversation id substituted in. */
  basePath: string;
  /** systemd unit name (webservice-<name>), for start/stop via exec. */
  unit: string;
}

/**
 * Reads a conversation's declared web services from the in-pod discovery manifest
 * (/run/scooter/web-services.json) via exec/download, and caches per conversation.
 * Cache is invalidated on suspend/resume and after a start.
 */
export interface WebServiceRegistry {
  list(conversationId: string): Promise<WebServiceDescriptor[]>;
  get(conversationId: string, name: string): Promise<WebServiceDescriptor | null>;
  /** Liveness: `systemctl is-active webservice-<name>` via exec. */
  isRunning(conversationId: string, name: string): Promise<boolean>;
  /** Start the unit: `systemctl start webservice-<name>` via exec. Resolves once
   *  issued (not once healthy — readiness-gating is a follow-up). */
  start(conversationId: string, name: string): Promise<void>;
  /** Drop cached descriptors for a conversation (call on suspend/resume/start). */
  invalidate(conversationId: string): void;
}

// --- the proxy ----------------------------------------------------------------

export interface WebServiceProxyDeps {
  sessions: SessionManager;
  resolvePodTarget: ResolvePodTarget;
  registry: WebServiceRegistry;
  /** The external host (marimo `--proxy` / absolute-URL correctness). From PUBLIC_URL. */
  publicHost: string;
}

/** Parsed shape of a proxy path: /c/<id>/<service>/<rest...> */
export interface ParsedProxyPath {
  conversationId: string;
  service: string;
  /** The remainder after /c/<id>/<service>, WITH leading slash (or "/"). */
  rest: string;
}

/**
 * Split a URL path into its proxy parts, or null if it isn't a /c/<id>/<service>
 * path. `/c/<id>` alone (the UI deep-link space) is NOT a proxy path — a service
 * segment is required.
 */
export function parseProxyPath(pathname: string): ParsedProxyPath | null {
  const parts = pathname.split("/").filter(Boolean);
  // ["c", "<id>", "<service>", ...rest]
  if (parts.length < 3 || parts[0] !== "c") return null;
  const conversationId = decodeURIComponent(parts[1]);
  const service = decodeURIComponent(parts[2]);
  if (!conversationId || !service) return null;
  const restParts = parts.slice(3);
  const rest = "/" + restParts.map(encodeURIComponent).join("/");
  return { conversationId, service, rest };
}

export interface WebServiceProxy {
  matches(pathname: string): boolean;
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
}

/** Resolve a proxy request to its concrete pod target + service, or an error the
 *  caller renders as an HTTP/handshake status. */
type Resolution =
  | { ok: true; podIP: string; port: number; rest: string; threadId: string; service: string }
  | { ok: false; status: 404 | 502 | 503; service: string; threadId: string };

export function renderNotStartedPage(service: string, threadId: string): string {
  const safe = (s: string) => s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
  const back = `/?thread=${encodeURIComponent(threadId)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safe(service)} isn't running</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}
a{color:#2563eb}</style></head><body>
<h2>${safe(service)} isn't running</h2>
<p>This service hasn't been started for the conversation yet. Start it from the
<strong>Services</strong> panel, then reload this page.</p>
<p><a href="${back}">← Back to the conversation</a></p>
</body></html>`;
}

export function createWebServiceProxy(deps: WebServiceProxyDeps): WebServiceProxy {
  const { sessions, resolvePodTarget, registry } = deps;

  const matches = (pathname: string): boolean => parseProxyPath(pathname) !== null;

  async function resolve(pathname: string): Promise<Resolution | null> {
    const parsed = parseProxyPath(pathname);
    if (!parsed) return null;
    const { conversationId, service, rest } = parsed;

    // The URL id may be the full threadId (UI) or the short hash — try both.
    const conv = sessions.get(conversationId) ?? (await sessions.getByShortId(conversationId));
    const threadId = conv?.threadId ?? conversationId;
    if (!conv) return { ok: false, status: 404, service, threadId };

    const desc = await registry.get(conv.id, service);
    if (!desc) return { ok: false, status: 404, service, threadId };

    if (!(await registry.isRunning(conv.id, service))) {
      return { ok: false, status: 502, service, threadId };
    }

    let target: PodTarget;
    try {
      target = await resolvePodTarget(conv.sandbox);
    } catch {
      // Pod suspended / not ready / no IP.
      return { ok: false, status: 503, service, threadId };
    }
    return { ok: true, podIP: target.podIP, port: desc.port, rest, threadId, service };
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const r = await resolve(url.pathname);
    if (!r) {
      res.writeHead(404).end();
      return;
    }
    if (!r.ok) {
      if (r.status === 502) {
        const page = renderNotStartedPage(r.service, r.threadId);
        res.writeHead(502, { "content-type": "text/html; charset=utf-8" }).end(page);
      } else if (r.status === 503) {
        res.writeHead(503, { "content-type": "text/plain" })
          .end(`${r.service} is asleep — resume the conversation and try again.`);
      } else {
        res.writeHead(404).end();
      }
      return;
    }

    // Preserve the FULL external path so the sub-path-aware service (marimo
    // --base-url, code-server --server-base-path) sees the prefix it expects.
    const upstreamPath = url.pathname + (url.search ?? "");
    const headers = { ...req.headers, host: `${r.podIP}:${r.port}` };
    const upstream = httpRequest(
      { host: r.podIP, port: r.port, method: req.method, path: upstreamPath, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("upstream error");
    });
    req.pipe(upstream);
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const r = await resolve(url.pathname);
    if (!r || !r.ok) {
      const status = !r ? 404 : r.status;
      const text = status === 503 ? "service asleep" : status === 502 ? "service not running" : "not found";
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    // Splice: open a raw TCP connection to the pod, replay the upgrade handshake
    // (with the Host rewritten), forward the buffered head, then pipe both ways.
    const upstreamPath = url.pathname + (url.search ?? "");
    const upstream: Socket = connect(r.port, r.podIP, () => {
      const lines = [
        `${req.method ?? "GET"} ${upstreamPath} HTTP/1.1`,
        `Host: ${r.podIP}:${r.port}`,
      ];
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "host") continue;
        for (const val of Array.isArray(v) ? v : [v]) if (val != null) lines.push(`${k}: ${val}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const teardown = () => { socket.destroy(); upstream.destroy(); };
    upstream.on("error", teardown);
    socket.on("error", teardown);
  }

  return { matches, handleHttp, handleUpgrade };
}
