/**
 * The show_sandbox_resources and set_sandbox_resources MCP tool handlers. Validation
 * lives here (a bad quantity is refused before reaching the broker); the wiring's
 * setResources writes the size spec, applied on the next restart.
 */

import { describe, it, expect, vi } from "vitest";

import {
  handleShowSandboxResources,
  handleSetSandboxResources,
  handleRestartSandbox,
  handleStopSandbox,
  handleWaitForSandbox,
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
      return true;
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
    // Without the hint the model picks by guessing at numbers.
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

describe("restart_sandbox / stop_sandbox handlers", () => {
  const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");

  it("restart_sandbox reports the image swap and size, and reminds what stopped", async () => {
    const { deps } = wiring({
      restartSandbox: async () => ({ fromImage: "os:old", toImage: "os:new", imageCurrent: true, sizeApplied: true, ready: true }),
    });
    const r = await handleRestartSandbox(deps, "c1");
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("from_image: os:old");
    expect(text(r)).toContain("to_image: os:new");
    expect(text(r)).toContain("size_applied: true");
    expect(text(r)).toMatch(/background jobs or web services/);
  });

  it("restart_sandbox says so when the image update failed", async () => {
    const { deps } = wiring({
      restartSandbox: async () => ({ fromImage: "os:old", toImage: "os:old", imageCurrent: false, sizeApplied: false, ready: true }),
    });
    expect(text(await handleRestartSandbox(deps, "c1"))).toMatch(/image update failed/);
  });

  it("restart_sandbox surfaces a 409 (another run in the sandbox) as a tool error", async () => {
    const { deps } = wiring({
      restartSandbox: async () => {
        throw Object.assign(new Error("conversation c2 is running in this sandbox; restart after it finishes"), { code: 409 });
      },
    });
    const r = await handleRestartSandbox(deps, "c1");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("c2 is running");
  });

  it("stop_sandbox returns what the next start picks up", async () => {
    const { deps } = wiring({
      stopSandbox: async () => ({ deferred: true, pending: { image: { from: "os:old", to: "os:new" }, size: true } }),
    });
    const t = text(await handleStopSandbox(deps, "c1"));
    expect(t).toContain("Sandbox stopped");
    expect(t).toMatch(/pending_restart: a newer sandbox image \(os:old -> os:new\), your recorded size change/);
  });

  it("set_sandbox_resources points at restart_sandbox only when restart is wired", async () => {
    const withRestart = wiring({ restartSandbox: vi.fn() });
    expect(text(await handleSetSandboxResources(withRestart.deps, "c1", { requestCpu: "2", limitCpu: "2" }))).toContain("restart_sandbox");
    const without = wiring();
    expect(text(await handleSetSandboxResources(without.deps, "c1", { requestCpu: "2", limitCpu: "2" }))).not.toContain("restart_sandbox");
  });
});

describe("wait_for_sandbox", () => {
  const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

  it("reports Ready, or why the pod still isn't", async () => {
    const waitForSandbox = vi.fn(async (_id: string, ms: number) => (ms > 1000 ? "pod Pending: Insufficient cpu" : undefined));
    const { deps } = wiring({ waitForSandbox });
    expect(text(await handleWaitForSandbox(deps, "c1", { timeout_seconds: 1 }))).toMatch(/^Sandbox ready/);
    const slow = text(await handleWaitForSandbox(deps, "c1", {}));
    expect(slow).toContain("still starting after 120s: pod Pending: Insufficient cpu");
    expect(waitForSandbox).toHaveBeenLastCalledWith("c1", 120_000);
  });

  it("is an error when not wired", async () => {
    expect((await handleWaitForSandbox(wiring().deps, "c1", {})).isError).toBe(true);
  });
});
