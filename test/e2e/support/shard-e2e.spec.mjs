import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { packShards, resolveWeights, windowReportWeights } from "./shard-e2e.mjs";

/** A minimal Playwright JSON report: one top-level suite per file, `durations` ms. */
function report(specs) {
  return JSON.stringify({
    suites: Object.entries(specs).map(([file, ms]) => ({
      file,
      specs: [{ file, tests: [{ results: [{ duration: ms }] }] }],
    })),
  });
}

function reportDir(runs) {
  const dir = mkdtempSync(join(tmpdir(), "shard-e2e-"));
  runs.forEach((specs, i) => {
    // One directory per run, as `gh run download` lays them out.
    const sub = join(dir, `run-${i}`);
    mkdirSync(sub);
    writeFileSync(join(sub, "report.json"), report(specs));
  });
  return dir;
}

describe("windowReportWeights", () => {
  it("takes the per-spec MAX across runs, so a truncated run cannot under-weight a spec", () => {
    // `heavy` ran fully in run 0 and was cut short in run 1 (the shard died partway).
    // A mean would report ~68s and pack it as a light spec; the max keeps it at 120s.
    const dir = reportDir([
      { "heavy.spec.ts": 120_000, "light.spec.ts": 10_000 },
      { "heavy.spec.ts": 7_000, "light.spec.ts": 11_000 },
    ]);
    expect(windowReportWeights(dir)).toEqual({ "heavy.spec.ts": 120, "light.spec.ts": 11 });
  });

  it("sums every test within a file, so a file's weight is its whole cost", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-e2e-"));
    writeFileSync(
      join(dir, "report.json"),
      JSON.stringify({
        suites: [
          {
            file: "a.spec.ts",
            specs: [
              { file: "a.spec.ts", tests: [{ results: [{ duration: 5_000 }] }] },
              { file: "a.spec.ts", tests: [{ results: [{ duration: 3_000 }] }] },
            ],
          },
        ],
      }),
    );
    expect(windowReportWeights(dir)).toEqual({ "a.spec.ts": 8 });
  });

  it("is empty for a missing or unreadable directory (callers fall back to the table)", () => {
    expect(windowReportWeights(join(tmpdir(), "definitely-not-here"))).toEqual({});
    expect(windowReportWeights(undefined)).toEqual({});
  });
});

describe("resolveWeights", () => {
  const files = ["a.spec.ts", "b.spec.ts", "c.spec.ts"];

  it("floors a measured weight with the committed one", () => {
    // Every way a weight goes wrong makes it too SMALL, and too-small is what overloads
    // a shard — so a measured value BELOW the committed table does not win.
    const w = resolveWeights(files, { "a.spec.ts": 5 }, { "a.spec.ts": 100 });
    expect(w["a.spec.ts"]).toBe(100);
  });

  it("prefers a measured weight once it exceeds the committed one", () => {
    const w = resolveWeights(files, { "a.spec.ts": 250 }, { "a.spec.ts": 100 });
    expect(w["a.spec.ts"]).toBe(250);
  });

  it("falls back to the flat default for a spec absent from both", () => {
    const w = resolveWeights(files, {}, {});
    expect(w["c.spec.ts"]).toBeGreaterThan(0);
  });
});

describe("packShards", () => {
  it("never emits an empty shard while specs remain unassigned", () => {
    const files = ["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"];
    const weights = { "a.spec.ts": 300, "b.spec.ts": 10, "c.spec.ts": 10, "d.spec.ts": 10 };
    for (const s of packShards(files, weights, 4)) expect(s.specs.length).toBeGreaterThan(0);
  });

  it("balances the committed FULL table within 10% across 4 shards", () => {
    // The regression this guards: the full target used to shard on the fast suite's
    // table, which planned four ~290s shards and produced a 9-minute one beside a
    // 24-minute one. A table in the wrong units shows up here as a spread, not as a
    // red nightly three hours later. Why: PR #675.
    const table = JSON.parse(readFileSync(join(import.meta.dirname, "..", "shard-weights.full.json"), "utf8"));
    const files = Object.keys(table).filter((k) => k.endsWith(".spec.ts"));
    const totals = packShards(files, table, 4).map((s) => s.total);
    expect(Math.max(...totals) / Math.min(...totals)).toBeLessThan(1.1);
  });

  it("keeps the heaviest spec off the heaviest shard (LPT, not round-robin)", () => {
    const files = ["big.spec.ts", "mid.spec.ts", "small.spec.ts"];
    const weights = { "big.spec.ts": 100, "mid.spec.ts": 60, "small.spec.ts": 50 };
    const shards = packShards(files, weights, 2);
    // big alone (100) vs mid+small (110) — LPT seeds the heaviest first, then fills.
    expect(shards.map((s) => s.specs.length).sort()).toEqual([1, 2]);
  });
});

describe("the committed FULL table", () => {
  it("covers every spec in the full allowlist", () => {
    // A spec added to the allowlist without a weight silently gets DEFAULT_WEIGHT (30s),
    // which for a cluster spec is a ~5x under-estimate — it lands on a full shard.
    const here = import.meta.dirname;
    const allow = JSON.parse(readFileSync(join(here, "..", "full-specs.json"), "utf8"));
    const table = JSON.parse(readFileSync(join(here, "..", "shard-weights.full.json"), "utf8"));
    expect(allow.filter((f) => !(f in table))).toEqual([]);
  });
});
