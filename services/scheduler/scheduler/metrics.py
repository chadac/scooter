"""OpenTelemetry metrics for the scheduler service.

Mirrors the agent-host pattern (services/agent-host/src/metrics/metrics.ts):
- OTLP exporter (vendor-neutral)
- No-op sink when disabled
- In-memory reader as a test seam

Instruments:
  - scheduler_fires_total: Counter {status=spawned|failed}
  - scheduler_spawn_duration_ms: Histogram
  - scheduler_tick_duration_ms: Histogram
  - scheduler_ticks_total: Counter {outcome=ok|error}
  - scheduler_claim_lag_ms: Histogram
  - scheduler_tasks: ObservableGauge {enabled=true|false}
  - scheduler_due_backlog: ObservableGauge
  - scheduler_runs_pruned_total: Counter

CRITICAL: NO task_id or owner attributes — unbounded cardinality.
"""

from __future__ import annotations

from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.metrics import Counter, Histogram, MeterProvider, ObservableGauge
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource

from .logging_config import format_error, get_logger

logger = get_logger("metrics")


class MetricsSink:
    """Interface for recording metrics. A no-op implementation is used when disabled."""

    def fire_started(self) -> None:
        """A task fire started (reserved for in-flight tracking if needed)."""
        pass

    def fire_completed(self, *, status: str, duration_ms: float) -> None:
        """A task fire completed. status=spawned|failed."""
        pass

    def tick_started(self) -> None:
        """A scheduler tick started (reserved)."""
        pass

    def tick_completed(self, *, outcome: str) -> None:
        """A scheduler tick completed. outcome=ok|error. MUST be called every tick."""
        pass

    def claim_lag(self, *, lag_ms: float) -> None:
        """Record the lag between now and a task's next_run_at at claim time."""
        pass

    def set_task_counts(self, *, enabled: int, disabled: int) -> None:
        """Update the observable task count gauges."""
        pass

    def set_due_backlog(self, *, count: int) -> None:
        """Update the observable due-backlog gauge."""
        pass

    def runs_pruned(self, *, count: int) -> None:
        """Record the number of runs deleted by the retention sweep."""
        pass

    async def shutdown(self) -> None:
        """Flush and shut down the exporter."""
        pass


class _OTelMetricsSink(MetricsSink):
    """Live OpenTelemetry metrics sink."""

    def __init__(self, reader):
        resource = Resource.create({"service.name": "agent-scheduler"})
        provider = MeterProvider(resource=resource, metric_readers=[reader])
        # Note: We don't use set_global_meter_provider here; just use the local provider
        self._provider = provider
        meter = provider.get_meter("agent-scheduler")

        # Counters
        self._fires = meter.create_counter(
            "scheduler_fires_total",
            description="Task fires completed, by status (spawned|failed).",
        )
        self._ticks = meter.create_counter(
            "scheduler_ticks_total",
            description="Scheduler ticks completed, by outcome (ok|error). MUST increment every tick.",
        )
        self._runs_pruned = meter.create_counter(
            "scheduler_runs_pruned_total",
            description="Task runs deleted by the retention sweep.",
        )

        # Histograms
        self._spawn_duration = meter.create_histogram(
            "scheduler_spawn_duration_ms",
            description="Task spawn duration, milliseconds.",
            unit="ms",
        )
        self._tick_duration = meter.create_histogram(
            "scheduler_tick_duration_ms",
            description="Scheduler tick duration, milliseconds.",
            unit="ms",
        )
        self._claim_lag_hist = meter.create_histogram(
            "scheduler_claim_lag_ms",
            description="Lag between now and next_run_at at claim time, milliseconds.",
            unit="ms",
        )

        # Observable gauges (set from outside at collection time)
        self._task_count_enabled = 0
        self._task_count_disabled = 0
        self._due_backlog_count = 0

        def _observe_tasks(observer):
            observer.observe(self._task_count_enabled, {"enabled": "true"})
            observer.observe(self._task_count_disabled, {"enabled": "false"})

        def _observe_backlog(observer):
            observer.observe(self._due_backlog_count)

        meter.create_observable_gauge(
            "scheduler_tasks",
            callbacks=[_observe_tasks],
            description="Task count by enabled status.",
        )
        meter.create_observable_gauge(
            "scheduler_due_backlog",
            callbacks=[_observe_backlog],
            description="Number of tasks currently overdue.",
        )

    def fire_completed(self, *, status: str, duration_ms: float) -> None:
        self._fires.add(1, {"status": status})
        self._spawn_duration.record(duration_ms)

    def tick_completed(self, *, outcome: str) -> None:
        self._ticks.add(1, {"outcome": outcome})

    def claim_lag(self, *, lag_ms: float) -> None:
        self._claim_lag_hist.record(lag_ms)

    def set_task_counts(self, *, enabled: int, disabled: int) -> None:
        self._task_count_enabled = enabled
        self._task_count_disabled = disabled

    def set_due_backlog(self, *, count: int) -> None:
        self._due_backlog_count = count

    def runs_pruned(self, *, count: int) -> None:
        self._runs_pruned.add(count)

    async def shutdown(self) -> None:
        try:
            self._provider.shutdown()
        except Exception as e:
            logger.error("metrics shutdown failed", extra={"error": format_error(e)})


class _NoopMetricsSink(MetricsSink):
    """No-op sink when metrics are disabled."""

    pass


def create_metrics(*, enabled: bool, reader_for_test=None) -> MetricsSink:
    """Create a metrics sink.

    Args:
        enabled: If False, returns a no-op sink.
        reader_for_test: Test seam — an in-memory reader instead of OTLP export.

    Returns:
        A MetricsSink (either live OTel or no-op).
    """
    if not enabled:
        return _NoopMetricsSink()

    # The OTLP exporter reads OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS / _PROTOCOL
    # from the environment automatically (set by the module when otel.enable is true).
    reader = reader_for_test or PeriodicExportingMetricReader(OTLPMetricExporter())
    return _OTelMetricsSink(reader)
