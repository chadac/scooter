/**
 * The agent-host's tunnel service, the cloud half of MCP-over-the-wire: the container
 * opens a stream naming a target, the service resolves it (names only, conversation
 * scoped server-side), makes the HTTP call, and streams the response back as frames.
 * Every failure must reach the container as a close with a reason, never a silent stop.
 */

import { describe, it, expect, vi } from "vitest";

import { createTunnelService } from "../../src/acp/tunnelService.js";
import type { WireFrame } from "../../src/acp/remoteProtocol.js";

/** Collect frames the service sends back toward the container. */
function collector() {
  const sent: WireFrame[] = [];
  return { sent, send: (f: WireFrame) => sent.push(f) };
}

const deps = (fetchImpl: typeof fetch) => ({
  mcpUrlFor: (conv: string) => `http://mcp.local/mcp?conv=${conv}`,
  fetchImpl,
});

/** A fetch that streams `chunks` as the response body. */
const streamingFetch = (chunks: string[], status = 200) =>
  (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
          c.close();
        },
      }),
      { status, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

describe("agent-host tunnel service", () => {
  it("resolves the target, calls it, and streams the response back", async () => {
    const out = collector();
    const svc = createTunnelService({ send: out.send, ...deps(streamingFetch(["part-1", "part-2"])) });

    await svc.onFrame("conv-a", { ch: "tunnel", type: "open", id: "s1", payload: { target: "scooter-env", method: "POST", path: "/mcp", headers: {} } });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "end", id: "s1", payload: {} });
    await svc.drain?.();

    const chunks = out.sent.filter((f) => f.type === "chunk");
    const body = chunks.map((f) => Buffer.from((f.payload as { data: string }).data, "base64").toString()).join("");
    expect(body).toBe("part-1part-2");
    expect(out.sent.at(-1)?.type).toBe("close");
    expect((out.sent.at(-1)?.payload as { error?: string }).error).toBeUndefined();
  });

  it("REJECTS an unresolvable target with a close carrying the reason", async () => {
    const out = collector();
    const svc = createTunnelService({ send: out.send, ...deps(streamingFetch([])) });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "open", id: "s1", payload: { target: "evil:9000", method: "GET", path: "/", headers: {} } });
    await svc.drain?.();

    const close = out.sent.find((f) => f.type === "close");
    expect(close).toBeTruthy();
    expect((close!.payload as { error?: string }).error).toMatch(/unknown target/i);
    expect(out.sent.some((f) => f.type === "chunk")).toBe(false);
  });

  it("scopes the call to the SERVER-SIDE conversation, not anything the container sent", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const out = collector();
    const svc = createTunnelService({ send: out.send, ...deps(fetchImpl) });
    // The payload names another conversation, which must be ignored.
    await svc.onFrame("conv-mine", {
      ch: "tunnel", type: "open", id: "s1",
      payload: { target: "scooter-env", method: "GET", path: "/mcp?conv=conv-theirs", headers: {} },
    });
    await svc.onFrame("conv-mine", { ch: "tunnel", type: "end", id: "s1", payload: {} });
    await svc.drain?.();
    expect(seen[0]).toContain("conv=conv-mine");
    expect(seen[0]).not.toContain("conv-theirs");
  });

  it("a fetch failure closes the stream WITH the error (never a silent stop)", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const out = collector();
    const svc = createTunnelService({ send: out.send, ...deps(failing) });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "open", id: "s1", payload: { target: "scooter-env", method: "GET", path: "/", headers: {} } });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "end", id: "s1", payload: {} });
    await svc.drain?.();

    const close = out.sent.find((f) => f.type === "close");
    expect((close!.payload as { error?: string }).error).toMatch(/ECONNREFUSED/);
  });

  it("forwards the request BODY the container streamed", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const out = collector();
    const svc = createTunnelService({ send: out.send, ...deps(fetchImpl) });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "open", id: "s1", payload: { target: "scooter-env", method: "POST", path: "/mcp", headers: {} } });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "chunk", id: "s1", payload: { data: Buffer.from('{"m":1}').toString("base64") } });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "end", id: "s1", payload: {} });
    await svc.drain?.();
    expect(bodies[0]).toBe('{"m":1}');
  });
});

// --- error responses reach the container intact -----------------------------------------------

describe("4xx responses are relayed, not swallowed", () => {
  it("a 400 reaches the container WITH its body — the CLI needs it to fall back", async () => {
    // The CLI probes optional methods such as `server/discover` and relies on the rejection body to fall back to the standard `initialize` handshake.
    const out = collector();
    const errorBody = JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Unsupported protocol version" }, id: null });
    const fetchImpl = (async () => new Response(errorBody, { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const svc = createTunnelService({ send: out.send, ...deps(fetchImpl) });

    await svc.onFrame("conv-a", { ch: "tunnel", type: "open", id: "s1", payload: { target: "scooter-env", method: "POST", path: "/mcp", headers: {} } });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "end", id: "s1", payload: {} });
    await svc.drain?.();

    const chunks = out.sent.filter((f) => f.type === "chunk");
    const body = chunks.map((f) => Buffer.from((f.payload as { data: string }).data, "base64").toString()).join("");
    expect(body, "the error body must survive the relay").toBe(errorBody);
    const first = chunks[0]?.payload as { status?: number };
    expect(first.status, "the status must be relayed too").toBe(400);
    // A rejected request is a normal protocol outcome, not a stream failure.
    const close = out.sent.find((f) => f.type === "close");
    expect((close?.payload as { error?: string }).error).toBeUndefined();
  });

  it("relays the request BYTE FOR BYTE — the tunnel never rewrites protocol payloads", async () => {
    // The tunnel is a pipe.
    const sent: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      sent.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const out = collector();
    const svc = createTunnelService({ send: out.send, ...deps(fetchImpl) });
    const probe = JSON.stringify({
      jsonrpc: "2.0", id: "server-discover-probe-1", method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "open", id: "s2", payload: { target: "scooter-env", method: "POST", path: "/mcp", headers: {} } });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "chunk", id: "s2", payload: { data: Buffer.from(probe).toString("base64") } });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "end", id: "s2", payload: {} });
    await svc.drain?.();
    expect(sent[0]).toBe(probe);
  });
});

