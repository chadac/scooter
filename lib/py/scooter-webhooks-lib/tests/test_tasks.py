"""Background tasks: kept alive, their failures logged, and drained at shutdown."""

from __future__ import annotations

import asyncio
import logging

from scooter_webhooks_lib import tasks


async def test_drain_waits_for_a_task_and_the_tasks_it_spawns():
    done: list[str] = []

    async def child():
        await asyncio.sleep(0.01)
        done.append("child")

    async def parent():
        await asyncio.sleep(0.01)
        tasks.spawn(child())
        done.append("parent")

    tasks.spawn(parent())
    await tasks.drain(timeout=5)
    assert done == ["parent", "child"]


async def test_a_failing_task_is_logged_with_its_context(caplog):
    async def boom():
        raise RuntimeError("nope")

    with caplog.at_level(logging.ERROR, logger=tasks.logger.name):
        tasks.spawn(boom(), name="gitlab", extra={"event_type": "Note Hook"})
        await tasks.drain(timeout=5)
    record = next(r for r in caplog.records if r.getMessage() == "background task failed")
    assert record.task == "gitlab" and record.event_type == "Note Hook"


async def test_drain_gives_up_at_its_timeout():
    release = asyncio.Event()
    task = tasks.spawn(release.wait())
    await tasks.drain(timeout=0.05)
    assert not task.done()
    release.set()
    await tasks.drain(timeout=5)
