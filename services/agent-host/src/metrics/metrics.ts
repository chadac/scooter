/**
 * OpenTelemetry metrics for the agent-host — vendor-neutral via OTLP, so a
 * deployer can ship to Datadog / Grafana / Honeycomb / any OTLP backend.
 *
 * Two metric families:
 *   - OPERATIONAL (no token data needed): run count, run-duration histogram,
 *     runs by model, active/suspended sandbox gauges, errors.
 *   - COST/USAGE: per-run token counts (by kind + model) read from goose's
 *     session DB (see gooseUsage.ts) and derived USD cost (see pricing.ts).
 *
 * Configuration is via the standard OTEL_EXPORTER_OTLP_* env vars (the OTel SDK
 * reads them directly) plus an on/off flag — OFF by default. When disabled,
 * createMetrics() returns a NO-OP sink so call sites stay unconditional.
 *
 * The rest of the codebase depends only on the MetricsSink interface, never on
 * OTel types — so metrics can be disabled, faked in tests, or swapped wholesale.
 *
 * DESIGN STAGE: signatures + types only. No implementation.
 */

import { metrics, type Counter, type Histogram, type ObservableGauge } from "@opentelemetry/api";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from "@opentelemetry/semantic-conventions";

import { computeCost, type PriceTable } from "./pricing.js";
import type { GooseUsageReader } from "./gooseUsage.js";
import { debug, debugError } from "../debug.js";

/** What the app reports. A no-op implementation is used when metrics are off. */
export interface MetricsSink {
  /** A run started for a conversation on a given model. */
  runStarted(attrs: { conversationId: string; model: string }): void;

  /**
   * A run finished. Records the run count + duration histogram (by model +
   * outcome) and, if a goose usage reader is configured, asynchronously reads
   * this session's token-usage delta and emits token + derived-cost metrics.
   */
  runFinished(attrs: {
    conversationId: string;
    model: string;
    acpSessionId: string;
    durationMs: number;
    outcome: "ok" | "error";
  }): void;

  /** Observed sandbox population (emitted from the idle sweep / provisioner). */
  setSandboxCounts(counts: { running: number; suspended: number }): void;

  /** A broker request passed through (provider + outcome), if wired. */
  brokerRequest?(attrs: { provider: string; outcome: "ok" | "error" }): void;

  /** A durable conversation-log append FAILED (finding #4) — the conversation's
   *  only persistence lost a turn. Surfaced so an operator can alert on it. */
  persistenceError?(attrs: { conversationId: string }): void;

  /** Flush + shut down the exporter (called on graceful shutdown). */
  shutdown(): Promise<void>;
}

export interface MetricsConfig {
  /** Master switch. Off -> createMetrics returns the no-op sink. */
  enabled: boolean;
  /** Logical service name (resource attribute service.name). */
  serviceName: string;
  /** deployment.environment resource attribute (e.g. "dev", "prod"). Optional. */
  environment?: string;
  /** The per-model price table for cost derivation (empty = no cost, just tokens). */
  prices: PriceTable;
  /**
   * Reads token usage per session for cost metrics. Omit to emit operational
   * metrics only (no token/cost). Endpoint/headers come from OTEL_* env.
   */
  usageReader?: GooseUsageReader;
  /**
   * Test seam: an alternate MetricReader (e.g. a manual reader over an
   * InMemoryMetricExporter) instead of the OTLP/periodic exporter. Production
   * leaves this unset. Typed loosely to avoid leaking the SDK type into the
   * public interface.
   */
  readerForTest?: unknown;
}

/**
 * Build the metrics sink. When `enabled` is false, returns a no-op sink (every
 * method is a cheap no-op, shutdown resolves immediately) so call sites don't
 * branch. When enabled, initializes the OTel MeterProvider with an OTLP metric
 * exporter (configured from OTEL_EXPORTER_OTLP_* env) and the instruments.
 */
