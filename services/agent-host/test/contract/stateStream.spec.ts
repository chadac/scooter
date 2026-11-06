// State hub, sandbox watcher and the state stream routes.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createManagementApi } from "../../src/api/management.js";
import { createStateHub, sandboxWatcher, type StateFrame, type StateProducer } from "../../src/session/stateHub.js";
import type { SessionManager } from "../../src/session/manager.js";
import type { WebServiceRegistry } from "../../src/proxy/webServiceProxy.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("state hub", () => {
  it("gives a new subscriber every kept value, then synced, then live frames", () => {
    const hub = createStateHub();
    const first: StateFrame[] = [];
    hub.subscribe("c", (f) => first.push(f));
    hub.publish("c", "a", { n: 1 });

    const second: StateFrame[] = [];
    hub.subscribe("c", (f) => second.push(f));
    hub.publish("c", "b", { n: 2 });

    expect(second).toEqual([
      { kind: "topic", topic: "a", data: { n: 1 } },
      { kind: "synced" },
      { kind: "topic", topic: "b", data: { n: 2 } },
    ]);
  });

  it("keeps no value for an invalidation, so a late joiner runs its own loader", () => {
    const hub = createStateHub();
    hub.subscribe("c", () => {});
    hub.publish("c", "a", { n: 1 });
    hub.publish("c", "a"); // changed, no value
    const late: StateFrame[] = [];
    hub.subscribe("c", (f) => late.push(f));
    expect(late).toEqual([{ kind: "synced" }]);
  });

  it("drops a publish nobody is watching", () => {
    const hub = createStateHub();
    hub.publish("c", "a", { n: 1 });
    const frames: StateFrame[] = [];
    hub.subscribe("c", (f) => frames.push(f));
    expect(frames).toEqual([{ kind: "synced" }]);
  });

  it("runs a conversation's producers once for all its tabs and stops them with the last", () => {
    const started: string[] = [];
    const stop = vi.fn();
    const producer: StateProducer = (id) => {
      started.push(id);
      return { stop };
    };
    const hub = createStateHub([producer]);
    const a = hub.subscribe("c", () => {});
    const b = hub.subscribe("c", () => {});
    expect(started).toEqual(["c"]);
    a();
    expect(stop).not.toHaveBeenCalled();
    b();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(hub.subscribers("c")).toBe(0);
  });

  it("keeps delivering to other subscribers when one throws", () => {
    const hub = createStateHub();
    hub.subscribe("c", (f) => {
      if (f.kind === "topic") throw new Error("dead socket");
    });
    const ok: StateFrame[] = [];
    hub.subscribe("c", (f) => ok.push(f));
    hub.publish("c", "a", 1);
    expect(ok.at(-1)).toEqual({ kind: "topic", topic: "a", data: 1 });
  });
});

describe("sandbox watcher", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const watch = (
    over: Partial<Parameters<typeof sandboxWatcher>[0]> = {},
    initial: Partial<{ status: string; ready: boolean }> = {},
  ) => {
    const state = { status: "running", ready: true, services: [{ name: "files" }] as unknown[], ...initial };
    const calls = { ready: 0, services: 0 };
    const producer = sandboxWatcher({
      status: async () => state.status,
      ready: async () => (calls.ready++, state.ready),
      services: async () => (calls.services++, state.services),
      startingMs: 10,
      runningMs: 10,
      ...over,
    });
    const published: unknown[] = [];
    const handle = producer("c", (_t, d) => published.push(d));
    return { state, calls, published, handle };
  };

  it("publishes the first read, then nothing until the value changes", async () => {
    const w = watch();
    await vi.advanceTimersByTimeAsync(45);
    expect(w.published).toEqual([{ status: "running", ready: true, services: [{ name: "files" }] }]);
    w.state.services = [{ name: "files" }, { name: "marimo" }];
    await vi.advanceTimersByTimeAsync(10);
    w.handle.stop();
    expect(w.published).toHaveLength(2);
  });

  it("does not probe the pod while it is down, nor list services before it is ready", async () => {
    const down = watch({}, { status: "suspended" });
    await vi.advanceTimersByTimeAsync(0);
    down.handle.stop();
    expect(down.calls).toEqual({ ready: 0, services: 0 });

    const starting = watch({}, { ready: false });
    await vi.advanceTimersByTimeAsync(0);
    starting.handle.stop();
    expect(starting.calls.services).toBe(0);
    expect(starting.published[0]).toEqual({ status: "running", ready: false, services: [] });
  });

  it("notices a down pod coming back within one starting tick", async () => {
    const w = watch({ startingMs: 2_000 }, { status: "suspended" });
    await vi.advanceTimersByTimeAsync(0);
    w.state.status = "running";
    await vi.advanceTimersByTimeAsync(2_000);
    w.handle.stop();
    expect(w.published.at(-1)).toEqual({ status: "running", ready: true, services: [{ name: "files" }] });
  });

  it("re-reads at once on a nudge instead of waiting out the period", async () => {
    const w = watch({ runningMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    w.state.services = [];
    w.handle.nudge?.();
    await vi.advanceTimersByTimeAsync(0);
    w.handle.stop();
    expect(w.published.at(-1)).toEqual({ status: "running", ready: true, services: [] });
  });

  it("stops ticking once stopped", async () => {
    const w = watch();
    await vi.advanceTimersByTimeAsync(0);
    w.handle.stop();
    const n = w.calls.ready;
    await vi.advanceTimersByTimeAsync(100);
    expect(w.calls.ready).toBe(n);
  });
});

// --- the routes ---------------------------------------------------------------

function fakeSessions(id: string, status = "running"): SessionManager {
  const conv = { id, threadId: id, status, sandbox: { name: "s", namespace: "n" } };
  return {
    get: (x: string) => (x === id ? conv : undefined),
    getBySandboxKey: async () => undefined,
    ensureReadable: async (x: string) => x === id,
    refreshSandbox: async () => {},
  } as unknown as SessionManager;
}

function fakeServices(): WebServiceRegistry & { running: Set<string> } {
  const running = new Set<string>();
  const desc = { name: "files", displayName: "Files", port: 1, basePath: "/", unit: "u", stripBasePath: false };
  return {
    running,
    list: async () => [desc],
    get: async (_c, n) => (n === "files" ? desc : null),
    isRunning: async (_c, n) => running.has(n),
    start: async (_c, n) => void running.add(n),
    stop: async (_c, n) => void running.delete(n),
    logs: async () => "",
    ready: async () => true,
    invalidate: () => {},
  };
}

/** Drive a request through the router, capturing a streamed body. */
function call(api: ReturnType<typeof createManagementApi>, method: string, url: string, body?: unknown) {
  const req = new PassThrough() as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers: body ? { "content-type": "application/json" } : {} });
  let status = 200;
  let out = "";
  const res = {
    statusCode: 200,
    writeHead: (s: number) => ((status = s), res),
    setHeader: () => {},
    write: (c: string) => ((out += c), true),
    end: (c?: string) => {
      if (c) out += c;
    },
    on: () => res,
  } as unknown as ServerResponse;
  if (body !== undefined) (req as unknown as PassThrough).end(JSON.stringify(body));
  else (req as unknown as PassThrough).end();
  const done = api.handle(req, res);
  return {
    done,
    frames: () =>
      out
        .split("\n\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5)) as StateFrame),
    status: () => (res as { statusCode: number }).statusCode !== 200 ? (res as { statusCode: number }).statusCode : status,
    text: () => out,
    close: () => (req as unknown as PassThrough).emit("close"),
  };
}

