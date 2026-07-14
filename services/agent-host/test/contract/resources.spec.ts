/**
 * Tier 1 contract — session/resources.ts: the friendly cpu/memory/gpu shape's
 * validator, the friendly→k8s render step (gpu → nvidia.com/gpu), and the
 * conversation → deployment-default → platform-default resolve order.
 *
 * These are the pure core of the "restart at new size" feature (todo/RESTART_RESOURCES.md).
 * validateResources is the boundary guard (a bad quantity must never reach the CR);
 * renderResources exists because the provisioner spreads a k8s block VERBATIM, so
 * gpu can't be a bare field.
 */

import { describe, it, expect } from "vitest";

import {
  validateResources,
  renderResources,
  resolveResources,
  InvalidResourceError,
  GPU_RESOURCE,
  PLATFORM_DEFAULT_RESOURCES,
  type SandboxResources,
} from "../../src/session/resources.js";

describe("validateResources", () => {
  it("accepts valid cpu / memory / gpu quantities and returns the value", () => {
    const r: SandboxResources = {
      requests: { cpu: "500m", memory: "1Gi", gpu: 0 },
      limits: { cpu: "2", memory: "8Gi", gpu: 1 },
    };
    expect(validateResources(r)).toEqual(r);
  });

  it("accepts an empty / partial value (omitted dimensions keep current)", () => {
    expect(validateResources({})).toEqual({});
    expect(validateResources({ limits: { memory: "4Gi" } })).toEqual({ limits: { memory: "4Gi" } });
  });

  it.each([
    ["requests.cpu", { requests: { cpu: "half" } }],
    ["requests.cpu", { requests: { cpu: "2.5" } }], // decimals not allowed by ^\d+m?$
    ["limits.memory", { limits: { memory: "8gb" } }], // wrong unit casing
    ["requests.memory", { requests: { memory: "1 Gi" } }], // space
  ])("REJECTS a bad quantity (%s) with InvalidResourceError naming the field", (field, bad) => {
    try {
      validateResources(bad as SandboxResources);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidResourceError);
      expect((e as InvalidResourceError).field).toBe(field);
    }
  });

  it("REJECTS a negative or non-integer gpu", () => {
    expect(() => validateResources({ requests: { gpu: -1 } })).toThrow(InvalidResourceError);
    expect(() => validateResources({ limits: { gpu: 1.5 } })).toThrow(InvalidResourceError);
  });
});

describe("renderResources", () => {
  it("passes cpu + memory through unchanged", () => {
    expect(renderResources({ requests: { cpu: "500m", memory: "1Gi" }, limits: { memory: "4Gi" } })).toEqual({
      requests: { cpu: "500m", memory: "1Gi" },
      limits: { memory: "4Gi" },
    });
  });

  it("renders gpu as nvidia.com/gpu on BOTH requests and limits (k8s requires request==limit)", () => {
    const out = renderResources({ requests: { gpu: 2 } });
    expect(out.requests?.[GPU_RESOURCE]).toBe("2");
    expect(out.limits?.[GPU_RESOURCE]).toBe("2");
  });

  it("takes gpu from limits too (either side sets both)", () => {
    const out = renderResources({ limits: { gpu: 1 } });
    expect(out.requests?.[GPU_RESOURCE]).toBe("1");
    expect(out.limits?.[GPU_RESOURCE]).toBe("1");
  });

  it("does not emit empty requests/limits objects for omitted dimensions", () => {
    expect(renderResources({})).toEqual({});
    const out = renderResources({ requests: { cpu: "1" } });
    expect(out.limits).toBeUndefined();
  });
});

describe("resolveResources", () => {
  const conv: SandboxResources = { requests: { cpu: "4", memory: "8Gi" } };
  const deploy: SandboxResources = { requests: { cpu: "1", memory: "2Gi" } };

  it("prefers the conversation override", () => {
    expect(resolveResources(conv, deploy)).toEqual(conv);
  });

  it("falls back to the deployment default when no conversation override", () => {
    expect(resolveResources(undefined, deploy)).toEqual(deploy);
  });

  it("falls back to the platform default when neither is set", () => {
    expect(resolveResources(undefined, undefined)).toEqual(PLATFORM_DEFAULT_RESOURCES);
  });
});
