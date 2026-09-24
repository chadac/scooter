"""The DSN assembly, and the reconnect guards every broker store now inherits.

`open_sessions` is the only place an async engine is built (the broker's own
test_db_pool_resilience asserts nothing else constructs one), so these guards being
right here is what makes them right everywhere — including for a contrib's store,
which never sees the kwargs at all.
"""

from __future__ import annotations

import ast
from pathlib import Path

from scooter_broker_lib.store import POOL_RECYCLE_SECONDS, StoreConfig

_STORE = Path(__file__).resolve().parents[1] / "scooter_broker_lib" / "store.py"


def _engine_kwargs() -> dict[str, ast.expr]:
    tree = ast.parse(_STORE.read_text())
    calls = [
        n
        for n in ast.walk(tree)
        if isinstance(n, ast.Call)
        and (getattr(n.func, "id", None) or getattr(n.func, "attr", None))
        == "create_async_engine"
    ]
    assert len(calls) == 1, f"expected exactly one engine constructor, found {len(calls)}"
    return {kw.arg: kw.value for kw in calls[0].keywords}


def test_engine_pre_pings():
    # Without it the pool hands out a connection a restart/failover already closed,
    # and the request dies with asyncpg "connection is closed".
    pre_ping = _engine_kwargs().get("pool_pre_ping")
    assert isinstance(pre_ping, ast.Constant) and pre_ping.value is True


def test_engine_recycles_within_common_idle_timeouts():
    assert _engine_kwargs().get("pool_recycle") is not None
    assert 0 < POOL_RECYCLE_SECONDS <= 3600


def test_password_assembles_a_postgres_dsn():
    cfg = StoreConfig(db_password="pw", db_host="pg.example", db_name="broker")
    assert cfg.resolved_dsn() == "postgresql+asyncpg://webhooks:pw@pg.example:5432/broker"


def test_explicit_postgres_dsn_wins_over_components():
    cfg = StoreConfig(dsn="postgresql+asyncpg://u:p@elsewhere/db", db_password="pw")
    assert cfg.resolved_dsn() == "postgresql+asyncpg://u:p@elsewhere/db"


def test_sslmode_becomes_asyncpgs_ssl_param():
    # asyncpg takes `ssl=`, not libpq's `sslmode=`.
    cfg = StoreConfig(db_password="pw", db_sslmode="require")
    assert cfg.resolved_dsn().endswith("?ssl=require")


def test_no_password_keeps_the_sqlite_dev_default():
    assert StoreConfig().resolved_dsn().startswith("sqlite+aiosqlite://")
