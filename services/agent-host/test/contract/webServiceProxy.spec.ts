/**
 * Tier 1 contract test — the web-service reverse proxy.
 *
 * Drives createWebServiceProxy over a FAKE pod target (a real local http.Server
 * standing in for the in-pod service, doing HTTP echo + a raw upgrade echo) and a
 * fake WebServiceRegistry / resolvePodTarget. Asserts:
 *   - matches() gates only /c/<id>/<service>/... paths (not /c/<id> alone)
 *   - parseProxyPath splits id / service / rest
 *   - handleHttp pipes method+body+headers through and streams the response back
 *   - handleUpgrade splices a WebSocket-style upgrade and echoes bytes
 *   - unknown service -> 404, suspended/unreachable pod -> 503,
 *     declared-but-not-running -> friendly 502 page
 *
 * RED against the Design boilerplate (createWebServiceProxy throws NOT_IMPLEMENTED).
 * See docs/WEB_SERVICES_PROXY.md.
 */

import { AddressInfo } from "node:net";
import { createServer, request, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createWebServiceProxy,
  parseProxyPath,
  type PodTarget,
  type WebServiceDescriptor,
  type WebServiceProxy,
  type WebServiceRegistry,
} from "../../src/proxy/webServiceProxy.js";

// A fake in-pod service: echoes HTTP (method + path + body) and echoes raw bytes
// on an `upgrade`. Stands in for marimo/xterm listening on podIP:port.
function fakeInPodService(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain", "x-echo-path": req.url ?? "" });
        res.end(`${req.method} ${req.url} ${body}`);
      });
    });
    server.on("upgrade", (req, socket, head) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      if (head?.length) socket.write(head);
      socket.on("data", (d) => socket.write(d)); // echo
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    );
  });
}

const MARIMO: WebServiceDescriptor = {
  name: "marimo",
  displayName: "marimo",
  port: 0, // filled with the fake service port in beforeEach
  basePath: "/c/conv-1/marimo",
  unit: "webservice-marimo",
};

function fakeRegistry(port: number, opts: { running?: boolean } = {}): WebServiceRegistry {
  const running = opts.running ?? true;
  const desc = { ...MARIMO, port };
  return {
    list: async () => [desc],
    get: async (_id, name) => (name === "marimo" ? desc : null),
    isRunning: async () => running,
    start: async () => {},
    stop: async () => {},
    logs: async () => "",
    ready: async () => true,
    invalidate: () => {},
  };
}

/** A registry that flips to running after N isRunning() calls (models a service
 *  that takes a moment to come up after start), and records start() calls + serves
 *  a canned journalctl tail. */
