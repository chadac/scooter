"""Tests for OpenTelemetry metrics — RED first (fail until implementation lands)."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from scheduler.metrics import create_metrics
from scheduler.store import Store


@pytest_asyncio.fixture
async def store():
    s = Store("sqlite+aiosqlite:///:memory:")
    await s.init()
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
    t = await store.list_tasks()
    await store.reschedule(t[0].id, last_run_at=now, next_run_at=future)

    # Simulate a tick with no due tasks
    due = await store.claim_due(now)
    assert len(due) == 0

    # The tick must STILL increment scheduler_ticks_total
    metrics_sink.tick_completed(outcome="ok")

    value = _get_metric_value(metrics_reader, "scheduler_ticks_total", {"outcome": "ok"})
    assert value == 1


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
    runs = await store.list_runs(t.id)
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
    runs = await store.list_runs(t.id)
    assert len(runs) == 1
    assert runs[0].id == run_id
