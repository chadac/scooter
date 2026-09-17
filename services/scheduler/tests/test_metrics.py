"""Tests for OpenTelemetry metrics — RED first (fail until implementation lands)."""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from opentelemetry.metrics import CallbackOptions, Observation
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from scheduler.metrics import create_metrics
from scheduler.store import Store

from conftest import sqlite_store



@pytest_asyncio.fixture
async def store():
    s = await sqlite_store()
    yield s
    await s.dispose()


@pytest_asyncio.fixture
def metrics_reader():
    """In-memory metric reader for test assertions (the agent-host pattern)."""
    return InMemoryMetricReader()


@pytest_asyncio.fixture
def metrics_sink(metrics_reader):
    """Enabled metrics sink with an in-memory reader."""
    sink = create_metrics(enabled=True, reader_for_test=metrics_reader)
    yield sink
    # Clean up (synchronous shutdown for test teardown)
    import asyncio
    try:
        asyncio.get_event_loop().run_until_complete(sink.shutdown())
    except:
        pass


def _get_metric_value(reader, name: str, attributes: dict = None):
    """Read a metric value from the in-memory reader."""
    metrics = reader.get_metrics_data()
    for rm in metrics.resource_metrics:
        for sm in rm.scope_metrics:
            for metric in sm.metrics:
                if metric.name == name:
                    for point in metric.data.data_points:
                        if attributes is None:
                            return point.value
                        # Match attributes as dict
                        point_attrs = dict(point.attributes) if point.attributes else {}
                        if point_attrs == attributes:
                            return point.value
    return None


@pytest.mark.asyncio
async def test_successful_fire_increments_spawned(store, metrics_reader, metrics_sink):
    """A successful fire (spawn returns a conversation) increments scheduler_fires_total{status=spawned}."""
    # Create a due task
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    t = await store.create_task(
        title="test", prompt="do it", cron="* * * * *", timezone_="UTC", owner="alice", enabled=True
    )
    await store.reschedule(t.id, last_run_at=past, next_run_at=past)

    # Mock spawn to succeed
    with patch("scheduler.app.spawn_conversation", new_callable=AsyncMock) as mock_spawn:
        mock_spawn.return_value = "conv-123"
        
        # Fire the task (import _fire from app)
        from scheduler.app import _fire
        await _fire(store, t, metrics_sink)

    # Assert: scheduler_fires_total{status=spawned} incremented
    value = _get_metric_value(metrics_reader, "scheduler_fires_total", {"status": "spawned"})
    assert value == 1


@pytest.mark.asyncio
async def test_failed_spawn_increments_failed(store, metrics_reader, metrics_sink):
    """A failed spawn (returns None) increments scheduler_fires_total{status=failed}."""
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    t = await store.create_task(
        title="test", prompt="do it", cron="* * * * *", timezone_="UTC", owner="alice", enabled=True
    )
    await store.reschedule(t.id, last_run_at=past, next_run_at=past)

    # Mock spawn to fail
    with patch("scheduler.app.spawn_conversation", new_callable=AsyncMock) as mock_spawn:
        mock_spawn.return_value = None
        
        from scheduler.app import _fire
        await _fire(store, t, metrics_sink)

    # Assert: scheduler_fires_total{status=failed} incremented
    value = _get_metric_value(metrics_reader, "scheduler_fires_total", {"status": "failed"})
    assert value == 1


@pytest.mark.asyncio
async def test_tick_with_no_due_tasks_still_increments_ticks_total(store, metrics_reader, metrics_sink):
    """CRITICAL: a tick with NO due tasks must still increment scheduler_ticks_total — the dead-loop detector."""
    # No due tasks in the store (empty or all future)
    now = datetime.now(timezone.utc)
    future = now + timedelta(hours=1)
    await store.create_task(
        title="later", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True
    )
    # Manually set next_run_at to future
    t = await store.list_tasks("a")
    await store.reschedule(t[0].id, last_run_at=now, next_run_at=future)

    # Simulate a tick with no due tasks
    due = await store.claim_due(now)
    assert len(due) == 0

    # The tick must STILL increment scheduler_ticks_total
    metrics_sink.tick_completed(outcome="ok")

    value = _get_metric_value(metrics_reader, "scheduler_ticks_total", {"outcome": "ok"})
    assert value == 1


def _observations(result):
    """Normalize a callback's return (a list/iterable of Observations) to a list."""
    assert result is not None, "an observable-gauge callback must RETURN observations, not None"
    return list(result)


