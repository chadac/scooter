/**
 * The sandbox-MCP proxy: the agent's stable per-server URL, resolved per request to the
 * server's pod IP and manifest port, behind the conversation token.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSandboxMcpProxy, type SandboxMcpProxyDeps } from "../../src/agent/sandboxMcpProxy.js";
import type { McpServerDescriptor } from "../../src/agent/mcpServerRegistry.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(handler: Parameters<typeof createServer>[0]): Promise<number> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const desc = (port: number, over: Partial<McpServerDescriptor> = {}): McpServerDescriptor => ({
  name: "alpha",
  displayName: "alpha",
  description: "",
  port,
  path: "/mcp",
  unit: "mcp-alpha",
  autoStart: true,
  ...over,
});

/** A front server running the proxy, as the management router mounts it. */
async function front(over: Partial<SandboxMcpProxyDeps> & { port?: number } = {}) {
  const deps: SandboxMcpProxyDeps = {
    baseUrl: "http://agent-host",
    resolveConversation: (req: IncomingMessage) => (req.headers.authorization === "Bearer good" ? "conv-1" : undefined),
    serverFor: vi.fn(async (_c: string, name: string) => (name === "alpha" ? desc(over.port ?? 1) : null)),
    podIPFor: vi.fn(async () => "127.0.0.1"),
    invalidate: vi.fn(),
    ...over,
  };
  const proxy = createSandboxMcpProxy(deps);
  const port = await listen((req, res) => {
    const name = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => void proxy.handle(req, res, raw ? JSON.parse(raw) : undefined, name));
  });
  return { url: (name: string) => `http://127.0.0.1:${port}/sandbox-mcp/${name}`, deps, proxy };
}

const auth = { authorization: "Bearer good", "content-type": "application/json" };

describe("sandbox MCP proxy", () => {
  it("advertises a stable URL per server name", () => {
    const proxy = createSandboxMcpProxy({
      baseUrl: "http://127.0.0.1:8080/",
      resolveConversation: () => undefined,
      serverFor: async () => null,
      podIPFor: async () => "",
      invalidate: () => {},
    });
    expect(proxy.urlFor("alpha")).toBe("http://127.0.0.1:8080/sandbox-mcp/alpha");
  });

  it("refuses a caller without a valid conversation token", async () => {
    const f = await front();
    const res = await fetch(f.url("alpha"), { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(f.deps.serverFor).not.toHaveBeenCalled();
  });

  it("404s a server this sandbox does not declare", async () => {
    const f = await front();
    const res = await fetch(f.url("nope"), { method: "POST", headers: auth, body: "{}" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("nope");
  });

  it("forwards to the manifest's port and path, without the agent's credential", async () => {
    const seen: { path?: string; auth?: string; session?: string; body?: string } = {};
    const upstream = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        Object.assign(seen, { path: req.url, auth: req.headers.authorization, session: req.headers["mcp-session-id"], body });
        res.setHeader("content-type", "application/json");
        res.setHeader("mcp-session-id", "s-2");
        res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      });
    });
    const f = await front({ port: upstream, serverFor: async () => desc(upstream, { path: "/custom" }) });
    const res = await fetch(f.url("alpha"), {
      method: "POST",
      headers: { ...auth, "mcp-session-id": "s-1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("s-2");
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(seen.path).toBe("/custom");
    expect(seen.auth, "the conversation token is for the proxy, not the server").toBeUndefined();
    expect(seen.session).toBe("s-1");
    expect(JSON.parse(seen.body ?? "")).toMatchObject({ method: "tools/list" });
  });

  it("streams an SSE response instead of buffering it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const upstream = await listen((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write("data: first\n\n");
      void gate.then(() => res.end("data: second\n\n"));
    });
    const f = await front({ port: upstream });
    const res = await fetch(f.url("alpha"), { method: "POST", headers: auth, body: "{}" });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first, "the first event arrives before the upstream finishes").toContain("first");
    release();
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    expect(rest).toContain("second");
  });

  it("closes the upstream stream when the agent disconnects", async () => {
    // An MCP client's GET stream stays open until the client leaves.
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    const upstream = await listen((req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write(": open\n\n");
      req.socket.on("close", upstreamClosed);
    });
    const f = await front({ port: upstream });
    const ac = new AbortController();
    const res = await fetch(f.url("alpha"), { method: "GET", headers: auth, signal: ac.signal });
    await res.body!.getReader().read();
    ac.abort();
    await closed;
  });

  it("reuses the pod IP across requests", async () => {
    const upstream = await listen((_req, res) => res.end("{}"));
    const f = await front({ port: upstream });
    await fetch(f.url("alpha"), { method: "POST", headers: auth, body: "{}" });
    await fetch(f.url("alpha"), { method: "POST", headers: auth, body: "{}" });
    expect(f.deps.podIPFor).toHaveBeenCalledTimes(1);
  });

  it("502s an unreachable server with the reason, and looks everything up again next time", async () => {
    const f = await front({ port: await closedPort() });
    const res = await fetch(f.url("alpha"), { method: "POST", headers: auth, body: "{}" });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("ECONNREFUSED");
    expect(f.deps.invalidate).toHaveBeenCalledWith("conv-1");
    await fetch(f.url("alpha"), { method: "POST", headers: auth, body: "{}" });
    expect(f.deps.podIPFor, "the cached pod IP was dropped").toHaveBeenCalledTimes(2);
  });

  it("503s when the sandbox is not running", async () => {
    const f = await front({
      podIPFor: async () => {
        throw new Error("no ready pod");
      },
    });
    const res = await fetch(f.url("alpha"), { method: "POST", headers: auth, body: "{}" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("no ready pod");
  });
});
