/** SANDBOX_GPU_RESOURCE renames the GPU's extended resource both ways, for CDI plugins that
 *  don't advertise nvidia.com/gpu. */

import { afterEach, describe, expect, it, vi } from "vitest";

async function load(name?: string) {
  vi.resetModules();
  if (name !== undefined) vi.stubEnv("SANDBOX_GPU_RESOURCE", name);
  return import("../../src/session/resources.js");
}

describe("GPU resource name", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to nvidia.com/gpu", async () => {
    const { renderResources } = await load();
    expect(renderResources({ requests: { gpu: 1 }, limits: { gpu: 1 } }).limits).toEqual({ "nvidia.com/gpu": "1" });
  });

  it("renders and un-renders under SANDBOX_GPU_RESOURCE", async () => {
    const { renderResources, unrenderResources } = await load("nvidia.com/gpu-all");
    const block = renderResources({ requests: { cpu: "4", gpu: 1 }, limits: { cpu: "4", gpu: 1 } });
    expect(block.requests).toEqual({ cpu: "4", "nvidia.com/gpu-all": "1" });
    expect(unrenderResources(block).limits).toEqual({ cpu: "4", gpu: 1 });
    expect(unrenderResources({ limits: { "nvidia.com/gpu": "1" } }).limits).toBeUndefined();
  });
});
