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

  function makeProxy(registry: WebServiceRegistry, target?: Partial<PodTarget>): WebServiceProxy {
    const resolvePodTarget = async () => ({
      name: "conv-1-pod",
      podIP: "127.0.0.1",
      ...target,
    });
    return createWebServiceProxy({
      sessions: { get: () => ({ id: "conv-1", threadId: "conv-1" }) } as never,
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
    // The in-pod service saw the rest-path (prefix stripped or preserved per design
    // — assert it at least reached the app with the tail).
    expect(echoPath).toContain("/app");
    expect(body).toContain("GET");
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
      sessions: { get: () => ({ id: "conv-1", threadId: "conv-1" }) } as never,
      resolvePodTarget: (async () => {
        throw new Error("no ready pod");
      }) as never,
      registry: fakeRegistry(svc.port),
      publicHost: "scooter.example.com",
    });
    const { status } = await proxyGet(proxy, "/c/conv-1/marimo/x");
    expect(status).toBe(503);
  });

  it("declared but not running -> friendly 502 page", async () => {
    const proxy = makeProxy(fakeRegistry(svc.port, { running: false }));
    const { status, body } = await proxyGet(proxy, "/c/conv-1/marimo/x");
    expect(status).toBe(502);
    expect(body.toLowerCase()).toContain("start"); // "start it from the Services panel"
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
): Promise<{ status: number; body: string; echoPath: string }> {
  return new Promise((resolve, reject) => {
    void withFront(proxy, (port) =>
      new Promise<void>((done) => {
        const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
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
