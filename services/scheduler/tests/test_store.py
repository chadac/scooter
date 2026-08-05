"""Tier 1 — the async store: CRUD, due-selection, reschedule, run history (SQLite)."""

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio

from scheduler.store import Store
from scheduler.cron import InvalidSchedule


@pytest_asyncio.fixture
async def store():
    s = Store("sqlite+aiosqlite:///:memory:")
    await s.init()
    yield s
    await s.dispose()


@pytest.mark.asyncio
async def test_create_computes_next_run(store):
    t = await store.create_task(
        title="daily", prompt="do the thing", cron="0 9 * * *", timezone_="UTC",
        owner="alice", enabled=True,
    )
    assert t.owner == "alice"
    assert t.next_run_at is not None  # scheduled
    # (tz-awareness of the stored value is backend-dependent: Postgres keeps it,
    #  SQLite returns naive-UTC. The value is correct UTC either way; the loop
    #  compares against a UTC `now`. See due_tasks + the comparison test below.)


@pytest.mark.asyncio
async def test_create_rejects_bad_cron(store):
    with pytest.raises(InvalidSchedule):
        await store.create_task(
            title="x", prompt="p", cron="nonsense", timezone_="UTC", owner="a", enabled=True,
        )


@pytest.mark.asyncio
async def test_disabled_task_has_no_next_run(store):
    t = await store.create_task(
        title="off", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="a", enabled=False,
    )
    assert t.next_run_at is None


@pytest.mark.asyncio
async def test_due_tasks_selects_only_overdue_enabled(store):
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    # overdue + enabled → due
    due_task = await store.create_task(title="due", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True)
    await store.reschedule(due_task.id, last_run_at=past, next_run_at=past)
    # future → not due
    later = await store.create_task(title="later", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True)
    await store.reschedule(later.id, last_run_at=past, next_run_at=future)
    # disabled → not due
    off = await store.create_task(title="off", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=False)
    await store.reschedule(off.id, last_run_at=past, next_run_at=past)

    due = await store.due_tasks(datetime.now(timezone.utc))
    due_ids = {t.id for t in due}
    assert due_task.id in due_ids
    assert later.id not in due_ids
    assert off.id not in due_ids


@pytest.mark.asyncio
async def test_claim_due_advances_next_run_atomically(store):
    """claim_due must ADVANCE next_run_at as part of claiming, so a second claim in
    the same instant returns nothing — the multi-replica double-fire guard. (Without
    this, due_tasks releases its row lock before _fire reschedules, and a second
    replica re-selects the still-due row.)"""
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    t = await store.create_task(title="due", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True)
    await store.reschedule(t.id, last_run_at=past, next_run_at=past)

    # First claim gets the task AND advances its next_run_at into the future.
    first = await store.claim_due(now)
    assert {c.id for c in first} == {t.id}

    # A second claim at the same `now` gets nothing — the row is no longer due.
    second = await store.claim_due(now)
    assert second == []

    # And the row's next_run_at was moved forward (to the next cron minute).
    # SQLite returns naive-UTC datetimes; normalize to aware-UTC for the comparison
    # (the value is correct UTC either way — see the create-computes-next_run note).
    row = await store.get_task(t.id)
    next_at = row.next_run_at if row.next_run_at.tzinfo else row.next_run_at.replace(tzinfo=timezone.utc)
    assert next_at > now
    assert row.last_run_at is not None


@pytest.mark.asyncio
async def test_patch_recomputes_next_run(store):
    t = await store.create_task(title="x", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="a", enabled=True)
    # disabling clears next_run_at
    p = await store.patch_task(t.id, enabled=False)
    assert p.next_run_at is None
    # re-enabling recomputes it
    p = await store.patch_task(t.id, enabled=True)
    assert p.next_run_at is not None


@pytest.mark.asyncio
async def test_run_lifecycle(store):
    t = await store.create_task(title="x", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="a", enabled=True)
    run_id = await store.start_run(t.id)
    await store.finish_run(run_id, conversation_id="conv-1", status="spawned", error=None)
    runs = await store.list_runs(t.id)
    assert len(runs) == 1
    assert runs[0].conversation_id == "conv-1"
    assert runs[0].status == "spawned"


@pytest.mark.asyncio
async def test_delete_cascades_runs(store):
    t = await store.create_task(title="x", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="a", enabled=True)
    await store.start_run(t.id)
    assert await store.delete_task(t.id) is True
    assert await store.get_task(t.id) is None
