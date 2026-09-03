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
  /** Strip the `/c/<id>/<name>` prefix before forwarding, so the service serves at
   *  ROOT. For a service that can't be told its base path (code-server). Default
   *  false — most services handle the prefix themselves (marimo --base-url). */
  stripBasePath?: boolean;
}

/**
 * Reads a conversation's declared web services from the in-pod discovery manifest
 * (/run/scooter/web-services.json) via exec/download, and caches per conversation.
 * The cache expires (MANIFEST_TTL_MS) so a `scooter-rebuild` that declares a new
 * service is picked up; a start drops it immediately, and list({force}) re-reads
 * on demand.
 */
export interface WebServiceRegistry {
  /** Declared services. `force` re-reads the in-pod manifest instead of serving a
   *  cached read — for the UI's explicit refresh after the agent rebuilds. */
  list(conversationId: string, opts?: { force?: boolean }): Promise<WebServiceDescriptor[]>;
  get(conversationId: string, name: string): Promise<WebServiceDescriptor | null>;
  /** Liveness: `systemctl is-active webservice-<name>` via exec. */
  isRunning(conversationId: string, name: string): Promise<boolean>;
  /** Start the unit: `systemctl start webservice-<name>` via exec. Resolves once
   *  issued (not once healthy — readiness-gating is a follow-up). */
  start(conversationId: string, name: string): Promise<void>;
  /** Stop the unit: `systemctl stop webservice-<name>` via exec. */
  stop(conversationId: string, name: string): Promise<void>;
  /** The unit's recent journal (`journalctl -u webservice-<name> -n <lines>`) via
   *  exec — surfaced on the loading page so a service that fails to bind/crashes is
   *  debuggable. Returns "" if the pod is unreachable or the read fails. */
  logs(conversationId: string, name: string, lines?: number): Promise<string>;
  /** Is the sandbox pod actually READY (exec succeeds)? The conversation status can
   *  be "running" (Sandbox operatingMode Running) while the pod is still
   *  ContainerCreating — exec only succeeds once the pod is Ready, so a trivial exec
   *  probe distinguishes "requested" from "actually up". False when the pod is
   *  creating / asleep / unreachable. */
  ready(conversationId: string): Promise<boolean>;
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
 *  caller renders as an HTTP/handshake status. `notRunning` is distinct from a plain
 *  502: the service EXISTS but its unit is down (the auto-start + loading-page case),
 *  so it carries the ids needed to start it and render/poll the loading page. */
type Resolution =
  | { ok: true; conversationId: string; podIP: string; port: number; rest: string; stripBasePath: boolean; threadId: string; service: string }
  | { ok: false; kind: "notRunning"; conversationId: string; service: string; basePath: string; threadId: string }
  | { ok: false; kind: "error"; status: 404 | 503; service: string; threadId: string };

// (The old static "isn't running — go click Start" page is gone: a dead service now
// auto-starts behind a live loading page — see renderLoadingPage below.)

/** The sub-path (under /c/<id>/<service>/) the loading page polls for readiness +
 *  the unit's journal. A reserved segment — no real web service serves it. */
export const STATUS_SEGMENT = "__scooter_status";

const htmlEscape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));

/** Is this request a top-level browser NAVIGATION (wants HTML), vs an XHR/asset
 *  fetch (which must get its real bytes / a plain error, never an HTML page)? */
export function wantsHtml(accept: string | undefined): boolean {
  return (accept ?? "").includes("text/html");
}

/**
 * The loading page shown while a just-started service comes up. Self-refreshing:
 * it polls `<base>/__scooter_status` and, once `running`, reloads into the app —
 * meanwhile it streams the unit's recent journal below a spinner so a service that
 * fails to bind/crashes is debuggable in-place. `basePath` is the service's own
 * external prefix (…/c/<id>/<service>), so the poll + reload stay within it.
 */
