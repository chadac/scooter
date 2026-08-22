/**
 * Tier 1 contract — /remote-agent/join-token when the BYOC controller is unreachable.
 *
 * THE BUG (observed live: agent-pg-byoc Secret missing → the controller pod never starts →
 * the mint POST gets connection-refused). mint() threw, the router has no catch, and the agui
 * server's outer catch did `res.end(String(err))` — a 500 whose body is a RAW stringified
 * error with no content-type. The Settings UI expects JSON on this route, so the user saw a
 * parser artifact instead of an explanation, and "the database secret is missing" surfaced as
 * an anonymous 500.
 *
 * An unreachable controller is an EXPECTED, diagnosable condition, not an internal error:
 * the route answers 503 with a JSON body that names the dependency, so the UI can render a
 * real message and an operator can tell "controller down" from "agent-host broken".
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
    answerPermission: async () => {},
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
      controllerUrl: "http://127.0.0.1:9", // discard port — connection refused
      publicByocUrl: "https://byoc.example.com",
    });

  it("answers 503 JSON naming the BYOC controller — never an uncaught 500", async () => {
    const { status, body } = await post(makeApi(deadControllerUi()), "/remote-agent/join-token");
    expect(status).toBe(503);
    const parsed = JSON.parse(body) as { error?: string };
    expect(parsed.error).toMatch(/BYOC controller/i);
  });

  it("the error body carries NO token material", async () => {
    // The join token is a bearer credential; an error path must never leak one (or anything
    // JWT-shaped) into a response that gets logged, screenshotted, and pasted into issues.
    const { body } = await post(makeApi(deadControllerUi()), "/remote-agent/join-token");
    expect(body).not.toMatch(/eyJ[A-Za-z0-9_-]+\./); // a JWT's header segment
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