const apiFor = (over: Partial<Parameters<typeof createManagementApi>[0]> = {}) => {
  const webServices = fakeServices();
  const api = createManagementApi({
    sessions: fakeSessions("c1"),
    store: {} as never,
    server: { broadcast: () => {} } as never,
    answerInterrupt: async () => ({ ok: true }),
    webServices,
    ...over,
  });
  return { api, webServices };
};

const sandboxFrames = (frames: StateFrame[]) =>
  frames.filter((f): f is Extract<StateFrame, { kind: "topic" }> => f.kind === "topic" && f.topic === "sandbox");

describe("state topics on GET /conversations/:id/events.integrity", () => {
  it("streams the sandbox topic, and a service start shows without waiting for a tick", async () => {
    const { api } = apiFor();
    const s = call(api, "GET", "/conversations/c1/events.integrity");
    type Sandbox = { ready: boolean; services: { running: boolean }[] };
    const latest = () => sandboxFrames(s.frames()).at(-1)?.data as Sandbox | undefined;
    await vi.waitFor(() => expect(latest()).toBeDefined());
    expect(s.frames()[0]).toEqual({ kind: "synced" });
    expect(latest()?.ready).toBe(true);
    expect(latest()?.services[0].running).toBe(false);

    // The watcher's next tick is 5s away, so only the nudge can deliver this.
    await call(api, "POST", "/conversations/c1/web-services/files/start").done;
    await vi.waitFor(() => expect(latest()?.services[0].running).toBe(true), { timeout: 1000 });
    s.close();
  });

  it("stops the conversation's watcher when its last stream closes", async () => {
    const stateHub = createStateHub();
    const { api } = apiFor({ stateHub });
    const s = call(api, "GET", "/conversations/c1/events.integrity");
    await vi.waitFor(() => expect(stateHub.subscribers("c1")).toBe(1));
    s.close();
    expect(stateHub.subscribers("c1")).toBe(0);
  });
});

describe("POST /conversations/:id/state/contrib/:contrib", () => {
  it("fans a contrib's data, or a bare invalidation, out to the conversation's stream", async () => {
    const { api } = apiFor();
    const s = call(api, "GET", "/conversations/c1/events.integrity");
    await flush();
    const withData = call(api, "POST", "/conversations/c1/state/contrib/shares", { data: { count: 2 } });
    await withData.done;
    expect(withData.status()).toBe(202);
    await call(api, "POST", "/conversations/c1/state/contrib/shares", {}).done;
    const contrib = s.frames().filter((f) => f.kind === "topic" && f.topic === "contrib:shares");
    expect(contrib).toEqual([
      { kind: "topic", topic: "contrib:shares", data: { count: 2 } },
      { kind: "topic", topic: "contrib:shares" },
    ]);
    s.close();
  });

  it("refuses a caller that is not a platform service", async () => {
    const { api } = apiFor({ authEnforced: true, serviceCaller: async () => false });
    const r = call(api, "POST", "/conversations/c1/state/contrib/shares", {});
    await r.done;
    expect(r.status()).toBe(403);
  });

  it("rejects a malformed contrib name and an oversized value", async () => {
    const { api } = apiFor();
    const bad = call(api, "POST", "/conversations/c1/state/contrib/Bad:Name", {});
    await bad.done;
    expect(bad.status()).toBe(400);
    const big = call(api, "POST", "/conversations/c1/state/contrib/shares", { data: "x".repeat(70_000) });
    await big.done;
    expect(big.status()).toBe(413);
  });
});
