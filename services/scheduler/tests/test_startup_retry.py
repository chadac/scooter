"""The startup system-task sync waits out a postgres or pgbouncer restart, but not a broken query."""

from __future__ import annotations

import pytest
from sqlalchemy.exc import OperationalError, ProgrammingError

from scheduler.app import sync_with_retry


class FlakyStore:
    def __init__(self, failures: list[BaseException]):
        self.failures = list(failures)
        self.calls = 0

    async def sync_system_tasks(self, specs) -> None:
        self.calls += 1
        if self.failures:
            raise self.failures.pop(0)


async def no_sleep(_s: float) -> None:
    return None


async def test_retries_refused_connections_then_succeeds() -> None:
    store = FlakyStore([
        ConnectionRefusedError(111, "Connect call failed ('10.0.0.1', 6432)"),
        OperationalError("SELECT 1", {}, Exception("terminating connection due to administrator command")),
    ])
    await sync_with_retry(store, [], sleep=no_sleep)
    assert store.calls == 3


async def test_gives_up_after_the_budget() -> None:
    store = FlakyStore([ConnectionRefusedError(111, "refused")] * 100)
    with pytest.raises(ConnectionRefusedError):
        await sync_with_retry(store, [], budget_s=0.0, sleep=no_sleep)
    assert store.calls == 1


async def test_schema_errors_are_not_retried() -> None:
    store = FlakyStore([ProgrammingError("SELECT", {}, Exception('relation "tasks" does not exist'))])
    with pytest.raises(ProgrammingError):
        await sync_with_retry(store, [], sleep=no_sleep)
    assert store.calls == 1
