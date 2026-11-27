/**
 * WebServiceRegistry over a fake exec client: list/get read the in-pod discovery
 * manifest, isRunning maps `systemctl is-active` behind a short TTL cache, start/stop
 * go through `scooter-service` (which persists the enabled set for boot restore) and
 * drop the caches, and logs() tails the unit journal.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createWebServiceRegistry,
  parseManifest,
  MANIFEST_PATH,
  type ExecLike,
} from "../../src/proxy/webServiceRegistry.js";
import type { SandboxRef } from "../../src/types.js";

const REF: SandboxRef = { name: "conv-1", namespace: "agent-sandbox" };

const MANIFEST = JSON.stringify({
  services: [
    { name: "marimo", displayName: "marimo", port: 2718, basePath: "/c/conv-1/marimo", unit: "webservice-marimo" },
  ],
});

function fakeExec(over: Partial<ExecLike> = {}): ExecLike {
  return {
    download: vi.fn(async (p: string) => (p === MANIFEST_PATH ? MANIFEST : "")),
    execute: vi.fn(async () => ({ stdout: "active", stderr: "", exitCode: 0 })),
    ...over,
  };
}

function make(exec: ExecLike, opts?: { ttlMs?: number; runningTtlMs?: number; now?: () => number }) {
  return createWebServiceRegistry(
    {
      sandboxFor: () => REF,
      connect: async () => exec,
    },
    opts,
  );
}

const TWO = JSON.stringify({
  services: [
    { name: "marimo", displayName: "marimo", port: 2718, basePath: "/c/conv-1/marimo", unit: "webservice-marimo" },
    { name: "docs", displayName: "docs", port: 8000, basePath: "/c/conv-1/docs", unit: "webservice-docs" },
  ],
});

/** An exec whose manifest can change under us, as `scooter-rebuild` does. */
function mutableExec(initial: string) {
  const state = { manifest: initial, reads: 0 };
  const exec: ExecLike = {
    download: vi.fn(async (p: string) => {
      if (p !== MANIFEST_PATH) return "";
      state.reads++;
      return state.manifest;
    }),
    execute: vi.fn(async () => ({ stdout: "active", stderr: "", exitCode: 0 })),
  };
  return { exec, state };
}

describe("parseManifest", () => {
  it("reads well-formed services and skips garbage", () => {
    expect(parseManifest(MANIFEST)).toHaveLength(1);
    expect(parseManifest(MANIFEST)[0]).toMatchObject({ name: "marimo", port: 2718 });
    expect(parseManifest("not json")).toEqual([]);
    expect(parseManifest(JSON.stringify({ services: [{ name: "x" }] }))).toEqual([]);
  });

  it("marks a service unlisted only when the manifest says visibleInMenu: false", () => {
    const json = JSON.stringify({
      services: [{ name: "notebook", port: 2720 }, { name: "marimo", port: 2718, visibleInMenu: false }],
    });
    const [page, server] = parseManifest(json);
    expect(page.visibleInMenu).toBeUndefined();
    expect(server.visibleInMenu).toBe(false);
  });

  it("carries a declared resource requirement through", () => {
    const json = JSON.stringify({
      services: [{ name: "marimo", port: 2718, resources: { cpu: "4", memory: "8Gi", gpu: 1 } }],
    });
    expect(parseManifest(json)[0].resources).toEqual({ cpu: "4", memory: "8Gi", gpu: 1 });
  });

  it("drops ill-typed dimensions but keeps the service", () => {
    // A bad `resources` block must not cost the service its proxy entry.
    const json = JSON.stringify({
      services: [{ name: "marimo", port: 2718, resources: { cpu: 4, memory: "8Gi", gpu: "one" } }],
    });
    const [svc] = parseManifest(json);
    expect(svc).toMatchObject({ name: "marimo", port: 2718 });
    expect(svc.resources).toEqual({ memory: "8Gi" });
  });

  it("omits `resources` entirely when nothing usable is declared", () => {
    // Absent stays distinguishable from a declared zero, which would read as a real requirement.
    for (const r of [undefined, null, "big", {}, { cpu: 4 }]) {
      const json = JSON.stringify({ services: [{ name: "m", port: 1, resources: r }] });
      expect(parseManifest(json)[0].resources).toBeUndefined();
    }
  });
});

