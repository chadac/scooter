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
    old_runs = []
    new_runs = []
    for days_ago in [10, 9, 8]:  # older than cutoff
        run_id = await store.start_run(task.id)
        old_runs.append(run_id)
        # Manually backdate finished_at
        async with store._session() as s:
            from scheduler.models import RunRow
            from sqlalchemy import update

            ts = now - timedelta(days=days_ago)
            await s.execute(
                update(RunRow).where(RunRow.id == run_id).values(started_at=ts, finished_at=ts)
            )
            await s.commit()

    for days_ago in [5, 3, 1]:  # newer than cutoff
        run_id = await store.start_run(task.id)
        new_runs.append(run_id)
        async with store._session() as s:
            from scheduler.models import RunRow
            from sqlalchemy import update

            ts = now - timedelta(days=days_ago)
            await s.execute(
                update(RunRow).where(RunRow.id == run_id).values(started_at=ts, finished_at=ts)
            )
            await s.commit()

    deleted_count = await store.prune_old_runs(retention_days=cutoff_days)

    # Expect 3 old runs deleted
    assert deleted_count == 3

    # Verify: the new runs remain
    all_runs = await store.list_runs(task.id, owner="alice", limit=100)
    remaining_ids = {r.id for r in all_runs}
    assert set(new_runs).issubset(remaining_ids)
    assert not set(old_runs).intersection(remaining_ids)


@pytest.mark.asyncio
async def test_retention_zero_disables_sweep(store):
    """retention_days=0 disables the sweep — no DELETE is issued."""
    now = datetime.now(timezone.utc)
    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )

    # Create an old run (100 days ago)
    run_id = await store.start_run(task.id)
    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update

        ts = now - timedelta(days=100)
        await s.execute(update(RunRow).where(RunRow.id == run_id).values(started_at=ts, finished_at=ts))
        await s.commit()

    deleted_count = await store.prune_old_runs(retention_days=0)

    # No deletion when retention_days=0
    assert deleted_count == 0

    all_runs = await store.list_runs(task.id, owner="alice", limit=100)
    assert len(all_runs) == 1


@pytest.mark.asyncio
async def test_prune_ignores_tasks_with_no_runs(store):
    """prune_old_runs doesn't break when tasks have no runs."""
    await store.create_task(
        title="never-fired", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )
    deleted_count = await store.prune_old_runs(retention_days=30)
    assert deleted_count == 0


@pytest.mark.asyncio
async def test_prune_only_deletes_finished_runs(store):
    """The sweep ignores in-progress runs (finished_at IS NULL)."""
    now = datetime.now(timezone.utc)
    cutoff_days = 7

    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )

    # Create an old finished run
    old_finished = await store.start_run(task.id)
    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update

        ts = now - timedelta(days=10)
        await s.execute(
            update(RunRow).where(RunRow.id == old_finished).values(started_at=ts, finished_at=ts)
        )
        await s.commit()

    # Create an old in-progress run (started_at old, finished_at NULL)
    old_in_progress = await store.start_run(task.id)
    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update

        ts = now - timedelta(days=10)
        await s.execute(
            update(RunRow).where(RunRow.id == old_in_progress).values(started_at=ts, finished_at=None)
        )
        await s.commit()

    deleted_count = await store.prune_old_runs(retention_days=cutoff_days)

    # Only the finished run is deleted
    assert deleted_count == 1

    all_runs = await store.list_runs(task.id, owner="alice", limit=100)
    remaining_ids = {r.id for r in all_runs}
    assert old_in_progress in remaining_ids
    assert old_finished not in remaining_ids