export function renderLoadingPage(service: string, basePath: string): string {
  const safe = htmlEscape(service);
  const base = basePath.replace(/\/$/, "");
  const statusUrl = `${base}/${STATUS_SEGMENT}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Starting ${safe}…</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font-family:system-ui,sans-serif;max-width:44rem;margin:12vh auto;padding:0 1rem;color:#222}
 .row{display:flex;align-items:center;gap:.6rem}
 .spin{width:1.1rem;height:1.1rem;border:2px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:s .8s linear infinite}
 @keyframes s{to{transform:rotate(360deg)}}
 pre{background:#0b1020;color:#cbd5e1;padding:.75rem 1rem;border-radius:.5rem;overflow:auto;max-height:22rem;font-size:.8rem;line-height:1.35;white-space:pre-wrap}
 .muted{color:#64748b;font-size:.85rem}
</style></head><body>
<div class="row"><div class="spin"></div><h2 style="margin:0">Starting ${safe}…</h2></div>
<p class="muted">The service is coming up — this page will load it automatically. Recent log:</p>
<pre id="log">(waiting for output…)</pre>
<p class="muted">Unit: <code>webservice-${safe}</code></p>
<script>
 const STATUS = ${JSON.stringify(statusUrl)};
 const logEl = document.getElementById("log");
 async function tick() {
   try {
     const r = await fetch(STATUS, { cache: "no-store", headers: { accept: "application/json" } });
     const j = await r.json();
     if (j.logs && j.logs.trim()) logEl.textContent = j.logs;
     if (j.running) { location.reload(); return; }
   } catch (e) { /* transient (pod still coming up) — keep polling */ }
   setTimeout(tick, 1200);
 }
 tick();
</script>
</body></html>`;
}

