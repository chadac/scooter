/**
 * Tier 1 contract — the advisory fit check between a web service's declared
 * requirement and the sandbox's actual limits. The point of the feature is turning
 * a silent OOM kill into a sentence, so the tests pin BOTH directions: a real gap
 * is reported, and anything we can't judge stays quiet (a false warning is worse
 * than none — it trains the reader to ignore the true one).
 */

import { describe, it, expect } from "vitest";

import { cpuToMillicores, memoryToBytes, shortfalls, fitAdvice } from "../../src/session/resourceFit.js";

describe("quantity parsing", () => {
  it("reads cpu as millicores, whole and milli", () => {
    expect(cpuToMillicores("2")).toBe(2000);
    expect(cpuToMillicores("500m")).toBe(500);
    expect(cpuToMillicores("0.5")).toBe(500);
  });

  it("reads memory in binary and decimal units, and bare bytes", () => {
    expect(memoryToBytes("1Gi")).toBe(1024 ** 3);
    expect(memoryToBytes("512Mi")).toBe(512 * 1024 ** 2);
    expect(memoryToBytes("2G")).toBe(2e9);
    expect(memoryToBytes("1024")).toBe(1024);
  });

  it("returns undefined for junk rather than guessing a number", () => {
    for (const bad of ["", "abc", "2GB", "-1", undefined]) {
      expect(cpuToMillicores(bad as string)).toBeUndefined();
      expect(memoryToBytes(bad as string)).toBeUndefined();
    }
  });

  it("does not confuse Mi with M (the 1024 vs 1000 trap)", () => {
    expect(memoryToBytes("1Mi")).toBe(1048576);
    expect(memoryToBytes("1M")).toBe(1000000);
  });
});

describe("shortfalls", () => {
  const sandbox = { requests: { cpu: "2", memory: "4Gi" }, limits: { cpu: "2", memory: "4Gi" } };

  it("reports memory the sandbox cannot cover", () => {
    expect(shortfalls({ memory: "8Gi" }, sandbox)).toEqual([
      { dimension: "memory", need: "8Gi", have: "4Gi" },
    ]);
  });

  it("stays silent when the need fits, including exactly at the cap", () => {
    expect(shortfalls({ memory: "4Gi", cpu: "2" }, sandbox)).toEqual([]);
    expect(shortfalls({ memory: "2Gi" }, sandbox)).toEqual([]);
  });

  it("reports every failing dimension at once, not just the first", () => {
    expect(shortfalls({ cpu: "4", memory: "8Gi" }, sandbox).map((s) => s.dimension)).toEqual([
      "cpu",
      "memory",
    ]);
  });

  it("treats an absent GPU limit as zero — a sandbox without the resource cannot run it", () => {
    expect(shortfalls({ gpu: 1 }, sandbox)).toEqual([
      { dimension: "gpu", need: "1", have: "0" },
    ]);
  });

  it("is quiet when the sandbox has enough GPUs", () => {
    expect(shortfalls({ gpu: 1 }, { limits: { gpu: 1 } })).toEqual([]);
  });

  it("cannot judge an un-capped dimension, so says nothing", () => {
    expect(shortfalls({ memory: "8Gi" }, { limits: { cpu: "2" } })).toEqual([]);
    expect(shortfalls({ memory: "8Gi" }, undefined)).toEqual([]);
  });

  it("says nothing when the service declared no requirement", () => {
    expect(shortfalls({}, sandbox)).toEqual([]);
  });
});

describe("fitAdvice", () => {
  const sandbox = { limits: { cpu: "2", memory: "4Gi" } };

  it("names the service, the need, the cap, and that it still starts", () => {
    const msg = fitAdvice("marimo", { memory: "8Gi" }, sandbox)!;
    expect(msg).toContain("marimo");
    expect(msg).toContain("8Gi");
    expect(msg).toContain("4Gi");
    // Advisory, never a block — the wording has to say so or the agent will treat
    // it as a refusal and give up instead of proceeding.
    expect(msg).toContain("still start");
  });

  it("is undefined when everything fits (nothing to show)", () => {
    expect(fitAdvice("marimo", { memory: "1Gi" }, sandbox)).toBeUndefined();
  });
});