function startingRegistry(
  port: number,
  opts: { runningAfter?: number; logs?: string } = {},
): WebServiceRegistry & { starts: string[] } {
  const desc = { ...MARIMO, port };
  const runningAfter = opts.runningAfter ?? 1;
  let calls = 0;
  const starts: string[] = [];
  return {
    starts,
    list: async () => [desc],
    get: async (_id, name) => (name === "marimo" ? desc : null),
    isRunning: async () => ++calls > runningAfter,
    start: async (_id, name) => { starts.push(name); },
    stop: async () => {},
    logs: async () => opts.logs ?? "starting marimo…",
    ready: async () => true,
    invalidate: () => {},
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
    // service with no extra path -> rest "/"
    expect(parseProxyPath("/c/conv-1/marimo")).toMatchObject({ service: "marimo", rest: "/" });
    // /c/<id> alone is the UI deep-link space, NOT a proxy path.
    expect(parseProxyPath("/c/conv-1")).toBeNull();
    expect(parseProxyPath("/conversations/conv-1")).toBeNull();
  });

  function makeProxy(
    registry: WebServiceRegistry,
    target?: Partial<PodTarget>,
    touchById: (id: string) => void = () => {},
  ): WebServiceProxy {
    const resolvePodTarget = async () => ({
      name: "conv-1-pod",
      podIP: "127.0.0.1",
      ...target,
    });
    return createWebServiceProxy({
      sessions: { get: () => ({ id: "conv-1", threadId: "conv-1" }), touchById } as never,
      resolvePodTarget: resolvePodTarget as never,
      registry,
      publicHost: "scooter.example.com",
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
    // Default (no stripBasePath): the FULL prefixed path reaches the pod (marimo
    // serves under --base-url /c/conv-1/marimo).
    expect(echoPath).toBe("/c/conv-1/marimo/app?x=1");
    expect(body).toContain("GET");
  });

  it("marks the conversation active (touchById) on a proxied request — keeps the pod alive", async () => {
    const touched: string[] = [];
    const proxy = makeProxy(fakeRegistry(svc.port), undefined, (id) => touched.push(id));
    await proxyGet(proxy, "/c/conv-1/marimo/app");
    // A user using the web service is real activity → the idle sweep must not suspend it.
    expect(touched).toContain("conv-1");
  });

  it("does NOT touch when the pod is unreachable (503 — nothing to keep alive)", async () => {
    const touched: string[] = [];
    const proxy = createWebServiceProxy({
      sessions: { get: () => ({ id: "conv-1", threadId: "conv-1" }), touchById: (id: string) => touched.push(id) } as never,
      resolvePodTarget: (async () => { throw new Error("no ready pod"); }) as never,
      registry: fakeRegistry(svc.port),
      publicHost: "scooter.example.com",
    });
    const { status } = await proxyGet(proxy, "/c/conv-1/marimo/x");
    expect(status).toBe(503);
    expect(touched).toEqual([]); // resolve failed → no touch
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
    // The /c/conv-1/marimo prefix is stripped → the pod sees just /app.
    expect(echoPath).toBe("/app?x=1");
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
    });
    const { status } = await proxyGet(proxy, "/c/conv-1/marimo/x");
    expect(status).toBe(503);
  });

  it("declared-but-not-running HTML nav -> auto-starts + serves a loading page (200)", async () => {
    const registry = startingRegistry(svc.port, { runningAfter: 99 /* stays down */ });
    const proxy = makeProxy(registry);
    // A browser navigation (Accept: text/html) to a dead service.
    const { status, body } = await proxyGet(proxy, "/c/conv-1/marimo/", {
      accept: "text/html",
    });
    expect(status).toBe(200);
    // It kicked off a start...
    expect(registry.starts).toContain("marimo");
    // ...and returned a loading page (spinner + a poll that reloads when healthy).
    expect(body.toLowerCase()).toContain("starting");
    // The page polls the status endpoint (not a static "go click Start" dead-end).
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
    // marimo's own asset/XHR fetches shouldn't receive an HTML loading page — that
    // would corrupt them. Only a top-level navigation gets the loading UX.
    const proxy = makeProxy(startingRegistry(svc.port, { runningAfter: 99 }));
    const { status } = await proxyGet(proxy, "/c/conv-1/marimo/assets/app.js", {
      accept: "*/*",
    });
    expect(status).toBe(502);
  });

  it("once the service is up, the loading page's status endpoint reports running", async () => {
    // runningAfter:0 → the very first isRunning() call returns true.
    const registry = startingRegistry(svc.port, { runningAfter: 0 });
    const proxy = makeProxy(registry);
    const { body } = await proxyGet(proxy, "/c/conv-1/marimo/__scooter_status");
    expect(JSON.parse(body).running).toBe(true);
  });

  // --- WebSocket upgrade ------------------------------------------------------

  it("handleUpgrade splices an upgrade and echoes bytes both ways", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port));
    const { statusLine, echoed } = await proxyUpgrade(proxy, "/c/conv-1/marimo/ws", "ping");
    expect(statusLine).toContain("101");
    expect(echoed).toContain("ping");
  });
});

// ---- helpers: run the proxy through a throwaway front server ------------------

/** Stand up a front http.Server whose handler/upgrade delegate to the proxy, then
 *  issue a real request so we exercise the actual node streaming path. */
async function withFront(
  proxy: WebServiceProxy,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const front = createServer((req, res) => {
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
  opts: { accept?: string } = {},
): Promise<{ status: number; body: string; echoPath: string }> {
  return new Promise((resolve, reject) => {
    void withFront(proxy, (port) =>
      new Promise<void>((done) => {
        const headers = opts.accept ? { accept: opts.accept } : undefined;
        const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body,
              echoPath: String(res.headers["x-echo-path"] ?? ""),
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
): Promise<{ statusLine: string; echoed: string }> {
  return new Promise((resolve, reject) => {
    void withFront(proxy, (port) =>
      new Promise<void>((done) => {
        const sock: Socket = connect(port, "127.0.0.1", () => {
          sock.write(
            `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n` +
              `Connection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n`,
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
            resolve({ statusLine, echoed: payload });
            sock.destroy();
            done();
          }
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
