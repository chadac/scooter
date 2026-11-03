/**
 * /remote-agent/join-token when the BYOC controller is unreachable: an expected,
 * diagnosable condition, so the route answers 503 with a JSON body naming the
 * dependency rather than an uncaught 500.
 */

import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createManagementApi } from "../../src/api/management.js";
import { createRemoteAgentUi } from "../../src/acp/remoteAgentOneliner.js";

function makeApi(remoteAgent: unknown) {
  return createManagementApi({
    sessions: { list: () => [] },
    store: { async *readEvents() {} },
    server: { broadcast() {} },
    answerInterrupt: async () => ({ ok: true }),
    remoteAgent,
    resolveUser: () => ({ id: "chadac", anonymous: false }),
  } as never);
}

async function post(api: ReturnType<typeof makeApi>, path: string) {
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  (req as { url?: string }).url = path;
  (req as { headers?: Record<string, string> }).headers = {};
  let status = 200;
  let headers: Record<string, string> = {};
  const parts: Buffer[] = [];
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => { status = s; if (h) headers = h; return res; },
    end: (c?: Buffer | string) => { if (c) parts.push(Buffer.from(c as Buffer)); },
    req,
  } as unknown as ServerResponse;
  const matched = api.handle(req, res);
  (req as PassThrough).end();
  await matched;
  return { status, headers, body: Buffer.concat(parts).toString() };
}

describe("POST /remote-agent/join-token — controller unreachable", () => {
  const deadControllerUi = () =>
    createRemoteAgentUi({
      joinSecret: "s",
      controllerUrl: "http://127.0.0.1:9", // the discard port refuses connections
      publicByocUrl: "https://byoc.example.com",
    });

  it("answers 503 JSON naming the BYOC controller — never an uncaught 500", async () => {
    const { status, body } = await post(makeApi(deadControllerUi()), "/remote-agent/join-token");
    expect(status).toBe(503);
    const parsed = JSON.parse(body) as { error?: string };
    expect(parsed.error).toMatch(/BYOC controller/i);
  });

  it("the error body carries NO token material", async () => {
    // The join token is a bearer credential, so an error path must not leak anything JWT-shaped.
    const { body } = await post(makeApi(deadControllerUi()), "/remote-agent/join-token");
    expect(body).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
    expect(body).not.toMatch(/docker run/);
  });

  it("a healthy controller still mints (the 503 path does not eat successes)", async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ sessionId: "sess-1" }), { status: 200 })) as unknown as typeof fetch;
    const ui = createRemoteAgentUi({
      joinSecret: "s",
      controllerUrl: "http://c:8080",
      publicByocUrl: "https://byoc.example.com",
      fetchImpl: impl,
    });
    const { status, body } = await post(makeApi(ui), "/remote-agent/join-token");
    expect(status).toBe(200);
    expect(JSON.parse(body)).toHaveProperty("token");
  });
});
