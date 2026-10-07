/**
 * The router mints subagent ids now, not the host.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, vi } from "vitest";

import { createRouterSubagentCreator } from "../../src/session/routerSubagents.js";
import {
  createSubagentManager,
  type SubagentSessions,
  type SubagentStore,
} from "../../src/session/subagentManager.js";
import type { SessionId } from "../../src/types.js";

const PARENT = "parent-1" as SessionId;

/** A fetch stub recording the request, answering `status` and `body`. */
function fetchStub(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

function sessionsFake() {
  const spawnChild = vi.fn(async (_p: SessionId, threadId: string, args: { title?: string }) => ({
    id: threadId,
    title: args.title,
  }));
  const sessions: SubagentSessions = {
    get: () => undefined,
    list: () => [],
    spawnChild,
    prompt: vi.fn(async () => {}),
  };
  const store: SubagentStore = {
    async *readEvents() {
      /* no events */
    },
  };
  return { sessions, store, spawnChild };
}

describe("createRouterSubagentCreator", () => {
  it("POSTs to the parent's subagents route and returns the ROUTER-minted id", async () => {
    const { calls, impl } = fetchStub(201, { id: "router-minted-1", title: "Review", sandboxRef: "conv-abc123" });
    const create = createRouterSubagentCreator({ url: "http://agent-host:8080/", fetchImpl: impl });

    const created = await create("parent-1", { title: "Review", model: "model-cheap" });

    expect(created).toEqual({ id: "router-minted-1", title: "Review", sandboxRef: "conv-abc123" });
    expect(calls).toHaveLength(1);
    // The base URL's trailing slash must not double up.
    expect(calls[0].url).toBe("http://agent-host:8080/conversations/parent-1/subagents");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ title: "Review", model: "model-cheap" });
  });

  it("sends NO owner and no id — the router infers both, so neither is spoofable from here", async () => {
    const { calls, impl } = fetchStub(201, { id: "x" });
    const create = createRouterSubagentCreator({ url: "http://agent-host:8080", fetchImpl: impl });

    await create("parent-1", {});

    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({});
    expect(Object.keys(body)).not.toContain("owner");
  });

  it("presents the projected SA token, read FRESH per call (projected tokens rotate)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "router-token-"));
    const tokenPath = join(dir, "token");
    await writeFile(tokenPath, "first-token\n");
    const { calls, impl } = fetchStub(201, { id: "x" });
    const create = createRouterSubagentCreator({ url: "http://agent-host:8080", tokenPath, fetchImpl: impl });

    await create("parent-1", {});
    await writeFile(tokenPath, "rotated-token\n");
    await create("parent-1", {});

    const auth = (i: number) => (calls[i].init.headers as Record<string, string>)["Authorization"];
    expect(auth(0)).toBe("Bearer first-token");
    expect(auth(1)).toBe("Bearer rotated-token");
  });

  it("works without a token (the kube-less stack has no TokenReview to satisfy)", async () => {
    const { calls, impl } = fetchStub(201, { id: "x" });
    const create = createRouterSubagentCreator({ url: "http://agent-host:8080", fetchImpl: impl });

    await create("parent-1", {});

    expect((calls[0].init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("REJECTS a refusal and a transport failure — never invents an id of its own", async () => {
    const refused = createRouterSubagentCreator({
      url: "http://agent-host:8080",
      fetchImpl: fetchStub(404, { error: "unknown parent conversation" }).impl,
    });
    await expect(refused("parent-1", {})).rejects.toThrow(/404/);

    const unreachable = createRouterSubagentCreator({
      url: "http://agent-host:8080",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(unreachable("parent-1", {})).rejects.toThrow(/unreachable/);

    const noId = createRouterSubagentCreator({
      url: "http://agent-host:8080",
      fetchImpl: fetchStub(201, {}).impl,
    });
    await expect(noId("parent-1", {})).rejects.toThrow(/no subagent id/);
  });
});

describe("spawn uses the router-minted id", () => {
  it("spawns the child under the id the ROUTER returned, not a locally minted uuid", async () => {
    const { sessions, store, spawnChild } = sessionsFake();
    const create = vi.fn(async () => ({ id: "router-minted-1" }));
    const mgr = createSubagentManager(sessions, store, create);

    const spawned = await mgr.spawn(PARENT, { prompt: "research X", title: "Research" });

    expect(create).toHaveBeenCalledWith(PARENT, { title: "Research", model: undefined });
    expect(spawnChild.mock.calls[0][1]).toBe("router-minted-1");
    expect(spawned.id).toBe("router-minted-1");
  });

  it("does not spawn anything when the router refuses — no child, no local id", async () => {
    const { sessions, store, spawnChild } = sessionsFake();
    const create = vi.fn(async () => {
      throw new Error("conversation-router refused the subagent create (404)");
    });
    const mgr = createSubagentManager(sessions, store, create);

    await expect(mgr.spawn(PARENT, { prompt: "research X" })).rejects.toThrow(/refused/);
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("mints locally ONLY when no creator is wired (the native single-host stack)", async () => {
    const { sessions, store, spawnChild } = sessionsFake();
    const mgr = createSubagentManager(sessions, store);

    const spawned = await mgr.spawn(PARENT, { prompt: "research X" });

    expect(spawnChild).toHaveBeenCalledTimes(1);
    expect(spawned.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
