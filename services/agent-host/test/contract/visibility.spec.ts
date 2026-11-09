/**
 * Private conversations: canAccess against the fixture shared with the conversation-router,
 * the per-request access check, and the management API's guard and visibility routes.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { canAccess, type Visibility } from "../../src/session/visibility.js";
import { createAccessCheck } from "../../src/session/access.js";
import { createManagementApi } from "../../src/api/management.js";
import type { Conversation, ConversationStore, SessionManager } from "../../src/session/manager.js";
import type { AguiServer } from "../../src/agui/server.js";
import { createMemoryAuthorStore, type AuthorStore } from "../../src/session/authorStore.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/visibility-cases.json", import.meta.url)), "utf8"),
) as { cases: Array<{ name: string; owner: string | null; visibility: string; caller: string | null; allowed: boolean }> };

const user = (id: string | null) => (id ? { id, anonymous: false } : { id: "anonymous", anonymous: true });

describe("canAccess", () => {
  it("has cases", () => expect(fixture.cases.length).toBeGreaterThan(0));
  for (const c of fixture.cases) {
    it(c.name, () => {
      const facts = { owner: c.owner ?? undefined, visibility: (c.visibility || undefined) as Visibility | undefined };
      expect(canAccess(facts, user(c.caller))).toBe(c.allowed);
    });
  }
});

const req = (headers: Record<string, string> = {}) => ({ headers }) as unknown as IncomingMessage;

describe("createAccessCheck", () => {
  it("prefers the store's fresh answer over a stale memory copy", async () => {
    const check = createAccessCheck({
      readAccess: async () => ({ owner: "alice", visibility: "private" }),
      memory: () => ({ owner: "alice", visibility: "shared" }),
    });
    expect(await check("c1", req(), user("bob"))).toBe("deny");
    expect(await check("c1", req(), user("alice"))).toBe("allow");
  });

  it("falls back to memory when the store has no row", async () => {
    const check = createAccessCheck({
      readAccess: async () => undefined,
      memory: () => ({ owner: "alice", visibility: "private" }),
    });
    expect(await check("c1", req(), user("bob"))).toBe("deny");
  });

  it("reports an unknown conversation as unknown, for the route's own 404", async () => {
    const check = createAccessCheck({ memory: () => undefined });
    expect(await check("nope", req(), user("bob"))).toBe("unknown");
  });

  it("admits a verified service only after the visibility rule refused", async () => {
    const trustedService = vi.fn(async () => true);
    const check = createAccessCheck({ memory: () => ({ owner: "alice", visibility: "private" }), trustedService });
    expect(await check("c1", req(), user("alice"))).toBe("allow");
    expect(trustedService).not.toHaveBeenCalled();
    expect(await check("c1", req(), user(null))).toBe("allow");
    expect(trustedService).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing service verifier as untrusted", async () => {
    const check = createAccessCheck({
      memory: () => ({ owner: "alice", visibility: "private" }),
      trustedService: async () => {
        throw new Error("apiserver down");
      },
    });
    expect(await check("c1", req(), user(null))).toBe("deny");
  });

  it("propagates a failed store read so the caller answers 503, not a guess", async () => {
    const check = createAccessCheck({
      readAccess: async () => {
        throw new Error("db down");
      },
      memory: () => ({ owner: "alice", visibility: "shared" }),
    });
    await expect(check("c1", req(), user("bob"))).rejects.toThrow("db down");
  });
});

// --- the management API ------------------------------------------------------------------------

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  threadId: "c1",
  sandbox: { name: "conv-c1", namespace: "ns" },
  status: "running",
  title: "Hello",
  createdAt: 1000,
  lastActivityAt: 1000,
  owner: "alice",
  ...over,
});

/** A request from the trusted in-cluster service, e.g. the broker. */
const SERVICE_HEADER = "x-test-service";

