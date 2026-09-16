/**
 * Tier 1 contract — the show_sandbox_resources / set_sandbox_resources MCP tool
 * handlers. The agent sees its sandbox's current cpu/memory/gpu and right-sizes it.
 * Validation lives HERE (a bad quantity is refused, never sent to the broker); the
 * wiring's setResources WRITES the broker size spec (applied on the next restart).
 */

import { describe, it, expect, vi } from "vitest";

import {
  handleShowSandboxResources,
  handleSetSandboxResources,
  type SandboxResourceToolsWiring,
} from "../../src/agent/resourceTools.js";
import type { SandboxResources } from "../../src/session/resources.js";

function wiring(over: Partial<SandboxResourceToolsWiring> = {}): {
  deps: SandboxResourceToolsWiring;
  set: Array<[string, SandboxResources]>;
} {
  const set: Array<[string, SandboxResources]> = [];
  const deps: SandboxResourceToolsWiring = {
    currentResources: async () => ({ requests: { cpu: "500m", memory: "1Gi" }, limits: { memory: "4Gi" } }),
    setResources: vi.fn(async (id: string, r: SandboxResources) => {
      set.push([id, r]);
      return true; // the size was recorded on the broker
    }),
    ...over,
  };
  return { deps, set };
}

describe("show_sandbox_resources", () => {
  it("renders the current cpu / memory (requests + limits)", async () => {
    const res = await handleShowSandboxResources(wiring().deps, "c1");
    const text = res.content[0].text;
    expect(text).toContain("500m");
    expect(text).toContain("1Gi");
    expect(text).toContain("4Gi");
  });

  it("renders (default) when nothing is stored", async () => {
    const res = await handleShowSandboxResources(wiring({ currentResources: async () => ({}) }).deps, "c1");
    expect(res.content[0].text).toContain("(default)");
  });
});

describe("set_sandbox_resources", () => {
  it("maps flat args → SandboxResources and calls setResources, noting the next-restart apply", async () => {
    const { deps, set } = wiring();
    const res = await handleSetSandboxResources(deps, "c1", { limitMemory: "8Gi", requestCpu: "2" });
    expect(res.isError).toBeFalsy();
    expect(set).toHaveLength(1);
    expect(set[0][0]).toBe("c1");
    expect(set[0][1]).toEqual({ requests: { cpu: "2" }, limits: { memory: "8Gi" } });
    expect(res.content[0].text.toLowerCase()).toContain("restart");
  });

  it("maps gpu args on both sides", async () => {
    const { deps, set } = wiring();
    await handleSetSandboxResources(deps, "c1", { requestGpu: 1, limitGpu: 1 });
    expect(set[0][1]).toEqual({ requests: { gpu: 1 }, limits: { gpu: 1 } });
  });

  it("REFUSES a bad quantity (isError, names the field) and never calls setResources", async () => {
    const { deps, set } = wiring();
    const res = await handleSetSandboxResources(deps, "c1", { limitMemory: "8gb" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/memory|8gb/i);
    expect(set).toEqual([]);
  });

  it("surfaces a setResources rejection (e.g. the broker write failed) as an error", async () => {
    const { deps } = wiring({
      setResources: vi.fn(async () => {
        throw new Error("broker set size failed: 500");
      }),
    });
    const res = await handleSetSandboxResources(deps, "c1", { limitMemory: "8Gi" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("broker set size failed");
  });
});

describe("show_sandbox_resources — the deployment's size presets", () => {
  const sizes = {
    small: { cpu: "1", memory: "2Gi", hint: "A single service, small repos." },
    large: { cpu: "4", memory: "16Gi", hint: "Parallel builds, large test runs." },
    "gpu-small": { cpu: "4", memory: "16Gi", gpu: 1 },
  };

  it("lists the presets, marks the default, and carries each deployment hint", async () => {
    const { deps } = wiring({ availableSizes: async () => ({ sizes, default: "small" }) });
    const text = (await handleShowSandboxResources(deps, "c1")).content[0].text;
    expect(text).toContain("small: 1 CPU, 2Gi");
    expect(text).toContain("large: 4 CPU, 16Gi");
    // The hint is the whole point of a deployment-authored catalog — without it the
    // model picks by guessing at numbers.
    expect(text).toContain("Parallel builds, large test runs.");
    expect(text).toMatch(/small:.*\(default\)/);
  });

  it("renders a GPU preset's gpu count, and omits the dash when a preset has no hint", async () => {
    const { deps } = wiring({ availableSizes: async () => ({ sizes, default: "small" }) });
    const line = (await handleShowSandboxResources(deps, "c1")).content[0].text
      .split("\n")
      .find((l) => l.startsWith("- gpu-small:"))!;
    expect(line).toContain("1 GPU");
    expect(line).not.toContain("—");
  });

  it("still reports the CURRENT size when the preset lookup fails (advice is not load-bearing)", async () => {
    const { deps } = wiring({
      availableSizes: async () => {
        throw new Error("broker unreachable");
      },
    });
    const res = await handleShowSandboxResources(deps, "c1");
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("500m");
  });

  it("omits the preset block entirely when the deployment configured none", async () => {
    const { deps } = wiring({ availableSizes: async () => ({ sizes: {}, default: null }) });
    const text = (await handleShowSandboxResources(deps, "c1")).content[0].text;
    expect(text).not.toContain("Available size presets");
  });
});