// --- the injected conversation token ------------------------------------------------
//
// The container's own headers are forwarded, so the credential the agent-host injects
// overwrites any Authorization the container sent rather than merging with it.
describe("tunnel credential injection", () => {
  const capture = () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const impl = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { seen, impl };
  };

  const withToken = (fetchImpl: typeof fetch) => ({
    mcpUrlFor: (_conv: string) => "http://mcp.local/mcp",
    mcpHeadersFor: (conv: string) => [{ name: "Authorization", value: `Bearer real-${conv}` }],
    fetchImpl,
  });

  const open = (payload: Record<string, unknown>) => ({
    ch: "tunnel" as const,
    type: "open" as const,
    id: "s1",
    payload: { target: "scooter-env", method: "POST", path: "/mcp", ...payload },
  });

  it("injects the conversation token on the proxied request", async () => {
    const out = collector();
    const cap = capture();
    const svc = createTunnelService({ send: out.send, ...withToken(cap.impl) });
    await svc.onFrame("conv-a", open({ headers: {} }));
    await svc.onFrame("conv-a", { ch: "tunnel", type: "end", id: "s1", payload: {} });
    expect(cap.seen[0].headers.Authorization).toBe("Bearer real-conv-a");
  });

  it("STRIPS a container-supplied Authorization rather than merging it", async () => {
    const out = collector();
    const cap = capture();
    const svc = createTunnelService({ send: out.send, ...withToken(cap.impl) });
    await svc.onFrame("conv-a", open({ headers: { Authorization: "Bearer forged-by-the-laptop" } }));
    await svc.onFrame("conv-a", { ch: "tunnel", type: "end", id: "s1", payload: {} });
    const sent = Object.entries(cap.seen[0].headers).filter(([k]) => k.toLowerCase() === "authorization");
    expect(sent).toEqual([["Authorization", "Bearer real-conv-a"]]);
  });

  // HTTP header names are case-insensitive and the container picks the spelling.
  it("strips a container header that differs only in CASE", async () => {
    const out = collector();
    const cap = capture();
    const svc = createTunnelService({ send: out.send, ...withToken(cap.impl) });
    await svc.onFrame("conv-a", open({ headers: { authorization: "Bearer forged-lowercase" } }));
    await svc.onFrame("conv-a", { ch: "tunnel", type: "end", id: "s1", payload: {} });
    const sent = Object.entries(cap.seen[0].headers).filter(([k]) => k.toLowerCase() === "authorization");
    expect(sent).toEqual([["Authorization", "Bearer real-conv-a"]]);
  });

  it("leaves the container's OTHER headers alone", async () => {
    const out = collector();
    const cap = capture();
    const svc = createTunnelService({ send: out.send, ...withToken(cap.impl) });
    await svc.onFrame("conv-a", open({ headers: { accept: "application/json", "x-thing": "keep" } }));
    await svc.onFrame("conv-a", { ch: "tunnel", type: "end", id: "s1", payload: {} });
    expect(cap.seen[0].headers["x-thing"]).toBe("keep");
    expect(cap.seen[0].headers.accept).toBe("application/json");
  });
});

describe("tunnel service — a target that resolves asynchronously", () => {
  it("keeps the frames that arrive while a sandbox server is being checked", async () => {
    // The tunnel client dispatches frames without awaiting, so the chunk and end land mid-check.
    const out = collector();
    let release!: (ok: boolean) => void;
    const seen: Array<{ url: string; body: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: String(init.body), auth: new Headers(init.headers).get("authorization") });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const svc = createTunnelService({
      send: out.send,
      ...deps(fetchImpl),
      mcpHeadersFor: (conv: string) => [{ name: "Authorization", value: `Bearer ${conv}` }],
      sandboxMcpUrlFor: (name: string) => `http://agent-host/sandbox-mcp/${name}`,
      sandboxServerDeclared: () => new Promise<boolean>((r) => (release = r)),
    });

    const open = svc.onFrame("conv-a", { ch: "tunnel", type: "open", id: "s1", payload: { target: "sandbox-jupyter", method: "POST", path: "/mcp", headers: { authorization: "Bearer mine" } } });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "chunk", id: "s1", payload: { data: Buffer.from('{"m":1}').toString("base64") } });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "end", id: "s1", payload: {} });
    release(true);
    await open;
    await svc.drain?.();

    expect(seen).toEqual([{ url: "http://agent-host/sandbox-mcp/jupyter", body: '{"m":1}', auth: "Bearer conv-a" }]);
  });

  it("closes with the reason when the server turns out undeclared, even after end", async () => {
    const out = collector();
    const fetchImpl = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    const svc = createTunnelService({
      send: out.send,
      ...deps(fetchImpl),
      sandboxMcpUrlFor: (name: string) => `http://agent-host/sandbox-mcp/${name}`,
      sandboxServerDeclared: async () => false,
    });

    const open = svc.onFrame("conv-a", { ch: "tunnel", type: "open", id: "s1", payload: { target: "sandbox-x", method: "POST", path: "/mcp", headers: {} } });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "end", id: "s1", payload: {} });
    await open;
    await svc.drain?.();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.sent).toHaveLength(1);
    expect((out.sent[0].payload as { error?: string }).error).toMatch(/no MCP server named "x"/);
  });
});
