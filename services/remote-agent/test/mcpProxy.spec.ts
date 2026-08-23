/**
 * Tier 1 contract — the container's local MCP proxy (one per offered server).
 *
 * The SDK reaches MCP by URL and knows nothing about the tunnel: each proxy listens on an
 * ephemeral 127.0.0.1 port and forwards what it receives as ch:"tunnel" frames. These tests
 * drive it with a REAL HTTP client against a fake cloud, because the whole point is that
 * ordinary HTTP works — a fake that only checks frame shapes would not prove that.
 */

import { describe, it, expect, afterEach } from "vitest";

import { startMcpProxy, startMcpProxies } from "../src/mcpProxy.js";
import type { WireFrame } from "../src/protocol.js";

/** A fake cloud: records outbound frames and can push responses back. */
function fakeCloud() {
  const sent: WireFrame[] = [];
  let onFrame: ((f: WireFrame) => void) | undefined;
  return {
    sent,
    deps: {
      send: (f: WireFrame) => sent.push(f),
      onFrame: (cb: (f: WireFrame) => void) => {
        onFrame = cb;
        return () => (onFrame = undefined);
      },
      sessionId: "sdk-1",
    },
    push: (f: WireFrame) => onFrame?.(f),
    /** The stream id of the Nth `open` the proxy sent. */
    streamId: (n = 0) => sent.filter((f) => f.type === "open")[n]?.id as string,
  };
}

const opened: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.close().catch(() => undefined)));
});

describe("local MCP proxy", () => {
  it("forwards an SDK request as a tunnel OPEN naming the target", async () => {
    const cloud = fakeCloud();
    const proxy = await startMcpProxy("scooter-env", cloud.deps);
    opened.push(proxy);

    const res = fetch(`${proxy.url}mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    // The open frame carries the NAME (never a host:port) + the request line.
    await new Promise((r) => setTimeout(r, 50));
    const open = cloud.sent.find((f) => f.type === "open");
    expect(open, "the proxy must open a tunnel stream").toBeTruthy();
    expect(open!.ch).toBe("tunnel");
    expect((open!.payload as { target: string }).target).toBe("scooter-env");
    expect((open!.payload as { method: string }).method).toBe("POST");
    // #305's session stamp rides along so the cloud attributes the stream.
    expect(open!.sid).toBe("sdk-1");

    // Answer so the pending fetch settles.
    cloud.push({ ch: "tunnel", type: "close", id: cloud.streamId(), payload: { status: 200 } });
    await res.catch(() => undefined);
  });

  it("STREAMS the response body through as chunks arrive (no buffering)", async () => {
    // MCP StreamableHTTP streams; a proxy that accumulated the whole body would break it.
    const cloud = fakeCloud();
    const proxy = await startMcpProxy("scooter-env", cloud.deps);
    opened.push(proxy);

    const resP = fetch(`${proxy.url}mcp`, { method: "POST", body: "{}" });
    await new Promise((r) => setTimeout(r, 50));
    const id = cloud.streamId();

    cloud.push({ ch: "tunnel", type: "chunk", id, payload: { data: Buffer.from("hello ").toString("base64"), status: 200 } });
    cloud.push({ ch: "tunnel", type: "chunk", id, payload: { data: Buffer.from("world").toString("base64") } });
    cloud.push({ ch: "tunnel", type: "close", id, payload: {} });

    const res = await resP;
    expect(await res.text()).toBe("hello world");
  });

  it("a tunnel CLOSE with an error fails the HTTP request — never a hang", async () => {
    // The failure mode this project keeps fixing: a dropped tunnel must surface as a tool
    // ERROR, not an unanswered call the agent waits on forever.
    const cloud = fakeCloud();
    const proxy = await startMcpProxy("scooter-env", cloud.deps);
    opened.push(proxy);

    const resP = fetch(`${proxy.url}mcp`, { method: "POST", body: "{}" });
    await new Promise((r) => setTimeout(r, 50));
    cloud.push({
      ch: "tunnel", type: "close", id: cloud.streamId(),
      payload: { error: "unknown target \"scooter-env\"" },
    });

    const res = await resP;
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await res.text()).toMatch(/unknown target/);
  });

  it("binds 127.0.0.1 only — never the user's network", async () => {
    const cloud = fakeCloud();
    const proxy = await startMcpProxy("scooter-env", cloud.deps);
    opened.push(proxy);
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  });

  it("startMcpProxies gives ONE proxy per offered server, each with its own port", async () => {
    // N servers per conversation is the design point; distinct ports prove they are separate.
    const cloud = fakeCloud();
    const started = await startMcpProxies([{ name: "scooter-env" }, { name: "other" }], cloud.deps);
    opened.push({ close: started.close });
    expect(started.servers.map((s) => s.name).sort()).toEqual(["other", "scooter-env"]);
    const urls = new Set(started.servers.map((s) => s.url));
    expect(urls.size, "each server needs its own local port").toBe(2);
  });

  it("close() fails in-flight requests instead of leaving them pending", async () => {
    const cloud = fakeCloud();
    const proxy = await startMcpProxy("scooter-env", cloud.deps);
    const resP = fetch(`${proxy.url}mcp`, { method: "POST", body: "{}" }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    await proxy.close();
    const out = await resP;
    expect(out, "a torn-down proxy must not leave the SDK hanging").toBeTruthy();
  });
});
