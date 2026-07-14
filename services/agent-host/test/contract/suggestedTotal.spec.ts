/**
 * Tier 1 contract — the module registry's suggested-total math (stage 1):
 * cpu additive, memory additive, gpu = max, over a baseline + enabled modules.
 * Plus the k8s quantity arithmetic it rests on. See todo/MODULE_REGISTRY.md.
 */

import { describe, it, expect } from "vitest";

import { suggestedTotal } from "../../src/modules/suggestedTotal.js";
import {
  cpuToMillis,
  millisToCpu,
  memToBytes,
  bytesToMem,
  type SandboxResources,
} from "../../src/session/resources.js";

describe("quantity arithmetic", () => {
  it("parses + renders cpu (millicpu round-trip, whole cores drop the suffix)", () => {
    expect(cpuToMillis("500m")).toBe(500);
    expect(cpuToMillis("2")).toBe(2000);
    expect(millisToCpu(1500)).toBe("1500m");
    expect(millisToCpu(2000)).toBe("2");
  });

  it("parses + renders memory (bytes; largest even binary unit)", () => {
    expect(memToBytes("1Gi")).toBe(1024 ** 3);
    expect(memToBytes("512Mi")).toBe(512 * 1024 ** 2);
    // 1Gi + 512Mi = 1536Mi
    expect(bytesToMem(1024 ** 3 + 512 * 1024 ** 2)).toBe("1536Mi");
    expect(bytesToMem(1024 ** 3)).toBe("1Gi");
  });
});

describe("suggestedTotal", () => {
  const base: SandboxResources = { requests: { cpu: "500m", memory: "1Gi" }, limits: { memory: "4Gi" } };

  it("returns the baseline when no modules are enabled", () => {
    expect(suggestedTotal(base, [])).toEqual(base);
  });

  it("ADDS cpu and memory across baseline + modules", () => {
    const mod: SandboxResources = { requests: { cpu: "1", memory: "1Gi" } };
    const total = suggestedTotal(base, [mod]);
    expect(total.requests?.cpu).toBe("1500m"); // 500m + 1
    expect(total.requests?.memory).toBe("2Gi"); // 1Gi + 1Gi
  });

  it("takes gpu as the MAX, not the sum", () => {
    const a: SandboxResources = { limits: { gpu: 1 } };
    const b: SandboxResources = { limits: { gpu: 2 } };
    expect(suggestedTotal(base, [a, b]).limits?.gpu).toBe(2);
  });

  it("treats a module with NO resources as zero contribution (not an error)", () => {
    expect(suggestedTotal(base, [undefined, {}])).toEqual(base);
  });

  it("sums requests and limits independently", () => {
    const mod: SandboxResources = { requests: { cpu: "1" }, limits: { memory: "4Gi" } };
    const total = suggestedTotal(base, [mod]);
    expect(total.requests?.cpu).toBe("1500m");
    expect(total.limits?.memory).toBe("8Gi"); // 4Gi + 4Gi
  });
});
