/**
 * Tier 1 contract test — the OTel metrics sink.
 *
 * Drives createMetrics() with an in-memory exporter (test seam) + a fake usage
 * reader, runs a couple of runs, and asserts the run/token/cost metrics are
 * emitted with the right attributes + values. Also covers the no-op sink and
 * per-run DELTA accounting (goose's usage columns are cumulative per session).
 */

import { describe, it, expect } from "vitest";
import {
  InMemoryMetricExporter,
  AggregationTemporality,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

import { createMetrics, noopMetrics, type MetricsConfig } from "../../src/metrics/metrics.js";
import type { GooseUsageReader } from "../../src/metrics/gooseUsage.js";
import type { TokenUsage } from "../../src/metrics/pricing.js";

/** A usage reader that returns scripted CUMULATIVE usage per session. */
function fakeUsageReader(bySession: Record<string, TokenUsage>): GooseUsageReader {
  return {
    async readSessionUsage(id) {
      return bySession[id];
    },
    async close() {},
  };
}

/** Collect all metrics currently held by the in-memory exporter, flattened to
 *  {name, value, attributes} points across every data point. */
async function collect(reader: PeriodicExportingMetricReader, exporter: InMemoryMetricExporter) {
  await reader.collect();
  // forceFlush pushes collected metrics into the exporter's in-memory list.
  await reader.forceFlush();
  const out: Array<{ name: string; value: number; attrs: Record<string, unknown> }> = [];
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        for (const dp of m.dataPoints) {
          out.push({ name: m.descriptor.name, value: dp.value as number, attrs: dp.attributes });
        }
      }
    }
  }
  return out;
}

function setup(config: Partial<MetricsConfig> & Pick<MetricsConfig, "prices" | "usageReader">) {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    // Long interval; the test collects manually.
    exportIntervalMillis: 60_000,
  });
  const sink = createMetrics({
    enabled: true,
    serviceName: "agent-host-test",
    readerForTest: reader,
    ...config,
  });
  return { sink, reader, exporter };
}

const PRICES = { "claude-opus": { inputPerMillion: 15, outputPerMillion: 75 } };

describe("metrics sink", () => {
  it("noopMetrics is safe to call and shuts down cleanly", async () => {
    const n = noopMetrics();
    n.runStarted({ conversationId: "c", model: "m" });
    n.runFinished({ conversationId: "c", model: "m", acpSessionId: "s", durationMs: 1, outcome: "ok" });
    n.setSandboxCounts({ running: 1, suspended: 2 });
    await expect(n.shutdown()).resolves.toBeUndefined();
  });

  it("createMetrics returns the no-op sink when disabled", async () => {
    const sink = createMetrics({ enabled: false, serviceName: "x", prices: {}, usageReader: undefined });
    // No throw, no exporter.
    sink.runFinished({ conversationId: "c", model: "m", acpSessionId: "s", durationMs: 5, outcome: "ok" });
    await sink.shutdown();
  });

  it("counts runs + records duration by model and outcome", async () => {
    const { sink, reader, exporter } = setup({ prices: PRICES, usageReader: undefined });
    sink.runFinished({ conversationId: "c1", model: "claude-opus", acpSessionId: "s1", durationMs: 1200, outcome: "ok" });
    sink.runFinished({ conversationId: "c1", model: "claude-opus", acpSessionId: "s1", durationMs: 800, outcome: "error" });

    const points = await collect(reader, exporter);
    const runs = points.filter((p) => p.name === "agent_runs_total");
    expect(runs.find((p) => p.attrs.outcome === "ok")?.value).toBe(1);
    expect(runs.find((p) => p.attrs.outcome === "error")?.value).toBe(1);
    expect(points.some((p) => p.name === "agent_run_duration_ms")).toBe(true);
    await sink.shutdown();
  });

  it("emits token + derived-cost metrics from goose usage", async () => {
    const reader0 = fakeUsageReader({ s1: { inputTokens: 1_000_000, outputTokens: 200_000 } });
    const { sink, reader, exporter } = setup({ prices: PRICES, usageReader: reader0 });

    sink.runFinished({ conversationId: "c1", model: "claude-opus", acpSessionId: "s1", durationMs: 100, outcome: "ok" });
    // runFinished kicks off an async usage read; let it settle.
    await new Promise((r) => setTimeout(r, 20));

    const points = await collect(reader, exporter);
    const tokens = points.filter((p) => p.name === "agent_tokens_total");
    expect(tokens.find((p) => p.attrs.kind === "input")?.value).toBe(1_000_000);
    expect(tokens.find((p) => p.attrs.kind === "output")?.value).toBe(200_000);

    // cost = 1M input @ $15 + 0.2M output @ $75 = 15 + 15 = 30
    const cost = points.find((p) => p.name === "agent_cost_usd_total");
    expect(cost?.value).toBeCloseTo(30, 6);
    expect(cost?.attrs.model).toBe("claude-opus");
    await sink.shutdown();
  });

  it("emits only the per-run DELTA for cumulative session usage", async () => {
    // Mutable cumulative usage: grows between runs.
    const usage: Record<string, TokenUsage> = { s1: { inputTokens: 100, outputTokens: 0 } };
    const { sink, reader, exporter } = setup({
      prices: PRICES,
      usageReader: { async readSessionUsage(id) { return usage[id]; }, async close() {} },
    });

    sink.runFinished({ conversationId: "c1", model: "claude-opus", acpSessionId: "s1", durationMs: 1, outcome: "ok" });
    await new Promise((r) => setTimeout(r, 10));
    // Second run: cumulative grew to 250 input -> delta should be 150.
    usage.s1 = { inputTokens: 250, outputTokens: 0 };
    sink.runFinished({ conversationId: "c1", model: "claude-opus", acpSessionId: "s1", durationMs: 1, outcome: "ok" });
    await new Promise((r) => setTimeout(r, 10));

    const points = await collect(reader, exporter);
    const inputTokens = points.find((p) => p.name === "agent_tokens_total" && p.attrs.kind === "input");
    // CUMULATIVE temporality sums the two deltas (100 + 150) = 250 total counted.
    expect(inputTokens?.value).toBe(250);
    await sink.shutdown();
  });

  it("reports sandbox population as a gauge", async () => {
    const { sink, reader, exporter } = setup({ prices: {}, usageReader: undefined });
    sink.setSandboxCounts({ running: 3, suspended: 5 });

    const points = await collect(reader, exporter);
    const gauges = points.filter((p) => p.name === "agent_sandboxes");
    expect(gauges.find((p) => p.attrs.state === "running")?.value).toBe(3);
    expect(gauges.find((p) => p.attrs.state === "suspended")?.value).toBe(5);
    await sink.shutdown();
  });
});
