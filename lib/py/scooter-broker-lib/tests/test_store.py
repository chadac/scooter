"""The DSN assembly, and the pool settings every broker store inherits from `open_sessions`."""

from __future__ import annotations

import ast
from pathlib import Path

from scooter_broker_lib.store import MAX_OVERFLOW, POOL_RECYCLE_SECONDS, POOL_SIZE, StoreConfig

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


def test_engine_skips_the_per_checkout_ping():
    assert "pool_pre_ping" not in _engine_kwargs()


def test_engine_keeps_its_connections_open():
    assert POOL_SIZE > 1 and MAX_OVERFLOW == 0


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
    cfg = StoreConfig(db_password="pw", db_sslmode="require")
    assert cfg.resolved_dsn().endswith("?ssl=require")


def test_no_password_keeps_the_sqlite_dev_default():
    assert StoreConfig().resolved_dsn().startswith("sqlite+aiosqlite://")


def test_with_database_swaps_only_the_database():
    cfg = StoreConfig(db_password="pw", db_host="pg.example", db_user="broker", db_name="broker")
    other = cfg.with_database("contrib_files")
    assert other.resolved_dsn() == "postgresql+asyncpg://broker:pw@pg.example:5432/contrib_files"
    assert cfg.db_name == "broker"  # the original is untouched


def test_with_database_rewrites_an_explicit_postgres_dsn():
    cfg = StoreConfig(dsn="postgresql+asyncpg://broker:p%40ss@pg:5432/broker?ssl=require")
    assert (
        cfg.with_database("contrib_aws").resolved_dsn()
        == "postgresql+asyncpg://broker:p%40ss@pg:5432/contrib_aws?ssl=require"
    )


def test_with_database_leaves_a_dev_sqlite_dsn_alone():
    cfg = StoreConfig(dsn="sqlite+aiosqlite:////tmp/x.db")
    assert cfg.with_database("contrib_files").resolved_dsn() == "sqlite+aiosqlite:////tmp/x.db"
