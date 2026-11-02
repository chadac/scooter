/**
 * Contract tests for the web-service reverse proxy. createWebServiceProxy is driven
 * over a real local http.Server standing in for the in-pod service (HTTP echo plus
 * a raw upgrade echo) and a fake WebServiceRegistry / resolvePodTarget.
 */

import { AddressInfo } from "node:net";
import { createServer, request, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWebServiceProxy,
  POD_TARGET_TTL_MS,
  parseProxyPath,
  renderLoadingPage,
  type PodTarget,
  type WebServiceDescriptor,
  type WebServiceProxy,
  type WebServiceRegistry,
} from "../../src/proxy/webServiceProxy.js";
import { createAccessCheck } from "../../src/session/access.js";

/** The identity headers the in-pod service received. */
interface IdentEcho {
  handoff: string | null;
  handoffEmail: string | null;
  ingress: string | null;
  oidcToken: string | null;
  cookie: string | null;
  accessToken: string | null;
}

function identEcho(headers: Record<string, unknown>): string {
  return JSON.stringify({
    handoff: headers["x-scooter-user"] ?? null,
    handoffEmail: headers["x-scooter-user-email"] ?? null,
    ingress: headers["x-auth-user"] ?? null,
    oidcToken: headers["x-amzn-oidc-accesstoken"] ?? null,
    cookie: headers["cookie"] ?? null,
    accessToken: headers["x-forwarded-access-token"] ?? null,
  });
}

/** What a hostile pod answers with on a path containing "set-cookie": an ingress session plus a cookie of its own. */
const POD_SET_COOKIES = ["_oauth2_proxy=attacker; Domain=.example.com; Path=/", "AWSELBAuthSessionCookie-0=x", "app=1; Path=/"];

