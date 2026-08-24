"""Test suite for task_runs retention sweep."""

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio

from scheduler.store import Store


@pytest_asyncio.fixture
async def store():
    s = Store("sqlite+aiosqlite:///:memory:")
    await s.init()
    yield s
    await s.dispose()


@pytest.mark.asyncio
async def test_prune_deletes_only_old_runs(store):
    """The retention sweep deletes only rows older than the cutoff and leaves newer ones."""
    now = datetime.now(timezone.utc)
    cutoff_days = 7

    # Create a task
    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )

    # Create runs at different ages
    old_run = await store.start_run(task.id)  # will be 10 days old
    recent_run = await store.start_run(task.id)  # will be 3 days old

    # Manually set the fired_at timestamps (need to update the DB directly)
    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update

        # Make old_run 10 days old
        await s.execute(
            update(RunRow).where(RunRow.id == old_run).values(fired_at=now - timedelta(days=10))
        )
        # Make recent_run 3 days old
        await s.execute(
            update(RunRow).where(RunRow.id == recent_run).values(fired_at=now - timedelta(days=3))
        )
        await s.commit()

    # Run the prune with 7-day retention
    deleted_count = await store.prune_old_runs(retention_days=cutoff_days, now=now)

    # Should have deleted 1 row (the 10-day-old one)
    assert deleted_count == 1

    # Verify the old run is gone and recent one remains
    all_runs = await store.list_runs(task.id, owner="alice", limit=100)
    run_ids = {r.id for r in all_runs}
    assert old_run not in run_ids
    assert recent_run in run_ids


@pytest.mark.asyncio
async def test_prune_with_zero_retention_does_nothing(store):
    """runRetentionDays=0 must genuinely DISABLE the sweep (no DELETE at all)."""
    now = datetime.now(timezone.utc)

    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )

    # Create an old run (100 days old)
    old_run = await store.start_run(task.id)

    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update

        await s.execute(
            update(RunRow).where(RunRow.id == old_run).values(fired_at=now - timedelta(days=100))
        )
        await s.commit()

    # Prune with retention_days=0 should delete NOTHING
    deleted_count = await store.prune_old_runs(retention_days=0, now=now)
    assert deleted_count == 0

    # The old run should still exist
    all_runs = await store.list_runs(task.id, owner="alice", limit=100)
    assert len(all_runs) == 1
    assert all_runs[0].id == old_run


@pytest.mark.asyncio
async def test_prune_with_no_old_runs(store):
    """The sweep on a fresh DB (no old runs) returns 0 and doesn't break."""
    now = datetime.now(timezone.utc)
    deleted_count = await store.prune_old_runs(retention_days=30, now=now)
    assert deleted_count == 0


@pytest.mark.asyncio
async def test_prune_boundary_condition(store):
    """A run at exactly the cutoff boundary is NOT deleted (only strictly older)."""
    now = datetime.now(timezone.utc)
    cutoff_days = 7

    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )

    # Create a run at exactly 7 days old
    boundary_run = await store.start_run(task.id)

    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update

        # Exactly at the cutoff
        await s.execute(
            update(RunRow).where(RunRow.id == boundary_run).values(fired_at=now - timedelta(days=cutoff_days))
        )
        await s.commit()

    # Should NOT delete the boundary case (only OLDER than cutoff)
    deleted_count = await store.prune_old_runs(retention_days=cutoff_days, now=now)
    assert deleted_count == 0

    all_runs = await store.list_runs(task.id, owner="alice", limit=100)
    assert len(all_runs) == 1
