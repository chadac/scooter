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

    # Create runs at different ages: 10 days old, 5 days old, 1 day old, just now
    old_timestamps = [
        now - timedelta(days=10),
        now - timedelta(days=5),
        now - timedelta(days=1),
        now,
    ]
    run_ids = []
    for ts in old_timestamps:
        rid = await store.start_run(task.id)
        await store.finish_run(rid, conversation_id="conv", status="spawned")
        # Backdate finished_at
        await store._execute(f"UPDATE task_runs SET finished_at = ? WHERE id = ?", [ts, rid])
        run_ids.append(rid)

    # Prune runs older than cutoff_days
    deleted_count = await store.prune_old_runs(retention_days=cutoff_days)

    # Should delete the 10-day-old run only (1 deleted)
    assert deleted_count == 1

    # Verify: 3 runs remain (the ones ≤7 days old)
    all_runs = await store.list_runs(task.id, owner="alice", limit=100)
    assert len(all_runs) == 3
    # The 10-day run is gone; the rest are present
    remaining_ids = {r.id for r in all_runs}
    assert run_ids[0] not in remaining_ids  # 10-day is gone
    assert run_ids[1] in remaining_ids  # 5-day remains
    assert run_ids[2] in remaining_ids  # 1-day remains
    assert run_ids[3] in remaining_ids  # now remains


@pytest.mark.asyncio
async def test_prune_with_zero_retention_is_noop(store):
    """retention_days=0 disables the sweep — no DELETE query."""
    now = datetime.now(timezone.utc)
    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )

    # Create an old run (100 days)
    rid = await store.start_run(task.id)
    await store.finish_run(rid, conversation_id="conv", status="spawned")
    await store._execute("UPDATE task_runs SET finished_at = ?", [now - timedelta(days=100)])

    deleted_count = await store.prune_old_runs(retention_days=0)

    # No rows deleted
    assert deleted_count == 0
    all_runs = await store.list_runs(task.id, owner="alice", limit=100)
    assert len(all_runs) == 1  # the old run is still there


@pytest.mark.asyncio
async def test_prune_leaves_unfinished_runs(store):
    """Unfinished runs (finished_at=NULL) are never pruned, regardless of age."""
    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )
    rid = await store.start_run(task.id)
    # Do NOT finish — finished_at stays NULL

    deleted_count = await store.prune_old_runs(retention_days=30)

    # Nothing deleted (unfinished runs exempt)
    assert deleted_count == 0


@pytest.mark.asyncio
async def test_prune_scoped_to_all_tasks(store):
    """The sweep prunes old runs across ALL tasks (not scoped per-task)."""
    now = datetime.now(timezone.utc)
    cutoff_days = 7

    # Two tasks, different owners
    t1 = await store.create_task(
        title="a", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )
    t2 = await store.create_task(
        title="b", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="bob", enabled=True
    )

    # Each has 1 old run (10 days) and 1 fresh run (1 day)
    for task in [t1, t2]:
        for age_days in [10, 1]:
            rid = await store.start_run(task.id)
            await store.finish_run(rid, conversation_id="conv", status="spawned")
            ts = now - timedelta(days=age_days)
            await store._execute("UPDATE task_runs SET finished_at = ?", [ts])

    deleted_count = await store.prune_old_runs(retention_days=cutoff_days)

    # 2 runs deleted (1 from each task — the 10-day ones)
    assert deleted_count == 2
    all_runs = await store.list_runs(t1.id, owner="alice", limit=100)
    assert len(all_runs) == 1  # t1's fresh run remains
    all_runs = await store.list_runs(t2.id, owner="bob", limit=100)
    assert len(all_runs) == 1  # t2's fresh run remains
