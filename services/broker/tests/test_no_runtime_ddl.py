"""Tier 1 — services must NEVER create tables on Postgres.

lib/sql is the source of truth: tables are declared in <db>/schema.sql and applied by
the Atlas migration Job. A service that also runs DDL at boot silently diverges from
the declared schema — which is exactly how byoc's remote_agent_devices existed in
production for months with no schema entry and no migration.

Schema creation is a TEST concern (conftest.create_schema, SQLite only), so these
tests assert the production code has no way to do it.
"""

import ast
import pathlib

import pytest

from broker.aws.store import PermissionStore, StoreConfig
from broker.sandbox.store import SandboxSizeStore

SERVICE_SRC = pathlib.Path(__file__).resolve().parents[1] / "broker"


@pytest.mark.parametrize(
    "store_cls", [PermissionStore, SandboxSizeStore], ids=lambda c: c.__name__
)
def test_stores_expose_NO_schema_creating_method(store_cls):
    # init() used to run create_all. It is gone: nothing on a store builds tables, so a
    # caller cannot reintroduce boot-time DDL by calling one.
    assert not hasattr(store_cls, "init")


def test_no_service_module_calls_create_all():
    # The mechanism-level guard: create_all anywhere under broker/ is DDL at runtime.
    # Greps the AST rather than the text so a comment mentioning it does not trip it.
    offenders = []
    for path in SERVICE_SRC.rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr in {"create_all", "drop_all"}:
                offenders.append(f"{path.relative_to(SERVICE_SRC)}:{node.lineno}")
    assert offenders == [], (
        f"schema DDL in service code: {offenders}. Tables are declared in lib/sql and "
        "applied by the migration Job; tests build SQLite schemas via conftest.create_schema."
    )


@pytest.mark.asyncio
async def test_create_schema_REFUSES_a_postgres_engine():
    # The test helper must not become a back door to the thing this file forbids.
    from conftest import create_schema
    from broker.aws import store as aws_store

    store = PermissionStore(StoreConfig(dsn="postgresql+asyncpg://u:p@127.0.0.1:1/nope"))
    with pytest.raises(AssertionError, match="SQLite-only"):
        await create_schema(store, aws_store._Base)


@pytest.mark.asyncio
async def test_create_schema_DOES_build_tables_on_sqlite():
    # The guard must not break the test path it protects.
    from conftest import create_schema, sqlite_config
    from broker.sandbox import store as sandbox_store

    store = SandboxSizeStore(sqlite_config())
    await create_schema(store, sandbox_store._Base)
    assert await store.get("someone") is None