export function createWebServiceProxy(deps: WebServiceProxyDeps): WebServiceProxy {
  const { sessions, resolvePodTarget, registry } = deps;

  const matches = (pathname: string): boolean => parseProxyPath(pathname) !== null;

  // Keep the conversation alive while a user is USING its web services: a live
  // vscode/marimo/terminal session is real activity, so the idle-suspend sweep must
  // not pull the pod out from under them. We mark the conversation active on proxy
  // traffic — throttled per conversation so a chatty WebSocket (terminal keystrokes,
  // marimo kernel) doesn't hammer the store; one touch per window is enough since the
  // idle threshold is minutes. (See SessionManager.touchById + sweepIdle.)
  const TOUCH_THROTTLE_MS = 15_000;
  const lastTouch = new Map<string, number>();
  const touch = (conversationId: string) => {
    const now = Date.now();
    if (now - (lastTouch.get(conversationId) ?? 0) < TOUCH_THROTTLE_MS) return;
    lastTouch.set(conversationId, now);
    sessions.touchById(conversationId as never);
  };

  async function resolve(pathname: string): Promise<Resolution | null> {
    const parsed = parseProxyPath(pathname);
    if (!parsed) return null;
    const { conversationId, service, rest } = parsed;

    // The URL id may be the full threadId (UI) or the short hash — try both.
    const conv = sessions.get(conversationId) ?? (await sessions.getByShortId(conversationId));
    const threadId = conv?.threadId ?? conversationId;
    if (!conv) return { ok: false, kind: "error", status: 404, service, threadId };

    const desc = await registry.get(conv.id, service);
    if (!desc) return { ok: false, kind: "error", status: 404, service, threadId };

    if (!(await registry.isRunning(conv.id, service))) {
      return { ok: false, kind: "notRunning", conversationId: conv.id, service, basePath: desc.basePath, threadId };
    }

    let target: PodTarget;
    try {
      target = await resolvePodTarget(conv.sandbox);
    } catch {
      // Pod suspended / not ready / no IP.
      return { ok: false, kind: "error", status: 503, service, threadId };
    }
    return { ok: true, conversationId: conv.id, podIP: target.podIP, port: desc.port, rest, stripBasePath: desc.stripBasePath ?? false, threadId, service };
  }

  /** The readiness/log endpoint the loading page polls: reports whether the unit is
   *  active yet + its recent journal. Returns true if it handled the request. */
  async function handleStatus(pathname: string, res: ServerResponse): Promise<boolean> {
    const parsed = parseProxyPath(pathname);
    if (!parsed || parsed.rest !== `/${STATUS_SEGMENT}`) return false;
    const conv = sessions.get(parsed.conversationId) ?? (await sessions.getByShortId(parsed.conversationId));
    if (!conv) {
      res.writeHead(404).end();
      return true;
    }
    const [running, logs] = await Promise.all([
      registry.isRunning(conv.id, parsed.service).catch(() => false),
      registry.logs(conv.id, parsed.service).catch(() => ""),
    ]);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
      .end(JSON.stringify({ running, logs }));
    return true;
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // The loading page's poll target — answer it before the normal resolve (which
    // would 502 while the unit is still down and never report readiness).
    if (await handleStatus(url.pathname, res)) return;

    const r = await resolve(url.pathname);
    if (!r) {
      res.writeHead(404).end();
      return;
    }
    if (!r.ok) {
      if (r.kind === "notRunning") {
        // The service exists but its unit is down (fresh conversation, or the pod was
        // recreated on resume). For a top-level NAVIGATION, kick off a start and hand
        // back a self-refreshing loading page (spinner + live journal) that reloads
        // into the app once healthy. For an XHR/asset fetch, a plain 502 — an HTML
        // page would corrupt it, and the navigation that spawned it already owns the UX.
        if (wantsHtml(req.headers.accept)) {
          // Best-effort start; the loading page polls readiness regardless of this result.
          await registry.start(r.conversationId, r.service).catch(() => {});
          const page = renderLoadingPage(r.service, r.basePath);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page);
        } else {
          res.writeHead(502, { "content-type": "text/plain" }).end(`${r.service} is not running`);
        }
      } else if (r.status === 503) {
        res.writeHead(503, { "content-type": "text/plain" })
          .end(`${r.service} is asleep — resume the conversation and try again.`);
      } else {
        res.writeHead(404).end();
      }
      return;
    }

    // Live web-service traffic counts as activity — keep the pod from idle-suspending.
    touch(r.conversationId);

    // Forward path: by default preserve the FULL external path so a sub-path-aware
    // service (marimo --base-url) sees the prefix it expects. When stripBasePath is
    // set (code-server, which can't be told a base path), forward only the REMAINDER
    // after /c/<id>/<service> so the service serves at root.
    const upstreamPath = (r.stripBasePath ? r.rest : url.pathname) + (url.search ?? "");
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
      // A WebSocket to a dead/unreachable service just fails — no loading-page UX for
      // an upgrade (the navigation that owns the page handles the auto-start).
      const status = !r ? 404 : r.kind === "notRunning" ? 502 : r.status;
      const text = status === 503 ? "service asleep" : status === 502 ? "service not running" : "not found";
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    // A live WebSocket (terminal PTY, marimo kernel, vscode RPC) is active use — mark
    // it on connect, then again on data (throttled) so ONGOING use keeps the pod alive
    // even across a run's worth of idle-sweep windows. (An open-but-silent socket only
    // holds it for one window; real interaction re-touches.)
    touch(r.conversationId);
    const conversationId = r.conversationId;

    // Splice: open a raw TCP connection to the pod, replay the upgrade handshake
    // (with the Host rewritten), forward the buffered head, then pipe both ways.
    // Same base-path handling as HTTP: strip the prefix for code-server (WS at root).
    const upstreamPath = (r.stripBasePath ? r.rest : url.pathname) + (url.search ?? "");
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
      // Frames in EITHER direction (client keystrokes, server output) = active use.
      const onData = () => touch(conversationId);
      socket.on("data", onData);
      upstream.on("data", onData);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const teardown = () => { socket.destroy(); upstream.destroy(); };
    upstream.on("error", teardown);
    socket.on("error", teardown);
  }

  return { matches, handleHttp, handleUpgrade };
}
