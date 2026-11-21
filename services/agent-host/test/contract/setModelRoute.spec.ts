/**
 * PATCH /conversations/:id/model: the model picker's switch, validated against the catalog
 * and owner-gated like the other conversation mutations.
 */

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createManagementApi } from "../../src/api/management.js";
import type { Conversation, ConversationStore, SessionManager } from "../../src/session/manager.js";
import type { AguiServer } from "../../src/agui/server.js";

const conv: Conversation = {
  id: "c1",
  threadId: "c1",
  sandbox: { name: "conv-c1", namespace: "ns" },
  status: "running",
  title: "Hello",
  createdAt: 1000,
  lastActivityAt: 1000,
  owner: "alice",
};

function setup(deferred = false) {
  const sessions = {
    get: (id: string) => (id === "c1" ? conv : undefined),
    ensureReadable: vi.fn(async (id: string) => id === "c1"),
    setModel: vi.fn(async () => ({ deferred })),
  } as unknown as SessionManager;
  const api = createManagementApi({
    sessions,
    store: { appendEvent: async () => {}, async *readEvents() {}, gooseStatePath: () => "/s" } as unknown as ConversationStore,
    server: { subscribeSSE: vi.fn(async () => {}) } as unknown as AguiServer,
    answerInterrupt: async () => ({ ok: true }),
    authEnforced: true,
    models: { default: "opus", available: ["opus", "sonnet"], providers: { sonnet: ["anthropic"] } },
  });
  return { api, sessions };
}

async function patch(api: ReturnType<typeof createManagementApi>, path: string, body: unknown, caller = "alice") {
  const r = new PassThrough() as unknown as IncomingMessage;
  Object.assign(r, { method: "PATCH", url: path, headers: { "x-auth-user": caller } });
  let status = 200;
  let chunks = "";
  const res = {
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    end: (c?: string) => {
      if (c) chunks += c;
    },
    req: r,
  } as unknown as ServerResponse;
  const matched = api.handle(r, res);
  (r as PassThrough).end(JSON.stringify(body));
  await matched;
  return { status, json: chunks ? JSON.parse(chunks) : null };
}

describe("PATCH /conversations/:id/model", () => {
  it("switches to an offered model and reports whether it is deferred", async () => {
    const { api, sessions } = setup(true);
    const got = await patch(api, "/conversations/c1/model", { model: "anthropic:sonnet" });
    expect(got).toEqual({ status: 200, json: { model: "sonnet", provider: "anthropic", deferred: true } });
    expect(sessions.setModel).toHaveBeenCalledWith("c1", "sonnet", "anthropic");
  });

  it("accepts a bare model id", async () => {
    const { api, sessions } = setup();
    expect((await patch(api, "/conversations/c1/model", { model: "opus" })).status).toBe(200);
    expect(sessions.setModel).toHaveBeenCalledWith("c1", "opus", undefined);
  });

  it("rejects a model or provider the catalog does not offer", async () => {
    const { api, sessions } = setup();
    expect((await patch(api, "/conversations/c1/model", { model: "gpt" })).status).toBe(400);
    expect((await patch(api, "/conversations/c1/model", { model: "bedrock:sonnet" })).status).toBe(400);
    expect((await patch(api, "/conversations/c1/model", {})).status).toBe(400);
    expect(sessions.setModel).not.toHaveBeenCalled();
  });

  it("404s an unknown conversation and 403s another user's", async () => {
    const { api, sessions } = setup();
    expect((await patch(api, "/conversations/nope/model", { model: "opus" })).status).toBe(404);
    expect((await patch(api, "/conversations/c1/model", { model: "opus" }, "bob")).status).toBe(403);
    expect(sessions.setModel).not.toHaveBeenCalled();
  });
});