def test_observable_gauge_callbacks_return_observations(metrics_sink):
    """CONTRACT (red before the fix): an OTel observable-gauge callback is handed a
    CallbackOptions and MUST RETURN/yield Observation objects. The old code called
    `observer.observe(...)` — CallbackOptions has no `.observe`, so invoking the callback
    raised AttributeError every collection cycle (≈2000+ error logs/day). Invoke the
    callbacks directly with a real CallbackOptions and assert the returned Observations."""
    metrics_sink.set_task_counts(enabled=5, disabled=2)
    metrics_sink.set_due_backlog(count=3)

    opts = CallbackOptions()

    task_obs = _observations(metrics_sink._observe_tasks(opts))
    for o in task_obs:
        assert isinstance(o, Observation), f"expected Observation, got {type(o).__name__}"
    by_enabled = {dict(o.attributes)["enabled"]: o.value for o in task_obs}
    assert by_enabled == {"true": 5, "false": 2}

    backlog_obs = _observations(metrics_sink._observe_backlog(opts))
    assert len(backlog_obs) == 1
    assert isinstance(backlog_obs[0], Observation)
    assert backlog_obs[0].value == 3


def test_observable_gauges_collect_through_the_reader(metrics_reader, metrics_sink):
    """End-to-end: a real collection cycle (which hands each callback a CallbackOptions)
    surfaces the gauge values. With the old `.observe()` bug the callback raised, the SDK
    dropped the gauges, and get_metrics_data() returned no scheduler_tasks points at all."""
    metrics_sink.set_task_counts(enabled=7, disabled=1)
    metrics_sink.set_due_backlog(count=4)

    assert _get_metric_value(metrics_reader, "scheduler_tasks", {"enabled": "true"}) == 7
    assert _get_metric_value(metrics_reader, "scheduler_tasks", {"enabled": "false"}) == 1
    assert _get_metric_value(metrics_reader, "scheduler_due_backlog") == 4


@pytest.mark.asyncio
async def test_metrics_disabled_returns_noop_sink():
    """When metrics are disabled, create_metrics returns a no-op sink (no errors, no recording)."""
    sink = create_metrics(enabled=False)
    
    # Should not raise
    sink.fire_started()
    sink.fire_completed(status="spawned", duration_ms=100)
    sink.tick_completed(outcome="ok")
    sink.set_task_counts(enabled=5, disabled=2)
    sink.runs_pruned(count=10)
    await sink.shutdown()
    
    # No assertion on values — the noop sink doesn't record anything; just verify no errors.


@pytest.mark.asyncio
async def test_retention_sweep_deletes_old_runs(store):
    """The retention sweep deletes only runs older than the cutoff, leaves newer ones."""
    now = datetime.now(timezone.utc)
    t = await store.create_task(
        title="x", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="a", enabled=True
    )
    
    # Create runs: one old (100 days ago), one recent (10 days ago)
    old_run_id = await store.start_run(t.id)
    await store.finish_run(old_run_id, conversation_id="old-conv", status="spawned", error=None)
    
    recent_run_id = await store.start_run(t.id)
    await store.finish_run(recent_run_id, conversation_id="recent-conv", status="spawned", error=None)
    
    # Backdate the old run's fired_at
    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update
        await s.execute(
            update(RunRow).where(RunRow.id == old_run_id).values(fired_at=now - timedelta(days=100))
        )
        await s.commit()
    
    # Run retention sweep with 90-day cutoff
    deleted = await store.prune_old_runs(retention_days=90, now=now)
    assert deleted == 1
    
    # Verify: old run gone, recent run remains
    runs = await store.list_runs(t.id, "a")
    assert len(runs) == 1
    assert runs[0].id == recent_run_id


@pytest.mark.asyncio
async def test_retention_sweep_disabled_when_zero(store):
    """runRetentionDays=0 must disable the sweep — NO delete at all."""
    now = datetime.now(timezone.utc)
    t = await store.create_task(
        title="x", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="a", enabled=True
    )
    
    # Create an ancient run (200 days old)
    run_id = await store.start_run(t.id)
    await store.finish_run(run_id, conversation_id="ancient", status="spawned", error=None)
    
    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update
        await s.execute(
            update(RunRow).where(RunRow.id == run_id).values(fired_at=now - timedelta(days=200))
        )
        await s.commit()
    
    # Sweep with retention_days=0 (disabled)
    deleted = await store.prune_old_runs(retention_days=0, now=now)
    assert deleted == 0
    
    # Verify: the ancient run is STILL there
    runs = await store.list_runs(t.id, "a")
    assert len(runs) == 1
    assert runs[0].id == run_id


# --- gauge guard + feed -----------------------------------------------------


def test_gauge_callback_failure_is_reported_once_not_every_cycle(metrics_sink, caplog):
    """CONTRACT: a raising gauge callback must NOT produce 'Callback failed for instrument
    <name>' on every collection cycle forever. The body's failure drops that cycle's data
    point and is reported ONCE; the instrument stays quiet until it collects cleanly again."""
    boom = RuntimeError("gauge body exploded")

    def explode():
        raise boom

    with caplog.at_level(logging.ERROR):
        for _ in range(5):
            assert metrics_sink._guarded("scheduler_tasks", explode) == []

    failures = [r for r in caplog.records if "observable-gauge callback failed" in r.getMessage()]
    assert len(failures) == 1, f"expected 1 report for 5 failed collections, got {len(failures)}"

    # A clean collection re-arms the report, so a LATER episode is still visible.
    caplog.clear()
    assert metrics_sink._guarded("scheduler_tasks", lambda: [Observation(1)]) != []
    with caplog.at_level(logging.ERROR):
        metrics_sink._guarded("scheduler_tasks", explode)
    assert len([r for r in caplog.records if "observable-gauge callback failed" in r.getMessage()]) == 1


