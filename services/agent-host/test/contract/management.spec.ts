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

import { createManagementApi, raiseAwsApprovalInterrupt, fetchPendingAwsRequests } from "../../src/api/management.js";
import { shortId } from "../../src/session/manager.js";
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
    // Read-only hydrate: true iff the conversation exists (in the fake store). Faithful to
    // the real ensureReadable — the read routes call it before deciding to 404.
    ensureReadable: vi.fn(async (id) => store.has(id)),
    reviveFromMirror: vi.fn(async () => {}),
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
      // Mirror the real no-op-once-user-titled behavior so route tests are faithful.
      if (c && !c.userTitled) store.set(id, conv({ ...c, title }));
      return Promise.resolve();
    }),
    setUserTitle: vi.fn((id, title) => {
      const c = store.get(id);
      if (c) store.set(id, conv({ ...c, title, userTitled: true }));
      return Promise.resolve();
    }),
    setStarred: vi.fn((id, starred) => {
      const c = store.get(id);
      if (c) store.set(id, conv({ ...c, starred }));
      return Promise.resolve();
    }),
    sweepIdle: vi.fn(async () => []),
    sweepRetention: vi.fn(async () => []),
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
  // POST /conversations exists here for SINGLE-REPLICA (and e2e, which runs the agent-host
  // with no router in front). In multi-replica the conversation-router serves this path
  // itself — a control-plane CR write that consults no agent-host capacity — and never
  // proxies it here. What both share is that the SERVER mints the id.
  it("POST /conversations mints the id SERVER-side and returns 201", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({
      sessions,
      store: fakeStore([]),
      server: stubServer,
      answerPermission: async () => {},
    });

    const res = await call(api, "POST", "/conversations", { title: "hello" });

    expect(res.status).toBe(201);
    expect((res.json as { id?: string }).id).toBeTruthy();
  });

  it("POST /conversations IGNORES a caller-supplied threadId", async () => {
    // The regression that matters. The old route honored body.threadId, which made an
    // unvalidated, caller-chosen string into a conversation id, an event-log key, and a
    // k8s resource name.
    const sessions = fakeSessions();
    const api = createManagementApi({
      sessions,
      store: fakeStore([]),
      server: stubServer,
      answerPermission: async () => {},
    });

    const res = await call(api, "POST", "/conversations", { threadId: "attacker-chosen-id" });

    expect(res.status).toBe(201);
    expect((res.json as { id?: string }).id).not.toBe("attacker-chosen-id");
  });

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

  it("GET /conversations exposes parentId so the UI can nest subagents", async () => {
    const s = fakeSessions();
    // c1 is top-level (no parentId); add a subagent child of c1.
    const withChild: SessionManager = {
      ...s,
      list: () => [
        conv({ id: "c1", threadId: "c1", title: "Parent" }),
        conv({ id: "sub1", threadId: "sub1", title: "Subagent", parentId: "c1" as any }),
      ],
    };
    const api = createManagementApi({ sessions: withChild, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { json } = await call(api, "GET", "/conversations");
    const rows = json as Array<{ id: string; parentId?: string }>;
    expect(rows.find((r) => r.id === "c1")?.parentId).toBeUndefined();
    expect(rows.find((r) => r.id === "sub1")?.parentId).toBe("c1");
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

  // --- user rename + starring ------------------------------------------------

  it("PATCH /conversations/:id/title renames + locks (userTitled) — anonymous single-user", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status, json } = await call(api, "PATCH", "/conversations/c1/title", { title: "  My pinned name  " });
    expect(status).toBe(200);
    expect(sessions.setUserTitle).toHaveBeenCalledWith("c1", "My pinned name"); // trimmed
    expect((json as any).title).toBe("My pinned name");
    expect((json as any).userTitled).toBe(true);
  });

  it("PATCH /conversations/:id/title rejects a blank title (400)", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status } = await call(api, "PATCH", "/conversations/c1/title", { title: "   " });
    expect(status).toBe(400);
  });

  it("PATCH /conversations/:id/title 404s an unknown conversation", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status } = await call(api, "PATCH", "/conversations/nope/title", { title: "x" });
    expect(status).toBe(404);
  });

  it("PATCH title 403s when another identified user owns the conversation", async () => {
    const sessions = fakeSessions();
    // c1 owned by bob; alice tries to rename it.
    (sessions.get("c1") as any).owner = "bob";
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status } = await call(api, "PATCH", "/conversations/c1/title", { title: "x" }, { "x-auth-user": "alice" });
    expect(status).toBe(403);
    expect(sessions.setUserTitle).not.toHaveBeenCalled();
  });

  it("PATCH title is allowed for the OWNER", async () => {
    const sessions = fakeSessions();
    (sessions.get("c1") as any).owner = "alice";
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status } = await call(api, "PATCH", "/conversations/c1/title", { title: "mine" }, { "x-auth-user": "alice" });
    expect(status).toBe(200);
    expect(sessions.setUserTitle).toHaveBeenCalledWith("c1", "mine");
  });

  it("PATCH /conversations/:id/starred toggles the star", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const on = await call(api, "PATCH", "/conversations/c1/starred", { starred: true });
    expect(on.status).toBe(200);
    expect(sessions.setStarred).toHaveBeenCalledWith("c1", true);
    expect((on.json as any).starred).toBe(true);

    const off = await call(api, "PATCH", "/conversations/c1/starred", { starred: false });
    expect((off.json as any).starred).toBe(false);
  });

  it("PATCH starred rejects a non-boolean body (400)", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status } = await call(api, "PATCH", "/conversations/c1/starred", { starred: "yes" });
    expect(status).toBe(400);
  });

  it("GET /conversations/:id/resources returns the sandbox size when wired", async () => {
    const size = { requests: { cpu: "500m", memory: "1Gi" }, limits: { memory: "4Gi" } };
    const api = createManagementApi({
      sessions: fakeSessions(),
      store: fakeStore([]),
      server: stubServer,
      answerPermission: async () => {},
      sandboxResources: async () => size,
    });
    const { status, json } = await call(api, "GET", "/conversations/c1/resources");
    expect(status).toBe(200);
    expect((json as any).resources).toEqual(size);
  });

  it("GET /conversations/:id/resources -> {resources:null} when unwired (fake/no-broker)", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status, json } = await call(api, "GET", "/conversations/c1/resources");
    expect(status).toBe(200);
    expect((json as any).resources).toBeNull();
  });

  it("GET /conversations/:id/resources -> null on a getter error (never 500s the tab)", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(),
      store: fakeStore([]),
      server: stubServer,
      answerPermission: async () => {},
      sandboxResources: async () => {
        throw new Error("broker down");
      },
    });
    const { status, json } = await call(api, "GET", "/conversations/c1/resources");
    expect(status).toBe(200);
    expect((json as any).resources).toBeNull();
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
      list: async () =>
        Object.entries(byEmail).map(([email, id]) => ({ id, email, name: undefined, updatedAt: undefined })),
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

  // --- GET /users (settings Users page) ----------------------------------------

  it("GET /users lists the learned users when an identity store is wired", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {},
      identityStore: fakeIdentity({ "alice@example.com": "user-alice", "bob@example.com": "user-bob" }),
    });
    const { status, json } = await call(api, "GET", "/users");
    expect(status).toBe(200);
    expect((json as { configured: boolean }).configured).toBe(true);
    expect((json as { users: Array<{ id: string }> }).users.map((u) => u.id).sort()).toEqual(["user-alice", "user-bob"]);
  });

  it("GET /users 501s (configured:false via the client) when no identity store is wired", async () => {
    const noStore = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const res = await call(noStore, "GET", "/users");
    expect(res.status).toBe(501);
    expect((res.json as { error: string }).error).toMatch(/identity store not configured/);
  });

  it("GET /models returns the catalog (default + available + hints)", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {},
      models: { default: "opus", available: ["opus", "sonnet"], hints: { sonnet: "fast/cheap" } },
    });
    const { status, json } = await call(api, "GET", "/models");
    expect(status).toBe(200);
    expect(json).toEqual({
      default: "opus", available: ["opus", "sonnet"], hints: { sonnet: "fast/cheap" },
      providers: {}, // id -> provider tags offering it; {} when the deployment doesn't tag
    });
  });

  it("GET /models defaults hints to {} when unset", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {},
      models: { default: "opus", available: ["opus"] },
    });
    const { json } = await call(api, "GET", "/models");
    expect(json).toEqual({ default: "opus", available: ["opus"], hints: {}, providers: {} });
  });

  it("POST /conversations/:id/suspend + resume flip status", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const s = await call(api, "POST", "/conversations/c1/suspend");
    expect((s.json as any).status).toBe("suspended");
    const r = await call(api, "POST", "/conversations/c1/resume");
    expect((r.json as any).status).toBe("running");
  });

  it("POST /conversations/:id/compact compacts (202) then revives", async () => {
    const sessions = fakeSessions();
    const compact = vi.fn(async () => ({ summarizedTurns: 8, keptRuns: 3 }));
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {}, compact });
    const { status, json } = await call(api, "POST", "/conversations/c1/compact");
    expect(status).toBe(202);
    expect((json as any).compacted).toBe(true);
    expect(compact).toHaveBeenCalledWith("c1");
    expect(sessions.revive).toHaveBeenCalledWith("c1"); // revive AFTER a successful compact
  });

  it("POST compact → 200 compacted:false when too short (no revive)", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {}, compact: async () => null });
    const { status, json } = await call(api, "POST", "/conversations/c1/compact");
    expect(status).toBe(200);
    expect((json as any).compacted).toBe(false);
    expect(sessions.revive).not.toHaveBeenCalled();
  });

  it("POST compact → 502 on a summarizer failure, conversation untouched (no revive)", async () => {
    const sessions = fakeSessions();
    const api = createManagementApi({
      sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {},
      compact: async () => { throw new Error("LLM down"); },
    });
    const { status } = await call(api, "POST", "/conversations/c1/compact");
    expect(status).toBe(502);
    expect(sessions.revive).not.toHaveBeenCalled();
  });

  it("POST compact → 501 when compaction is unwired (no token)", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    expect((await call(api, "POST", "/conversations/c1/compact")).status).toBe(501);
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

  it("GET /conversations?scope=mine returns STRICTLY the caller's own (not others, not unowned)", async () => {
    const sessions = fakeSessions();
    // alice + bob each own one; c1 (the seed) has no owner -> unowned.
    await sessions.start("a1", undefined, "alice");
    await sessions.start("b1", undefined, "bob");
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });

    const mine = await call(api, "GET", "/conversations?scope=mine", undefined, { "x-auth-user": "alice" });
    const ids = (mine.json as any[]).map((c) => c.id).sort();
    // ONLY alice's own. For a known user, Mine no longer leaks unowned (c1) or
    // others' (b1) — an unowned conversation is All-only (see the scope=all test).
    expect(ids).toEqual(["a1"]);
  });

  it("GET /conversations?scope=mine for an ANONYMOUS caller still shows everything (dev-friendly)", async () => {
    const sessions = fakeSessions();
    await sessions.start("a1", undefined, "alice");
    await sessions.start("b1", undefined, "bob");
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    // No x-auth-user -> anonymous -> can't distinguish -> sees all.
    const mine = await call(api, "GET", "/conversations?scope=mine");
    const ids = (mine.json as any[]).map((c) => c.id).sort();
    expect(ids).toEqual(["a1", "b1", "c1"]);
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
      stop: async (_id: string, name: string) => { running.delete(name); },
      logs: async () => "",
      ready: async () => true,
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

  it("GET web-services?refresh=1 forces a manifest re-read", async () => {
    // The Rescan button: the agent declared a service with `scooter-rebuild` and
    // nothing in the pod told the host, so the user needs a way to say "look again".
    const seen: Array<boolean | undefined> = [];
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer,
      answerPermission: async () => {},
      webServices: fakeWebServices({
        list: async (_id: string, opts?: { force?: boolean }) => {
          seen.push(opts?.force);
          return [{ name: "marimo", displayName: "marimo", port: 2718, basePath: "/c/c1/marimo", unit: "webservice-marimo" }];
        },
      }),
    });
    await call(api, "GET", "/conversations/c1/web-services");
    await call(api, "GET", "/conversations/c1/web-services?refresh=1");
    expect(seen).toEqual([false, true]);
  });

  it("GET web-services returns [] when the registry is unwired (fake/local mode)", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { json } = await call(api, "GET", "/conversations/c1/web-services");
    expect((json as any).services).toEqual([]);
  });

  it("GET /conversations/:id/ready probes actual pod readiness for a running conversation", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer,
      answerPermission: async () => {}, webServices: fakeWebServices({ ready: async () => true }),
    });
    const { json } = await call(api, "GET", "/conversations/c1/ready");
    expect(json).toEqual({ ready: true, status: "running" });
  });

  it("GET /ready reports ready:false when the pod exec probe fails (ContainerCreating)", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer,
      answerPermission: async () => {}, webServices: fakeWebServices({ ready: async () => false }),
    });
    const { json } = await call(api, "GET", "/conversations/c1/ready");
    expect(json).toEqual({ ready: false, status: "running" });
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

  // --- Modules (search / list attached / install) ------------------------------

  const fakeModules = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      search: async (_id: string, _q: string) => [
        { id: 1, name: "gpu-tools", description: "CUDA", visibility: "public", owner: "c-2" },
      ],
      attached: async () => ["gpu-tools"],
      install: async (_id: string, ref: string) => `attached ${ref} — applying...`,
      ...over,
    }) as never;

  it("GET /conversations/:id/module-registry returns modules + attached flag", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer,
      answerPermission: async () => {}, moduleRegistry: fakeModules(),
    });
    const { status, json } = await call(api, "GET", "/conversations/c1/module-registry?q=gpu");
    expect(status).toBe(200);
    expect((json as any).configured).toBe(true);
    expect((json as any).modules[0]).toMatchObject({ name: "gpu-tools", attached: true });
  });

  it("module-registry 501s (configured:false) when unwired (fake/local mode)", async () => {
    const api = createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status, json } = await call(api, "GET", "/conversations/c1/module-registry");
    expect(status).toBe(501);
    expect((json as any).configured).toBe(false);
  });

  it("POST .../modules/:ref/install attaches (202) with the CLI message", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer,
      answerPermission: async () => {}, moduleRegistry: fakeModules(),
    });
    const { status, json } = await call(api, "POST", "/conversations/c1/modules/gpu-tools/install");
    expect(status).toBe(202);
    expect((json as any).message).toContain("attached gpu-tools");
  });

  it("POST install maps an install failure to 502", async () => {
    const api = createManagementApi({
      sessions: fakeSessions(), store: fakeStore([]), server: stubServer,
      answerPermission: async () => {},
      moduleRegistry: fakeModules({ install: async () => { throw new Error("not found"); } }),
    });
    const { status } = await call(api, "POST", "/conversations/c1/modules/nope/install");
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

  it("GET /conversations/:id hydrates a conversation absent from memory (moved by a rollout) instead of 404ing", async () => {
    // Simulate a reconnect landing on a pod that doesn't have the conversation in memory but
    // CAN make it readable (ensureReadable pulls it from the mirror). Must NOT 404.
    const s = fakeSessions();
    const map = new Map<string, Conversation>();
    const sessions = {
      ...s,
      get: (id: string) => map.get(id),
      // Not in memory yet, but hydratable → register it and report readable.
      ensureReadable: vi.fn(async (id: string) => { map.set(id, conv({ id, threadId: id, status: "suspended" })); return true; }),
    } as unknown as SessionManager;
    const api = createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} });
    const { status } = await call(api, "GET", "/conversations/moved-1");
    expect(status).not.toBe(404);
    expect(sessions.ensureReadable).toHaveBeenCalledWith("moved-1");
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

  describe("fetchPendingAwsRequests (revive re-raise query — the short-id id-space)", () => {
    // Regression for scooter-bug-reraise-pending-uses-threadid-not-shortid: the re-raise path queried
    // the broker with the thread UUID, but the broker keys AWS requests by the sandbox SHORT-id, so it
    // got [] and the Approve window never reappeared after a rollout/resume/revive.
    const UUID = "5e1949ce-c98c-4c52-bb43-afe923b040ce";
    const SHORT = shortId(UUID); // what the broker actually keys on

    const mockFetch = (byShortId: Record<string, unknown[]>) =>
      vi.fn(async (url: string) => {
        const convId = new URL(url).searchParams.get("conversation_id") ?? "";
        return {
          ok: true,
          status: 200,
          json: async () => ({ requests: byShortId[convId] ?? [] }),
        } as Response;
      });

    it("queries the broker by the SHORT-id (not the thread UUID) so pending requests are found", async () => {
      // The broker holds the request under the short-id ONLY (as it does in production).
      const fetchFn = mockFetch({ [SHORT]: [{ request_id: "req-pending-1" }] });
      vi.stubGlobal("fetch", fetchFn);
      try {
        // The caller (index.ts) resolves shortId(id) before calling — assert that's what hits the wire.
        const pending = await fetchPendingAwsRequests("http://broker:8080", shortId(UUID), {});
        expect(fetchFn).toHaveBeenCalledOnce();
        const calledUrl = new URL(fetchFn.mock.calls[0][0] as string);
        expect(calledUrl.searchParams.get("conversation_id")).toBe(SHORT);
        expect(calledUrl.searchParams.get("conversation_id")).not.toBe(UUID); // the bug
        expect(pending).toEqual([{ request_id: "req-pending-1" }]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("returns [] (not throw) on a 404/501 no-broker response, and drops rows without a request_id", async () => {
      const fetch404 = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
      vi.stubGlobal("fetch", fetch404);
      try {
        expect(await fetchPendingAwsRequests("http://broker:8080", SHORT, {})).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
      const fetchJunk = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ requests: [{ request_id: "ok" }, { target_account: "no-id" }] }),
      }) as Response);
      vi.stubGlobal("fetch", fetchJunk);
      try {
        expect(await fetchPendingAwsRequests("http://broker:8080", SHORT, {})).toEqual([{ request_id: "ok" }]);
      } finally {
        vi.unstubAllGlobals();
      }
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

  // --- Scheduled-tasks proxy (UI settings page) --------------------------------
  // The /scheduled-tasks routes forward to the scheduler client scoped to the CALLER
  // (x-auth-user), so a user only manages their own tasks. Absent client -> 501;
  // anonymous -> 401.
  describe("scheduled-tasks proxy", () => {
    const task = (over: Record<string, unknown> = {}) => ({
      id: "t1", title: "Daily", prompt: "check", cron: "0 9 * * *", timezone: "UTC",
      owner: "alice", enabled: true, next_run_at: null, last_run_at: null, ...over,
    });

    /** A fake SchedulerClient recording the owner it was called for. A null owner and
     *  "" are the same unowned bucket (the caller sends null for anonymous). */
    function fakeScheduler(seed: Array<ReturnType<typeof task>> = []) {
      const calls: Array<{ method: string; owner: string | null }> = [];
      const owns = (t: { owner: string }, owner: string | null) => t.owner === (owner ?? "");
      const client = {
        async list(owner: string | null) { calls.push({ method: "list", owner }); return seed.filter((t) => owns(t, owner)); },
        async get(owner: string | null, id: string) { calls.push({ method: "get", owner }); return seed.find((t) => t.id === id && owns(t, owner)) ?? null; },
        async create(owner: string | null, body: Record<string, unknown>) { calls.push({ method: "create", owner }); return task({ ...body, owner: owner ?? "", id: "new" }); },
        async patch(owner: string | null, id: string, body: Record<string, unknown>) { calls.push({ method: "patch", owner }); const t = seed.find((x) => x.id === id && owns(x, owner)); return t ? task({ ...t, ...body }) : null; },
        async del(owner: string | null, id: string) { calls.push({ method: "del", owner }); return seed.some((t) => owns(t, owner) && t.id === id); },
        async runs(owner: string | null) { calls.push({ method: "runs", owner }); return []; },
      };
      return { client, calls };
    }

    const mk = (scheduler?: ReturnType<typeof fakeScheduler>["client"]) =>
      createManagementApi({ sessions: fakeSessions(), store: fakeStore([]), server: stubServer, answerPermission: async () => {}, scheduler });

    it("501s when the scheduler isn't configured", async () => {
      const res = await call(mk(undefined), "GET", "/scheduled-tasks", undefined, { "x-auth-user": "alice" });
      expect(res.status).toBe(501);
    });

    it("anonymous caller uses the unowned bucket (null owner is fine, not a refusal)", async () => {
      const { client, calls } = fakeScheduler([task({ owner: "" }), task({ id: "t2", owner: "alice" })]);
      const res = await call(mk(client), "GET", "/scheduled-tasks");
      expect(res.status).toBe(200);
      expect(calls[0]).toEqual({ method: "list", owner: null }); // scopeOwner -> null for anon
      const ids = (res.json as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
      expect(ids).toEqual(["t1"]); // only the unowned task
    });

    it("GET lists only the caller's tasks (scoped by x-auth-user)", async () => {
      const { client, calls } = fakeScheduler([task(), task({ id: "t2", owner: "bob" })]);
      const res = await call(mk(client), "GET", "/scheduled-tasks", undefined, { "x-auth-user": "alice" });
      expect(res.status).toBe(200);
      const tasks = (res.json as { tasks: Array<{ id: string }> }).tasks;
      expect(tasks.map((t) => t.id)).toEqual(["t1"]); // bob's t2 excluded
      expect(calls[0]).toEqual({ method: "list", owner: "alice" });
    });

    it("POST creates a task for the caller (owner = x-auth-user)", async () => {
      const { client, calls } = fakeScheduler();
      const res = await call(mk(client), "POST", "/scheduled-tasks",
        { title: "Morning", prompt: "do X", cron: "0 8 * * *" }, { "x-auth-user": "alice" });
      expect(res.status).toBe(201);
      expect(calls.at(-1)).toEqual({ method: "create", owner: "alice" });
    });

    it("POST 400s a missing required field", async () => {
      const { client } = fakeScheduler();
      const res = await call(mk(client), "POST", "/scheduled-tasks", { title: "x" }, { "x-auth-user": "alice" });
      expect(res.status).toBe(400);
    });

    it("PATCH edits a scoped task; 404 for someone else's", async () => {
      const { client } = fakeScheduler([task()]);
      const ok = await call(mk(client), "PATCH", "/scheduled-tasks/t1", { enabled: false }, { "x-auth-user": "alice" });
      expect(ok.status).toBe(200);
      const nope = await call(mk(fakeScheduler([task({ id: "t9", owner: "bob" })]).client),
        "PATCH", "/scheduled-tasks/t9", { enabled: false }, { "x-auth-user": "alice" });
      expect(nope.status).toBe(404); // bob's task isn't visible to alice
    });

    it("DELETE removes a scoped task (204); 404 for another owner's", async () => {
      const gone = await call(mk(fakeScheduler([task()]).client), "DELETE", "/scheduled-tasks/t1", undefined, { "x-auth-user": "alice" });
      expect(gone.status).toBe(204);
      const nope = await call(mk(fakeScheduler([task({ id: "t9", owner: "bob" })]).client), "DELETE", "/scheduled-tasks/t9", undefined, { "x-auth-user": "alice" });
      expect(nope.status).toBe(404);
    });
  });

  describe("DELETE / suspend cross-replica + starred guard", () => {
    // A DELETE routed to a pod that doesn't hold the conversation in memory must HYDRATE it
    // (ensureReadable) before deciding — else it 404s and leaks the sandbox (the multi-replica
    // DELETE-404 leak). And a STARRED conversation must be protected from deletion.
    const mkApi = (over: Partial<Conversation>, opts: { inMemory?: boolean } = {}) => {
      const c = conv({ id: "cx", threadId: "cx", ...over });
      const durable = new Map<string, Conversation>([["cx", c]]); // "exists" (hydratable)
      const memory = new Map<string, Conversation>();             // in THIS pod's memory
      if (opts.inMemory) memory.set("cx", c);
      const sessions = {
        ...fakeSessions(),
        get: (id: string) => memory.get(id),
        // Faithful ensureReadable: hydrates a durable conversation INTO memory so the
        // subsequent get() succeeds (the real behavior the routes rely on). Returns whether
        // it now exists in memory.
        ensureReadable: vi.fn(async (id: string) => {
          if (durable.has(id)) memory.set(id, durable.get(id)!);
          return memory.has(id);
        }),
        end: vi.fn(async () => {}),
        suspend: vi.fn(async () => {}),
      } as unknown as SessionManager;
      return { api: createManagementApi({ sessions, store: fakeStore([]), server: stubServer, answerPermission: async () => {} }), sessions };
    };

    it("DELETE hydrates an absent conversation and destroys it (no 404 leak)", async () => {
      const { api, sessions } = mkApi({ starred: false }); // not in memory, but hydratable
      const r = await call(api, "DELETE", "/conversations/cx");
      expect(r.status).toBe(204);
      expect(sessions.end).toHaveBeenCalledWith("cx");
    });

    it("DELETE refuses a STARRED conversation with 409 (accidental-delete guard)", async () => {
      const { api, sessions } = mkApi({ starred: true }, { inMemory: true });
      const r = await call(api, "DELETE", "/conversations/cx");
      expect(r.status).toBe(409);
      expect(sessions.end).not.toHaveBeenCalled();
    });

    it("DELETE still 404s when the conversation truly doesn't exist anywhere", async () => {
      const { api } = mkApi({}, {}); // store has cx, but ask for a different id
      const r = await call(api, "DELETE", "/conversations/nope");
      expect(r.status).toBe(404);
    });

    it("suspend hydrates an absent conversation instead of 404ing", async () => {
      const { api, sessions } = mkApi({});
      const r = await call(api, "POST", "/conversations/cx/suspend");
      expect(sessions.suspend).toHaveBeenCalledWith("cx");
      expect(r.status).not.toBe(404);
    });
  });
});
