/**
 * Tier 1 contract — the agent-host's tunnel service: resolve a target, call it, stream back.
 *
 * This is the cloud half of MCP-over-the-wire. The container opens a stream naming a target;
 * this resolves it (see tunnelTargets.ts — names only, conversation scoped server-side), makes
 * the real HTTP call, and streams the response back as tunnel frames.
 *
 * The behaviours pinned here are the ones whose absence produces a HANGING agent rather than a
 * failing one — the silent-degradation class this project keeps fixing.
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
    // The container must learn WHY — a silent drop becomes a hung tool call.
    const out = collector();
    const svc = createTunnelService({ send: out.send, ...deps(streamingFetch([])) });
    await svc.onFrame("conv-a", { ch: "tunnel", type: "open", id: "s1", payload: { target: "evil:9000", method: "GET", path: "/", headers: {} } });
    await svc.drain?.();

    const close = out.sent.find((f) => f.type === "close");
    expect(close).toBeTruthy();
    expect((close!.payload as { error?: string }).error).toMatch(/unknown target/i);
    // and it never called out
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
    // The payload even tries to name another conversation — it must be ignored.
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

// --- error responses must reach the container INTACT ------------------------------------------

describe("4xx responses are relayed, not swallowed", () => {
  it("a 400 reaches the container WITH its body — the CLI needs it to fall back", async () => {
    // THE LIVE FAILURE, and it was self-inflicted: the CLI probes optional methods
    // (`server/discover`) and RELIES on the rejection so it can fall back to the standard
    // `initialize` handshake. A diagnostic that did `res.clone().text()` to log the error
    // consumed undici's shared stream, so the original yielded NOTHING and the container got an
    // empty response. The CLI never fell back, ended up with no server, and the model told the
    // user the tool does not exist. (The first "fix" — rewriting the client's negotiated
    // protocol version — was treating that symptom, and lying to both ends to do it.)
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
    // A rejected request is a NORMAL protocol outcome, not a stream failure.
    const close = out.sent.find((f) => f.type === "close");
    expect((close?.payload as { error?: string }).error).toBeUndefined();
  });

  it("relays the request BYTE FOR BYTE — the tunnel never rewrites protocol payloads", async () => {
    // Rewriting a client's negotiated version behind its back makes each end believe it is
    // speaking a protocol the other is not. The tunnel is a pipe.
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
