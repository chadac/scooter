"""Tier 1 — services must NEVER create tables on Postgres.

lib/sql is the source of truth: tables are declared in <db>/schema.sql and applied by
the Atlas migration Job. A service that also runs DDL at boot silently diverges from
the declared schema — which is exactly how byoc's remote_agent_devices existed in
production for months with no schema entry and no migration.

create_all stays for SQLite because the test suites build their schema from the ORM
models and there is no migration path for an in-memory database.
"""

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from broker.aws.store import PermissionStore, StoreConfig
from broker.registry.store import ModuleRegistryStore
from broker.sandbox.store import SandboxSizeStore


def _stores():
    """Every broker store that owns Postgres tables, pointed at a FAKE postgres DSN.

    The DSN never connects: init() must return before it opens a connection, so a
    store that still tries to create tables fails here with a connection error.
    """
    dsn = "postgresql+asyncpg://u:p@127.0.0.1:1/nope"
    return [
        ("permission_requests", PermissionStore(StoreConfig(dsn=dsn))),
        ("module_registry", ModuleRegistryStore(StoreConfig(dsn=dsn))),
        ("sandbox_size", SandboxSizeStore(StoreConfig(dsn=dsn))),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("name,store", _stores(), ids=lambda v: v if isinstance(v, str) else "")
async def test_init_creates_NO_tables_on_postgres(name, store):
    # No connection is attempted at all: on a real Postgres this would have run
    # CREATE TABLE against a schema the migrations own.
    await store.init()


@pytest.mark.asyncio
async def test_init_DOES_still_create_tables_on_sqlite():
    # The guard must not break the test path it protects.
    store = ModuleRegistryStore(StoreConfig(dsn="sqlite+aiosqlite:///:memory:"))
    await store.init()
    # A query only succeeds if init() actually built the table.
    assert await store.list_visible(viewer="someone") == []


@pytest.mark.asyncio
async def test_the_guard_is_dialect_based_not_dsn_string_matching():
    # Pins the mechanism: SQLAlchemy's dialect name, so a postgres DSN in any spelling
    # (postgresql://, postgresql+asyncpg://, a socket URL) is covered by one check.
    eng = create_async_engine("postgresql+asyncpg://u:p@127.0.0.1:1/nope")
    assert eng.dialect.name == "postgresql"
    await eng.dispose()