function setup(initial: Partial<Conversation> = {}, opts: { readAccessFails?: boolean; authorStore?: AuthorStore } = {}) {
  const convs = new Map<string, Conversation>([["c1", conv(initial)]]);
  const sessions = {
    get: (id: string) => convs.get(id),
    ensureReadable: vi.fn(async (id: string) => convs.has(id)),
    getBySandboxKey: vi.fn(async (h: string) => [...convs.values()].find((c) => `short-${c.id}` === h)),
    enqueueByThread: vi.fn(async () => {}),
    start: vi.fn(async (threadId: string, model?: string, owner?: string, o?: { visibility?: Visibility }) => {
      const c = conv({ id: threadId, threadId, model, owner, visibility: o?.visibility });
      convs.set(threadId, c);
      return c;
    }),
    setTitle: vi.fn(async () => {}),
    refreshRouterMeta: vi.fn(async () => {}),
    setVisibility: vi.fn(async (id: string, visibility: Visibility) => {
      convs.set(id, { ...convs.get(id)!, visibility });
    }),
  } as unknown as SessionManager;
  const store = {
    appendEvent: async () => {},
    async *readEvents() {},
    gooseStatePath: (id: string) => `/state/${id}`,
    readAccess: async (id: string) => {
      if (opts.readAccessFails) throw new Error("db down");
      const c = convs.get(id);
      return c ? { owner: c.owner, visibility: c.visibility ?? "shared" } : undefined;
    },
  } as unknown as ConversationStore;
  const accessCheck = createAccessCheck({
    readAccess: (id) => store.readAccess!(id),
    memory: (id) => convs.get(id),
    trustedService: async (req) => req.headers[SERVICE_HEADER] === "1",
  });
  const api = createManagementApi({
    sessions,
    store,
    server: { subscribeSSE: vi.fn(async () => {}) } as unknown as AguiServer,
    answerInterrupt: async () => ({ ok: true }),
    accessCheck,
    serviceCaller: async (req) => req.headers[SERVICE_HEADER] === "1",
    authorStore: opts.authorStore,
    writeSandboxFile: async (_id, f) => `${f.dir}/${f.name}`,
  });
  return { api, sessions, convs };
}

async function call(
  api: ReturnType<typeof createManagementApi>,
  method: string,
  path: string,
  body?: unknown,
  caller?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const r = new PassThrough() as unknown as IncomingMessage;
  (r as { method?: string }).method = method;
  (r as { url?: string }).url = path;
  (r as { headers?: Record<string, string> }).headers = { ...(caller ? { "x-auth-user": caller } : {}), ...headers };
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
  if (body !== undefined) (r as PassThrough).write(JSON.stringify(body));
  (r as PassThrough).end();
  await matched;
  return { status, json: chunks ? JSON.parse(chunks) : null };
}

describe("management API on a private conversation", () => {
  it("serves the owner", async () => {
    const { api } = setup({ visibility: "private" });
    const got = await call(api, "GET", "/conversations/c1", undefined, "alice");
    expect(got.status).toBe(200);
    expect(got.json.visibility).toBe("private");
  });

  it("answers 404 to another user and to an anonymous caller, on reads and writes alike", async () => {
    const { api, sessions } = setup({ visibility: "private" });
    for (const caller of ["bob", undefined]) {
      expect((await call(api, "GET", "/conversations/c1", undefined, caller)).status).toBe(404);
      expect((await call(api, "POST", "/conversations/c1/messages", { text: "hi" }, caller)).status).toBe(404);
    }
    expect(sessions.enqueueByThread).not.toHaveBeenCalled();
  });

  it("still serves everyone on a shared conversation", async () => {
    const { api } = setup();
    expect((await call(api, "GET", "/conversations/c1", undefined, "bob")).status).toBe(200);
  });

  it("serves the broker's lookup by the sandbox's short id, with owner and visibility", async () => {
    const { api } = setup({ visibility: "private" });
    const got = await call(api, "GET", "/conversations/short-c1", undefined, undefined, { [SERVICE_HEADER]: "1" });
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ id: "c1", owner: "alice", visibility: "private" });
  });

  it("applies the visibility rule to a short id too", async () => {
    const { api } = setup({ visibility: "private" });
    expect((await call(api, "GET", "/conversations/short-c1", undefined, "alice")).status).toBe(200);
    for (const caller of ["bob", undefined]) {
      expect((await call(api, "GET", "/conversations/short-c1", undefined, caller)).status).toBe(404);
      expect((await call(api, "GET", "/conversations/short-c1/links", undefined, caller)).status).toBe(404);
    }
  });

  it("refuses with 503 when the visibility read fails", async () => {
    const { api } = setup({ visibility: "private" }, { readAccessFails: true });
    expect((await call(api, "GET", "/conversations/c1", undefined, "alice")).status).toBe(503);
  });
});