export function createMetrics(config: MetricsConfig): MetricsSink {
  if (!config.enabled) return noopMetrics();

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...(config.environment ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment } : {}),
  });
  // The OTLP exporter reads OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS / _PROTOCOL
  // etc. from the environment automatically — nothing to thread through here.
  // Tests inject a manual reader (over an in-memory exporter) instead.
  const reader =
    (config.readerForTest as PeriodicExportingMetricReader | undefined) ??
    new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() });
  const provider = new MeterProvider({ resource, readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  const meter = provider.getMeter("agent-host");

  // --- Instruments ---------------------------------------------------------
  const runs: Counter = meter.createCounter("agent_runs_total", {
    description: "Agent runs (prompts) completed, by model + outcome.",
  });
  const runDuration: Histogram = meter.createHistogram("agent_run_duration_ms", {
    description: "Wall-clock duration of an agent run, ms.",
    unit: "ms",
  });
  const tokens: Counter = meter.createCounter("agent_tokens_total", {
    description: "Tokens used, by model + token kind (input/output/cache_read/cache_write).",
  });
  const cost: Counter = meter.createCounter("agent_cost_usd_total", {
    description: "Derived cost in USD (tokens × price table), by model.",
    unit: "USD",
  });
  const brokerReqs: Counter = meter.createCounter("agent_broker_requests_total", {
    description: "Broker requests, by provider + outcome.",
  });
  const persistenceErrors: Counter = meter.createCounter("agent_persistence_errors_total", {
    description: "Durable conversation-log append failures (a turn was lost).",
  });

  // Sandbox population is observed (set from outside); an ObservableGauge reads
  // the latest values at collection time.
  let sandboxRunning = 0;
  let sandboxSuspended = 0;
  const sandboxGauge: ObservableGauge = meter.createObservableGauge("agent_sandboxes", {
    description: "Sandbox population by state.",
  });
  sandboxGauge.addCallback((obs) => {
    obs.observe(sandboxRunning, { state: "running" });
    obs.observe(sandboxSuspended, { state: "suspended" });
  });

  // Per-session cumulative usage already counted, so we emit only the per-run
  // DELTA (goose's accumulated_* columns are cumulative for the session).
  const lastUsage = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();

  const emitUsageDelta = async (acpSessionId: string, model: string): Promise<void> => {
    const reader = config.usageReader;
    if (!reader) return;
    try {
      const u = await reader.readSessionUsage(acpSessionId);
      if (!u) return; // no DB / unknown session -> skip silently (graceful)
      const cur = {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cachedReadTokens ?? 0,
        cacheWrite: u.cachedWriteTokens ?? 0,
      };
      const prev = lastUsage.get(acpSessionId) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const delta = {
        input: Math.max(0, cur.input - prev.input),
        output: Math.max(0, cur.output - prev.output),
        cacheRead: Math.max(0, cur.cacheRead - prev.cacheRead),
        cacheWrite: Math.max(0, cur.cacheWrite - prev.cacheWrite),
      };
      lastUsage.set(acpSessionId, cur);

      const base = { model };
      if (delta.input) tokens.add(delta.input, { ...base, kind: "input" });
      if (delta.output) tokens.add(delta.output, { ...base, kind: "output" });
      if (delta.cacheRead) tokens.add(delta.cacheRead, { ...base, kind: "cache_read" });
      if (delta.cacheWrite) tokens.add(delta.cacheWrite, { ...base, kind: "cache_write" });

      const c = computeCost(
        model,
        {
          inputTokens: delta.input,
          outputTokens: delta.output,
          cachedReadTokens: delta.cacheRead,
          cachedWriteTokens: delta.cacheWrite,
        },
        config.prices,
      );
      if (c.priced && c.totalCost > 0) cost.add(c.totalCost, base);
      else if (!c.priced) debug("[metrics] no price for model %s; tokens counted, cost omitted", model);
    } catch (err) {
      debugError("[metrics] usage/cost emit failed:", err);
    }
  };

  return {
    runStarted() {
      // Reserved for an in-flight gauge if needed; runs are counted on finish.
    },

    runFinished(attrs) {
      runs.add(1, { model: attrs.model, outcome: attrs.outcome });
      runDuration.record(attrs.durationMs, { model: attrs.model, outcome: attrs.outcome });
      // Token/cost read is async + best-effort; don't block the run.
      void emitUsageDelta(attrs.acpSessionId, attrs.model);
    },

    setSandboxCounts(counts) {
      sandboxRunning = counts.running;
      sandboxSuspended = counts.suspended;
    },

    brokerRequest(attrs) {
      brokerReqs.add(1, { provider: attrs.provider, outcome: attrs.outcome });
    },

    persistenceError(attrs) {
      persistenceErrors.add(1, { conversationId: attrs.conversationId });
    },

    async shutdown() {
      try {
        await provider.shutdown(); // flushes the exporter
      } catch (err) {
        debugError("[metrics] shutdown failed:", err);
      }
      await config.usageReader?.close();
    },
  };
}

/** The always-safe no-op sink (used when metrics are disabled or in tests). */
export function noopMetrics(): MetricsSink {
  return {
    runStarted() {},
    runFinished() {},
    setSandboxCounts() {},
    brokerRequest() {},
    persistenceError() {},
    async shutdown() {},
  };
}