describe("WebServiceRegistry", () => {
  it("list/get read the manifest via download and cache it", async () => {
    const exec = fakeExec();
    const reg = make(exec);
    expect(await reg.list("conv-1")).toHaveLength(1);
    expect((await reg.get("conv-1", "marimo"))?.port).toBe(2718);
    expect(await reg.get("conv-1", "nope")).toBeNull();
    expect(exec.download).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache an empty result — retries until the pod's manifest is readable", async () => {
    // The pod is ContainerCreating on the first read, then Ready on the next.
    let ready = false;
    const download = vi.fn(async () => {
      if (!ready) throw new Error("pod not ready");
      return MANIFEST;
    });
    const reg = make(fakeExec({ download }));
    expect(await reg.list("conv-1")).toEqual([]);
    ready = true;
    expect(await reg.list("conv-1")).toHaveLength(1);
    expect(download).toHaveBeenCalledTimes(2);
    // The non-empty result is cached.
    expect(await reg.list("conv-1")).toHaveLength(1);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("isRunning maps `systemctl is-active`", async () => {
    const active = make(fakeExec({ execute: vi.fn(async () => ({ stdout: "active", stderr: "", exitCode: 0 })) }));
    expect(await active.isRunning("conv-1", "marimo")).toBe(true);

    const inactive = make(fakeExec({ execute: vi.fn(async () => ({ stdout: "inactive", stderr: "", exitCode: 3 })) }));
    expect(await inactive.isRunning("conv-1", "marimo")).toBe(false);
  });

  it("serves a cached liveness within its TTL, since each answer is a pod exec", async () => {
    // The loading page polls this every second while a unit starts.
    let clock = 0;
    const execute = vi.fn(async () => ({ stdout: "active", stderr: "", exitCode: 0 }));
    const reg = make(fakeExec({ execute }), { runningTtlMs: 2_000, now: () => clock });
    expect(await reg.isRunning("conv-1", "marimo")).toBe(true);
    expect(await reg.isRunning("conv-1", "marimo")).toBe(true);
    const execs = execute.mock.calls.filter((c) => c[0].command === "systemctl").length;
    expect(execs).toBe(1);
    // Past the TTL it asks again, so a unit that came up is seen promptly.
    clock = 2_500;
    expect(await reg.isRunning("conv-1", "marimo")).toBe(true);
    expect(execute.mock.calls.filter((c) => c[0].command === "systemctl").length).toBe(2);
  });

  it("a start drops the cached liveness, so the unit it just started is re-read", async () => {
    // Otherwise a "down" cached a moment before the start outlives the fact.
    let clock = 0;
    let active = false;
    const execute = vi.fn(async (req: { command: string; args?: string[] }) => {
      if (req.command === "scooter-service") { active = true; return { stdout: "", stderr: "", exitCode: 0 }; }
      return active ? { stdout: "active", stderr: "", exitCode: 0 } : { stdout: "inactive", stderr: "", exitCode: 3 };
    });
    const reg = make(fakeExec({ execute }), { runningTtlMs: 60_000, now: () => clock });
    expect(await reg.isRunning("conv-1", "marimo")).toBe(false);
    await reg.start("conv-1", "marimo");
    expect(await reg.isRunning("conv-1", "marimo")).toBe(true);
  });

  it("invalidate drops the cached liveness too (a refused connection calls it)", async () => {
    let clock = 0;
    const execute = vi.fn(async () => ({ stdout: "active", stderr: "", exitCode: 0 }));
    const reg = make(fakeExec({ execute }), { runningTtlMs: 60_000, now: () => clock });
    await reg.isRunning("conv-1", "marimo");
    reg.invalidate("conv-1");
    await reg.isRunning("conv-1", "marimo");
    expect(execute.mock.calls.filter((c) => c[0].command === "systemctl").length).toBe(2);
  });

  it("start runs `scooter-service start <name>` (persists autostart) and invalidates the cache", async () => {
    const execute = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const download = vi.fn(async () => MANIFEST);
    const reg = make(fakeExec({ execute, download }));
    await reg.list("conv-1");
    await reg.start("conv-1", "marimo");
    // scooter-service records the enabled set on the PVC so boot restore can bring it back.
    expect(execute).toHaveBeenCalledWith({ command: "scooter-service", args: ["start", "marimo"] });
    await reg.list("conv-1");
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("start throws when the unit fails", async () => {
    const reg = make(fakeExec({ execute: vi.fn(async () => ({ stdout: "", stderr: "boom", exitCode: 1 })) }));
    await expect(reg.start("conv-1", "marimo")).rejects.toThrow(/failed/);
  });

  it("stop runs `scooter-service stop <name>` (clears autostart)", async () => {
    const execute = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const reg = make(fakeExec({ execute, download: vi.fn(async () => MANIFEST) }));
    await reg.stop("conv-1", "marimo");
    expect(execute).toHaveBeenCalledWith({ command: "scooter-service", args: ["stop", "marimo"] });
  });

  it("stop throws when the unit fails", async () => {
    const reg = make(fakeExec({ execute: vi.fn(async () => ({ stdout: "", stderr: "nope", exitCode: 1 })) }));
    await expect(reg.stop("conv-1", "marimo")).rejects.toThrow(/failed/);
  });

  it("logs() tails the unit journal via journalctl", async () => {
    const execute = vi.fn(async () => ({ stdout: "Running on http://0.0.0.0:2718\n", stderr: "", exitCode: 0 }));
    const reg = make(fakeExec({ execute, download: vi.fn(async () => MANIFEST) }));
    const out = await reg.logs("conv-1", "marimo", 20);
    expect(execute).toHaveBeenCalledWith({
      command: "journalctl",
      args: ["-u", "webservice-marimo", "-n", "20", "--no-pager", "--no-hostname"],
    });
    expect(out).toContain("Running on http://0.0.0.0:2718");
  });

  it("logs() returns '' when the pod is unreachable (never throws)", async () => {
    const reg = make(fakeExec({ execute: vi.fn(async () => { throw new Error("no pod"); }), download: vi.fn(async () => MANIFEST) }));
    expect(await reg.logs("conv-1", "marimo")).toBe("");
  });

  it("ready() is true when the pod is reachable (manifest download succeeds)", async () => {
    const reg = make(fakeExec({ download: vi.fn(async () => MANIFEST) }));
    expect(await reg.ready("conv-1")).toBe(true);
  });

  it("ready() is true even for an EMPTY manifest (reachable is what matters)", async () => {
    const reg = make(fakeExec({ download: vi.fn(async () => "{}") }));
    expect(await reg.ready("conv-1")).toBe(true);
  });

  it("ready() is false when the pod isn't reachable (creating / asleep)", async () => {
    const reg = createWebServiceRegistry({
      sandboxFor: () => REF,
      connect: async () => { throw new Error("pod ContainerCreating"); },
    });
    expect(await reg.ready("conv-1")).toBe(false);
  });

  it("ready() is false when the manifest download throws (pod not up)", async () => {
    const reg = make(fakeExec({ download: vi.fn(async () => { throw new Error("exec failed"); }) }));
    expect(await reg.ready("conv-1")).toBe(false);
  });

  it("ready() is false when there is no sandbox for the conversation", async () => {
    const reg = createWebServiceRegistry({ sandboxFor: () => undefined, connect: async () => fakeExec() });
    expect(await reg.ready("conv-1")).toBe(false);
  });

  it("a pod that can't be reached yields no services (not a throw)", async () => {
    const reg = createWebServiceRegistry({
      sandboxFor: () => REF,
      connect: async () => { throw new Error("pod asleep"); },
    });
    expect(await reg.list("conv-1")).toEqual([]);
    expect(await reg.isRunning("conv-1", "marimo")).toBe(false);
  });
});

describe("picking up a scooter-rebuild", () => {
  it("re-reads the manifest once the cached read expires", async () => {
    // A `scooter-rebuild` repoints /run/scooter/web-services.json without telling the host.
    let clock = 1_000;
    const { exec, state } = mutableExec(MANIFEST);
    const reg = make(exec, { ttlMs: 10_000, now: () => clock });

    expect((await reg.list("c1")).map((s) => s.name)).toEqual(["marimo"]);
    state.manifest = TWO;

    // Still inside the TTL, so the cached read stands.
    const readsAfterFirst = state.reads;
    expect((await reg.list("c1")).map((s) => s.name)).toEqual(["marimo"]);
    expect(state.reads).toBe(readsAfterFirst);

    clock += 10_001;
    // The expired read answers while the re-read runs; the next call sees the rebuild.
    expect((await reg.list("c1")).map((s) => s.name)).toEqual(["marimo"]);
    await new Promise((r) => setImmediate(r));
    expect((await reg.list("c1")).map((s) => s.name)).toEqual(["marimo", "docs"]);
  });

  it("an expired read answers at once while one slow re-read runs (a busy pod must not stall requests)", async () => {
    let clock = 1_000;
    let reads = 0;
    const exec = fakeExec({
      download: vi.fn(async () => {
        reads++;
        if (reads > 1) await new Promise(() => {}); // the pod never answers
        return MANIFEST;
      }),
    });
    const reg = make(exec, { ttlMs: 10_000, now: () => clock });
    await reg.list("c1");

    clock += 10_001;
    for (let i = 0; i < 3; i++) expect((await reg.get("c1", "marimo"))?.port).toBe(2718);
    expect(reads).toBe(2);
  });

  it("concurrent cold reads share one exec", async () => {
    const { exec, state } = mutableExec(MANIFEST);
    const reg = make(exec, { ttlMs: 10_000, now: () => 5_000 });
    await Promise.all([reg.list("c1"), reg.list("c1"), reg.get("c1", "marimo")]);
    expect(state.reads).toBe(1);
  });

  it("an invalidate during a read keeps that read out of the cache", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { exec, state } = mutableExec(MANIFEST);
    const slow = fakeExec({ download: vi.fn(async (p: string) => { await gate; return exec.download(p); }) });
    const reg = make(slow, { ttlMs: 10_000, now: () => 5_000 });
    const first = reg.list("c1");
    reg.invalidate("c1");
    release();
    await first;
    await reg.list("c1");
    expect(state.reads).toBe(2);
  });

  it("re-reads immediately when forced, without waiting for the TTL", async () => {
    let clock = 1_000;
    const { exec, state } = mutableExec(MANIFEST);
    const reg = make(exec, { ttlMs: 10_000, now: () => clock });

    await reg.list("c1");
    state.manifest = TWO;
    // No clock movement; this is the UI's Rescan button.
    expect((await reg.list("c1", { force: true })).map((s) => s.name)).toEqual(["marimo", "docs"]);
  });

  it("serves cached reads within the TTL so listing is not an exec per call", async () => {
    // list() is called on a 4s poll and by the proxy.
    const { exec, state } = mutableExec(MANIFEST);
    const reg = make(exec, { ttlMs: 10_000, now: () => 5_000 });
    await reg.list("c1");
    await reg.list("c1");
    await reg.list("c1");
    expect(state.reads).toBe(1);
  });

  it("keeps retrying while the manifest reads empty (pod still coming up)", async () => {
    // An empty read means "could not read it yet", never "no services".
    const { exec, state } = mutableExec("");
    const reg = make(exec, { ttlMs: 10_000, now: () => 5_000 });
    expect(await reg.list("c1")).toEqual([]);
    state.manifest = MANIFEST;
    expect((await reg.list("c1")).map((s) => s.name)).toEqual(["marimo"]);
    expect(state.reads).toBe(2);
  });
});
