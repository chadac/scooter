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

import { createManagementApi, raiseAwsApprovalInterrupt } from "../../src/api/management.js";
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

/** The SAME short DNS-safe hash the manager uses (session/manager.ts shortId) —
 *  the broker sends this, extracted from the sandbox SA name `sandbox-{shortId}`. */
function shortIdOf(threadId: string): string {
  let h = 0;
  for (let i = 0; i < threadId.length; i++) h = (h * 31 + threadId.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

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
    // Resolve by the short DNS-safe hash of the threadId (what the broker sends).
    getByShortId: vi.fn(async (shortHash) =>
      [...store.values()].find((c) => shortHash === shortIdOf(c.threadId)),
    ),
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

/** Drive a route capturing the RAW response (status + headers + Buffer body) —
 *  for the binary assets route. */
async function callRaw(
  api: ReturnType<typeof createManagementApi>,
  method: string,
  path: string,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
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
  return { status, headers, body: Buffer.concat(parts) };
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

  it("GET /conversations enriches each row with sources + a compact links summary", async () => {
    const store = fakeStore([]);
    // Attach a GitHub PR link to c1 (what the sidebar shows the name of / filters by).
    await store.addLink!("c1", {
      source: "github",
      resourceType: "pull_request",
      url: "https://github.com/org/app/pull/203",
      title: "org/app #203",
    });
    const api = createManagementApi({
      sessions: fakeSessions(),
      store,
      server: stubServer,
      answerPermission: async () => {},
    });
    const { json } = await call(api, "GET", "/conversations");
    const row = (json as any[]).find((c) => c.id === "c1");
    expect(row.sources).toEqual(["github"]);
    expect(row.links).toEqual([
      {
        source: "github",
        resourceType: "pull_request",
        url: "https://github.com/org/app/pull/203",
        title: "org/app #203",
      },
    ]);
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

  // --- GET /users/by-email (external-user identity mapping) --------------------

  const fakeIdentity = (byEmail: Record<string, string>) =>
    ({
      get: async () => undefined,
      put: async () => {},
      getByEmail: async (email: string) => {
        const id = byEmail[email.trim().toLowerCase()];
        return id ? { id } : undefined;
      },
      close: async () => {},
    }) as never;

  it("GET /users/by-email returns the Scooter user id for a matching email", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {},
      identityStore: fakeIdentity({ "alice@example.com": "user-alice" }),
    });
    const res = await call(api, "GET", "/users/by-email?email=Alice@Example.com");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: "user-alice" });
  });

  it("GET /users/by-email 404s an unmatched email", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {},
      identityStore: fakeIdentity({ "alice@example.com": "user-alice" }),
    });
    expect((await call(api, "GET", "/users/by-email?email=bob@example.com")).status).toBe(404);
  });

  it("GET /users/by-email 400s a missing email, 404s when no store is wired", async () => {
    const noStore = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    expect((await call(noStore, "GET", "/users/by-email")).status).toBe(400);
    expect((await call(noStore, "GET", "/users/by-email?email=x@y.io")).status).toBe(404);
  });

  it("GET /models returns the catalog (default + available + hints)", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {},
      models: { default: "opus", available: ["opus", "sonnet"], hints: { sonnet: "fast/cheap" } },
    });
    const { status, json } = await call(api, "GET", "/models");
    expect(status).toBe(200);
    expect(json).toEqual({ default: "opus", available: ["opus", "sonnet"], hints: { sonnet: "fast/cheap" } });
  });

  it("GET /models defaults hints to {} when unset", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {},
      models: { default: "opus", available: ["opus"] },
    });
    const { json } = await call(api, "GET", "/models");
    expect(json).toEqual({ default: "opus", available: ["opus"], hints: {} });
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

  it("GET /conversations/:id/tail?runs=N windows the log to the last N runs", async () => {
    const mkRun = (n: number): AguiEvent[] => [
      { type: "RUN_STARTED", threadId: "c1", runId: `r${n}` },
      { type: "TEXT_MESSAGE_START", messageId: `m${n}`, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: `m${n}`, delta: `t${n}` },
      { type: "TEXT_MESSAGE_END", messageId: `m${n}` },
      { type: "RUN_FINISHED", threadId: "c1", runId: `r${n}` },
    ];
    const events = [...mkRun(1), ...mkRun(2), ...mkRun(3)];
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore(events), server: stubServer, answerPermission: async () => {} });
    const { json } = await call(api, "GET", "/conversations/c1/tail?runs=1");
    const body = json as any;
    expect(body.runs).toBe(1);
    // Only the last run's events, starting at its RUN_STARTED (the store here has
    // no readEventsTail, so this exercises the read-all + tailByRuns fallback).
    expect(body.events[0]).toMatchObject({ type: "RUN_STARTED", runId: "r3" });
    expect(body.events.filter((e: any) => e.type === "RUN_STARTED")).toHaveLength(1);
  });

  // --- image assets route (multimodal replay) ---------------------------------

  function fakeAssets() {
    return {
      read: vi.fn(async (id: string, assetId: string) =>
        id === "c1" && assetId === "img1.png" ? { data: Buffer.from([1, 2, 3, 4]), mimeType: "image/png" } : null,
      ),
      put: vi.fn(),
      clear: vi.fn(),
      urlFor: (id: string, assetId: string) => `/conversations/${id}/assets/${assetId}`,
    } as never;
  }

  it("GET /conversations/:id/assets/:assetId streams the bytes with the right content-type", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {}, assets: fakeAssets(),
    });
    const { status, headers, body } = await callRaw(api, "GET", "/conversations/c1/assets/img1.png");
    expect(status).toBe(200);
    expect(headers["Content-Type"]).toBe("image/png");
    expect(body.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });

  it("GET assets 404s an unknown asset", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {}, assets: fakeAssets(),
    });
    const { status } = await callRaw(api, "GET", "/conversations/c1/assets/nope.png");
    expect(status).toBe(404);
  });

  it("GET assets 404s when assets are not enabled", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status } = await callRaw(api, "GET", "/conversations/c1/assets/img1.png");
    expect(status).toBe(404);
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

  it("links routes resolve the broker's SHORT id to the full conversation", async () => {
    // The broker (auto-link injector + /link) identifies the conversation by the
    // short DNS hash from the SA token, NOT the full threadId. A link posted under
    // the short id must land on — and read back under — the full conversation, or
    // it's the same silent shortId mismatch that broke aws-request.
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const short = shortIdOf("c1");
    const post = await call(api, "POST", `/conversations/${short}/links`, {
      source: "github",
      resourceType: "pr",
      url: "https://github.com/example-org/example-app/pull/7",
    });
    expect(post.status).toBe(201);
    // Readable back under BOTH the short id and the full threadId.
    const viaShort = await call(api, "GET", `/conversations/${short}/links`);
    const viaFull = await call(api, "GET", "/conversations/c1/links");
    expect((viaShort.json as any).links).toHaveLength(1);
    expect((viaFull.json as any).links).toHaveLength(1);
    expect((viaFull.json as any).links[0].url).toBe("https://github.com/example-org/example-app/pull/7");
  });

  it("accepts a link for a NOT-YET-EXISTENT conversation (the Slack on_created pre-run flow)", async () => {
    // REGRESSION (broker-autolink #118 gated POST /links behind resolveConvId and
    // 404'd when the conversation didn't exist yet). The Slack webhook registers
    // the thread link in its on_created hook — BEFORE /agui creates the session —
    // to anchor the first reply to the thread. That POST must be accepted and
    // written under the (full threadId) raw id, so it's readable once the
    // conversation materializes. A 404 here silently dropped every Slack link.
    const store = fakeStore([]);
    const api = createManagementApi({ sessions: fakeSessions(), store, server: stubServer, answerPermission: async () => {} });
    const threadId = "brand-new-thread-uuid";
    const post = await call(api, "POST", `/conversations/${threadId}/links`, {
      source: "slack",
      resourceType: "thread",
      title: "#eng thread",
      ref: { channel: "C1", threadTs: "1700.5" },
    });
    expect(post.status).toBe(201);
    // Readable back under that same id (what the conversation will be keyed by).
    const { json } = await call(api, "GET", `/conversations/${threadId}/links`);
    expect((json as any).links).toHaveLength(1);
    expect((json as any).links[0]).toMatchObject({ source: "slack", resourceType: "thread" });
  });

  // --- web services (Services panel: list + start) ----------------------------

  function fakeWebServices(over: Partial<Record<string, unknown>> = {}) {
    const running = new Set<string>();
    return {
      list: async () => [{ name: "marimo", displayName: "marimo", port: 2718, basePath: "/c/c1/marimo", unit: "webservice-marimo" }],
      get: async (_id: string, name: string) =>
        name === "marimo" ? { name, displayName: "marimo", port: 2718, basePath: "/c/c1/marimo", unit: "webservice-marimo" } : null,
      isRunning: async (_id: string, name: string) => running.has(name),
      start: async (_id: string, name: string) => { running.add(name); },
      invalidate: () => {},
      ...over,
    } as never;
  }

  it("GET /conversations/:id/web-services lists services with a URL + running state", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer,
      answerPermission: async () => {}, webServices: fakeWebServices(),
    });
    const { status, json } = await call(api, "GET", "/conversations/c1/web-services");
    expect(status).toBe(200);
    const svc = (json as any).services[0];
    expect(svc).toMatchObject({ name: "marimo", running: false });
    expect(svc.url).toBe("/c/c1/marimo/"); // opens under the full threadId
  });

  it("GET web-services returns [] when the registry is unwired (fake/local mode)", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { json } = await call(api, "GET", "/conversations/c1/web-services");
    expect((json as any).services).toEqual([]);
  });

  it("POST .../web-services/:name/start starts it (202) and it reads back running", async () => {
    const web = fakeWebServices();
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer,
      answerPermission: async () => {}, webServices: web,
    });
    const started = await call(api, "POST", "/conversations/c1/web-services/marimo/start");
    expect(started.status).toBe(202);
    const { json } = await call(api, "GET", "/conversations/c1/web-services");
    expect((json as any).services[0].running).toBe(true);
  });

  it("POST start 404s an unknown service, 404s an unknown conversation", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer,
      answerPermission: async () => {}, webServices: fakeWebServices(),
    });
    expect((await call(api, "POST", "/conversations/c1/web-services/nope/start")).status).toBe(404);
    expect((await call(api, "POST", "/conversations/nope/web-services/marimo/start")).status).toBe(404);
  });

  it("POST start maps a systemctl failure to 502", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer,
      answerPermission: async () => {},
      webServices: fakeWebServices({ start: async () => { throw new Error("unit failed"); } }),
    });
    const { status } = await call(api, "POST", "/conversations/c1/web-services/marimo/start");
    expect(status).toBe(502);
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

  describe("POST /conversations/:id/aws-request (approval interrupt)", () => {
    // A full-UUID conversation with a live bridge — so its short hash != its id,
    // reproducing the broker keying that used to 404.
    const UUID = "aee8b191-a4ca-4cb5-81f0-ffd058a89663";
    const SHORT = shortIdOf(UUID);

    const sessionsWithBridge = (opts: { bridge?: boolean } = {}) => {
      const raiseInterrupt = vi.fn();
      const bridge = opts.bridge === false ? undefined : ({ raiseInterrupt } as never);
      const c = conv({ id: UUID, threadId: UUID, bridge });
      const map = new Map<string, Conversation>([[UUID, c]]);
      const sessions = {
        ...fakeSessions(),
        get: (id: string) => map.get(id),
        getByShortId: vi.fn(async (h: string) =>
          [...map.values()].find((cc) => shortIdOf(cc.threadId) === h),
        ),
        revive: vi.fn(async (id: string) => {
          // Revive rebuilds the bridge on the existing conversation.
          const cc = conv({ id, threadId: id, status: "running", bridge: { raiseInterrupt } as never });
          map.set(id, cc);
          return cc;
        }),
      } as unknown as SessionManager;
      return { sessions, raiseInterrupt };
    };

    const awsBody = { request_id: "req-1", target_account: "dev", risk_level: "low", policy_summary: "s3:GetObject", justification: "read state" };

    it("resolves by the SHORT id the broker sends (not just the full threadId) and raises the interrupt", async () => {
      const { sessions, raiseInterrupt } = sessionsWithBridge();
      const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
      // The broker POSTs the SHORT hash — the pre-fix route did get(SHORT) -> 404.
      const { status } = await call(api, "POST", `/conversations/${SHORT}/aws-request`, awsBody);
      expect(status).toBe(202);
      expect(raiseInterrupt).toHaveBeenCalledOnce();
      expect((raiseInterrupt.mock.calls[0][0] as { id: string }).id).toBe("req-1");
    });

    it("still resolves by the FULL threadId (UI/webhooks path unchanged)", async () => {
      const { sessions, raiseInterrupt } = sessionsWithBridge();
      const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
      const { status } = await call(api, "POST", `/conversations/${UUID}/aws-request`, awsBody);
      expect(status).toBe(202);
      expect(raiseInterrupt).toHaveBeenCalledOnce();
    });

    it("REVIVES a conversation with no live bridge, then raises (idle-suspended path)", async () => {
      const { sessions, raiseInterrupt } = sessionsWithBridge({ bridge: false });
      const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
      const { status } = await call(api, "POST", `/conversations/${SHORT}/aws-request`, awsBody);
      expect(sessions.revive).toHaveBeenCalledWith(UUID); // revived by the RESOLVED id
      expect(status).toBe(202);
      expect(raiseInterrupt).toHaveBeenCalledOnce();
    });

    it("404s a genuinely unknown conversation (neither full nor short id matches)", async () => {
      const { sessions } = sessionsWithBridge();
      const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
      const { status } = await call(api, "POST", `/conversations/totally-unknown/aws-request`, awsBody);
      expect(status).toBe(404);
    });

    it("400s without a request_id", async () => {
      const { sessions } = sessionsWithBridge();
      const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
      const { status } = await call(api, "POST", `/conversations/${SHORT}/aws-request`, { target_account: "dev" });
      expect(status).toBe(400);
    });
  });

  describe("raiseAwsApprovalInterrupt (shared builder — route + revive re-raise)", () => {
    it("raises an Approve/Deny interrupt tagged aws, and routes the answer to resolveAwsRequest", async () => {
      const raiseInterrupt = vi.fn();
      const bridge = { raiseInterrupt } as never;
      const resolveAwsRequest = vi.fn(async () => {});
      raiseAwsApprovalInterrupt(bridge, "conv-1", { request_id: "req-9", target_account: "prod", risk_level: "high" }, resolveAwsRequest);

      const arg = raiseInterrupt.mock.calls[0][0] as {
        id: string; metadata: { aws: boolean; requestId: string };
        options: Array<{ optionId: string }>; onAnswer: (o: string, a?: unknown) => void;
      };
      expect(arg.id).toBe("req-9");
      expect(arg.metadata).toMatchObject({ aws: true, requestId: "req-9" });
      expect(arg.options.map((o) => o.optionId)).toEqual(["approve", "deny"]);

      // Answering "approve" routes to the broker with approved=true.
      arg.onAnswer("approve", { id: "u@x" });
      await Promise.resolve();
      expect(resolveAwsRequest).toHaveBeenCalledWith("conv-1", "req-9", true, { id: "u@x" });

      // Answering "deny" -> approved=false; the approver falls back to the conv id.
      arg.onAnswer("deny", undefined);
      await Promise.resolve();
      expect(resolveAwsRequest).toHaveBeenCalledWith("conv-1", "req-9", false, { id: "conv-1" });
    });
  });

  describe("POST /conversations/:id/cancel (Stop button)", () => {
    const sessionsWithCancel = (opts: { bridge?: boolean } = {}) => {
      const cancel = vi.fn(async () => {});
      const bridge = opts.bridge === false ? undefined : ({ cancel } as never);
      const c = conv({ id: "c1", threadId: "c1", bridge });
      const map = new Map<string, Conversation>([["c1", c]]);
      const sessions = { ...fakeSessions(), get: (id: string) => map.get(id) } as unknown as SessionManager;
      return { sessions, cancel };
    };

    it("calls bridge.cancel() on the running conversation (202)", async () => {
      const { sessions, cancel } = sessionsWithCancel();
      const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
      const { status } = await call(api, "POST", "/conversations/c1/cancel");
      expect(status).toBe(202);
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("is a no-op-OK (202) when the conversation has no live bridge", async () => {
      const { sessions } = sessionsWithCancel({ bridge: false });
      const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
      const { status } = await call(api, "POST", "/conversations/c1/cancel");
      expect(status).toBe(202); // stopping "nothing" still succeeds — a stale click never errors
    });

    it("404s an unknown conversation", async () => {
      const { sessions } = sessionsWithCancel();
      const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
      const { status } = await call(api, "POST", "/conversations/nope/cancel");
      expect(status).toBe(404);
    });
  });
});
