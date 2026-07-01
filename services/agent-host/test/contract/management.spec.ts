/**
 * Tier 1 contract test — the management REST API.
 *
 * Drives createManagementApi over a fake SessionManager + store + a stub server,
 * via the router's handle(), with mock req/res. Proves the routes map to the
 * right SessionManager calls and shape the responses correctly.
 */

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createManagementApi } from "../../src/api/management.js";
import type { Conversation, SessionManager, ConversationStore, ConversationLink } from "../../src/session/manager.js";
import type { AguiServer } from "../../src/agui/server.js";
import type { AguiEvent } from "../../src/bridge.js";

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  threadId: "c1",
  sandbox: { name: "conv-c1", namespace: "ns" },
  status: "running",
  title: "Hello",
  createdAt: 1000,
  lastActivityAt: 1000,
  ...over,
});

function fakeSessions(): SessionManager {
  const store = new Map<string, Conversation>([["c1", conv()]]);
  return {
    start: vi.fn(async (threadId, model, owner) => {
      const c = conv({ id: threadId, threadId, status: "running", title: "New chat", model, owner });
      store.set(threadId, c);
      return c;
    }),
    revive: vi.fn(async (id) => {
      const c = conv({ id, status: "running" });
      store.set(id, c);
      return c;
    }),
    prompt: vi.fn(async () => {}),
    promptByThread: vi.fn(async () => {}),
    suspend: vi.fn(async (id) => {
      store.set(id, conv({ id, status: "suspended" }));
    }),
    end: vi.fn(async (id) => {
      store.set(id, conv({ id, status: "ended" }));
    }),
    get: (id) => store.get(id),
    list: () => [...store.values()],
    setTitle: vi.fn((id, title) => {
      const c = store.get(id);
      if (c) store.set(id, conv({ ...c, title }));
    }),
    sweepIdle: vi.fn(async () => []),
    onConversationChange: vi.fn(() => () => {}),
  };
}

function fakeStore(events: AguiEvent[]): ConversationStore {
  const links = new Map<string, ConversationLink[]>();
  return {
    appendEvent: async () => {},
    async *readEvents() {
      yield* events;
    },
    gooseStatePath: (id) => `/state/${id}`,
    async addLink(id, link) {
      links.set(id, [...(links.get(id) ?? []), link]);
    },
    async listLinks(id) {
      return links.get(id) ?? [];
    },
  };
}

const stubServer = { subscribeSSE: vi.fn(async () => {}) } as unknown as AguiServer;

/** Drive a route through the router with a mock req/res; return {status, json}. */
async function call(
  api: ReturnType<typeof createManagementApi>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = path;
  (req as { headers?: Record<string, string> }).headers = headers;
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
    req,
  } as unknown as ServerResponse;

  const matched = api.handle(req, res);
  if (body !== undefined) {
    (req as PassThrough).write(JSON.stringify(body));
  }
  (req as PassThrough).end();
  await matched;
  return { status, json: chunks ? JSON.parse(chunks) : null };
}

