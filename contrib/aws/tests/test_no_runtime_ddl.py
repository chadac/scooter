"""Tier 1 — this contrib must NEVER create tables on Postgres.

lib/sql is the source of truth: `permission_requests` is declared in
lib/sql/broker/schema.sql and applied by the Atlas migration Job. Code that also
runs DDL at boot silently diverges from the declared schema — which is how byoc's
remote_agent_devices existed in production for months with no schema entry.

The app asserts this for its own stores (services/broker/tests/test_no_runtime_ddl.py).
The invariant follows the CODE, so aws's half came here with the store (PR #599) —
otherwise moving a store out of the app would quietly move it out of the guard too,
which is the failure this file exists to prevent.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

from scooter_broker_lib.store import StoreConfig
from scooter_contrib_aws.store import PermissionStore

CONTRIB_SRC = pathlib.Path(__file__).resolve().parents[1] / "scooter_contrib_aws"


def test_the_store_exposes_NO_schema_creating_method():
    # init() used to run create_all. It is gone: nothing on the store builds tables,
    # so a caller cannot reintroduce boot-time DDL by calling one.
    assert not hasattr(PermissionStore, "init")


def test_no_module_in_this_contrib_calls_create_all():
    # Mechanism-level guard. Greps the AST rather than the text, so a comment
    # mentioning create_all does not trip it.
    assert CONTRIB_SRC.is_dir(), f"source not found at {CONTRIB_SRC}"
    offenders = []
    for path in sorted(CONTRIB_SRC.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Attribute) and node.attr in {"create_all", "drop_all"}:
                offenders.append(f"{path.relative_to(CONTRIB_SRC)}:{node.lineno}")
    assert offenders == [], (
        f"schema DDL in contrib code: {offenders}. `permission_requests` is declared "
        "in lib/sql and applied by the migration Job; tests build SQLite schemas via "
        "conftest.create_schema."
    )


@pytest.mark.asyncio
async def test_create_schema_REFUSES_a_postgres_engine():
    # The test helper must not become a back door to the thing this file forbids.
    from conftest import create_schema
    from scooter_contrib_aws import store as aws_store

    store = PermissionStore(StoreConfig(dsn="postgresql+asyncpg://u:p@127.0.0.1:1/nope"))
    with pytest.raises(AssertionError, match="SQLite-only"):
        await create_schema(store, aws_store._Base)
