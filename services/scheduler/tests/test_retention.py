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

    # Create runs at different ages (directly in the DB, bypassing start_run/finish_run
    # so we can control created_at precisely without waiting)
    old_run_id = await store.start_run(task.id)
    recent_run_id = await store.start_run(task.id)

    # Manually backdate the old run's created_at to 10 days ago
    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update

        old_created = now - timedelta(days=10)
        await s.execute(update(RunRow).where(RunRow.id == old_run_id).values(created_at=old_created))
        await s.commit()

    # Prune with a 7-day retention
    deleted_count = await store.prune_old_runs(retention_days=cutoff_days)

    assert deleted_count == 1, "Should delete exactly the old run"

    # Verify: the recent run remains, the old one is gone
    all_runs = await store.list_runs(task.id, owner="alice", limit=100)
    assert len(all_runs) == 1
    assert all_runs[0].id == recent_run_id


@pytest.mark.asyncio
async def test_prune_respects_zero_retention_disables_sweep(store):
    """retention_days=0 disables the sweep (no DELETE issued)."""
    now = datetime.now(timezone.utc)

    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )

    # Create an old run (100 days ago)
    old_run_id = await store.start_run(task.id)
    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update

        old_created = now - timedelta(days=100)
        await s.execute(update(RunRow).where(RunRow.id == old_run_id).values(created_at=old_created))
        await s.commit()

    # Prune with retention_days=0 → NO deletion
    deleted_count = await store.prune_old_runs(retention_days=0)

    assert deleted_count == 0, "Zero retention should disable the sweep"

    # The old run is still there
    all_runs = await store.list_runs(task.id, owner="alice", limit=100)
    assert len(all_runs) == 1


@pytest.mark.asyncio
async def test_prune_noop_when_no_old_runs(store):
    """Prune is a no-op when all runs are recent."""
    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )
    await store.start_run(task.id)

    deleted_count = await store.prune_old_runs(retention_days=30)
    assert deleted_count == 0


@pytest.mark.asyncio
async def test_prune_scoped_to_cutoff(store):
    """The cutoff is retention_days ago from NOW, not from some other anchor."""
    now = datetime.now(timezone.utc)
    cutoff_days = 14

    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )

    # Create runs at 10, 15, 20 days ago
    run_ids = []
    for days_ago in [10, 15, 20]:
        run_id = await store.start_run(task.id)
        run_ids.append(run_id)
        async with store._session() as s:
            from scheduler.models import RunRow
            from sqlalchemy import update

            created = now - timedelta(days=days_ago)
            await s.execute(update(RunRow).where(RunRow.id == run_id).values(created_at=created))
            await s.commit()

    # Prune with 14-day retention → should delete the 15-day and 20-day runs
    deleted_count = await store.prune_old_runs(retention_days=cutoff_days)
    assert deleted_count == 2

    # Only the 10-day-old run remains
    all_runs = await store.list_runs(task.id, owner="alice", limit=100)
    assert len(all_runs) == 1
    assert all_runs[0].id == run_ids[0]
