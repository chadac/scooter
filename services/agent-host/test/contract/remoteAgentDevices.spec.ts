/**
 * /remote-agent/devices: the Settings device list and revoke, relayed to the BYOC
 * controller's in-cluster port as the signed-in user, never one the caller names.
 */

import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createManagementApi } from "../../src/api/management.js";
import { createRemoteAgentUi } from "../../src/acp/remoteAgentOneliner.js";

function makeApi(remoteAgent: unknown, user = { id: "chadac", anonymous: false }) {
  return createManagementApi({
    sessions: { list: () => [] },
    store: { async *readEvents() {} },
    server: { broadcast() {} },
    answerInterrupt: async () => ({ ok: true }),
    remoteAgent,
    resolveUser: () => user,
  } as never);
}

async function call(api: ReturnType<typeof makeApi>, method: string, path: string, headers: Record<string, string> = {}) {
  const req = new PassThrough() as unknown as IncomingMessage;
  Object.assign(req, { method, url: path, headers });
  let status = 200;
  const parts: Buffer[] = [];
  const res = {
    writeHead: (s: number) => { status = s; return res; },
    end: (c?: Buffer | string) => { if (c) parts.push(Buffer.from(c as Buffer)); },
    req,
  } as unknown as ServerResponse;
  const matched = api.handle(req, res);
  (req as PassThrough).end();
  await matched;
  return { status, body: Buffer.concat(parts).toString() };
}

/** A fake controller that records each call and answers with `reply`. */
function controller(reply: () => Response) {
  const calls: Array<{ url: string; method: string; user: string | null }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", user: h.get("x-auth-request-user") });
    return reply();
  }) as unknown as typeof fetch;
  const ui = createRemoteAgentUi({ joinSecret: "s", controllerUrl: "http://c:8080/", fetchImpl });
  return { ui, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("/remote-agent/devices", () => {
  it("lists the signed-in user's devices, ignoring an identity header the caller sends", async () => {
    const { ui, calls } = controller(() => json([{ id: "d1", lastSeen: 1 }]));
    const { status, body } = await call(makeApi(ui), "GET", "/remote-agent/devices", { "x-auth-request-user": "mallory" });
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual([{ id: "d1", lastSeen: 1 }]);
    expect(calls).toEqual([{ url: "http://c:8080/byoc/devices", method: "GET", user: "chadac" }]);
  });

  it("answers 404 when the controller has device auth off", async () => {
    const { ui } = controller(() => json({ error: "device auth not enabled" }, 404));
    expect((await call(makeApi(ui), "GET", "/remote-agent/devices")).status).toBe(404);
  });

  it("answers 503 when the controller is unreachable", async () => {
    const ui = createRemoteAgentUi({ joinSecret: "s", controllerUrl: "http://127.0.0.1:9" });
    expect((await call(makeApi(ui), "GET", "/remote-agent/devices")).status).toBe(503);
  });

  it("refuses an anonymous caller without reaching the controller", async () => {
    const { ui, calls } = controller(() => json([]));
    const { status } = await call(makeApi(ui, { id: "anon", anonymous: true }), "DELETE", "/remote-agent/devices/d1");
    expect(status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("revokes as the signed-in user with the id re-encoded", async () => {
    const { ui, calls } = controller(() => new Response(null, { status: 204 }));
    const { status } = await call(makeApi(ui), "DELETE", "/remote-agent/devices/a%2Fb");
    expect(status).toBe(204);
    expect(calls).toEqual([{ url: "http://c:8080/byoc/devices/a%2Fb", method: "DELETE", user: "chadac" }]);
  });
});
