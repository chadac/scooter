/**
 * The agent-host MCP endpoint's conversation scoping (issue #700).
 *
 * This endpoint hands out sandbox exec, subagents, model switching and scheduled-task
 * management for ONE conversation. It used to take which conversation from `?conv=` on
 * a route with no caller authentication, so these tests exist to pin that the only
 * answer now comes from a signature we made.
 */

import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createMcpEndpoint } from "../../src/agent/mcpServer.js";
import { mintConvToken } from "../../src/auth/convToken.js";

const SECRET = "endpoint-test-secret";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** The endpoint on a loopback port, with a jobs wiring so tools/list is non-empty. */
async function serve(opts: { secret?: string } = {}) {
  const jobs = {
    start: async () => ({ jobId: "job-1" }),
    check: async () => ({ state: "running" as const, command: "x", output: "", logPath: "/l", truncated: false }),
    list: async () => [],
    kill: async () => ({ outcome: "killed" as const }),
  };
  let handle: ReturnType<typeof createMcpEndpoint>["handle"];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        body = {};
      }
      void handle(req, res, body).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const endpoint = createMcpEndpoint({
    baseUrl: `http://127.0.0.1:${port}`,
    convTokenSecret: opts.secret === undefined ? SECRET : opts.secret,
    jobs: jobs as never,
  });
  handle = endpoint.handle;
  return { endpoint, url: endpoint.urlFor("conv-a") };
}

const toolsList = (headers: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});

describe("the MCP endpoint's conversation scoping", () => {
  it("serves tools to a caller holding a valid conversation token", async () => {
    const { endpoint, url } = await serve();
    const headers = Object.fromEntries(endpoint.headersFor("conv-a").map((h) => [h.name, h.value]));
    const res = await fetch(url, toolsList(headers));
    expect(res.ok).toBe(true);
    expect(await res.text()).toMatch(/run_background/);
  });

  it("REFUSES a request with no token", async () => {
    const { url } = await serve();
    const res = await fetch(url, toolsList({}));
    expect(res.status).toBe(401);
  });

  it("REFUSES a token signed with another secret", async () => {
    const { url } = await serve();
    const forged = mintConvToken("conv-a", "not-the-secret");
    const res = await fetch(url, toolsList({ Authorization: `Bearer ${forged}` }));
    expect(res.status).toBe(401);
  });

  it("REFUSES an expired token", async () => {
    const { url } = await serve();
    const stale = mintConvToken("conv-a", SECRET, { ttlSeconds: 1, now: 1_000 });
    const res = await fetch(url, toolsList({ Authorization: `Bearer ${stale}` }));
    expect(res.status).toBe(401);
  });

  // THE one. `?conv=` is deleted, so naming a conversation in the URL must not work
  // even for a conversation that exists.
  it("IGNORES ?conv= entirely — a URL cannot name a conversation any more", async () => {
    const { url } = await serve();
    const res = await fetch(`${url}?conv=conv-victim`, toolsList({}));
    expect(res.status).toBe(401);
  });

  it("does not let ?conv= override the token's conversation", async () => {
    const { endpoint, url } = await serve();
    const headers = Object.fromEntries(endpoint.headersFor("conv-a").map((h) => [h.name, h.value]));
    // A valid token for conv-a plus a query param naming conv-victim. The token wins;
    // the request is served (200) and the param is simply not consulted.
    const res = await fetch(`${url}?conv=conv-victim`, toolsList(headers));
    expect(res.ok).toBe(true);
  });

  it("the URL carries no conversation at all, for any conversation", async () => {
    const { endpoint } = await serve();
    expect(endpoint.urlFor("conv-a")).toBe(endpoint.urlFor("conv-b"));
    expect(endpoint.urlFor("conv-a")).not.toMatch(/conv/);
  });

  it("the token differs per conversation, which is where the scope now lives", async () => {
    const { endpoint } = await serve();
    expect(endpoint.headersFor("conv-a")).not.toEqual(endpoint.headersFor("conv-b"));
  });

  it("carries the owner through to the token when given", async () => {
    const { endpoint } = await serve();
    const [h] = endpoint.headersFor("conv-a", "alice@example.com");
    const claims = JSON.parse(
      Buffer.from(h.value.replace(/^Bearer /, "").split(".")[1], "base64url").toString("utf8"),
    );
    expect(claims.owner).toBe("alice@example.com");
    expect(claims.sub).toBe("conv-a");
  });

  // Fails CLOSED. An unconfigured secret must not mean "accept anything" — that would
  // leave the agent-host failing open while the broker's verifier fails closed.
  describe("with no secret configured", () => {
    it("offers no headers", async () => {
      const { endpoint } = await serve({ secret: "" });
      expect(endpoint.headersFor("conv-a")).toEqual([]);
    });

    it("refuses every request rather than falling back to ?conv=", async () => {
      const { url } = await serve({ secret: "" });
      expect((await fetch(url, toolsList({}))).status).toBe(401);
      expect((await fetch(`${url}?conv=conv-a`, toolsList({}))).status).toBe(401);
    });
  });
});