describe("PATCH /conversations/:id/visibility", () => {
  it("lets the owner make a conversation private", async () => {
    const { api, sessions } = setup();
    const got = await call(api, "PATCH", "/conversations/c1/visibility", { visibility: "private" }, "alice");
    expect(got.status).toBe(200);
    expect(got.json.visibility).toBe("private");
    expect(sessions.setVisibility).toHaveBeenCalledWith("c1", "private");
  });

  it("refuses anyone but the owner, even on a shared conversation", async () => {
    const { api, sessions } = setup();
    expect((await call(api, "PATCH", "/conversations/c1/visibility", { visibility: "private" }, "bob")).status).toBe(403);
    expect((await call(api, "PATCH", "/conversations/c1/visibility", { visibility: "private" })).status).toBe(403);
    expect(sessions.setVisibility).not.toHaveBeenCalled();
  });

  it("needs confirm to go from private back to shared", async () => {
    const { api, sessions } = setup({ visibility: "private" });
    expect((await call(api, "PATCH", "/conversations/c1/visibility", { visibility: "shared" }, "alice")).status).toBe(409);
    expect(sessions.setVisibility).not.toHaveBeenCalled();
    const ok = await call(api, "PATCH", "/conversations/c1/visibility", { visibility: "shared", confirm: true }, "alice");
    expect(ok.status).toBe(200);
    expect(ok.json.visibility).toBe("shared");
  });

  it("refuses a subagent, which follows its parent", async () => {
    const { api } = setup({ parentId: "root" });
    expect((await call(api, "PATCH", "/conversations/c1/visibility", { visibility: "private" }, "alice")).status).toBe(409);
  });

  it("rejects an unknown value", async () => {
    const { api } = setup();
    expect((await call(api, "PATCH", "/conversations/c1/visibility", { visibility: "secret" }, "alice")).status).toBe(400);
  });
});

describe("POST /conversations with visibility", () => {
  it("creates a private conversation for a signed-in user", async () => {
    const { api, sessions } = setup();
    const got = await call(api, "POST", "/conversations", { visibility: "private" }, "alice");
    expect(got.status).toBe(201);
    expect(got.json.visibility).toBe("private");
    expect(sessions.start).toHaveBeenCalledWith(expect.any(String), undefined, "alice", { visibility: "private" });
  });

  it("refuses a private conversation with no owner", async () => {
    const { api } = setup();
    expect((await call(api, "POST", "/conversations", { visibility: "private" })).status).toBe(400);
  });

  it("rejects an unknown value", async () => {
    const { api } = setup();
    expect((await call(api, "POST", "/conversations", { visibility: "hidden" }, "alice")).status).toBe(400);
  });
});

describe("conversation authors", () => {
  it("serves them to the broker, and omits them when the read fails", async () => {
    const authorStore = createMemoryAuthorStore();
    await authorStore.record("c1", { kind: "user", id: "alice" });
    const { api } = setup({ visibility: "private" }, { authorStore });
    const got = await call(api, "GET", "/conversations/c1", undefined, undefined, { [SERVICE_HEADER]: "1" });
    expect(got.json.authors).toMatchObject([{ conversationId: "c1", kind: "user", author: "alice", user: "alice" }]);

    const failing = { ...authorStore, listTree: async () => { throw new Error("db down"); } };
    const { api: api2 } = setup({ visibility: "private" }, { authorStore: failing });
    const bad = await call(api2, "GET", "/conversations/c1", undefined, "alice");
    expect(bad.status).toBe(200);
    expect(bad.json.authors).toBeUndefined();
  });

  it("records another user's interrupt as theirs, and the owner's as nothing", async () => {
    const authorStore = createMemoryAuthorStore();
    const { api } = setup({}, { authorStore });
    expect((await call(api, "POST", "/conversations/c1/messages", { text: "hi" }, "alice")).status).toBe(202);
    expect(await authorStore.listTree("c1")).toEqual([]);
    expect((await call(api, "POST", "/conversations/c1/messages", { text: "hi" }, "bob")).status).toBe(202);
    expect(await authorStore.listTree("c1")).toMatchObject([{ kind: "user", author: "bob", user: "bob" }]);
  });

  it("records nothing for a platform service's message, and unknown for an anonymous one", async () => {
    const authorStore = createMemoryAuthorStore();
    const { api } = setup({}, { authorStore });
    await call(api, "POST", "/conversations/c1/messages", { text: "hi", source: "kanban" }, undefined, { [SERVICE_HEADER]: "1" });
    expect(await authorStore.listTree("c1")).toEqual([]);
    await call(api, "POST", "/conversations/c1/messages", { text: "hi" });
    expect(await authorStore.listTree("c1")).toMatchObject([{ kind: "unknown", author: "", user: null }]);
  });

  it("refuses an interrupt whose author can't be recorded", async () => {
    const failing = { ...createMemoryAuthorStore(), record: async () => { throw new Error("db down"); } };
    const { api, sessions } = setup({}, { authorStore: failing });
    await expect(call(api, "POST", "/conversations/c1/messages", { text: "hi" }, "bob")).rejects.toThrow("db down");
    expect(sessions.enqueueByThread).not.toHaveBeenCalled();
  });

  it("records another user writing a sandbox file, but not a platform service", async () => {
    const authorStore = createMemoryAuthorStore();
    const { api } = setup({}, { authorStore });
    const file = { dir: "/workspace/out", name: "a.txt", data: "YWJj" };
    expect((await call(api, "POST", "/conversations/c1/files", file, undefined, { [SERVICE_HEADER]: "1" })).status).toBe(201);
    expect(await authorStore.listTree("c1")).toEqual([]);
    expect((await call(api, "POST", "/conversations/c1/files", file, "bob")).status).toBe(201);
    expect(await authorStore.listTree("c1")).toMatchObject([{ kind: "user", author: "bob", user: "bob" }]);
  });

  it("leaves a shared conversation going private untainted", async () => {
    const authorStore = createMemoryAuthorStore();
    const { api } = setup({}, { authorStore });
    expect((await call(api, "PATCH", "/conversations/c1/visibility", { visibility: "private" }, "alice")).status).toBe(200);
    expect(await authorStore.listTree("c1")).toEqual([]);
  });
});

