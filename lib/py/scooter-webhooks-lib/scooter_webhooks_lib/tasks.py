"""Background work started by a webhook, after the sender has had its response.

A forge treats a slow response as a failed delivery, and GitLab disables a hook
that keeps failing, so a handler answers first and does its work in `spawn`.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

logger = logging.getLogger(__name__)
_C = {"component": "webhooks.tasks"}

# The event loop holds tasks weakly, so a running task needs a reference here.
_tasks: set[asyncio.Task] = set()


def spawn(coro: Coroutine[Any, Any, Any], *, name: str | None = None, extra: dict | None = None) -> asyncio.Task:
    """Run `coro` in the background and log its exception, if any, with `extra`."""
    name = name or coro.__qualname__
    task = asyncio.create_task(_logged(coro, name, extra or {}), name=name)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return task


async def _logged(coro: Coroutine[Any, Any, Any], name: str, extra: dict) -> None:
    try:
        await coro
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("background task failed", extra={**_C, **extra, "task": name})


async def drain(timeout: float | None = None) -> None:
    """Wait for the running tasks, including any they spawn, up to `timeout` seconds."""
    loop = asyncio.get_running_loop()
    deadline = None if timeout is None else loop.time() + timeout
    while _tasks:
        remaining = None if deadline is None else deadline - loop.time()
        if remaining is not None and remaining <= 0:
            break
        await asyncio.wait(set(_tasks), timeout=remaining)
    if _tasks:
        logger.warning("background tasks still running at shutdown", extra={**_C, "count": len(_tasks)})
