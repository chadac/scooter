/**
 * Web-service reverse proxy — forwards `/c/<id>/<service>/...` from the browser
 * (via UI nginx) into the conversation's sandbox pod, over HTTP AND WebSocket.
 *
 * DESIGN BOILERPLATE (PoC stage 2): interfaces + signatures + the wiring contract.
 * No implementation — bodies throw NOT_IMPLEMENTED. See docs/WEB_SERVICES_PROXY.md.
 *
 * Why this lives in the agent-host (not nginx): nginx can't resolve <id> -> pod IP
 * (dynamic IPs, no per-conversation Service, agent-host lacks create-Service RBAC).
 * The agent-host already resolves the pod (exec/k8sExec.ts) and knows the caller.
 *
 * Attaches at two seams in agui/server.ts:
 *   - HTTP:  a fallback in handle(req,res) BEFORE the 404, when the path is /c/*.
 *   - WS:    a `server.on("upgrade", ...)` listener registered in listen() — the
 *            agent-host http.Server has NONE today; this adds it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { SessionManager } from "../session/manager.js";

// --- pod target resolution ----------------------------------------------------

/** A conversation pod's reachable address for direct in-cluster HTTP/WS. */
export interface PodTarget {
  /** The pod name (as resolvePodName returns today). */
  name: string;
  /** The pod's routable cluster IP (status.podIP). Re-resolve after suspend/resume
   *  — the IP changes; never cache it across a suspend. */
  podIP: string;
}

/**
 * Sibling to resolvePodName in exec/k8sExec.ts, but also returns status.podIP
 * (already fetched from the ready pod object today, then discarded). Same 90s
 * ready-poll. Throws if no ready pod (proxy maps that to 503).
 * TODO(impl): implement in exec/k8sExec.ts and import here.
 */
export type ResolvePodTarget = (
  ref: { name: string; namespace: string },
) => Promise<PodTarget>;

// --- service discovery (id + name -> port) -----------------------------------

/** One proxyable service as declared by the in-pod `services.webServices` option
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
 * Cache is invalidated on suspend/resume and after a start (a newly-enabled
 * service may have just appeared).
 * TODO(impl).
 */
export interface WebServiceRegistry {
  /** All declared services for a conversation (empty if none / pod asleep). */
  list(conversationId: string): Promise<WebServiceDescriptor[]>;
  /** One service by name, or null if not declared. */
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
  /** The external host (for marimo `--proxy` / absolute-URL correctness and for
   *  Host-header rewriting). From PUBLIC_URL. */
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
 * path. Note `/c/<id>` alone (the UI deep-link space) is NOT a proxy path — a
 * service segment is required.
 * TODO(impl).
 */
export function parseProxyPath(_pathname: string): ParsedProxyPath | null {
  throw new Error("NOT_IMPLEMENTED");
}

export interface WebServiceProxy {
  /** True if this request path is ours (`/c/<id>/<service>/...`). Both the HTTP
   *  fallback and the upgrade listener gate on this. */
  matches(pathname: string): boolean;

  /**
   * Handle an HTTP request: resolve conversation -> pod -> service port, then
   * stream the request to http://<podIP>:<port><rest> and pipe the response back
   * (no buffering; forward+strip headers appropriately). Auth is whatever the
   * ingress already applied — NO extra per-conversation check (any authed user).
   * Failure modes:
   *   - unknown conversation / service      -> 404
   *   - pod suspended / unreachable / no IP -> 503 (friendly "service asleep")
   *   - service declared but unit not running -> a friendly 502 HTML page
   *     ("<service> isn't running — start it from the Services panel", with a
   *     link back to /?thread=<id>). NOT an auto-start (that's the lazy-start
   *     follow-up). renderNotStartedPage() below produces it.
   * TODO(impl).
   */
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void>;

  /**
   * Handle a WebSocket upgrade: same resolution as handleHttp, then splice the
   * client socket to a raw upstream connection to http://<podIP>:<port><rest>
   * with Upgrade/Connection headers intact (marimo kernel, VS Code RPC, xterm PTY).
   * On any resolution failure, write a 4xx/5xx handshake response and destroy the
   * socket.
   * TODO(impl).
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
}

/**
 * The friendly "service isn't running" page (HTTP 502) shown when a user opens a
 * declared-but-unstarted service before pressing Start. `threadId` links back to
 * the conversation UI. TODO(impl).
 */
export function renderNotStartedPage(_service: string, _threadId: string): string {
  throw new Error("NOT_IMPLEMENTED");
}

/**
 * Construct the proxy. Wired into agui/server.ts:
 *   - handle(): `if (proxy.matches(url.pathname)) return proxy.handleHttp(req,res);`
 *     placed just before the final 404.
 *   - listen(): `server.on("upgrade", (req, sock, head) => { if
 *     (proxy.matches(new URL(req.url,'http://x').pathname)) proxy.handleUpgrade(...);
 *     else sock.destroy(); });`
 * TODO(impl).
 */
export function createWebServiceProxy(_deps: WebServiceProxyDeps): WebServiceProxy {
  throw new Error("NOT_IMPLEMENTED");
}
