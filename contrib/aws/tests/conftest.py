"""Shared helpers for the aws contrib's suite.

SQLite has no migrations, so these tests build the permission store's schema from
its own model. On Postgres the Atlas migrations under lib/sql own `broker`'s
schema and no service issues DDL — which is why this lives here and not in
PermissionStore.init(). Mirrors services/broker/tests/conftest.py, which the
in-app suite used before this provider moved out (PR #599).
"""

from __future__ import annotations

from scooter_broker_lib.store import StoreConfig

SQLITE = "sqlite+aiosqlite:///:memory:"


def sqlite_config(**kw) -> StoreConfig:
    """A StoreConfig pointed at a fresh in-memory SQLite database."""
    return StoreConfig(dsn=SQLITE, **kw)


async def create_schema(store, base) -> None:
    """Create `base`'s tables on the store's engine. SQLite only, by construction:
    a Postgres store would be a test reaching for DDL that the migrations own."""
    engine = store._engine
    assert engine.dialect.name == "sqlite", (
        f"create_schema is SQLite-only; got {engine.dialect.name!r}. "
        "On Postgres the lib/sql migrations own the schema."
    )
    async with engine.begin() as conn:
        await conn.run_sync(base.metadata.create_all)