describe("conversation taint", () => {
  async function tainted() {
    const authorStore = createMemoryAuthorStore();
    await authorStore.record("c1", { kind: "user", id: "bob" });
    await authorStore.record("c1", { kind: "unknown" });
    return authorStore;
  }

  it("shows the owner who taints the conversation, and nobody else", async () => {
    const { api } = setup({ visibility: "private" }, { authorStore: await tainted() });
    const got = await call(api, "GET", "/conversations/c1/taint", undefined, "alice");
    expect(got.json.summary).toBe("user bob and unattributed text");
    expect(got.json.authors.map((a: { label: string }) => a.label)).toEqual(["user bob", "unattributed text"]);

    const { api: shared } = setup({}, { authorStore: await tainted() });
    expect((await call(shared, "GET", "/conversations/c1/taint", undefined, "bob")).status).toBe(403);
  });

  it("clears exactly the rows the owner was shown", async () => {
    const authorStore = await tainted();
    const { api } = setup({ visibility: "private" }, { authorStore });
    const shown = (await call(api, "GET", "/conversations/c1/taint", undefined, "alice")).json.authors;
    // Bob writes again after the owner looked, so his row still taints.
    await authorStore.record("c1", { kind: "user", id: "bob" });
    const got = await call(api, "POST", "/conversations/c1/taint/clear", { authors: shown }, "alice");
    expect(got.json).toMatchObject({ cleared: 1, summary: "user bob" });
    expect(authorStore.clears).toMatchObject([{ kind: "unknown", user: "alice", via: "ui" }]);
  });

  it("ignores rows from outside the conversation's tree", async () => {
    const authorStore = await tainted();
    await authorStore.record("elsewhere", { kind: "user", id: "carol" });
    const { api } = setup({ visibility: "private" }, { authorStore });
    const stranger = [{ conversationId: "elsewhere", kind: "user", author: "carol", lastAt: 99 }];
    const got = await call(api, "POST", "/conversations/c1/taint/clear", { authors: stranger }, "alice");
    expect(got.json.cleared).toBe(0);
    expect(await authorStore.listTree("elsewhere")).toHaveLength(1);
  });

  it("refuses a shared conversation, another user and a malformed body", async () => {
    const shown = [{ conversationId: "c1", kind: "unknown", author: "", lastAt: 99 }];
    const { api: shared } = setup({}, { authorStore: await tainted() });
    expect((await call(shared, "POST", "/conversations/c1/taint/clear", { authors: shown }, "alice")).status).toBe(409);

    const { api } = setup({ visibility: "private" }, { authorStore: await tainted() });
    expect((await call(api, "POST", "/conversations/c1/taint/clear", { authors: shown }, "bob")).status).toBe(404);
    expect((await call(api, "POST", "/conversations/c1/taint/clear", { authors: "all" }, "alice")).status).toBe(400);
  });
});