def test_sdk_never_logs_callback_failed_for_instrument(metrics_reader, metrics_sink, caplog):
    """THE REPORTED SYMPTOM: 'Callback failed for instrument scheduler_tasks'. The SDK logs
    that itself, at error, on EVERY collection cycle a callback raises. Our guard must absorb
    the raise so the SDK never sees it — while the other gauge still collects normally."""
    metrics_sink.set_due_backlog(count=9)
    # Make the gauge BODY raise the way the original bug did (it read an attribute that
    # was not there — CallbackOptions.observe — and raised AttributeError every cycle).
    del metrics_sink._task_count_enabled

    with caplog.at_level(logging.ERROR):
        assert _get_metric_value(metrics_reader, "scheduler_due_backlog") == 9

    sdk_errors = [r for r in caplog.records if "Callback failed for instrument" in r.getMessage()]
    assert not sdk_errors, f"the SDK logged {len(sdk_errors)} callback failures; the guard must absorb them"


def test_setters_coerce_to_int(metrics_sink):
    """Coercion happens at the setter, so a bad value is attributable to its caller rather
    than surfacing as an anonymous callback failure at the next collection."""
    metrics_sink.set_task_counts(enabled=True, disabled=2.0)
    metrics_sink.set_due_backlog(count=3.7)

    opts = CallbackOptions()
    by_enabled = {dict(o.attributes)["enabled"]: o.value for o in metrics_sink._observe_tasks(opts)}
    assert by_enabled == {"true": 1, "false": 2}
    assert all(isinstance(v, int) for v in by_enabled.values())
    assert metrics_sink._observe_backlog(opts)[0].value == 3


@pytest.mark.asyncio
async def test_gauge_counts_reports_enabled_disabled_and_backlog(store):
    """gauge_counts is the feed the gauges never had: enabled/disabled split plus the
    number of tasks actually overdue."""
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    future = now + timedelta(hours=1)

    overdue = await store.create_task(
        title="overdue", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True
    )
    await store.reschedule(overdue.id, last_run_at=past, next_run_at=past)
    later = await store.create_task(
        title="later", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True
    )
    await store.reschedule(later.id, last_run_at=past, next_run_at=future)
    off = await store.create_task(
        title="off", prompt="p", cron="* * * * *", timezone_="UTC", owner="b", enabled=False
    )
    await store.reschedule(off.id, last_run_at=past, next_run_at=past)

    enabled, disabled, backlog = await store.gauge_counts(now)

    assert (enabled, disabled) == (2, 1)
    # A DISABLED task that is overdue is not backlog — it is never going to fire.
    assert backlog == 1


@pytest.mark.asyncio
async def test_tick_feeds_the_gauges_before_claiming(store, metrics_reader, metrics_sink):
    """REGRESSION: nothing called set_task_counts/set_due_backlog, so both gauges reported 0
    forever. The tick must feed them — and must do so BEFORE claim_due, which advances
    next_run_at and would otherwise zero the very backlog it is meant to report."""
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    t = await store.create_task(
        title="overdue", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True
    )
    await store.reschedule(t.id, last_run_at=past, next_run_at=past)

    stop = asyncio.Event()

    async def one_tick():
        # Let exactly one tick run, then stop the loop.
        await asyncio.sleep(0.05)
        stop.set()

    from scheduler.app import _scheduler_loop

    with patch("scheduler.app.spawn_conversation", new_callable=AsyncMock) as mock_spawn:
        mock_spawn.return_value = "conv-1"
        await asyncio.gather(_scheduler_loop(store, metrics_sink, stop), one_tick())

    assert _get_metric_value(metrics_reader, "scheduler_tasks", {"enabled": "true"}) == 1
    assert _get_metric_value(metrics_reader, "scheduler_tasks", {"enabled": "false"}) == 0
    # Read before the claim, so the overdue task is still counted as backlog.
    assert _get_metric_value(metrics_reader, "scheduler_due_backlog") == 1


@pytest.mark.asyncio
async def test_gauge_refresh_failure_does_not_fail_the_tick(store, metrics_reader, metrics_sink):
    """A gauge refresh is observability, not the job: if it raises, the tick still runs and
    still reports outcome=ok (the dead-loop detector must not be poisoned by a metrics bug)."""
    stop = asyncio.Event()

    async def one_tick():
        await asyncio.sleep(0.05)
        stop.set()

    from scheduler.app import _scheduler_loop

    with patch.object(store, "gauge_counts", side_effect=RuntimeError("no db")):
        await asyncio.gather(_scheduler_loop(store, metrics_sink, stop), one_tick())

    assert _get_metric_value(metrics_reader, "scheduler_ticks_total", {"outcome": "ok"}) == 1
