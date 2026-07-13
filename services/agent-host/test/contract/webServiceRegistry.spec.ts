/**
 * Tier 1 contract test — WebServiceRegistry over a fake exec client.
 *
 * Asserts the manifest parse + systemctl coupling: list/get read the in-pod
 * discovery manifest, isRunning maps `systemctl is-active`, start runs
 * `systemctl start` and drops the cache. See docs/WEB_SERVICES_PROXY.md.
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

function make(exec: ExecLike) {
  return createWebServiceRegistry({
    sandboxFor: () => REF,
    connect: async () => exec,
  });
}

describe("parseManifest", () => {
  it("reads well-formed services and skips garbage", () => {
    expect(parseManifest(MANIFEST)).toHaveLength(1);
    expect(parseManifest(MANIFEST)[0]).toMatchObject({ name: "marimo", port: 2718 });
    expect(parseManifest("not json")).toEqual([]);
    expect(parseManifest(JSON.stringify({ services: [{ name: "x" }] }))).toEqual([]); // no port
  });
});

describe("WebServiceRegistry", () => {
  it("list/get read the manifest via download and cache it", async () => {
    const exec = fakeExec();
    const reg = make(exec);
    expect(await reg.list("conv-1")).toHaveLength(1);
    expect((await reg.get("conv-1", "marimo"))?.port).toBe(2718);
    expect(await reg.get("conv-1", "nope")).toBeNull();
    // cached: download called once despite three reads.
    expect(exec.download).toHaveBeenCalledTimes(1);
  });

  it("isRunning maps `systemctl is-active`", async () => {
    const active = make(fakeExec({ execute: vi.fn(async () => ({ stdout: "active", stderr: "", exitCode: 0 })) }));
    expect(await active.isRunning("conv-1", "marimo")).toBe(true);

    const inactive = make(fakeExec({ execute: vi.fn(async () => ({ stdout: "inactive", stderr: "", exitCode: 3 })) }));
    expect(await inactive.isRunning("conv-1", "marimo")).toBe(false);
  });

  it("start runs `systemctl start <unit>` and invalidates the cache", async () => {
    const execute = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const download = vi.fn(async () => MANIFEST);
    const reg = make(fakeExec({ execute, download }));
    await reg.list("conv-1"); // populate cache (download #1)
    await reg.start("conv-1", "marimo");
    expect(execute).toHaveBeenCalledWith({ command: "systemctl", args: ["start", "webservice-marimo"] });
    await reg.list("conv-1"); // cache dropped -> download #2
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("start throws when the unit fails", async () => {
    const reg = make(fakeExec({ execute: vi.fn(async () => ({ stdout: "", stderr: "boom", exitCode: 1 })) }));
    await expect(reg.start("conv-1", "marimo")).rejects.toThrow(/failed/);
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