// A fake in-pod service that echoes HTTP requests, raw bytes on an `upgrade`, and identity headers.
function fakeInPodService(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "text/plain",
          "x-echo-path": req.url ?? "",
          "x-echo-ident": identEcho(req.headers as Record<string, unknown>),
          ...(req.url?.includes("set-cookie") ? { "set-cookie": POD_SET_COOKIES } : {}),
        });
        res.end(`${req.method} ${req.url} ${body}`);
      });
    });
    server.on("upgrade", (req, socket, head) => {
      const cookies = req.url?.includes("set-cookie") ? POD_SET_COOKIES.map((c) => `Set-Cookie: ${c}\r\n`).join("") : "";
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${cookies}\r\n`,
      );
      socket.write(`IDENT ${identEcho(req.headers as Record<string, unknown>)}\n`);
      if (head?.length) socket.write(head);
      socket.on("data", (d) => socket.write(d));
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    );
  });
}

/** Refuses connections: the unit is down, as forwarding sees it. */
const DEAD_PORT = 1;

const MARIMO: WebServiceDescriptor = {
  name: "marimo",
  displayName: "marimo",
  port: 0,
  basePath: "/c/conv-1/marimo",
  unit: "webservice-marimo",
};

function fakeRegistry(
  port: number,
  opts: { running?: boolean } = {},
): WebServiceRegistry & { execs: number; invalidated: string[] } {
  const running = opts.running ?? true;
  const desc = { ...MARIMO, port };
  const state = { execs: 0, invalidated: [] as string[] };
  return {
    get execs() { return state.execs; },
    invalidated: state.invalidated,
    list: async () => [desc],
    get: async (_id, name) => (name === "marimo" ? desc : null),
    // Standing in for `systemctl is-active`, which is a pod exec.
    isRunning: async () => { state.execs++; return running; },
    start: async () => {},
    stop: async () => {},
    logs: async () => "",
    ready: async () => true,
    invalidate: (id: string) => { state.invalidated.push(id); },
  };
}

/** A registry that flips to running after N isRunning() calls, records start() calls and serves a canned log tail. */
function startingRegistry(
  port: number,
  opts: { runningAfter?: number; logs?: string } = {},
): WebServiceRegistry & { starts: string[]; invalidated: string[] } {
  const desc = { ...MARIMO, port };
  const runningAfter = opts.runningAfter ?? 1;
  let calls = 0;
  const starts: string[] = [];
  const invalidated: string[] = [];
  return {
    starts,
    invalidated,
    list: async () => [desc],
    get: async (_id, name) => (name === "marimo" ? desc : null),
    isRunning: async () => ++calls > runningAfter,
    start: async (_id, name) => { starts.push(name); },
    stop: async () => {},
    logs: async () => opts.logs ?? "starting marimo…",
    ready: async () => true,
    invalidate: (id: string) => { invalidated.push(id); },
  };
}

describe("web-service proxy", () => {
  let svc: { server: Server; port: number };

  beforeEach(async () => {
    svc = await fakeInPodService();
  });
  afterEach(() => {
    svc.server.close();
  });

  // --- path parsing / matching ------------------------------------------------

  it("parseProxyPath splits /c/<id>/<service>/<rest>", () => {
    expect(parseProxyPath("/c/conv-1/marimo/foo/bar")).toEqual({
      conversationId: "conv-1",
      service: "marimo",
      rest: "/foo/bar",
    });
    expect(parseProxyPath("/c/conv-1/marimo")).toMatchObject({ service: "marimo", rest: "/" });
    // /c/<id> alone is the UI deep-link space.
    expect(parseProxyPath("/c/conv-1")).toBeNull();
    expect(parseProxyPath("/conversations/conv-1")).toBeNull();
  });

  /** No ingress identity: single-user mode. */
  const ANON = { id: "anonymous", anonymous: true };

  function makeProxy(
    registry: WebServiceRegistry,
    target?: Partial<PodTarget>,
    touchById: (id: string) => void = () => {},
    opts: {
      /** The conversation's owner, undefined = unowned. */
      owner?: string;
      /** The caller the resolver reports, or a throwing resolver via `resolveUser`. */
      user?: { id: string; email?: string; anonymous: boolean };
      resolveUser?: () => never;
    } = {},
  ): WebServiceProxy {
    const resolvePodTarget = async () => ({
      name: "conv-1-pod",
      podIP: "127.0.0.1",
      ...target,
    });
    return createWebServiceProxy({
      sessions: {
        get: () => ({ id: "conv-1", threadId: "conv-1", owner: opts.owner }),
        touchById,
      } as never,
      resolvePodTarget: resolvePodTarget as never,
      registry,
      publicHost: "scooter.example.com",
      resolveUser: opts.resolveUser ?? (() => opts.user ?? ANON),
    });
  }

  it("matches() only claims /c/<id>/<service>/... paths", () => {
    const proxy = makeProxy(fakeRegistry(svc.port));
    expect(proxy.matches("/c/conv-1/marimo/x")).toBe(true);
    expect(proxy.matches("/c/conv-1")).toBe(false);
    expect(proxy.matches("/agui")).toBe(false);
  });

  // --- HTTP proxying ----------------------------------------------------------

  it("handleHttp pipes the request into the pod and streams the response back", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port));
    const { status, body, echoPath } = await proxyGet(proxy, "/c/conv-1/marimo/app?x=1");
    expect(status).toBe(200);
    // Without stripBasePath the full prefixed path reaches the pod.
    expect(echoPath).toBe("/c/conv-1/marimo/app?x=1");
    expect(body).toContain("GET");
  });

  it("marks the conversation active (touchById) on a proxied request — keeps the pod alive", async () => {
    const touched: string[] = [];
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, (id) => touched.push(id));
    await proxyGet(proxy, "/c/conv-1/marimo/app");
    expect(touched).toContain("conv-1");
  });

  it("does NOT touch when the pod is unreachable (503 — nothing to keep alive)", async () => {
    const touched: string[] = [];
    const proxy = createWebServiceProxy({
      sessions: { get: () => ({ id: "conv-1", threadId: "conv-1" }), touchById: (id: string) => touched.push(id) } as never,
      resolvePodTarget: (async () => { throw new Error("no ready pod"); }) as never,
      registry: fakeRegistry(svc.port),
      publicHost: "scooter.example.com",
      resolveUser: () => ANON,
    });
    const { status } = await proxyGet(proxy, "/c/conv-1/marimo/x");
    expect(status).toBe(503);
    expect(touched).toEqual([]);
  });

  it("stripBasePath forwards only the remainder (service serves at root — code-server)", async () => {
    const desc = { ...MARIMO, port: svc.port, stripBasePath: true };
    const registry = {
      ...fakeRegistry(svc.port),
      list: async () => [desc],
      get: async (_id: string, name: string) => (name === "marimo" ? desc : null),
    } as WebServiceRegistry;
    const proxy = makeProxy(registry);
    const { status, echoPath } = await proxyGet(proxy, "/c/conv-1/marimo/app?x=1");
    expect(status).toBe(200);
    expect(echoPath).toBe("/app?x=1");
  });

  // --- sandbox hosts (<label>.<sandbox domain>/<service>/) --------------------

  describe("sandbox hosts", () => {
    const ID = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff";
    const HOST = { "x-scooter-sandbox-host": "5a515e73" };

    function sandboxProxy(registry: WebServiceRegistry, sandboxDomain: string | undefined = "scooter.example.com") {
      return createWebServiceProxy({
        sessions: {
          get: (id: string) => (id === ID ? { id: ID, threadId: ID } : undefined),
          getBySandboxKey: async () => undefined,
          ensureReadable: async () => false,
          touchById: () => {},
        } as never,
        resolvePodTarget: (async () => ({ name: "pod", podIP: "127.0.0.1" })) as never,
        registry,
        publicHost: "scooter.example.com",
        resolveUser: () => ANON,
        sandboxDomain,
      });
    }

    it("forwards the browser-visible /<service>/... path, not the router's /c/<id> prefix", async () => {
      const { status, echoPath } = await proxyGet(sandboxProxy(fakeRegistry(svc.port)), `/c/${ID}/marimo/app%2Fx?x=1`, { headers: HOST });
      expect(status).toBe(200);
      expect(echoPath).toBe("/marimo/app%2Fx?x=1");
    });

    it("does not pass the routing header on to the pod", async () => {
      const seen: Record<string, unknown>[] = [];
      const pod = createServer((req, res) => { seen.push(req.headers); res.end("ok"); });
      await new Promise<void>((r) => pod.listen(0, "127.0.0.1", () => r()));
      try {
        await proxyGet(sandboxProxy(fakeRegistry((pod.address() as AddressInfo).port)), `/c/${ID}/marimo/`, { headers: HOST });
        expect(seen[0]?.["x-scooter-sandbox-host"]).toBeUndefined();
      } finally {
        pod.close();
      }
    });

    // code-server's WebSocket origin check compares Origin with the forwarded host, so
    // the pod must learn the browser-facing host now that Host is its own address.
    const SANDBOX_HOST = "5a515e73.scooter.example.com";
    async function podSeeing(fn: (port: number, seen: Record<string, unknown>[]) => Promise<void>) {
      const seen: Record<string, unknown>[] = [];
      const pod = createServer((req, res) => { seen.push(req.headers); res.end("ok"); });
      pod.on("upgrade", (req, socket) => {
        seen.push(req.headers);
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        socket.on("data", (d) => socket.write(d));
      });
      await new Promise<void>((r) => pod.listen(0, "127.0.0.1", () => r()));
      try {
        await fn((pod.address() as AddressInfo).port, seen);
      } finally {
        pod.close();
      }
    }

    it("forwards the browser-facing host as x-forwarded-host, overriding a client's (HTTP)", async () => {
      await podSeeing(async (port, seen) => {
        await proxyGet(sandboxProxy(fakeRegistry(port)), `/c/${ID}/marimo/`, {
          headers: { ...HOST, host: SANDBOX_HOST, "x-forwarded-host": "evil.example.org" },
        });
        expect(seen[0]?.["x-forwarded-host"]).toBe(SANDBOX_HOST);
        expect(seen[0]?.host).toBe(`127.0.0.1:${port}`);
      });
    });

    it("forwards the browser-facing host as x-forwarded-host on the UPGRADE handshake", async () => {
      await podSeeing(async (port, seen) => {
        const { statusLine } = await proxyUpgrade(sandboxProxy(fakeRegistry(port)), `/c/${ID}/marimo/ws`, "ping", { headers: HOST });
        expect(statusLine).toContain("101");
        // proxyUpgrade's handshake sends Host: x.
        expect(seen[0]?.["x-forwarded-host"]).toBe("x");
        expect(seen[0]?.host).toBe(`127.0.0.1:${port}`);
      });
    });

    it("stripBasePath still forwards only the remainder", async () => {
      const desc = { ...MARIMO, port: svc.port, stripBasePath: true };
      const registry = { ...fakeRegistry(svc.port), get: async (_id: string, n: string) => (n === "marimo" ? desc : null) } as WebServiceRegistry;
      const { echoPath } = await proxyGet(sandboxProxy(registry), `/c/${ID}/marimo/app?x=1`, { headers: HOST });
      expect(echoPath).toBe("/app?x=1");
    });

    it("the loading page polls the short base path", async () => {
      const { body } = await proxyGet(sandboxProxy(startingRegistry(DEAD_PORT)), `/c/${ID}/marimo/`, { headers: HOST, accept: "text/html" });
      expect(body).toContain("/marimo/__scooter_status");
      expect(body).not.toContain(`/c/${ID}`);
    });

    it("with sandbox hosts on, the main host serves no services", async () => {
      const { status, body } = await proxyGet(sandboxProxy(fakeRegistry(svc.port)), `/c/${ID}/marimo/app`, { method: "POST" });
      expect(status).toBe(404);
      // Non-empty, so a browser navigation renders it rather than its own error page.
      expect(body).toBe("not found\n");
      const status2 = await proxyGet(sandboxProxy(fakeRegistry(svc.port)), `/c/${ID}/marimo/__scooter_status`);
      expect(status2.status).toBe(404);
    });

    it("an old main-host link redirects to the conversation's host, path and query intact", async () => {
      const { status, location, echoPath } = await proxyGet(sandboxProxy(fakeRegistry(svc.port)), `/c/${ID}/marimo/app/x?file=a.py`);
      expect(status).toBe(302);
      expect(location).toBe("https://5a515e73.scooter.example.com/marimo/app/x?file=a.py");
      expect(echoPath).toBe(""); // nothing reached the pod
      const bare = await proxyGet(sandboxProxy(fakeRegistry(svc.port)), `/c/${ID}/marimo`);
      expect(bare.location).toBe("https://5a515e73.scooter.example.com/marimo/");
    });

    it("an old link to an unknown conversation is a 404, not a redirect", async () => {
      const { status, location } = await proxyGet(sandboxProxy(fakeRegistry(svc.port)), `/c/ffffffff-0000-0000-0000-000000000000/marimo/`);
      expect(status).toBe(404);
      expect(location).toBe("");
    });

    it("with sandbox hosts off, a host-routed request is refused", async () => {
      const { status } = await proxyGet(sandboxProxy(fakeRegistry(svc.port), ""), `/c/${ID}/marimo/app`, { headers: HOST });
      expect(status).toBe(404);
    });

    it("a label that is not the conversation's prefix is refused", async () => {
      const { status } = await proxyGet(sandboxProxy(fakeRegistry(svc.port)), `/c/${ID}/marimo/app`, { headers: { "x-scooter-sandbox-host": "deadbeef" } });
      expect(status).toBe(404);
    });

    // --- the router's direct path: GET /internal/web-services/target ---------------

    const target = (q: string, headers: Record<string, string> = {}) =>
      proxyGet(sandboxProxyAs(fakeRegistry(svc.port)), `/internal/web-services/target?${q}`, { headers });

    function sandboxProxyAs(registry: WebServiceRegistry, opts: { user?: { id: string; email?: string; anonymous: boolean }; touched?: string[]; podDown?: boolean; sandboxDomain?: string; conv?: { status?: string; parentId?: string } } = {}) {
      return createWebServiceProxy({
        sessions: { get: () => ({ id: ID, threadId: ID, ...opts.conv }), touchById: (id: string) => opts.touched?.push(id) } as never,
        resolvePodTarget: (async () => {
          if (opts.podDown) throw new Error("no ready pod");
          return { name: "pod", podIP: "127.0.0.1" };
        }) as never,
        registry,
        publicHost: "scooter.example.com",
        resolveUser: () => opts.user ?? ANON,
        sandboxDomain: opts.sandboxDomain ?? "scooter.example.com",
      });
    }

    it("target: answers the pod address, port, caller and what to strip", async () => {
      const touched: string[] = [];
      const proxy = sandboxProxyAs(fakeRegistry(svc.port), { user: { id: "alice", email: "a@x", anonymous: false }, touched });
      const { status, body } = await proxyGet(proxy, `/internal/web-services/target?conversation=${ID}&service=marimo&label=5a515e73`);
      expect(status).toBe(200);
      const t = JSON.parse(body);
      expect(t).toMatchObject({ conversationId: ID, podIP: "127.0.0.1", port: svc.port, stripBasePath: false, user: { id: "alice", email: "a@x" } });
      expect(t.dropHeaders).toEqual(expect.arrayContaining(["x-scooter-user", "x-amzn-oidc-accesstoken"]));
      expect(t.sessionCookies).toEqual(expect.arrayContaining(["_oauth2_proxy"]));
      expect(t.ttlMs).toBeGreaterThan(0);
      // Asking for the target is the router's sign of live traffic.
      expect(touched).toContain(ID);
    });

    it("target: anonymous callers carry no user", async () => {
      const { body } = await target(`conversation=${ID}&service=marimo&label=5a515e73`);
      expect(JSON.parse(body).user).toBeUndefined();
    });

    it("target: a pod that is down is 503, so the router sends the request here to wake it", async () => {
      const proxy = sandboxProxyAs(fakeRegistry(svc.port), { podDown: true });
      const { status, body } = await proxyGet(proxy, `/internal/web-services/target?conversation=${ID}&service=marimo&label=5a515e73`);
      expect(status).toBe(503);
      expect(JSON.parse(body).reason).toBe("asleep");
    });

    it("target: a suspended conversation is asleep even while its old pod still answers", async () => {
      const proxy = sandboxProxyAs(fakeRegistry(svc.port), { conv: { status: "suspended" } });
      const { status, body } = await proxyGet(proxy, `/internal/web-services/target?conversation=${ID}&service=marimo&label=5a515e73`);
      expect(status).toBe(503);
      expect(JSON.parse(body).reason).toBe("asleep");
    });

    it("target: a suspended subagent still answers, since the pod is its parent's", async () => {
      const proxy = sandboxProxyAs(fakeRegistry(svc.port), { conv: { status: "suspended", parentId: "parent-1" } });
      const { status } = await proxyGet(proxy, `/internal/web-services/target?conversation=${ID}&service=marimo&label=5a515e73`);
      expect(status).toBe(200);
    });

    it("target: refuses a wrong label, an unknown service, a missing label and sandbox hosts off", async () => {
      expect((await target(`conversation=${ID}&service=marimo&label=deadbeef`)).status).toBe(404);
      expect((await target(`conversation=${ID}&service=nope&label=5a515e73`)).status).toBe(404);
      expect((await target(`conversation=${ID}&service=marimo`)).status).toBe(404);
      const off = sandboxProxyAs(fakeRegistry(svc.port), { sandboxDomain: "" });
      expect((await proxyGet(off, `/internal/web-services/target?conversation=${ID}&service=marimo&label=5a515e73`)).status).toBe(404);
    });

    it("touch: marks the conversation active", async () => {
      const touched: string[] = [];
      const proxy = sandboxProxyAs(fakeRegistry(svc.port), { touched });
      const status = await new Promise<number>((resolve, reject) => {
        void withFront(proxy, (port) => new Promise<void>((done) => {
          const req = request({ host: "127.0.0.1", port, path: `/internal/web-services/touch?conversation=${ID}`, method: "POST" }, (res) => {
            res.resume();
            res.on("end", () => { resolve(res.statusCode ?? 0); done(); });
          });
          req.on("error", reject);
          req.end();
        })).catch(reject);
      });
      expect(status).toBe(202);
      expect(touched).toContain(ID);
    });

    it("WebSockets forward the short path", async () => {
      const { statusLine } = await proxyUpgrade(sandboxProxy(fakeRegistry(svc.port)), `/c/${ID}/marimo/ws`, "ping", { headers: HOST });
      expect(statusLine).toContain("101");
    });
  });

  it("unknown service -> 404", async () => {
    const proxy = makeProxy({
      ...fakeRegistry(svc.port),
      get: async () => null,
    });
    const { status } = await proxyGet(proxy, "/c/conv-1/nope/x");
    expect(status).toBe(404);
  });

  it("suspended / unreachable pod -> 503", async () => {
    const proxy = createWebServiceProxy({
      sessions: { get: () => ({ id: "conv-1", threadId: "conv-1" }), touchById: () => {} } as never,
      resolvePodTarget: (async () => {
        throw new Error("no ready pod");
      }) as never,
      registry: fakeRegistry(svc.port),
      publicHost: "scooter.example.com",
      resolveUser: () => ANON,
    });
    const { status } = await proxyGet(proxy, "/c/conv-1/marimo/x");
    expect(status).toBe(503);
  });

  it("declared-but-not-running HTML nav -> auto-starts + serves a loading page (200)", async () => {
    const registry = startingRegistry(DEAD_PORT, { runningAfter: 99 });
    const proxy = makeProxy(registry);
    const { status, body } = await proxyGet(proxy, "/c/conv-1/marimo/", {
      accept: "text/html",
    });
    expect(status).toBe(200);
    expect(registry.starts).toContain("marimo");
    expect(body.toLowerCase()).toContain("starting");
    // The page polls the status endpoint.
    expect(body).toContain("__scooter_status");
  });

  it("the status endpoint reports running + a journalctl tail (loading page polls it)", async () => {
    const registry = startingRegistry(svc.port, {
      runningAfter: 99,
      logs: "marimo edit --host 0.0.0.0\nRunning on http://0.0.0.0:2718",
    });
    const proxy = makeProxy(registry);
    const { status, body } = await proxyGet(proxy, "/c/conv-1/marimo/__scooter_status");
    expect(status).toBe(200);
    const j = JSON.parse(body);
    expect(j.running).toBe(false);
    expect(j.logs).toContain("Running on http://0.0.0.0:2718");
  });

  it("a NON-HTML request to a dead service still gets a 502 (no HTML for an XHR/asset)", async () => {
    // An HTML loading page would corrupt an asset or XHR fetch.
    const proxy = makeProxy(startingRegistry(DEAD_PORT, { runningAfter: 99 }));
    const { status } = await proxyGet(proxy, "/c/conv-1/marimo/assets/app.js", {
      accept: "*/*",
    });
    expect(status).toBe(502);
  });

  it("once the service is up, the loading page's status endpoint reports running", async () => {
    const registry = startingRegistry(svc.port, { runningAfter: 0 });
    const proxy = makeProxy(registry);
    const { body } = await proxyGet(proxy, "/c/conv-1/marimo/__scooter_status");
    expect(JSON.parse(body).running).toBe(true);
  });

  it("forwards without asking the pod whether the unit is up (no exec on the hot path)", async () => {
    // `systemctl is-active` is a pod exec -- an API-server round trip, a stream
    // upgrade and a process spawn, measured at ~0.7s against a sandbox. It used to be
    // paid before every forward, including every forward that then worked.
    const registry = fakeRegistry(svc.port);
    const proxy = makeProxy(registry);
    for (let i = 0; i < 3; i++) {
      const { status } = await proxyGet(proxy, `/c/conv-1/marimo/app?n=${i}`);
      expect(status).toBe(200);
    }
    expect(registry.execs).toBe(0);
  });

  it("a refused connection is the liveness check: loading page, auto-start, cache dropped", async () => {
    // The registry says the unit is up and the port says otherwise. The port wins,
    // because it is the one that was asked at the moment of use.
    const registry = fakeRegistry(DEAD_PORT, { running: true });
    const proxy = makeProxy(registry);
    const { status, body } = await proxyGet(proxy, "/c/conv-1/marimo/", { accept: "text/html" });
    expect(status).toBe(200);
    expect(body.toLowerCase()).toContain("starting");
    expect(registry.invalidated).toContain("conv-1");
  });

  it("a refused connection on an XHR still gets a 502, not a loading page", async () => {
    const registry = fakeRegistry(DEAD_PORT, { running: true });
    const proxy = makeProxy(registry);
    const { status, body } = await proxyGet(proxy, "/c/conv-1/marimo/api/x", { accept: "*/*" });
    expect(status).toBe(502);
    expect(body).not.toContain("<html");
  });

  it("the status endpoint still asks, since its answer is the product", async () => {
    const registry = fakeRegistry(svc.port);
    const proxy = makeProxy(registry);
    await proxyGet(proxy, "/c/conv-1/marimo/__scooter_status");
    expect(registry.execs).toBeGreaterThan(0);
  });

  it("an active unit whose port is not listening yet is not reported running", async () => {
    // systemd says active the moment the unit starts; reloading then would hit a refused
    // connection and land back on a fresh loading page, over and over.
    const notYet = await proxyGet(makeProxy(fakeRegistry(DEAD_PORT)), "/c/conv-1/marimo/__scooter_status");
    expect(JSON.parse(notYet.body)).toMatchObject({ running: false, phase: "service" });
    const up = await proxyGet(makeProxy(fakeRegistry(svc.port)), "/c/conv-1/marimo/__scooter_status");
    expect(JSON.parse(up.body)).toMatchObject({ running: true });
  });

  it("the loading page auto-tails the log rather than resetting it", () => {
    const page = renderLoadingPage("marimo", "/c/conv-1/marimo");
    expect(page).toContain("logEl.scrollTop = logEl.scrollHeight");
    expect(page).toContain("!shown && j.phase");
  });

  it("the loading page polls the path the browser used, not the manifest's unexpanded basePath", async () => {
    // web-services.nix renders basePath as the literal "/c/${CONVERSATION_ID}/<name>".
    const registry = startingRegistry(DEAD_PORT, { runningAfter: 99 });
    const raw = { ...registry, get: async (id: string, name: string) => {
      const d = await registry.get(id, name);
      return d && { ...d, basePath: "/c/${CONVERSATION_ID}/marimo" };
    } } as WebServiceRegistry;
    const { body } = await proxyGet(makeProxy(raw), "/c/conv-1/marimo/?path=a.md", { accept: "text/html" });
    expect(body).toContain('"/c/conv-1/marimo/__scooter_status"');
    expect(body).not.toContain("CONVERSATION_ID");
  });

  it("a navigation to an asleep sandbox wakes it and serves the loading page", async () => {
    const woken: string[] = [];
    const proxy = createWebServiceProxy({
      sessions: { get: () => ({ id: "conv-1", threadId: "conv-1" }), touchById: () => {} } as never,
      resolvePodTarget: (async () => ({ name: "p", podIP: "127.0.0.1" })) as never,
      // The pod is down: the manifest cannot be read and the exec channel is not live.
      registry: { ...fakeRegistry(svc.port), get: async () => null, ready: async () => false },
      publicHost: "scooter.example.com",
      wake: async (id) => { woken.push(id); },
    });
    const { status, body } = await proxyGet(proxy, "/c/conv-1/marimo/", { accept: "text/html" });
    expect(status).toBe(200);
    expect(body).toContain("__scooter_status");
    expect(woken).toEqual(["conv-1"]);
    // An XHR to the same asleep service still gets the 503.
    expect((await proxyGet(proxy, "/c/conv-1/marimo/api/x", { accept: "*/*" })).status).toBe(503);
  });

  it("the status poll wakes a down sandbox, then starts the unit once the pod is ready", async () => {
    let podReady = false;
    const woken: string[] = [];
    const registry = startingRegistry(svc.port, { runningAfter: 99 });
    const proxy = createWebServiceProxy({
      sessions: { get: () => ({ id: "conv-1", threadId: "conv-1" }), touchById: () => {} } as never,
      resolvePodTarget: (async () => ({ name: "p", podIP: "127.0.0.1" })) as never,
      registry: { ...registry, ready: async () => podReady },
      publicHost: "scooter.example.com",
      wake: async (id) => { woken.push(id); },
    });
    const first = JSON.parse((await proxyGet(proxy, "/c/conv-1/marimo/__scooter_status")).body);
    expect(first).toMatchObject({ running: false, phase: "sandbox" });
    expect(woken).toEqual(["conv-1"]);
    expect(registry.starts).toEqual([]);

    podReady = true;
    const second = JSON.parse((await proxyGet(proxy, "/c/conv-1/marimo/__scooter_status")).body);
    expect(second).toMatchObject({ running: false, phase: "service" });
    expect(registry.starts).toEqual(["marimo"]);
    // Throttled: the next poll inside the window does not re-issue the start.
    await proxyGet(proxy, "/c/conv-1/marimo/__scooter_status");
    expect(registry.starts).toEqual(["marimo"]);
  });

  it("a suspended sandbox with no pod wakes without waiting on a pod exec", async () => {
    const woken: string[] = [];
    // With no pod, an exec waits for one to become ready.
    const hang = () => new Promise<never>(() => {});
    const proxy = createWebServiceProxy({
      sessions: { get: () => ({ id: "conv-1", threadId: "conv-1", status: "suspended" }), touchById: () => {} } as never,
      resolvePodTarget: hang as never,
      registry: { ...fakeRegistry(svc.port), get: hang, ready: hang },
      publicHost: "scooter.example.com",
      wake: async (id) => { woken.push(id); },
    });
    const nav = await proxyGet(proxy, "/c/conv-1/marimo/", { accept: "text/html" });
    expect(nav.status).toBe(200);
    expect(nav.body).toContain("__scooter_status");
    const poll = JSON.parse((await proxyGet(proxy, "/c/conv-1/marimo/__scooter_status")).body);
    expect(poll).toMatchObject({ running: false, phase: "sandbox" });
    expect(woken).toEqual(["conv-1"]);
  });

  it("a full conversation id this pod has not loaded is hydrated, not 404'd", async () => {
    let loaded = false;
    const proxy = createWebServiceProxy({
      sessions: {
        get: () => (loaded ? { id: "conv-1", threadId: "conv-1" } : undefined),
        getBySandboxKey: async () => undefined,
        ensureReadable: async () => { loaded = true; return true; },
        touchById: () => {},
      } as never,
      resolvePodTarget: (async () => ({ name: "p", podIP: "127.0.0.1" })) as never,
      registry: fakeRegistry(svc.port),
      publicHost: "scooter.example.com",
    });
    expect((await proxyGet(proxy, "/c/conv-1/marimo/app")).status).toBe(200);
  });

  // --- WebSocket upgrade ------------------------------------------------------

  it("handleUpgrade splices an upgrade and echoes bytes both ways", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port));
    const { statusLine, echoed } = await proxyUpgrade(proxy, "/c/conv-1/marimo/ws", "ping");
    expect(statusLine).toContain("101");
    expect(echoed).toContain("ping");
  });

  // --- access: shared by default (#798) -----------------------------------------

  const ALICE = { id: "alice", email: "alice@example.com", anonymous: false };
  const BOB = { id: "bob", email: "bob@example.com", anonymous: false };

  it("another signed-in user reaches the service, and the service is told it is them", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, undefined, { owner: "alice", user: BOB });
    const { status, ident } = await proxyGet(proxy, "/c/conv-1/marimo/app");
    expect(status).toBe(200);
    expect(ident).toMatchObject({ handoff: "bob", handoffEmail: "bob@example.com" });
  });

  it("another signed-in user's WebSocket upgrade is spliced through too", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, undefined, { owner: "alice", user: BOB });
    const { statusLine, echoed } = await proxyUpgrade(proxy, "/c/conv-1/marimo/ws", "ping");
    expect(statusLine).toContain("101");
    expect(echoed).toContain("ping");
  });

  it("resolves a repeat caller's identity once, not per request", async () => {
    let calls = 0;
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, undefined, {
      resolveUser: (() => { calls++; return BOB; }) as never,
    });
    const headers = { "x-auth-user": "bob" };
    await proxyGet(proxy, "/c/conv-1/marimo/a.js", { headers });
    const { ident } = await proxyGet(proxy, "/c/conv-1/marimo/b.js", { headers });
    expect(calls).toBe(1);
    expect(ident).toMatchObject({ handoff: "bob" });
  });

  it("a FAILING resolver still serves, handing off nobody rather than a guess", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, undefined, {
      owner: "alice",
      resolveUser: () => { throw new Error("identity store down"); },
    });
    const { status, ident } = await proxyGet(proxy, "/c/conv-1/marimo/app", {
      headers: { "x-scooter-user": "root" },
    });
    expect(status).toBe(200);
    // The forged inbound copy is still stripped.
    expect(ident).toMatchObject({ handoff: null });
  });

  // --- identity handoff -------------------------------------------------------

  it("strips the ingress's identity headers and stamps its own (HTTP)", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, undefined, { owner: "alice", user: ALICE });
    const { ident } = await proxyGet(proxy, "/c/conv-1/marimo/app", {
      headers: {
        "x-auth-user": "alice",
        "x-amzn-oidc-accesstoken": "a-real-bearer-token",
        "x-scooter-user": "root",
      },
    });
    expect(ident).toEqual({
      handoff: "alice",
      handoffEmail: "alice@example.com",
      ingress: null,
      oidcToken: null,
      cookie: null,
      accessToken: null,
    });
  });

  it("strips and stamps on the UPGRADE handshake as well", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, undefined, { owner: "alice", user: ALICE });
    const { raw } = await proxyUpgrade(proxy, "/c/conv-1/marimo/ws", "ping", {
      headers: { "x-scooter-user": "root", "x-auth-user": "alice" },
    });
    const ident = JSON.parse(raw.slice(raw.indexOf("IDENT ") + 6, raw.indexOf("\n", raw.indexOf("IDENT "))));
    expect(ident.handoff).toBe("alice");
    expect(ident.ingress).toBeNull();
  });

  // --- ingress session cookies -------------------------------------------------

  const SESSION_COOKIES =
    "_oauth2_proxy=sess; theme=dark; _oauth2_proxy_csrf=c; _oauth2_proxy_1=part; AWSELBAuthSessionCookie-0=alb; marimo_ui=1";

  it("keeps the ingress session cookies out of the pod and forwards the service's own (HTTP)", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, undefined, { owner: "alice", user: ALICE });
    const { ident } = await proxyGet(proxy, "/c/conv-1/marimo/app", {
      headers: { cookie: SESSION_COOKIES, "x-forwarded-access-token": "gho_provider_token" },
    });
    expect(ident).toMatchObject({ cookie: "theme=dark; marimo_ui=1", accessToken: null });
  });

  it("drops the Cookie header entirely when only session cookies were sent", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, undefined, { owner: "alice", user: ALICE });
    const { ident } = await proxyGet(proxy, "/c/conv-1/marimo/app", { headers: { cookie: "_oauth2_proxy=sess" } });
    expect(ident).toMatchObject({ cookie: null });
  });

  it("keeps the ingress session cookies out of the UPGRADE handshake too", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, undefined, { owner: "alice", user: ALICE });
    const { raw } = await proxyUpgrade(proxy, "/c/conv-1/marimo/ws", "ping", { headers: { cookie: SESSION_COOKIES } });
    const ident = JSON.parse(raw.slice(raw.indexOf("IDENT ") + 6, raw.indexOf("\n", raw.indexOf("IDENT "))));
    expect(ident.cookie).toBe("theme=dark; marimo_ui=1");
  });

  it("a pod cannot set the ingress session cookie (HTTP response)", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, undefined, { owner: "alice", user: ALICE });
    const { status, setCookie } = await proxyGet(proxy, "/c/conv-1/marimo/set-cookie");
    expect(status).toBe(200);
    expect(setCookie).toEqual(["app=1; Path=/"]);
  });

  it("a pod cannot set the ingress session cookie (UPGRADE response)", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, undefined, { owner: "alice", user: ALICE });
    const { statusLine, echoed, raw } = await proxyUpgrade(proxy, "/c/conv-1/marimo/set-cookie/ws", "ping");
    expect(statusLine).toContain("101");
    expect(echoed).toBe("ping"); // frames after the filtered handshake still flow
    const handshake = raw.slice(0, raw.indexOf("\r\n\r\n"));
    expect(handshake).toContain("Set-Cookie: app=1; Path=/");
    expect(handshake).not.toMatch(/_oauth2_proxy|AWSELBAuthSessionCookie/);
  });

  it("an anonymous caller hands off NO identity (not the string \"anonymous\")", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, undefined, { user: ANON });
    const { ident } = await proxyGet(proxy, "/c/conv-1/marimo/app");
    expect(ident).toMatchObject({ handoff: null, handoffEmail: null });
  });

  // --- pod address cache --------------------------------------------------------

  /** A proxy whose resolver counts lookups and answers from `ips` in turn (the last one repeats). */
  function countingProxy(
    registry: WebServiceRegistry,
    conv: { status?: string } = {},
    ips: string[] = ["127.0.0.1"],
    gate?: Promise<void>,
  ): { proxy: WebServiceProxy; lookups: () => number } {
    let n = 0;
    const proxy = createWebServiceProxy({
      sessions: { get: () => ({ id: "conv-1", threadId: "conv-1", ...conv }), touchById: () => {} } as never,
      resolvePodTarget: (async () => {
        const ip = ips[Math.min(n, ips.length - 1)];
        n++;
        if (gate) await gate;
        return { name: "conv-1-pod", podIP: ip };
      }) as never,
      registry,
      publicHost: "scooter.example.com",
      resolveUser: () => ANON,
    });
    return { proxy, lookups: () => n };
  }

  it("looks the pod up once, not per request", async () => {
    const { proxy, lookups } = countingProxy(fakeRegistry(svc.port));
    for (let i = 0; i < 4; i++) {
      expect((await proxyGet(proxy, `/c/conv-1/marimo/a?n=${i}`)).status).toBe(200);
    }
    expect(lookups()).toBe(1);
  });

  it("concurrent requests share one in-flight lookup (a page load fans out)", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { proxy, lookups } = countingProxy(fakeRegistry(svc.port), {}, ["127.0.0.1"], gate);
    const all = Promise.all([1, 2, 3, 4].map((i) => proxyGet(proxy, `/c/conv-1/marimo/a?n=${i}`)));
    setTimeout(open, 20);
    expect((await all).map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(lookups()).toBe(1);
  });

  it("looks again once the cached address expires", async () => {
    const { proxy, lookups } = countingProxy(fakeRegistry(svc.port));
    const realNow = Date.now;
    let offset = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    try {
      await proxyGet(proxy, "/c/conv-1/marimo/a");
      offset = POD_TARGET_TTL_MS + 1;
      await proxyGet(proxy, "/c/conv-1/marimo/a");
    } finally {
      spy.mockRestore();
    }
    expect(lookups()).toBe(2);
  });

  it("looks again when the conversation's status changes (suspend/resume moves the pod)", async () => {
    const conv = { status: "running" };
    const { proxy, lookups } = countingProxy(fakeRegistry(svc.port), conv);
    await proxyGet(proxy, "/c/conv-1/marimo/a");
    conv.status = "suspended";
    expect((await proxyGet(proxy, "/c/conv-1/marimo/a")).status).toBe(503);
    expect(lookups()).toBe(1);
    conv.status = "running";
    expect((await proxyGet(proxy, "/c/conv-1/marimo/a")).status).toBe(200);
    expect(lookups()).toBe(2);
  });

  it("a stale cached address is dropped on the first failed connect, and the next request finds the pod", async () => {
    // 127.0.0.2 is loopback but nothing listens there for this port: the old pod IP.
    const { proxy, lookups } = countingProxy(fakeRegistry(svc.port), {}, ["127.0.0.2", "127.0.0.1"]);
    expect((await proxyGet(proxy, "/c/conv-1/marimo/a", { accept: "*/*" })).status).toBe(502);
    expect((await proxyGet(proxy, "/c/conv-1/marimo/a")).status).toBe(200);
    expect(lookups()).toBe(2);
  });

  it("a failed lookup is not cached", async () => {
    let n = 0;
    const proxy = createWebServiceProxy({
      sessions: { get: () => ({ id: "conv-1", threadId: "conv-1" }), touchById: () => {} } as never,
      resolvePodTarget: (async () => {
        if (n++ === 0) throw new Error("no ready pod");
        return { name: "conv-1-pod", podIP: "127.0.0.1" };
      }) as never,
      registry: fakeRegistry(svc.port),
      publicHost: "scooter.example.com",
      resolveUser: () => ANON,
    });
    expect((await proxyGet(proxy, "/c/conv-1/marimo/a")).status).toBe(503);
    expect((await proxyGet(proxy, "/c/conv-1/marimo/a")).status).toBe(200);
  });
});

// ---- helpers: run the proxy through a throwaway front server ------------------

/** Stand up a front http.Server delegating to the proxy, so a real request exercises the node streaming path. */
async function withFront(
  proxy: WebServiceProxy,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const front = createServer(async (req, res) => {
    if (await proxy.handleInternal(req, res)) return;
    if (proxy.matches(new URL(req.url ?? "/", "http://x").pathname)) void proxy.handleHttp(req, res);
    else res.writeHead(404).end();
  });
  front.on("upgrade", (req, socket, head) => {
    if (proxy.matches(new URL(req.url ?? "/", "http://x").pathname))
      void proxy.handleUpgrade(req, socket as never, head);
    else socket.destroy();
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", () => r()));
  try {
    await fn((front.address() as AddressInfo).port);
  } finally {
    front.close();
  }
}

function proxyGet(
  proxy: WebServiceProxy,
  path: string,
  opts: { accept?: string; headers?: Record<string, string>; method?: string } = {},
): Promise<{ status: number; body: string; echoPath: string; ident: IdentEcho | null; setCookie: string[]; location: string }> {
  return new Promise((resolve, reject) => {
    void withFront(proxy, (port) =>
      new Promise<void>((done) => {
        const headers = {
          ...(opts.accept ? { accept: opts.accept } : {}),
          ...(opts.headers ?? {}),
        };
        const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            const raw = res.headers["x-echo-ident"];
            resolve({
              status: res.statusCode ?? 0,
              body,
              echoPath: String(res.headers["x-echo-path"] ?? ""),
              ident: raw ? (JSON.parse(String(raw)) as IdentEcho) : null,
              setCookie: res.headers["set-cookie"] ?? [],
              location: String(res.headers.location ?? ""),
            });
            done();
          });
        });
        req.on("error", reject);
        req.end();
      }),
    ).catch(reject);
  });
}

function proxyUpgrade(
  proxy: WebServiceProxy,
  path: string,
  payload: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<{ statusLine: string; echoed: string; raw: string }> {
  return new Promise((resolve, reject) => {
    void withFront(proxy, (port) =>
      new Promise<void>((done) => {
        const extra = Object.entries(opts.headers ?? {})
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("");
        const sock: Socket = connect(port, "127.0.0.1", () => {
          sock.write(
            `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n` +
              `Connection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
          );
        });
        let buf = "";
        let sentPayload = false;
        sock.on("data", (d) => {
          buf += d.toString("latin1");
          if (!sentPayload && buf.includes("101")) {
            sentPayload = true;
            sock.write(payload);
          } else if (sentPayload && buf.includes(payload)) {
            const statusLine = buf.split("\r\n")[0];
            resolve({ statusLine, echoed: payload, raw: buf });
            sock.destroy();
            done();
          }
        });
        // A REFUSED upgrade answers with a status line and closes, so close is a real
        // outcome here, not a failure; `resolve` after a successful echo is a no-op.
        sock.on("close", () => {
          resolve({ statusLine: buf.split("\r\n")[0] ?? "", echoed: "", raw: buf });
          done();
        });
        sock.on("error", reject);
        sock.setTimeout(2000, () => {
          reject(new Error("upgrade timed out"));
          sock.destroy();
          done();
        });
      }),
    ).catch(reject);
  });
}