describe("management API", () => {
  it("GET /conversations lists conversations (JSON-safe view)", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(),
      store: fakeStore([]),
      server: stubServer,
      answerPermission: async () => {},
    });
    const { status, json } = await call(api, "GET", "/conversations");
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect((json as any[])[0]).toMatchObject({ id: "c1", title: "Hello", status: "running" });
    expect((json as any[])[0]).not.toHaveProperty("bridge");
  });

  // --- Part 2: conversation-list push stream (RED until implemented) ----------
  // Captures res.write() SSE frames + the onConversationChange callback the route
  // registers, so we can assert: initial snapshot of the visible list, then an
  // upsert when a new conversation is announced.
  async function callStream(
    api: ReturnType<typeof createManagementApi>,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; frames: unknown[]; closeReq: () => void }> {
    const req = new PassThrough() as unknown as IncomingMessage;
    (req as { method?: string }).method = "GET";
    (req as { url?: string }).url = path;
    (req as { headers?: Record<string, string> }).headers = headers;
    let status = 200;
    const frames: unknown[] = [];
    const res = {
      writeHead: (s: number) => { status = s; return res; },
      write: (c: string) => {
        for (const line of c.split("\n")) {
          if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
        }
        return true;
      },
      end: () => {},
      req,
    } as unknown as ServerResponse;
    const matched = api.handle(req, res);
    (req as PassThrough).end();
    await matched;
    return { status, frames, closeReq: () => (req as PassThrough).emit("close") };
  }

  it("GET /conversations/events emits a snapshot then upserts new conversations", async () => {
    const sessions = fakeSessions();
    let announce: ((c: Conversation) => void) | undefined;
    (sessions.onConversationChange as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (c: Conversation) => void) => { announce = cb; return () => {}; },
    );
    const api = createManagementApi({
      sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {},
    });

    const s = await callStream(api, "/conversations/events");
    expect(s.status).toBe(200);
    // First frame is the snapshot of the currently-visible list.
    expect(s.frames[0]).toMatchObject({ kind: "snapshot" });
    expect((s.frames[0] as any).conversations.map((c: any) => c.id)).toContain("c1");

    // A newly-created conversation is pushed as an upsert.
    announce?.(conv({ id: "c2", threadId: "c2", title: "Slack: help" }));
    expect(s.frames).toContainEqual(
      expect.objectContaining({ kind: "upsert", conversation: expect.objectContaining({ id: "c2" }) }),
    );
  });

  it("POST /conversations creates with a title", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status, json } = await call(api, "POST", "/conversations", { threadId: "new1", title: "My task" });
    expect(status).toBe(201);
    expect(sessions.start).toHaveBeenCalledWith("new1", undefined, undefined);
    expect(sessions.setTitle).toHaveBeenCalledWith("new1", "My task");
    expect((json as any).title).toBe("My task");
  });

  it("GET /whoami returns the caller's identity (header)", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const me = await call(api, "GET", "/whoami", undefined, { "x-auth-user": "alice", "x-auth-email": "a@x.io" });
    expect(me.json).toEqual({ id: "alice", email: "a@x.io", anonymous: false });
  });

  it("GET /whoami is anonymous when no header is set", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const me = await call(api, "GET", "/whoami");
    expect(me.json).toEqual({ id: "anonymous", email: null, anonymous: true });
  });

  it("GET /models returns the catalog", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {},
      models: { default: "opus", available: ["opus", "sonnet"] },
    });
    const { status, json } = await call(api, "GET", "/models");
    expect(status).toBe(200);
    expect(json).toEqual({ default: "opus", available: ["opus", "sonnet"] });
  });

  it("POST /conversations honors an offered model", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({
      sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {},
      models: { default: "opus", available: ["opus", "sonnet"] },
    });
    const { status, json } = await call(api, "POST", "/conversations", { threadId: "m1", model: "sonnet" });
    expect(status).toBe(201);
    expect(sessions.start).toHaveBeenCalledWith("m1", "sonnet", undefined);
    expect((json as any).model).toBe("sonnet");
  });

  it("POST /conversations rejects an unknown model", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({
      sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {},
      models: { default: "opus", available: ["opus", "sonnet"] },
    });
    const { status } = await call(api, "POST", "/conversations", { threadId: "m2", model: "haiku" });
    expect(status).toBe(400);
    expect(sessions.start).not.toHaveBeenCalled();
  });

  it("POST /conversations/:id/suspend + resume flip status", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const s = await call(api, "POST", "/conversations/c1/suspend");
    expect((s.json as any).status).toBe("suspended");
    const r = await call(api, "POST", "/conversations/c1/resume");
    expect((r.json as any).status).toBe("running");
  });

  it("POST /conversations/:id/messages prompts the thread", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status } = await call(api, "POST", "/conversations/c1/messages", { text: "do it" });
    expect(status).toBe(202);
    expect(sessions.promptByThread).toHaveBeenCalledWith("c1", "do it");
  });

  it("GET /conversations/:id/history returns the event log", async () => {
    const events: AguiEvent[] = [
      { type: "RUN_STARTED", threadId: "c1", runId: "r" },
      { type: "RUN_FINISHED", threadId: "c1", runId: "r" },
    ];
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore(events), server: stubServer, answerPermission: async () => {} });
    const { json } = await call(api, "GET", "/conversations/c1/history");
    expect((json as any).events).toHaveLength(2);
  });

  it("POST /conversations stamps the caller (x-auth-user) as the owner", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const res = await call(api, "POST", "/conversations", { threadId: "owned" }, { "x-auth-user": "alice" });
    expect(res.status).toBe(201);
    // start() was called with (threadId, model, owner="alice").
    expect(sessions.start).toHaveBeenCalledWith("owned", undefined, "alice");
    expect((res.json as any).owner).toBe("alice");
  });

  it("GET /conversations?scope=mine returns only the caller's conversations", async () => {
    const sessions = fakeSessions();
    // alice + bob each own one; c1 (the seed) has no owner -> public.
    await sessions.start("a1", undefined, "alice");
    await sessions.start("b1", undefined, "bob");
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });

    const mine = await call(api, "GET", "/conversations?scope=mine", undefined, { "x-auth-user": "alice" });
    const ids = (mine.json as any[]).map((c) => c.id).sort();
    // alice's own + the null-owner public one; NOT bob's.
    expect(ids).toContain("a1");
    expect(ids).toContain("c1"); // null-owner is public
    expect(ids).not.toContain("b1");
  });

  it("GET /conversations?scope=all returns everything regardless of owner", async () => {
    const sessions = fakeSessions();
    await sessions.start("a1", undefined, "alice");
    await sessions.start("b1", undefined, "bob");
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const all = await call(api, "GET", "/conversations?scope=all", undefined, { "x-auth-user": "alice" });
    const ids = (all.json as any[]).map((c) => c.id).sort();
    expect(ids).toEqual(["a1", "b1", "c1"]);
  });

  it("GET /conversations default scope is 'mine'", async () => {
    const sessions = fakeSessions();
    await sessions.start("b1", undefined, "bob");
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const def = await call(api, "GET", "/conversations", undefined, { "x-auth-user": "alice" });
    const ids = (def.json as any[]).map((c) => c.id);
    expect(ids).not.toContain("b1"); // default = mine, so bob's is excluded
  });

  it("anonymous (no header) sees all conversations (single-user/dev unchanged)", async () => {
    const sessions = fakeSessions();
    await sessions.start("a1", undefined, "alice");
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    // No x-auth-user -> anonymous -> sees everything even at default scope.
    const res = await call(api, "GET", "/conversations");
    const ids = (res.json as any[]).map((c) => c.id).sort();
    expect(ids).toEqual(["a1", "c1"]);
  });

  it("GET /conversations includes each conversation's distinct link sources (for sidebar icons)", async () => {
    const store = fakeStore([]);
    const api = createManagementApi({ sessions: fakeSessions(), store, server: stubServer, answerPermission: async () => {} });
    // c1 has a github PR + a slack thread (+ a duplicate github -> distinct sources only).
    await call(api, "POST", "/conversations/c1/links", { source: "github", resourceType: "pull_request", url: "https://gh/pr/1" });
    await call(api, "POST", "/conversations/c1/links", { source: "slack", resourceType: "thread", title: "#eng" });
    await call(api, "POST", "/conversations/c1/links", { source: "github", resourceType: "issue", url: "https://gh/i/2" });

    const { json } = await call(api, "GET", "/conversations");
    const c1 = (json as any[]).find((c) => c.id === "c1");
    expect(c1).toBeDefined();
    // Distinct sources, sorted; a conversation with no links has [].
    expect([...c1.sources].sort()).toEqual(["github", "slack"]);
  });

  it("GET /conversations gives [] sources for a conversation with no links", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { json } = await call(api, "GET", "/conversations");
    const c1 = (json as any[]).find((c) => c.id === "c1");
    expect(c1.sources).toEqual([]);
  });

  it("POST then GET /conversations/:id/links round-trips an external link", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const post = await call(api, "POST", "/conversations/c1/links", {
      source: "github",
      resourceType: "pull_request",
      url: "https://github.com/example-org/example-app/pull/203",
      title: "example-org/example-app #203",
    });
    expect(post.status).toBe(201);
    const { json } = await call(api, "GET", "/conversations/c1/links");
    expect((json as any).links).toHaveLength(1);
    expect((json as any).links[0]).toMatchObject({ source: "github", resourceType: "pull_request" });
  });

  it("POST /conversations/:id/links rejects a missing source/type", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status } = await call(api, "POST", "/conversations/c1/links", { url: "x" });
    expect(status).toBe(400);
  });

  it("DELETE /conversations/:id ends it", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status } = await call(api, "DELETE", "/conversations/c1");
    expect(status).toBe(204);
    expect(sessions.end).toHaveBeenCalledWith("c1");
  });

  it("404 on an unknown conversation", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status } = await call(api, "GET", "/conversations/nope");
    expect(status).toBe(404);
  });
});
