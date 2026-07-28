/**
 * Tier 1 contract — the module registry (search/attached/install via in-pod CLIs).
 * Drives createModuleRegistry over a FAKE exec (agent-broker / scooter-rebuild /
 * the registry-modules.json download), asserting it parses the broker catalog,
 * reads attached names, and drives `scooter-rebuild module add`.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createModuleRegistry,
  parseModuleList,
  REGISTRY_IDS_PATH,
  type ModuleRegistry,
} from "../../src/proxy/moduleRegistry.js";
import type { ExecLike } from "../../src/proxy/webServiceRegistry.js";

const REF = { name: "sandbox", namespace: "ns" } as never;

const CATALOG = JSON.stringify({
  modules: [
    { id: 1, name: "gpu-tools", description: "CUDA + drivers", visibility: "public", owner: "c-2" },
    { id: 2, name: "my-secret", description: "", visibility: "private" },
  ],
});

function fakeExec(over: Partial<ExecLike> = {}): ExecLike {
  return {
    execute: vi.fn(async (req) => {
      if (req.command === "agent-broker") return { stdout: CATALOG, stderr: "", exitCode: 0 };
      if (req.command === "scooter-rebuild") return { stdout: "attached gpu-tools — applying...", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    }),
    download: vi.fn(async (p) => (p === REGISTRY_IDS_PATH ? '["gpu-tools"]' : "")),
    ...over,
  };
}

function make(exec: ExecLike | null): ModuleRegistry {
  return createModuleRegistry({
    sandboxFor: () => (exec ? REF : undefined),
    connect: async () => {
      if (!exec) throw new Error("pod asleep");
      return exec;
    },
  });
}

describe("parseModuleList", () => {
  it("reads well-formed modules and skips garbage", () => {
    expect(parseModuleList(CATALOG)).toHaveLength(2);
    expect(parseModuleList(CATALOG)[0]).toMatchObject({ id: 1, name: "gpu-tools", visibility: "public" });
    expect(parseModuleList("not json")).toEqual([]);
    expect(parseModuleList(JSON.stringify({ modules: [{ name: "x" }] }))).toEqual([]); // no id
  });
});

describe("ModuleRegistry", () => {
  it("search() execs agent-broker and parses the catalog", async () => {
    const exec = fakeExec();
    const reg = make(exec);
    const out = await reg.search("c1", "gpu");
    expect(out.map((m) => m.name)).toEqual(["gpu-tools", "my-secret"]);
    expect(exec.execute).toHaveBeenCalledWith({ command: "agent-broker", args: ["modules?q=gpu"] });
  });

  it("attached() reads registry-modules.json", async () => {
    const reg = make(fakeExec());
    expect(await reg.attached("c1")).toEqual(["gpu-tools"]);
  });

  it("attached() returns [] when the file is missing / pod asleep", async () => {
    const reg = make(fakeExec({ download: vi.fn(async () => { throw new Error("ENOENT"); }) }));
    expect(await reg.attached("c1")).toEqual([]);
  });

  it("install() runs `scooter-rebuild module add <ref>` and returns its message", async () => {
    const exec = fakeExec();
    const reg = make(exec);
    const msg = await reg.install("c1", "gpu-tools");
    expect(exec.execute).toHaveBeenCalledWith({ command: "scooter-rebuild", args: ["module", "add", "gpu-tools"] });
    expect(msg).toContain("attached gpu-tools");
  });

  it("install() throws the CLI error on a non-zero exit", async () => {
    const exec = fakeExec({
      execute: vi.fn(async (req) =>
        req.command === "scooter-rebuild"
          ? { stdout: "", stderr: "registry module 'nope' not found", exitCode: 1 }
          : { stdout: CATALOG, stderr: "", exitCode: 0 },
      ),
    });
    await expect(make(exec).install("c1", "nope")).rejects.toThrow(/not found/);
  });

  it("install() throws when the pod isn't running", async () => {
    await expect(make(null).install("c1", "gpu-tools")).rejects.toThrow(/isn't running/);
  });

  it("search() returns [] when the pod is asleep", async () => {
    expect(await make(null).search("c1", "")).toEqual([]);
  });
});
