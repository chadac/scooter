/**
 * Tier 1 contract — the show_sandbox_resources / set_sandbox_resources MCP tool
 * handlers. The agent sees its sandbox's current cpu/memory/gpu and right-sizes +
 * restarts it. Validation lives HERE (a bad quantity is refused, never sent to the
 * CR); the wiring's setResources does the persist→suspend→resume mechanism.
 * See todo/RESTART_RESOURCES.md.
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
      return true; // a restart happened
    }),
    ...over,
  };
  return { deps, set };
}

describe("show_sandbox_resources", () => {
  it("renders the current cpu / memory (requests + limits)", async () => {
    const text = (await handleShowSandboxResources(wiring().deps, "c1")).content[0].text;
    expect(text).toContain("500m");
    expect(text).toContain("1Gi");
    expect(text).toContain("4Gi");
  });
});

describe("set_sandbox_resources", () => {
  it("maps flat args → SandboxResources and calls setResources, reporting the restart", async () => {
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

  it("reports 'no change' when setResources is a no-op (requested == current)", async () => {
    const { deps } = wiring({ setResources: vi.fn(async () => false) });
    const res = await handleSetSandboxResources(deps, "c1", { limitMemory: "4Gi" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.toLowerCase()).toMatch(/no change|already/);
  });

  it("surfaces a setResources rejection (e.g. a switch in flight) as an error", async () => {
    const { deps } = wiring({
      setResources: vi.fn(async () => {
        throw new Error("an environment switch is in progress");
      }),
    });
    const res = await handleSetSandboxResources(deps, "c1", { limitMemory: "8Gi" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("in progress");
  });
});