// ---- private conversations ---------------------------------------------------

describe("web-service proxy on a private conversation", () => {
  let svc: { server: Server; port: number };
  beforeEach(async () => {
    svc = await fakeInPodService();
  });
  afterEach(() => {
    svc.server.close();
  });

  const ID = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff";

  /** A proxy over a private conversation owned by alice, with the caller named by x-auth-user. */
  function privateProxy(registry: WebServiceRegistry, sandboxDomain?: string, failCheck = false) {
    return createWebServiceProxy({
      sessions: {
        get: (id: string) => (id === "conv-1" || id === ID ? { id, threadId: id, owner: "alice", visibility: "private" } : undefined),
        touchById: () => {},
        refreshSandbox: async () => {},
      } as never,
      resolvePodTarget: (async () => ({ name: "pod", podIP: "127.0.0.1" })) as never,
      registry,
      publicHost: "scooter.example.com",
      sandboxDomain,
      resolveUser: (req) => {
        const id = req.headers["x-auth-user"];
        return typeof id === "string" ? { id, anonymous: false } : { id: "anonymous", anonymous: true };
      },
      accessCheck: createAccessCheck({
        readAccess: failCheck ? async () => { throw new Error("db down"); } : undefined,
        memory: () => ({ owner: "alice", visibility: "private" }),
      }),
    });
  }

  it("proxies the owner's request", async () => {
    const { status } = await proxyGet(privateProxy(fakeRegistry(svc.port)), "/c/conv-1/marimo/app", { headers: { "x-auth-user": "alice" } });
    expect(status).toBe(200);
  });

  it("answers 404 to another user and to an anonymous caller", async () => {
    const proxy = privateProxy(fakeRegistry(svc.port));
    expect((await proxyGet(proxy, "/c/conv-1/marimo/app", { headers: { "x-auth-user": "bob" } })).status).toBe(404);
    expect((await proxyGet(proxy, "/c/conv-1/marimo/app")).status).toBe(404);
  });

  it("refuses the loading page's status poll, which returns logs and wakes the pod", async () => {
    const registry = startingRegistry(svc.port, { logs: "secret log line" });
    const got = await proxyGet(privateProxy(registry), "/c/conv-1/marimo/__scooter_status", { headers: { "x-auth-user": "bob" } });
    expect(got.status).toBe(404);
    expect(got.body).not.toContain("secret log line");
    expect(registry.starts).toEqual([]);
  });

  it("refuses a non-owner's WebSocket upgrade (the terminal)", async () => {
    const got = await proxyUpgrade(privateProxy(fakeRegistry(svc.port)), "/c/conv-1/marimo/ws", "hello", { headers: { "x-auth-user": "bob" } });
    expect(got.statusLine).toContain("404");
    expect(got.echoed).toBe("");
  });

  it("allows the owner's WebSocket upgrade", async () => {
    const got = await proxyUpgrade(privateProxy(fakeRegistry(svc.port)), "/c/conv-1/marimo/ws", "hello", { headers: { "x-auth-user": "alice" } });
    expect(got.echoed).toBe("hello");
  });

  it("refuses the router's direct-target lookup for a non-owner, so it cannot proxy around the check", async () => {
    const proxy = privateProxy(fakeRegistry(svc.port), "scooter.example.com");
    const q = `/internal/web-services/target?conversation=${ID}&service=marimo&label=5a515e73`;
    expect((await proxyGet(proxy, q, { headers: { "x-auth-user": "bob" } })).status).toBe(404);
  });

  it("answers 503 when the visibility read fails", async () => {
    const proxy = privateProxy(fakeRegistry(svc.port), undefined, true);
    expect((await proxyGet(proxy, "/c/conv-1/marimo/app", { headers: { "x-auth-user": "alice" } })).status).toBe(503);
  });
});
